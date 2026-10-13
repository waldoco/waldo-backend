import { iMessageResultSchema, type IMessageResult } from '@waldo/contracts';
import type { IMessageInboxRecord } from './owner-inbox';

// Owner-DO frozen reply outbox. The reply text, exact target (via binding digest + revision) and
// stable commandId are frozen in the same transaction that closes the owner turn. Handoff to the
// bridge mailbox is retried with identical bytes/identity; terminal results are recorded once.
// A reply is never regenerated and never gets a new logical id. A settled record keeps its identity and result
// but not its text: the reply bytes are no longer needed once the bridge reported a terminal outcome.

export const IMESSAGE_OUTBOX_DUE_KEY = 'imessage_final_outbox_due_v1';
const PREFIX = 'imessage:outbox-record:';
const RETRY_MS = 5_000;
/** Telegram's final-outbox bound: only settled records are evicted, oldest first; live replies are never dropped. */
export const IMESSAGE_OUTBOX_MAX_RECORDS = 256;

export type IMessageOutboxRecord = {
  replyRef: string; commandId: string; text: string; bridgeDoName: string; ownerDoName: string; revision: string; bindingDigest: string;
  frozenAt: number; state: 'frozen' | 'queued' | 'settled'; nextAttemptAt: number; attempts: number;
  result?: IMessageResult; conflicts?: number;
};

export class IMessageFinalOutbox {
  constructor(private readonly storage: DurableObjectStorage, private readonly now = Date.now) {}
  records(): IMessageOutboxRecord[] { return [...this.storage.kv.list<IMessageOutboxRecord>({ prefix: PREFIX })].map(([, r]) => r).sort((a, b) => a.frozenAt - b.frozenAt); }
  get(replyRef: string): IMessageOutboxRecord | null { return this.storage.kv.get<IMessageOutboxRecord>(PREFIX + replyRef) ?? null; }

  /** Synchronous: must run inside the run scope's commit transaction. Identical refreeze is a no-op. */
  freeze(record: IMessageInboxRecord, text: string): IMessageOutboxRecord {
    const replyRef = `reply:${record.id}`, prior = this.get(replyRef);
    if (prior) {
      // A settled record no longer holds its text; its stable commandId is the identity check.
      if (prior.commandId !== record.commandId || (prior.state !== 'settled' && prior.text !== text)) throw new Error('imessage_reply_conflict');
      return prior;
    }
    const rows = this.records();
    if (rows.length >= IMESSAGE_OUTBOX_MAX_RECORDS) {
      const evict = rows.find((r) => r.state === 'settled');
      if (!evict) throw new Error('imessage_outbox_capacity');
      this.storage.kv.delete(PREFIX + evict.replyRef);
    }
    const row: IMessageOutboxRecord = { replyRef, commandId: record.commandId, text, bridgeDoName: record.bridgeDoName, ownerDoName: record.ownerDoName,
      revision: record.revision, bindingDigest: record.bindingDigest, frozenAt: this.now(), state: 'frozen', nextAttemptAt: this.now(), attempts: 0 };
    this.storage.kv.put(PREFIX + replyRef, row);
    this.storage.kv.put(IMESSAGE_OUTBOX_DUE_KEY, this.dueAt());
    return row;
  }
  due(): IMessageOutboxRecord[] { return this.records().filter((r) => r.state === 'frozen' && r.nextAttemptAt <= this.now()); }
  markQueued(replyRef: string) { this.update(replyRef, (r) => { if (r.state === 'frozen') { r.state = 'queued'; r.attempts += 1; } }); }
  retryLater(replyRef: string, maxAgeMs: number) {
    this.update(replyRef, (r) => {
      if (r.state !== 'frozen') return;
      r.attempts += 1;
      // Bounded: a reply the bridge never accepted is proved not_started, not silently resent forever.
      if (this.now() - r.frozenAt >= maxAgeMs) { r.state = 'settled'; r.text = ''; r.result = { version: 1, commandId: r.commandId, target: { bridgeId: 'unbound', accountId: 'unbound', chatGuid: 'unbound' }, state: 'rejected', disposition: 'not_started', reason: 'bridge_unavailable' }; }
      else r.nextAttemptAt = this.now() + RETRY_MS;
    });
  }
  /** First terminal result is authoritative; a different later result is counted, never applied. */
  settle(replyRef: string, commandId: string, input: unknown): boolean {
    const result = iMessageResultSchema.parse(input);
    if (result.state === 'queued' || result.state === 'started' || result.commandId !== commandId) throw new Error('imessage_result_invalid');
    let known = false;
    this.update(replyRef, (r) => {
      if (r.commandId !== commandId) return;
      known = true;
      if (r.state === 'settled') { if (JSON.stringify(r.result) !== JSON.stringify(result)) r.conflicts = (r.conflicts ?? 0) + 1; return; }
      r.state = 'settled'; r.result = result; r.text = '';
    });
    return known;
  }
  dueAt(): number | null {
    const open = this.records().filter((r) => r.state === 'frozen');
    return open.length ? Math.max(this.now() + 250, Math.min(...open.map((r) => r.nextAttemptAt))) : null;
  }
  /**
   * Literal owner forget. A frozen reply (not yet handed to the bridge) that holds a forgotten literal is
   * cancelled as proved not_started; a queued reply's owner copy is redacted (the bridge copy is that
   * custody's own, documented gap); settled records hold no text. Returns owner-side rows still holding it.
   */
  forget(redact: (text: string) => string, holds: (text: string) => boolean): Readonly<{ rewritten: number; remaining: number }> {
    let rewritten = 0;
    for (const r of this.records()) {
      if (!r.text || !holds(r.text)) continue;
      if (r.state === 'frozen') { r.state = 'settled'; r.text = ''; r.result = { version: 1, commandId: r.commandId, target: { bridgeId: 'unbound', accountId: 'unbound', chatGuid: 'unbound' }, state: 'rejected', disposition: 'not_started', reason: 'owner_forget' }; }
      else r.text = r.state === 'settled' ? '' : redact(r.text);
      this.storage.kv.put(PREFIX + r.replyRef, r); rewritten += 1;
    }
    if (rewritten) this.storage.kv.put(IMESSAGE_OUTBOX_DUE_KEY, this.dueAt());
    return { rewritten, remaining: this.records().filter((r) => r.text && holds(r.text)).length };
  }
  private update(replyRef: string, mutate: (r: IMessageOutboxRecord) => void) {
    this.storage.transactionSync(() => {
      const r = this.get(replyRef);
      if (!r) return;
      mutate(r);
      this.storage.kv.put(PREFIX + replyRef, r);
      this.storage.kv.put(IMESSAGE_OUTBOX_DUE_KEY, this.dueAt());
    });
  }
}
