import { APP_UPDATE_BASE } from './app-api';
import { APP_INBOX_DUE_KEY, rearmSharedAlarm } from '../scheduler/alarm-slot';
import { ClosedRunError, type RunEffectScope } from './run-effect-scope';
import { stableJson } from '../context-composer/canonical';
import { redactSecretUrls } from './egress-guard';
import { appThreadAttachmentRefV1Schema, appThreadContextRefV1Schema, appThreadIdV1Schema, type AppThreadSendV1, type AppThreadMessageReceiptV1 } from '../../../contracts/src/app/threads';
import { appVoiceReviewV1Schema, type AppVoiceReviewV1 } from '../../../contracts/src/app/media';

export const APP_INBOX_KEY = 'app_inbox_v1';
const APP_INBOX_RECORD_PREFIX = 'app:inbox-record:';
const recordKey = (id: string) => `${APP_INBOX_RECORD_PREFIX}${id}`;
export type AppThreadContextSnapshot = Readonly<{ threadId: string; revision: number; leafId: string | null; digest: string }>;
export type AppInboxWorkContinuation = Readonly<{ owner_ref: string; work_ref: string; predecessor_run_id: string }>;
export type AppInboxAdmission = Readonly<{
  conversationRef: string;
  threadId?: string; threadRevision?: number;
  contextRefs?: readonly AppThreadSendV1['context_refs'][number][];
  attachmentRefs?: readonly AppThreadSendV1['attachment_refs'][number][];
  contextSnapshots?: readonly AppThreadContextSnapshot[];
  voice?: AppVoiceReviewV1;
  // Server-only immutable membership, published with the existing inbox row.
  workContinuation?: AppInboxWorkContinuation;
}>;
export type AppConversationSelection = Readonly<{ conversationRef: string; includeLegacyMain?: boolean }>;
export type AppInboxClosedReason = 'interrupted' | 'session_revoked' | 'cancelled' | 'archived' | 'deleted' | 'thread_changed';
export type AppInboxRecord = {
  id: string; clientId: string; updateId: number; digest: string; text: string; owner: string; sessionHash: string;
  admittedAt: number; state: 'admitted' | 'running' | 'completed' | 'interrupted' | 'revoked';
  attempt?: string; deadline?: number; closedAt?: number;
  conversationRef?: string; threadId?: string; threadRevision?: number;
  contextRefs?: AppThreadSendV1['context_refs']; attachmentRefs?: AppThreadSendV1['attachment_refs'];
  digestVersion?: 2; closedReason?: AppInboxClosedReason; effectsUnconfirmed?: boolean; erased?: boolean;
  contextSnapshots?: AppThreadContextSnapshot[]; snapshotDigest?: string;
  voice?: AppVoiceReviewV1;
  workPause?: Readonly<{ envelope_digest: string }>;
  workContinuation?: AppInboxWorkContinuation;
};
export const appInboxConversationMatches = (row: AppInboxRecord, selection?: AppConversationSelection) => !selection
  || row.conversationRef === selection.conversationRef || (!row.conversationRef && selection.includeLegacyMain === true);
const admissionEnvelope = (text: string, binding?: AppInboxAdmission) => {
  if (!binding) return null;
  if (!binding.conversationRef || binding.conversationRef.length > 256 || /[\u0000-\u001f]/.test(binding.conversationRef)) throw new Error('invalid app conversation binding');
  if ((binding.threadId === undefined) !== (binding.threadRevision === undefined)
    || (binding.threadId && (!appThreadIdV1Schema.safeParse(binding.threadId).success || !Number.isSafeInteger(binding.threadRevision) || binding.threadRevision! <= 0
      || !binding.conversationRef.endsWith(`:thread:${binding.threadId.slice(4)}`)))) throw new Error('invalid app thread binding');
  if ((binding.contextRefs?.length ?? 0) > 16 || (binding.attachmentRefs?.length ?? 0) > 16) throw new Error('invalid app references');
  const contextRefs = (binding.contextRefs ?? []).map(reference => appThreadContextRefV1Schema.parse(reference));
  const attachmentRefs = (binding.attachmentRefs ?? []).map(reference => appThreadAttachmentRefV1Schema.parse(reference));
  return { text, conversationRef: binding.conversationRef, threadId: binding.threadId ?? null, threadRevision: binding.threadRevision ?? null, contextRefs, attachmentRefs,
    ...(binding.voice ? { voice: appVoiceReviewV1Schema.parse(binding.voice) } : {}) };
};
const clearPayload = (row: AppInboxRecord) => { row.text = ''; row.contextRefs = []; row.attachmentRefs = []; row.contextSnapshots = []; delete row.snapshotDigest; delete row.voice; delete row.workPause; };
const due = (rows: readonly AppInboxRecord[], now: number) => rows.some(row => row.state === 'admitted') ? now + 250 : null;
export class AppInbox {
  constructor(private readonly storage: DurableObjectStorage, private readonly now = Date.now) {}
  records(): AppInboxRecord[] {
    const old = this.storage.kv.get<AppInboxRecord[]>(APP_INBOX_KEY) ?? [];
    const rows = new Map(old.map(row => [row.id, row]));
    for (const [, row] of this.storage.kv.list<AppInboxRecord>({ prefix: APP_INBOX_RECORD_PREFIX })) rows.set(row.id, row);
    return [...rows.values()].sort((a, b) => a.updateId - b.updateId);
  }
  private writeRecords(rows: readonly AppInboxRecord[], changed: readonly AppInboxRecord[] = rows): void {
    for (const row of this.storage.kv.get(APP_INBOX_KEY) ? rows : changed) this.storage.kv.put(recordKey(row.id), row);
    this.storage.kv.delete(APP_INBOX_KEY);
  }
  receipt(owner: string, clientId: string, selection?: AppConversationSelection): AppThreadMessageReceiptV1 | null {
    const row = this.records().find(value => value.owner === owner && value.clientId === clientId && appInboxConversationMatches(value, selection));
    return row ? { accepted: true, message_id: row.id, state: row.state,
      ...(row.closedReason ? { closed_reason: row.closedReason } : {}), ...(row.effectsUnconfirmed !== undefined ? { effects_unconfirmed: row.effectsUnconfirmed } : {}),
    } : null;
  }
  async admit(owner: string, sessionHash: string, clientId: string, text: string, binding?: AppInboxAdmission, assertCurrent?: () => void) {
    const envelope = admissionEnvelope(text, binding);
    const workContinuation = binding?.workContinuation;
    if (workContinuation && (!/^prn_[a-f0-9]{32}$/.test(workContinuation.owner_ref) || !binding!.conversationRef.startsWith(`owner:${workContinuation.owner_ref}`)
      || !/^(responsibility|work_unit|run):[A-Za-z0-9_.:-]{1,256}$/.test(workContinuation.work_ref) || !/^app-[0-9]+$/.test(workContinuation.predecessor_run_id))) throw new Error('invalid Work continuation membership');
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(envelope ? stableJson(envelope) : text)))].map(value => value.toString(16).padStart(2, '0')).join('');
    const contextSnapshots = binding?.contextSnapshots?.map(snapshot => {
      if (!appThreadIdV1Schema.safeParse(snapshot.threadId).success || !Number.isSafeInteger(snapshot.revision) || snapshot.revision <= 0
        || (snapshot.leafId !== null && (!snapshot.leafId || snapshot.leafId.length > 512)) || !/^sha256:[a-f0-9]{64}$/.test(snapshot.digest)
        || !envelope?.contextRefs.some(reference => reference.kind === 'thread' && reference.thread_id === snapshot.threadId && reference.revision === snapshot.revision)) throw new Error('invalid app context checkpoint');
      return { threadId: snapshot.threadId, revision: snapshot.revision, leafId: snapshot.leafId, digest: snapshot.digest };
    });
    if ((contextSnapshots?.length ?? 0) > 16) throw new Error('invalid app context checkpoints');
    const snapshotDigest = contextSnapshots ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(contextSnapshots))))].map(value => value.toString(16).padStart(2, '0')).join('') : undefined;
    const result = await this.storage.transaction(async txn => {
      // The host rechecks session, thread and resolved references at durable publication.
      assertCurrent?.();
      const old = await txn.get<AppInboxRecord[]>(APP_INBOX_KEY) ?? [], merged = new Map(old.map(row => [row.id, row]));
      for (const [, row] of await txn.list<AppInboxRecord>({ prefix: APP_INBOX_RECORD_PREFIX })) merged.set(row.id, row);
      const rows = [...merged.values()].sort((a, b) => a.updateId - b.updateId);
      const previous = rows.find(row => row.clientId === clientId);
      if (previous) return previous.owner === owner && previous.digest === digest && stableJson(previous.workContinuation ?? null) === stableJson(workContinuation ?? null) ? { kind: 'duplicate' as const, record: previous } : { kind: 'conflict' as const };
      if (rows.filter(row => ['admitted', 'running'].includes(row.state)).length >= 256) return { kind: 'capacity' as const };
      const sequence = (await txn.get<number>('app_seq') ?? 0) + 1;
      assertCurrent?.();
      const record: AppInboxRecord = { id: `app-${APP_UPDATE_BASE + sequence}`, updateId: APP_UPDATE_BASE + sequence, clientId, digest, text: redactSecretUrls(text).text, owner, sessionHash, admittedAt: this.now(), state: 'admitted',
        ...(envelope ? { digestVersion: 2, conversationRef: envelope.conversationRef, ...(binding!.threadId ? { threadId: binding!.threadId, threadRevision: binding!.threadRevision! } : {}), contextRefs: envelope.contextRefs, attachmentRefs: envelope.attachmentRefs } : {}),
        ...(contextSnapshots ? { contextSnapshots, snapshotDigest } : {}),
        ...(envelope && binding?.voice ? { voice: binding.voice } : {}),
        ...(workContinuation ? { workContinuation: structuredClone(workContinuation) } : {}),
      };
      // Uncertain attempts stay as evidence but do not consume the runnable admission quota.
      const retained = rows.filter(row => ['admitted', 'running', 'interrupted'].includes(row.state) || row.admittedAt + 30 * 86_400_000 > this.now());
      retained.push(record);
      const retainedIds = new Set(retained.map(row => row.id));
      for (const row of old) if (retainedIds.has(row.id) && row.id !== record.id) await txn.put(recordKey(row.id), merged.get(row.id)!);
      await txn.put(recordKey(record.id), record);
      for (const row of rows) if (!retainedIds.has(row.id)) await txn.delete(recordKey(row.id));
      await txn.delete(APP_INBOX_KEY);
      await txn.put({ app_seq: sequence, [APP_INBOX_DUE_KEY]: due(retained, this.now()) });
      return { kind: 'admitted' as const, record };
    });
    // ACK follows both durable payload publication and durable wake registration.
    await rearmSharedAlarm(this.storage, null, this.now());
    return result;
  }
  recover(live: ReadonlySet<string>): void {
    this.storage.transactionSync(() => {
      const rows = this.records(), changed: AppInboxRecord[] = [];
      for (const row of rows) if (row.state === 'running' && !live.has(row.attempt ?? '')) { row.state = 'interrupted'; clearPayload(row); row.closedAt = this.now(); row.closedReason = 'interrupted'; row.effectsUnconfirmed = true; changed.push(row); }
      this.writeRecords(rows, changed);
      this.storage.kv.put(APP_INBOX_DUE_KEY, due(rows, this.now()));
    });
  }
  claim(id: string, sessionCurrent: boolean, conversationCurrent = true): AppInboxRecord | null {
    return this.storage.transactionSync(() => {
      const rows = this.records(), row = rows.find(value => value.id === id);
      if (!row || row.state !== 'admitted') return null;
      if (row.workContinuation) {
        const hold = this.storage.kv.get<{mode:string;current_run:string;checkpoint:{run_id:string}}>(`owner:work-control.v1:${row.workContinuation.work_ref}`);
        // In-progress publication retains custody without creating an attempt.
        if (sessionCurrent && conversationCurrent && hold?.mode === 'resume_pending' && hold.checkpoint.run_id === row.workContinuation.predecessor_run_id) return null;
        if (!hold || hold.mode !== 'active' || hold.current_run !== row.id) conversationCurrent = false;
      }
      row.state = !sessionCurrent ? 'revoked' : conversationCurrent ? 'running' : 'interrupted';
      if (row.state === 'running') { row.attempt = crypto.randomUUID(); row.deadline = this.now() + 15 * 60_000; }
      else { clearPayload(row); row.closedAt = this.now(); row.closedReason = sessionCurrent ? 'thread_changed' : 'session_revoked'; row.effectsUnconfirmed = false; }
      this.writeRecords(rows, [row]); this.storage.kv.put(APP_INBOX_DUE_KEY, due(rows, this.now()));
      return row.state === 'running' ? structuredClone(row) : null;
    });
  }
  scope(record: AppInboxRecord, signal: AbortSignal, assertConversationCurrent?: (record: AppInboxRecord) => void): RunEffectScope {
    const admit = () => {
      const current = this.records().find(row => row.id === record.id);
      if (signal.aborted || !current || current.state !== 'running' || current.attempt !== record.attempt || current.owner !== record.owner || current.digest !== record.digest
        || current.sessionHash !== record.sessionHash || current.text !== record.text || current.conversationRef !== record.conversationRef || current.threadId !== record.threadId || current.threadRevision !== record.threadRevision
        || stableJson(current.contextRefs ?? []) !== stableJson(record.contextRefs ?? []) || stableJson(current.attachmentRefs ?? []) !== stableJson(record.attachmentRefs ?? [])
        || current.snapshotDigest !== record.snapshotDigest || stableJson(current.contextSnapshots ?? []) !== stableJson(record.contextSnapshots ?? [])
        || stableJson(current.voice ?? null) !== stableJson(record.voice ?? null) || stableJson(current.workContinuation ?? null) !== stableJson(record.workContinuation ?? null)
        || this.now() >= (record.deadline ?? 0)) throw new ClosedRunError();
      if (current.workContinuation) {
        const hold = this.storage.kv.get<{mode:string;current_run:string}>(`owner:work-control.v1:${current.workContinuation.work_ref}`);
        if (!hold || hold.mode !== 'active' || hold.current_run !== current.id) throw new ClosedRunError();
      }
      assertConversationCurrent?.(current);
    };
    return { runId: record.id, attempt: record.attempt!, deadline: record.deadline!, signal, admit, commit: work => this.storage.transactionSync(() => { admit(); return work(); }) };
  }
  settle(record: AppInboxRecord, completed: boolean): void {
    this.storage.transactionSync(() => {
      const rows = this.records(), row = rows.find(value => value.id === record.id);
      if (!row || row.state !== 'running' || row.attempt !== record.attempt) return;
      row.state = completed ? 'completed' : 'interrupted'; clearPayload(row); row.closedAt = this.now();
      if (!completed) { row.closedReason = 'interrupted'; row.effectsUnconfirmed = true; }
      this.writeRecords(rows, [row]); this.storage.kv.put(APP_INBOX_DUE_KEY, due(rows, this.now()));
    });
  }
  // Work controls close exactly the witnessed run, never every task in its chat.
  // Existing scope.admit() observes this publication synchronously after eviction.
  cancelRun(id: string, attempt: string | undefined, digest: string, reason: 'cancelled' = 'cancelled', preserveEnvelope?: Readonly<{ envelope_digest: string }>): boolean {
    if (preserveEnvelope && !/^[a-f0-9]{64}$/.test(preserveEnvelope.envelope_digest)) throw new Error('invalid Work envelope witness');
    return this.storage.transactionSync(() => {
      const rows = this.records(), row = rows.find(value => value.id === id);
      if (!row || row.attempt !== attempt || row.digest !== digest) return false;
      if (row.state === 'interrupted' && row.closedReason === reason) {
        if (preserveEnvelope) { if (row.workPause?.envelope_digest !== preserveEnvelope.envelope_digest) return false; }
        else { clearPayload(row); this.writeRecords(rows, [row]); }
        return true;
      }
      if (row.state !== 'admitted' && row.state !== 'running') return false;
      row.effectsUnconfirmed = row.state === 'running'; row.state = 'interrupted';
      row.closedReason = reason; row.closedAt = this.now();
      if (preserveEnvelope) row.workPause = preserveEnvelope; else clearPayload(row);
      this.writeRecords(rows, [row]); this.storage.kv.put(APP_INBOX_DUE_KEY, due(rows, this.now()));
      return true;
    });
  }
  // Only a published Work continuation may release its exact predecessor's
  // retained request. Digests/attempt/state/effect residue remain for readback.
  releaseWorkPause(id: string, attempt: string | undefined, digest: string, envelopeDigest: string): boolean {
    return this.storage.transactionSync(() => {
      const rows = this.records(), row = rows.find(value => value.id === id);
      if (!row || row.state !== 'interrupted' || row.closedReason !== 'cancelled' || row.attempt !== attempt || row.digest !== digest) return false;
      if (!row.workPause) return true;
      if (row.workPause.envelope_digest !== envelopeDigest) return false;
      clearPayload(row); this.writeRecords(rows, [row]); return true;
    });
  }
  cancelConversation(conversationRef: string, reason: 'cancelled' | 'archived' | 'deleted' = 'cancelled'): number {
    return this.storage.transactionSync(() => {
      const rows = this.records(), changed: AppInboxRecord[] = []; let count = 0;
      for (const row of rows) if (row.conversationRef === conversationRef && (row.state === 'admitted' || row.state === 'running' || row.workPause !== undefined)) {
        row.effectsUnconfirmed = row.state === 'running'; row.state = 'interrupted'; row.closedReason = reason; row.closedAt = this.now(); clearPayload(row); changed.push(row); count++;
      }
      this.writeRecords(rows, changed); this.storage.kv.put(APP_INBOX_DUE_KEY, due(rows, this.now())); return count;
    });
  }
  eraseConversation(conversationRef: string): number {
    return this.storage.transactionSync(() => {
      this.cancelConversation(conversationRef, 'deleted');
      const rows = this.records(), changed: AppInboxRecord[] = []; let count = 0;
      for (const row of rows) if (row.conversationRef === conversationRef) { clearPayload(row); row.erased = true; changed.push(row); count++; }
      this.writeRecords(rows, changed); return count;
    });
  }
}
