import type { IMessageBinding } from '@waldo/contracts';
import { armAlarm } from '../../scheduler/alarm-slot';
import { ClosedRunError, type RunEffectScope } from '../run-effect-scope';

// Owner-DO side of iMessage ingress. One durable writer: payload, dedup identity, digest, sequence
// and wake commit before the bridge's handoff is acknowledged. Cross-DO handoff is at-least-once;
// this inbox deduplicates on the bridge/account/generation/eventId identity plus the raw digest.
// A recovered running attempt is uncertain and never becomes runnable again.

export const IMESSAGE_INBOX_DUE_KEY = 'imessage_owner_inbox_due_v1';
export const IMESSAGE_UPDATE_BASE = 9_000_000_000_000;
const PREFIX = 'imessage:inbox-record:';
const SEQ = 'imessage_seq';
const MAX_ROWS = 4096;
const MAX_OPEN = 256;
// A finished row keeps its dedup identity for this long; afterwards the bridge has long since moved on.
export const IMESSAGE_INBOX_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const IMESSAGE_TURN_DEADLINE_MS = 15 * 60_000;

export type IMessageInboxRecord = {
  id: string; updateId: number; dedupKey: string; digest: string; text: string; conversationRef: string;
  binding: IMessageBinding; bindingDigest: string; revision: string; environment: string; bridgeDoName: string; ownerDoName: string;
  commandId: string; occurredAt: number; admittedAt: number;
  state: 'admitted' | 'running' | 'completed' | 'interrupted' | 'revoked';
  attempt?: string; deadline?: number; closedAt?: number;
  closedReason?: 'interrupted' | 'authority_revoked' | 'final_committed'; effectsUnconfirmed?: boolean;
};
export type IMessageAdmitInput = Omit<IMessageInboxRecord, 'id' | 'updateId' | 'admittedAt' | 'state'>;

const finished = (r: IMessageInboxRecord) => r.state === 'completed' || r.state === 'interrupted' || r.state === 'revoked';
const open = (r: IMessageInboxRecord) => r.state === 'admitted' || r.state === 'running';
const due = (rows: readonly IMessageInboxRecord[], now: number) => (rows.some((r) => r.state === 'admitted') ? now + 250 : null);
const clear = (r: IMessageInboxRecord) => { r.text = ''; };

export class IMessageOwnerInbox {
  constructor(private readonly storage: DurableObjectStorage, private readonly now = Date.now) {}
  records(): IMessageInboxRecord[] {
    return [...this.storage.kv.list<IMessageInboxRecord>({ prefix: PREFIX })].map(([, r]) => r).sort((a, b) => a.updateId - b.updateId);
  }
  get(id: string): IMessageInboxRecord | null { return this.storage.kv.get<IMessageInboxRecord>(PREFIX + id) ?? null; }

  async admit(input: IMessageAdmitInput, assertCurrent?: () => void): Promise<{ kind: 'admitted' | 'duplicate'; record: IMessageInboxRecord } | { kind: 'conflict' | 'capacity' }> {
    return this.storage.transaction(async (txn) => {
      assertCurrent?.();
      const now = this.now();
      let rows = [...(await txn.list<IMessageInboxRecord>({ prefix: PREFIX })).values()];
      const previous = rows.find((r) => r.dedupKey === input.dedupKey);
      if (previous) return previous.digest === input.digest ? { kind: 'duplicate' as const, record: previous } : { kind: 'conflict' as const };
      const expired = rows.filter((r) => finished(r) && (r.closedAt ?? r.admittedAt) < now - IMESSAGE_INBOX_RETENTION_MS).slice(0, 512);
      for (const r of expired) await txn.delete(PREFIX + r.id);
      rows = rows.filter((r) => !expired.includes(r));
      if (rows.length >= MAX_ROWS || rows.filter(open).length >= MAX_OPEN) return { kind: 'capacity' as const };
      const sequence = ((await txn.get<number>(SEQ)) ?? 0) + 1;
      const record: IMessageInboxRecord = { ...input, id: `imsg-${IMESSAGE_UPDATE_BASE + sequence}`, updateId: IMESSAGE_UPDATE_BASE + sequence, admittedAt: now, state: 'admitted' };
      assertCurrent?.();
      await txn.put({ [PREFIX + record.id]: record, [SEQ]: sequence, [IMESSAGE_INBOX_DUE_KEY]: now + 250 });
      const existing = await txn.getAlarm();
      await armAlarm(txn, existing === null ? now + 250 : Math.min(existing, now + 250));
      return { kind: 'admitted' as const, record };
    });
  }
  recover(live: ReadonlySet<string>): void {
    this.storage.transactionSync(() => {
      const rows = this.records();
      for (const r of rows) if (r.state === 'running' && !live.has(r.attempt ?? '')) {
        r.state = 'interrupted'; r.closedReason = 'interrupted'; r.effectsUnconfirmed = true; r.closedAt = this.now(); clear(r);
        this.storage.kv.put(PREFIX + r.id, r);
      }
      this.storage.kv.put(IMESSAGE_INBOX_DUE_KEY, due(rows, this.now()));
    });
  }
  deferWake(delayMs: number): void {
    this.storage.transactionSync(() => { if (this.records().some((r) => r.state === 'admitted')) this.storage.kv.put(IMESSAGE_INBOX_DUE_KEY, this.now() + delayMs); });
  }
  /** Revocation closes queued and running work for a bridge; running turns stop at their next scope check. */
  revokeBridge(bridgeDoName: string): number {
    return this.storage.transactionSync(() => {
      let fenced = 0;
      for (const r of this.records()) {
        if (r.bridgeDoName !== bridgeDoName || !open(r)) continue;
        r.effectsUnconfirmed = r.state === 'running'; r.state = 'revoked'; r.closedReason = 'authority_revoked'; r.closedAt = this.now(); clear(r);
        this.storage.kv.put(PREFIX + r.id, r); fenced += 1;
      }
      this.storage.kv.put(IMESSAGE_INBOX_DUE_KEY, due(this.records(), this.now()));
      return fenced;
    });
  }
  claim(id: string, current: boolean): IMessageInboxRecord | null {
    return this.storage.transactionSync(() => {
      const r = this.storage.kv.get<IMessageInboxRecord>(PREFIX + id);
      if (!r || r.state !== 'admitted') return null;
      if (current) { r.state = 'running'; r.attempt = crypto.randomUUID(); r.deadline = this.now() + IMESSAGE_TURN_DEADLINE_MS; }
      else { r.state = 'revoked'; r.closedReason = 'authority_revoked'; r.effectsUnconfirmed = false; r.closedAt = this.now(); clear(r); }
      this.storage.kv.put(PREFIX + id, r); this.storage.kv.put(IMESSAGE_INBOX_DUE_KEY, due(this.records(), this.now()));
      return current ? structuredClone(r) : null;
    });
  }
  scope(record: IMessageInboxRecord, signal: AbortSignal): RunEffectScope {
    const admit = () => {
      const r = this.storage.kv.get<IMessageInboxRecord>(PREFIX + record.id);
      if (signal.aborted || !r || r.state !== 'running' || r.attempt !== record.attempt || r.digest !== record.digest || r.text !== record.text
        || r.revision !== record.revision || r.conversationRef !== record.conversationRef || this.now() >= (record.deadline ?? 0)) throw new ClosedRunError();
    };
    return { runId: record.id, attempt: record.attempt!, deadline: record.deadline!, signal, admit, commit: (work) => this.storage.transactionSync(() => { admit(); return work(); }) };
  }
  /** Called inside the scope's commit transaction together with the frozen reply. */
  closeFinal(record: IMessageInboxRecord): void {
    const r = this.storage.kv.get<IMessageInboxRecord>(PREFIX + record.id);
    if (!r || r.state !== 'running' || r.attempt !== record.attempt) throw new ClosedRunError();
    r.state = 'completed'; r.closedReason = 'final_committed'; r.closedAt = this.now(); clear(r);
    this.storage.kv.put(PREFIX + r.id, r);
  }
  settle(record: IMessageInboxRecord, completed: boolean): void {
    this.storage.transactionSync(() => {
      const r = this.storage.kv.get<IMessageInboxRecord>(PREFIX + record.id);
      if (!r || r.state !== 'running' || r.attempt !== record.attempt) return;
      r.state = completed ? 'completed' : 'interrupted'; r.closedAt = this.now(); clear(r);
      if (!completed) { r.closedReason = 'interrupted'; r.effectsUnconfirmed = true; }
      this.storage.kv.put(PREFIX + r.id, r); this.storage.kv.put(IMESSAGE_INBOX_DUE_KEY, due(this.records(), this.now()));
    });
  }
}
