import { iMessageResultSchema, type IMessageResult, type IMessageStandardReaction } from '@waldo/contracts';
import { IMessageOwnerInbox, type IMessageInboxRecord } from './owner-inbox';

// Owner-DO frozen reply outbox. The reply text, exact target (via binding digest + revision) and
// stable commandId are frozen in the same transaction that closes the owner turn. Handoff to the
// bridge mailbox is retried with identical bytes/identity; terminal results are recorded once.
// A reply is never regenerated and never gets a new logical id. A settled record keeps its identity and result
// but not its text: the reply bytes are no longer needed once the bridge reported a terminal outcome.

export const IMESSAGE_OUTBOX_DUE_KEY = 'imessage_final_outbox_due_v1';
// The order records were frozen in. frozenAt cannot order them: the Workers clock stands still between I/O.
const SEQ_KEY = 'imessage_final_outbox_seq_v1';
const PREFIX = 'imessage:outbox-record:';
const RETRY_MS = 5_000;
/** A reply the bridge could not take because its one mailbox slot was busy tries again this soon. */
export const IMESSAGE_BUSY_RETRY_MS = 1_000;
// A progress note is sent once, while its turn runs, and never after its reply. It wakes nothing: one left frozen by an
// evicted turn is settled may_have_completed at the next drain.
const PROGRESS = 'progress:';
export const isProgressNote = (replyRef: string) => replyRef.startsWith(PROGRESS);
const UNBOUND = { bridgeId: 'unbound', accountId: 'unbound', chatGuid: 'unbound' };
const notStarted = (commandId: string, reason: string): IMessageResult => ({ version: 1, commandId, target: UNBOUND, state: 'rejected', disposition: 'not_started', reason });
const mayHaveSent = (commandId: string, reason: string): IMessageResult => ({ version: 1, commandId, target: UNBOUND, state: 'unknown', disposition: 'may_have_completed', reason });
/** Telegram's final-outbox bound: only settled records are evicted, oldest first; live replies are never dropped. */
export const IMESSAGE_OUTBOX_MAX_RECORDS = 256;

// An exact message in the bound chat, for a tapback or a reply threaded onto it. The bridge refuses one whose chat is not the binding's.
export type IMessageMessageTarget = Readonly<{ chatGuid: string; messageGuid: string; partIndex: number }>;
export type IMessageTapback = IMessageMessageTarget & Readonly<{ type: IMessageStandardReaction }>;
export type IMessageOutboxRecord = {
  replyRef: string; commandId: string; text: string; bridgeDoName: string; ownerDoName: string; revision: string; bindingDigest: string;
  /** The sender this reply answers; selects that sender's own authority on a shared bridge. Absent on older records. */
  subject?: string;
  /** Set on a tapback, whose text is empty. */
  reaction?: IMessageTapback;
  /** Set on a turn's reply: the owner's message it answers, which the bridge threads it onto where the host verified replies. */
  replyTo?: IMessageMessageTarget;
  frozenAt: number; state: 'frozen' | 'queued' | 'settled'; nextAttemptAt: number; attempts: number;
  result?: IMessageResult; conflicts?: number;
  /** Its place in the order this owner's records were frozen. Absent on records frozen before the order was kept. */
  seq?: number;
};

// Where a message goes: the bridge, the owner object, the sender and the exact binding the bridge must still hold.
export type IMessageProactiveTarget = Readonly<{ bridgeDoName: string; ownerDoName: string; subject: string; revision: string; bindingDigest: string }>;
export const targetOf = (record: IMessageInboxRecord): IMessageProactiveTarget =>
  ({ bridgeDoName: record.bridgeDoName, ownerDoName: record.ownerDoName, subject: record.binding.subject, revision: record.revision, bindingDigest: record.bindingDigest });

// A turn's reply sent once more, unthreaded, after the host refused the threaded send before sending anything.
const PLAIN = 'plain:';

/** Whether a record is one an owner turn sent under its own name: its reply (or that reply resent plain), failure notice, console or connect link, tapback or a progress note. */
export const sentByTurn = (replyRef: string, turnId: string) =>
  replyRef === `reply:${turnId}` || replyRef === `${PLAIN}${turnId}` || replyRef === `failure:${turnId}` || replyRef === `console:${turnId}` || replyRef === `connect:${turnId}` || replyRef === `react:${turnId}`
  || replyRef.startsWith(`${PROGRESS}${turnId}:`);

export class IMessageFinalOutbox {
  constructor(private readonly storage: DurableObjectStorage, private readonly now = Date.now) {}
  records(): IMessageOutboxRecord[] { return [...this.storage.kv.list<IMessageOutboxRecord>({ prefix: PREFIX })].map(([, r]) => r).sort((a, b) => a.frozenAt - b.frozenAt); }
  get(replyRef: string): IMessageOutboxRecord | null { return this.storage.kv.get<IMessageOutboxRecord>(PREFIX + replyRef) ?? null; }

  /**
   * Synchronous: must run inside the run scope's commit transaction. Identical refreeze is a no-op. A console or connect link
   * sent for the same inbound message is its own record, under its own commandId, so the reply still sends after it. The reply
   * carries the owner's message it answers as its thread target only where a thread helps (see threadHelps); nothing the model
   * chose names it.
   */
  freeze(record: IMessageInboxRecord, text: string, kind: 'reply' | 'console' | 'connect' = 'reply'): IMessageOutboxRecord {
    const ref = kind === 'reply' && this.threadHelps(record) ? record.messageRef : undefined;
    return this.put(`${kind}:${record.id}`, { ...targetOf(record), commandId: record.commandId }, text,
      ref ? { replyTo: { chatGuid: record.binding.chatGuid, messageGuid: ref.messageGuid, partIndex: ref.partIndex } } : {});
  }

  /**
   * A copy of a message Waldo started (a reminder, a day card, a follow-up), to the sender the owner last wrote from. Its id
   * names the app message it copies, so copying that message again freezes the same record and command; the bridge
   * re-checks that sender's authority before it sends, exactly as for a reply.
   */
  freezeProactive(id: string, commandId: string, target: IMessageProactiveTarget, text: string): IMessageOutboxRecord {
    return this.put(`proactive:${id}`, { ...target, commandId }, text);
  }

  /**
   * Progress note `index` of a running turn, to the sender that turn answers. Its commandId is fixed by the turn and the
   * index, so freezing it again freezes the same record. Synchronous: it runs inside the turn's run-scope commit.
   */
  freezeProgress(record: IMessageInboxRecord, index: 1 | 2, text: string): IMessageOutboxRecord {
    return this.put(`${PROGRESS}${record.id}:${index}`, { ...targetOf(record), commandId: `wpn${index}_${record.commandId}` }, text);
  }
  /**
   * The one fixed notice for a turn that closed without its reply. Its id and commandId are fixed by the turn, so closing the
   * same turn again freezes the same record. Synchronous: it runs inside the transaction that closes the turn.
   */
  freezeFailure(record: IMessageInboxRecord, text: string): IMessageOutboxRecord {
    return this.put(`failure:${record.id}`, { ...targetOf(record), commandId: `wfn_${record.commandId}` }, text);
  }
  /**
   * A tapback on the owner's message this record's turn answers, frozen under the turn's scope before any send. Its commandId
   * is fixed by the turn and the reaction, so freezing it again freezes the same record, and a different one is a conflict.
   */
  freezeReaction(record: IMessageInboxRecord, type: IMessageStandardReaction): IMessageOutboxRecord {
    if (!record.messageRef) throw new Error('imessage_reaction_untargeted');
    return this.put(`react:${record.id}`, { ...targetOf(record), commandId: `wrx_${type}_${record.commandId}` }, '',
      { reaction: { chatGuid: record.binding.chatGuid, messageGuid: record.messageRef.messageGuid, partIndex: record.messageRef.partIndex, type } });
  }
  /**
   * A reply threads onto the owner's message only where a plain one could read as answering something else, or where the
   * owner threaded first: they wrote this message as a reply themselves, or wrote again in this chat before Waldo answered.
   * A reply to the owner's latest message, written plainly, goes out plain. Read once, when the reply freezes.
   */
  private threadHelps(record: IMessageInboxRecord): boolean {
    return record.ownerThreaded === true
      || new IMessageOwnerInbox(this.storage).records().some((r) => r.updateId > record.updateId && r.conversationRef === record.conversationRef);
  }
  /** Whether a message to this bridge, not a note, is frozen and still waiting to be handed over. A tapback waits for no note. */
  messageWaiting(bridgeDoName: string): boolean {
    return this.records().some((r) => r.state === 'frozen' && !isProgressNote(r.replyRef) && !r.reaction && r.bridgeDoName === bridgeDoName);
  }
  /** When Waldo last put a message on this chat's way: the newest record not proved unsent. */
  lastSentAt(): number | null {
    const sent = this.records().filter((r) => r.result?.state !== 'rejected');
    return sent.length ? Math.max(...sent.map((r) => r.frozenAt)) : null;
  }
  /**
   * Settles the progress notes still frozen: every one, or only the given turn's. A note's handoff starts as it freezes, so
   * the bridge may hold a frozen one: it settles may_have_completed, unless `refused` says the bridge did not take it.
   */
  dropProgress(reason: string, recordId?: string, refused = false): void {
    for (const r of this.records()) {
      if (r.state !== 'frozen' || !isProgressNote(r.replyRef) || (recordId !== undefined && !r.replyRef.startsWith(`${PROGRESS}${recordId}:`))) continue;
      this.update(r.replyRef, (row) => { if (row.state === 'frozen') { row.state = 'settled'; row.text = ''; row.result = (refused ? notStarted : mayHaveSent)(row.commandId, reason); } });
    }
  }

  private put(replyRef: string, target: IMessageProactiveTarget & Readonly<{ commandId: string }>, text: string,
    { reaction, replyTo, frozenAt = this.now() }: Readonly<{ reaction?: IMessageTapback; replyTo?: IMessageMessageTarget; frozenAt?: number }> = {}): IMessageOutboxRecord {
    const prior = this.get(replyRef);
    if (prior) {
      // A settled record no longer holds its text; its stable commandId is the identity check.
      if (prior.commandId !== target.commandId || (prior.state !== 'settled' && prior.text !== text)) throw new Error('imessage_reply_conflict');
      return prior;
    }
    const rows = this.records();
    if (rows.length >= IMESSAGE_OUTBOX_MAX_RECORDS) {
      const evict = rows.find((r) => r.state === 'settled');
      if (!evict) throw new Error('imessage_outbox_capacity');
      this.storage.kv.delete(PREFIX + evict.replyRef);
    }
    const seq = (this.storage.kv.get<number>(SEQ_KEY) ?? 0) + 1;
    this.storage.kv.put(SEQ_KEY, seq);
    const row: IMessageOutboxRecord = { replyRef, commandId: target.commandId, text, bridgeDoName: target.bridgeDoName, ownerDoName: target.ownerDoName, subject: target.subject,
      revision: target.revision, bindingDigest: target.bindingDigest, frozenAt, state: 'frozen', nextAttemptAt: this.now(), attempts: 0, seq, ...(reaction ? { reaction } : {}), ...(replyTo ? { replyTo } : {}) };
    this.storage.kv.put(PREFIX + replyRef, row);
    this.storage.kv.put(IMESSAGE_OUTBOX_DUE_KEY, this.dueAt());
    return row;
  }
  // A tapback goes behind the messages due with it: the bridge holds one command at a time, and a reply never waits on one.
  due(): IMessageOutboxRecord[] {
    return this.records().filter((r) => r.state === 'frozen' && !isProgressNote(r.replyRef) && r.nextAttemptAt <= this.now()).sort((a, b) => Number(!!a.reaction) - Number(!!b.reaction));
  }
  markQueued(replyRef: string) { this.update(replyRef, (r) => { if (r.state === 'frozen') { r.state = 'queued'; r.attempts += 1; } }); }
  retryLater(replyRef: string, maxAgeMs: number, delayMs = RETRY_MS) {
    this.update(replyRef, (r) => {
      if (r.state !== 'frozen') return;
      r.attempts += 1;
      // Bounded: a reply the bridge never accepted is proved not_started, not silently resent forever.
      if (this.now() - r.frozenAt >= maxAgeMs) { r.state = 'settled'; r.text = ''; r.result = notStarted(r.commandId, 'bridge_unavailable'); }
      else r.nextAttemptAt = this.now() + delayMs;
    });
  }
  /**
   * First terminal result is authoritative; a different later result is counted, never applied. A threaded reply the host
   * proved it never sent (rejected, not_started) is frozen once more, unthreaded, in the same transaction: a refused thread
   * never costs the owner their answer. Its record and command are keyed to the turn's, so a repeated result freezes nothing new,
   * and it keeps its reply's place ahead of later turns. An uncertain result is never resent: it may have been delivered.
   */
  settle(replyRef: string, commandId: string, input: unknown): boolean {
    const result = iMessageResultSchema.parse(input);
    if (result.state === 'queued' || result.state === 'started' || result.commandId !== commandId) throw new Error('imessage_result_invalid');
    let known = false;
    this.update(replyRef, (r) => {
      if (r.commandId !== commandId) return;
      known = true;
      if (r.state === 'settled') { if (JSON.stringify(r.result) !== JSON.stringify(result)) r.conflicts = (r.conflicts ?? 0) + 1; return; }
      // A command conflict proves nothing about the other delivery under that command, which may have gone out.
      if (r.replyTo && r.text && r.subject !== undefined && r.replyRef.startsWith('reply:') && result.state === 'rejected' && result.disposition === 'not_started'
        && result.reason !== 'command_conflict') {
        // A full outbox of live replies has no room: the refusal is still recorded, and the answer stays unsent.
        try { this.put(`${PLAIN}${r.replyRef.slice('reply:'.length)}`, { ...r, subject: r.subject, commandId: `wpl_${r.commandId}` }, r.text, { frozenAt: r.frozenAt }); }
        catch (error) {
          if (!(error instanceof Error) || error.message !== 'imessage_outbox_capacity') throw error;
          console.error(JSON.stringify({ hop: 'imessage_plain_resend', ok: false, code: 'outbox_capacity' }));
        }
      }
      r.state = 'settled'; r.result = result; r.text = '';
    });
    return known;
  }
  dueAt(): number | null {
    const open = this.records().filter((r) => r.state === 'frozen' && !isProgressNote(r.replyRef));
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
      if (r.state === 'frozen') { r.state = 'settled'; r.text = ''; r.result = notStarted(r.commandId, 'owner_forget'); }
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
