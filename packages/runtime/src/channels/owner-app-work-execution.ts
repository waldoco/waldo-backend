import type { ConversationEntry } from '@waldo/contracts';
import type { AppThreadV1 } from '../../../contracts/src/app/threads';
import { AppInbox, type AppInboxRecord } from './app-inbox';
import type { ResponsibilityBook } from './responsibilities';
import type { EffectRecord, EffectReadback } from './owner-effect-ledger';
import type { OwnerWorkCheckpoint, OwnerWorkControlHost, OwnerWorkReadback } from './owner-work-control';
import { ClosedRunError } from './run-effect-scope';
import { sha256Hex } from '../connectors/google';
import { stableJson } from '../context-composer/canonical';

export type OwnerWorkExecutorReadback = Readonly<{ fenced: boolean; evidence_refs: readonly string[] }>;
export type OwnerAppWorkExecutionOptions = Readonly<{
  storage: DurableObjectStorage; inbox: AppInbox;
  // Owner name selects the physical inbox; principal/tenant select witnessed history.
  ownerName: string; principalRef: string; tenantRef: string; sessionHash: string;
  responsibilities: Pick<ResponsibilityBook, 'get'>;
  sourceRevision(): number; assertCurrent(): Promise<void>;
  // Must check the current authenticated request scope/owner lock synchronously.
  // Used at the inbox's actual publication point after awaited storage reads.
  assertLocalCurrent(): void;
  assertRequestCurrent?(record: AppInboxRecord): void;
  activeRun(): Readonly<{ run_id: string; attempt: string; fence(): void }> | null;
  executor: Readonly<{
    cancel(runId: string, assertCurrent: () => Promise<void>): Promise<OwnerWorkExecutorReadback>;
    reconcile(runId: string, assertCurrent: () => Promise<void>): Promise<OwnerWorkExecutorReadback>;
  }>;
  // Provider-specific independent readback only. No retry or mutation dispatch.
  reconcileEffect(record: EffectRecord, assertCurrent: () => Promise<void>): Promise<EffectReadback>;
  // Optional authoritative unit/lease mapping, never a background_runs status.
  canonicalBinding?(workRef: string): Readonly<{ run_id: string; revision: number }> | null;
  // Queue drain after control publication. The root's serialized drain must consult
  // assertRunnable(workRef,runId); this callback does not grant a scope itself.
  admitted(record: AppInboxRecord, workRef: string): void;
}>;
type HistoryWitness = Readonly<{ lineage: string; principal_ref: string; tenant_ref: string; entry: ConversationEntry }>;
type Anchor = Readonly<{
  owner_ref: string; run_id: string; attempt?: string; inbox_digest: string;
  conversation_ref: string; leaf_id: string | null; source_revision: number; resume_mode: 'envelope' | 'history'; envelope_digest?: string;
  thread_id?: string; thread_revision?: number;
}>;
type RunBinding = Readonly<{ owner_ref: string; work_ref: string; run_id: string }>;
const closed = (record: AppInboxRecord) => !['admitted', 'running'].includes(record.state);

// Root calls this before inbox claim and on every admitted scope check. Membership
// cannot disappear when another resume supersedes a mutable Work projection.
export function ownerAppWorkContinuationPending(storage: Pick<DurableObjectStorage, 'kv'>, record: AppInboxRecord): boolean {
  const membership = record.workContinuation; if (!membership) return false;
  const hold = storage.kv.get<{mode:string;checkpoint:{run_id:string}}>(`owner:work-control.v1:${membership.work_ref}`);
  return hold?.mode === 'resume_pending' && hold.checkpoint.run_id === membership.predecessor_run_id;
}
export function assertOwnerAppWorkRunnable(storage: Pick<DurableObjectStorage, 'kv'>, record: AppInboxRecord): void {
  const membership = record.workContinuation; if (!membership) return;
  const hold = storage.kv.get<{mode:string;current_run:string}>(`owner:work-control.v1:${membership.work_ref}`);
  if (!record.conversationRef?.startsWith(`owner:${membership.owner_ref}`) || !hold || hold.mode !== 'active' || hold.current_run !== record.id) throw new ClosedRunError();
}

// The existing inbox and canonical conversation remain the only request/history
// stores. Durable Work state contains exact run, attempt and leaf references only.
export function ownerAppWorkExecution(options: OwnerAppWorkExecutionOptions) {
  const { storage } = options;
  const prefix = `owner:work-execution.v1:${options.principalRef}:`;
  const historyPrefix = `canonical-owner-v1:${options.principalRef}:${options.tenantRef}:`;
  const anchorKey = (id: string) => `${prefix}checkpoint:${id}`;
  const bindingKey = (ref: string) => `${prefix}binding:${ref}`;
  const pendingKey = (id: string) => `${prefix}pending:${id}`;
  const record = (id: string) => options.inbox.records().find(row => row.id === id && row.owner === options.ownerName && !row.erased) ?? null;
  const history = (conversationRef: string) => {
    const entries = [...storage.kv.list<ConversationEntry>({ prefix: `${historyPrefix}conv:` })].map(([, entry]) => entry)
      .filter(entry => entry.chatId === conversationRef);
    const ids = new Set<string>();
    for (const entry of entries) {
      const witness = storage.kv.get<HistoryWitness>(`${historyPrefix}witness:${entry.id}`);
      if (entry.ownerId !== options.principalRef || ids.has(entry.id) || !witness || witness.lineage !== 'canonical_v1'
        || witness.principal_ref !== options.principalRef || witness.tenant_ref !== options.tenantRef || stableJson(witness.entry) !== stableJson(entry)) throw new ClosedRunError();
      ids.add(entry.id);
    }
    return entries;
  };
  const threadCurrent = (anchor: Anchor) => {
    if (!anchor.thread_id) return;
    const thread = storage.kv.get<AppThreadV1>(`app-thread-v1:${options.principalRef}:${options.tenantRef}:thread:${anchor.thread_id}`);
    if (!thread || thread.thread_id !== anchor.thread_id || thread.state !== 'active' || thread.revision !== anchor.thread_revision || thread.conversation_ref !== anchor.conversation_ref) throw new ClosedRunError();
  };
  const envelopeMaterial = (row: AppInboxRecord) => stableJson({ text: row.text, conversation_ref: row.conversationRef, thread_id: row.threadId ?? null, thread_revision: row.threadRevision ?? null,
    context_refs: row.contextRefs ?? [], attachment_refs: row.attachmentRefs ?? [], context_snapshots: row.contextSnapshots ?? [], snapshot_digest: row.snapshotDigest ?? null, voice: row.voice ?? null });
  const requestCurrent = (row: AppInboxRecord) => {
    options.assertRequestCurrent?.(row);
    for (const reference of row.contextRefs ?? []) if (reference.kind === 'thread') {
      const thread = storage.kv.get<AppThreadV1>(`app-thread-v1:${options.principalRef}:${options.tenantRef}:thread:${reference.thread_id}`);
      if (!thread || thread.state !== 'active' || thread.revision !== reference.revision || thread.thread_id !== reference.thread_id) throw new ClosedRunError();
    }
  };
  const freshAnchor = (row: AppInboxRecord): Anchor | null => {
    if (!row.conversationRef || !row.conversationRef.startsWith(`owner:${options.principalRef}`)) return null;
    if (row.conversationRef !== `owner:${options.principalRef}` && (!row.threadId || row.conversationRef !== `owner:${options.principalRef}:thread:${row.threadId.slice(4)}`)) return null;
    const input = history(row.conversationRef).find(entry => entry.id === row.id);
    if (input && (input.role !== 'user' || input.inputOrigin !== 'owner' || input.surface !== 'app')) throw new ClosedRunError();
    // A queued request has not entered the conversation yet. Its own immutable
    // inbox envelope is the checkpoint; an earlier or latest sibling is not it.
    if (!input && closed(row) && !row.workPause) return null;
    const value: Anchor = { owner_ref: options.principalRef, run_id: row.id, ...(row.attempt ? { attempt: row.attempt } : {}), inbox_digest: row.digest,
      conversation_ref: row.conversationRef, leaf_id: input?.id ?? null, resume_mode: input ? 'history' : 'envelope', source_revision: options.sourceRevision(),
      ...(row.threadId ? { thread_id: row.threadId, thread_revision: row.threadRevision } : {}) };
    threadCurrent(value); requestCurrent(row); return value;
  };
  const anchor = (row: AppInboxRecord) => storage.kv.get<Anchor>(anchorKey(row.id)) ?? freshAnchor(row);
  const assertAnchor = (held: Anchor) => {
    const row = record(held.run_id);
    if (!row || held.owner_ref !== options.principalRef || row.digest !== held.inbox_digest || row.attempt !== held.attempt
      || row.conversationRef !== held.conversation_ref || row.threadId !== held.thread_id || row.threadRevision !== held.thread_revision
      || row.closedReason === 'archived' || row.closedReason === 'deleted' || row.closedReason === 'thread_changed' || row.state === 'revoked'
      || held.source_revision !== options.sourceRevision()) throw new ClosedRunError();
    if (held.leaf_id !== null) {
      const input = history(held.conversation_ref).find(entry => entry.id === held.leaf_id);
      if (!input || input.id !== row.id || input.role !== 'user' || input.inputOrigin !== 'owner' || input.surface !== 'app') throw new ClosedRunError();
    }
    threadCurrent(held); requestCurrent(row); return row;
  };
  const envelopeCurrent = async (held: Anchor, guard: () => Promise<void>, requirePaused = false) => {
    await options.assertCurrent(); await guard(); options.assertLocalCurrent();
    const before = assertAnchor(held), material = envelopeMaterial(before), digest = await sha256Hex(material);
    await options.assertCurrent(); await guard(); options.assertLocalCurrent();
    const after = assertAnchor(held);
    if (envelopeMaterial(after) !== material || held.envelope_digest && held.envelope_digest !== digest
      || requirePaused && (after.state !== 'interrupted' || after.workPause?.envelope_digest !== digest)) throw new ClosedRunError();
    return { row: after, digest };
  };
  const effects = (runId: string) => [...storage.kv.list<EffectRecord>({ prefix: 'owner:effect:' })].map(([, value]) => value)
    .filter(effect => effect.origin_run_ref === runId);
  const binding = (workRef: string): Readonly<{ run_id: string; revision: number }> | null => {
    const persisted = storage.kv.get<RunBinding>(bindingKey(workRef));
    if (persisted && (persisted.owner_ref !== options.principalRef || persisted.work_ref !== workRef)) throw new ClosedRunError();
    if (workRef.startsWith('responsibility:')) {
      const responsibility = options.responsibilities.get(workRef.slice('responsibility:'.length));
      if (!responsibility || !['open', 'waiting', 'uncertain'].includes(responsibility.status)) return null;
      return { run_id: persisted?.run_id ?? responsibility.created_from, revision: responsibility.revision };
    }
    if (workRef.startsWith('run:')) {
      const id = workRef.slice('run:'.length);
      // An audit row may name a different runner. Only an actual inbox record or
      // an explicitly verified canonical unit binding supplies control authority.
      return record(persisted?.run_id ?? id) ? { run_id: persisted?.run_id ?? id, revision: 1 } : options.canonicalBinding?.(workRef) ?? null;
    }
    const canonical = options.canonicalBinding?.(workRef);
    return canonical ? { run_id: persisted?.run_id ?? canonical.run_id, revision: canonical.revision } : null;
  };
  const checkpoint = (workRef: string): OwnerWorkCheckpoint | null => {
    options.assertLocalCurrent();
    const linked = binding(workRef), row = linked && record(linked.run_id), held = row && anchor(row);
    if (!linked || !row || !held) return null;
    try { assertAnchor(held); } catch { return null; }
    return { work_ref: workRef, revision: linked.revision, run_id: row.id, conversation_ref: held.conversation_ref,
      checkpoint_ref: `inbox:${row.id}:${row.digest}:${held.leaf_id ?? 'envelope'}`, source_revision: held.source_revision,
      state: row.state === 'admitted' ? 'queued' : row.state, effect_refs: effects(row.id).map(effect => effect.operationId), resumable: !closed(row) || row.state === 'interrupted' && row.workPause?.envelope_digest !== undefined && row.workPause.envelope_digest === held.envelope_digest };
  };
  const heldCheckpoint = (value: OwnerWorkCheckpoint) => {
    const row = record(value.run_id), held = row && anchor(row);
    if (!held || value.checkpoint_ref !== `inbox:${value.run_id}:${held.inbox_digest}:${held.leaf_id ?? 'envelope'}` || value.conversation_ref !== held.conversation_ref || value.source_revision !== held.source_revision) throw new ClosedRunError();
    assertAnchor(held); return held;
  };
  const current = async (guard: () => Promise<void>) => { await options.assertCurrent(); await guard(); options.assertLocalCurrent(); };
  const readback = async (value: OwnerWorkCheckpoint, guard: () => Promise<void>, cancel: boolean): Promise<OwnerWorkReadback> => {
    await current(guard); const held = heldCheckpoint(value), before = record(held.run_id)!;
    const execution = cancel ? await options.executor.cancel(held.run_id, guard) : await options.executor.reconcile(held.run_id, guard);
    await current(guard); assertAnchor(held);
    const unresolved: string[] = [], evidence = [`inbox:${held.run_id}:${held.inbox_digest}`, ...(held.leaf_id ? [`conversation:${held.leaf_id}`] : []), ...execution.evidence_refs];
    const known = effects(held.run_id), byId = new Map(known.map(effect => [effect.operationId, effect]));
    for (const ref of new Set([...value.effect_refs, ...byId.keys()])) {
      await current(guard);
      const effect = byId.get(ref);
      if (!effect || ![options.principalRef, options.ownerName].includes(effect.owner_ref)) { unresolved.push(ref); continue; }
      if (effect.state === 'done' && effect.receipt?.provider_id) { evidence.push(`effect:${ref}`, `provider:${effect.receipt.provider_id}`); continue; }
      if (effect.state === 'rejected') { evidence.push(`effect:${ref}:not_applied`); continue; }
      const outcome = await options.reconcileEffect(effect, guard); await current(guard); assertAnchor(held);
      if (outcome.status === 'done' && outcome.receipt.provider_id) evidence.push(`effect:${ref}`, `provider:${outcome.receipt.provider_id}`);
      else if (outcome.status === 'not_applied') evidence.push(`effect:${ref}:not_applied`);
      else unresolved.push(ref);
    }
    await current(guard); assertAnchor(held);
    // A separately authorized decision may publish another effect while provider
    // readback is awaited. It cannot disappear from this cancellation receipt.
    for (const effect of effects(held.run_id)) if (!byId.has(effect.operationId)) unresolved.push(effect.operationId);
    const after = record(held.run_id);
    return { fenced: !!after && closed(after) && execution.fenced && (closed(before) || cancel), unresolved_effect_refs: unresolved, evidence_refs: [...new Set(evidence)] };
  };
  const publishedContinuation = (workRef: string, newRunId: string, predecessorCheckpoint: OwnerWorkCheckpoint) => {
    options.assertLocalCurrent();
    const published = storage.kv.get<{mode:string;current_run:string;checkpoint:OwnerWorkCheckpoint}>(`owner:work-control.v1:${workRef}`);
    const linked = storage.kv.get<RunBinding>(pendingKey(newRunId)), fresh = record(newRunId), predecessor = record(predecessorCheckpoint.run_id);
    const previous = predecessor && storage.kv.get<Anchor>(anchorKey(predecessor.id));
    if (published?.mode !== 'active' || published.current_run !== newRunId || published.checkpoint.run_id !== predecessorCheckpoint.run_id
      || linked?.owner_ref !== options.principalRef || linked.work_ref !== workRef || linked.run_id !== newRunId || !fresh
      || fresh.workContinuation?.owner_ref !== options.principalRef || fresh.workContinuation.work_ref !== workRef || fresh.workContinuation.predecessor_run_id !== predecessorCheckpoint.run_id
      || !predecessor || !previous?.envelope_digest || !options.inbox.releaseWorkPause(predecessor.id, predecessor.attempt, predecessor.digest, previous.envelope_digest)) throw new ClosedRunError();
    storage.kv.put(bindingKey(workRef), linked);
    // A winning publication also clears every superseded fresh admission for
    // this Work hold. Each has durable membership and has never owned this hold.
    for (const orphan of options.inbox.records()) if (orphan.id !== newRunId && orphan.owner === options.ownerName && orphan.state === 'admitted'
      && orphan.workContinuation?.owner_ref === options.principalRef && orphan.workContinuation.work_ref === workRef) {
      if (!options.inbox.cancelRun(orphan.id, orphan.attempt, orphan.digest)) throw new ClosedRunError();
      storage.kv.delete(pendingKey(orphan.id));
    }
  };
  const ports: Pick<OwnerWorkControlHost, 'checkpoint' | 'assertCheckpoint' | 'fenceRun' | 'cancel' | 'reconcile' | 'admitContinuation' | 'publishedContinuation'> = {
    publishedContinuation,
    checkpoint,
    async assertCheckpoint(value) {
      await options.assertCurrent(); options.assertLocalCurrent(); const before = checkpoint(value.work_ref);
      if (!before || stableJson(before) !== stableJson(value)) throw new ClosedRunError();
      const held = heldCheckpoint(value);
      if (closed(assertAnchor(held)) && !assertAnchor(held).workPause) return;
      const checked = await envelopeCurrent(held, options.assertCurrent);
      storage.transactionSync(() => { options.assertLocalCurrent(); const row = assertAnchor(held); if (envelopeMaterial(row) !== envelopeMaterial(checked.row)) throw new ClosedRunError();
        storage.kv.put(anchorKey(row.id), { ...held, envelope_digest: checked.digest } satisfies Anchor); });
    },
    fenceRun(runId, action) {
      options.assertLocalCurrent(); const row = record(runId), held = row && anchor(row);
      if (!row || !held) throw new ClosedRunError(); assertAnchor(held);
      // Same transaction as the Work hold: no provider I/O can race durable closure.
      storage.kv.put(anchorKey(runId), held);
      if (!held.envelope_digest || !options.inbox.cancelRun(row.id, row.attempt, row.digest, 'cancelled', action === 'pause' ? { envelope_digest: held.envelope_digest } : undefined)) throw new ClosedRunError();
      const live = options.activeRun(); if (live?.run_id === runId) { if (live.attempt !== row.attempt) throw new ClosedRunError(); live.fence(); }
    },
    cancel: (value, _operation, guard) => readback(value, guard, true),
    reconcile: (value, guard) => readback(value, guard, false),
    async admitContinuation(value, operationId, guard) {
      await current(guard); const held = heldCheckpoint(value), checked = await envelopeCurrent(held, guard, true), original = checked.row;
      if (!closed(original)) throw new ClosedRunError();
      const clientId = `work_${(await sha256Hex(stableJson([options.principalRef, value.work_ref, operationId]))).slice(0, 48)}`;
      await current(guard); assertAnchor(held);
      const text = held.resume_mode === 'envelope' ? original.text : `Continue the owner-requested work ${value.work_ref} from its exact retained owner-input checkpoint ${held.leaf_id}. Read the existing responsibility and effect receipts before continuing. Earlier execution ${value.run_id} was fenced; do not repeat uncertain effects.`;
      const material = envelopeMaterial(original);
      const result = await options.inbox.admit(options.ownerName, options.sessionHash, clientId, text,
        { conversationRef: held.conversation_ref, ...(held.thread_id ? { threadId: held.thread_id, threadRevision: held.thread_revision } : {}),
          contextRefs: original.contextRefs, attachmentRefs: original.attachmentRefs, contextSnapshots: original.contextSnapshots, voice: original.voice,
          workContinuation: { owner_ref: options.principalRef, work_ref: value.work_ref, predecessor_run_id: value.run_id } },
        () => { options.assertLocalCurrent(); const row = assertAnchor(held);
          if (!closed(row) || envelopeMaterial(row) !== material || row.workPause?.envelope_digest !== checked.digest) throw new ClosedRunError(); });
      await current(guard); assertAnchor(held);
      if (result.kind !== 'admitted' && result.kind !== 'duplicate') throw new Error(`continuation ${result.kind}`);
      if (result.record.id === value.run_id || result.record.owner !== options.ownerName || result.record.sessionHash !== options.sessionHash || result.record.state !== 'admitted') throw new ClosedRunError();
      storage.transactionSync(() => { options.assertLocalCurrent(); assertAnchor(held); const linked = { owner_ref: options.principalRef, work_ref: value.work_ref, run_id: result.record.id } satisfies RunBinding; storage.kv.put(pendingKey(result.record.id), linked); });
      return { admitted: true, run_id: result.record.id, evidence_refs: [`inbox:${result.record.id}:${result.record.digest}`, ...(held.leaf_id ? [`conversation:${held.leaf_id}`] : [])] };
    },
  };
  const flushAdmissions = () => {
    options.assertLocalCurrent();
    for (const [key, linked] of [...storage.kv.list<RunBinding>({ prefix: `${prefix}pending:` })]) {
      const hold = storage.kv.get<{mode:string;current_run:string;checkpoint:OwnerWorkCheckpoint}>(`owner:work-control.v1:${linked.work_ref}`), fresh = record(linked.run_id);
      if (linked.owner_ref !== options.principalRef || hold?.mode !== 'active' || hold.current_run !== linked.run_id || !fresh) continue;
      storage.transactionSync(() => { publishedContinuation(linked.work_ref, linked.run_id, hold.checkpoint); storage.kv.delete(key); });
      if (fresh.state === 'admitted') options.admitted(fresh, linked.work_ref);
    }
  };
  return { ...ports, flushAdmissions, workRefForRun: (runId: string) => record(runId)?.workContinuation?.work_ref ?? [...storage.kv.list<RunBinding>({ prefix: `${prefix}binding:` })].map(([, row]) => row).find(row => row.owner_ref === options.principalRef && row.run_id === runId)?.work_ref ?? null };
}
