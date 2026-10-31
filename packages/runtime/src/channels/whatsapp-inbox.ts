import { literalTextRedactor } from '@waldo/contracts';
import { carriesTopic } from '../memory/forget-guard';
import { WHATSAPP_INBOX_DUE_KEY } from '../scheduler/alarm-slot';
import { ClosedRunError, type RunEffectScope } from './run-effect-scope';
import { WA_UPDATE_BASE, WAMID_RETENTION_MS, type WaSyntheticUpdate } from './whatsapp-api';

// Owner-DO side of WhatsApp ingress: one durable row per owner message, written in the same synchronous step that claims its
// wamid and before Meta gets its 200. The alarm drains the rows one turn at a time, so a message that arrives while another
// turn runs waits as a row, not as an in-memory promise an eviction would lose. A row that was running when the object went
// away may have had effects: it closes as interrupted and is never run again. A row that never started runs on the next drain.

export { WHATSAPP_INBOX_DUE_KEY };
export const WHATSAPP_TURN_DEADLINE_MS = 15 * 60_000;
// While a turn runs and nothing waits behind it, the drain is woken this often, so a turn cut off by an eviction is found
// and its owner told within about a minute.
export const WHATSAPP_RUNNING_CHECK_MS = 60_000;
export const WHATSAPP_INBOX_MAX_OPEN = 256;
const MAX_ROWS = 4096;
const PREFIX = 'whatsapp:inbox-record:';
const SEQ = 'wa_seq';

export class WhatsAppInboxFull extends Error { constructor() { super('whatsapp inbox full'); } }

export type WhatsAppInboxRecord = {
  id: string; updateId: number; wamid: string; subject: string;
  /** The turn's input, built at admission; null once the row closes, so no closed row keeps the owner's words. */
  update: WaSyntheticUpdate | null;
  admittedAt: number;
  state: 'admitted' | 'running' | 'completed' | 'interrupted' | 'revoked';
  attempt?: string; deadline?: number; closedAt?: number;
};

const open = (r: WhatsAppInboxRecord) => r.state === 'admitted' || r.state === 'running';

// The owner's words an update carries: its text or caption, the quoted message of Waldo's it replies to, and a file's name.
const TEXT_PATHS = [['text'], ['caption'], ['reply_to_message', 'text'], ['document', 'file_name']] as const;
const texts = (update: WaSyntheticUpdate | null): string[] => {
  const message = (update as { message?: Record<string, unknown> } | null)?.message;
  if (!message) return [];
  return TEXT_PATHS.flatMap(path => {
    const value = path.reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], message);
    return typeof value === 'string' ? [value] : [];
  });
};
const redacted = (update: WaSyntheticUpdate, redact: (text: string) => string): WaSyntheticUpdate => {
  const copy = structuredClone(update) as { message?: Record<string, unknown> };
  for (const path of TEXT_PATHS) {
    const parent = path.slice(0, -1).reduce<Record<string, unknown> | undefined>((node, key) => node?.[key] as Record<string, unknown> | undefined, copy.message);
    const key = path.at(-1)!;
    if (typeof parent?.[key] === 'string') parent[key] = redact(parent[key] as string);
  }
  return copy;
};

export class WhatsAppOwnerInbox {
  constructor(private readonly storage: DurableObjectStorage, private readonly now: () => number = () => Date.now()) {}

  records(): WhatsAppInboxRecord[] {
    return [...this.storage.kv.list<WhatsAppInboxRecord>({ prefix: PREFIX })].map(([, r]) => r).sort((a, b) => a.updateId - b.updateId);
  }
  get(id: string): WhatsAppInboxRecord | null { return this.storage.kv.get<WhatsAppInboxRecord>(PREFIX + id) ?? null; }
  /** The last update sequence handed out; the next message's update_id is WA_UPDATE_BASE + seq() + 1. */
  seq(): number { return this.storage.kv.get<number>(SEQ) ?? 0; }
  /** The oldest message waiting for its turn. */
  next(): WhatsAppInboxRecord | null { return this.records().find(r => r.state === 'admitted') ?? null; }

  /**
   * Inside the caller's transactionSync, beside the wamid claims: one row per update, in order. Throws WhatsAppInboxFull when
   * the inbox cannot take them, which rolls the caller's claims back so Meta's retry is admitted later.
   */
  admit(updates: readonly Readonly<{ update: WaSyntheticUpdate; wamid: string }>[], subject: string): void {
    if (!updates.length) return;
    const now = this.now();
    let rows = this.records();
    for (const r of rows) if (!open(r) && (r.closedAt ?? r.admittedAt) < now - WAMID_RETENTION_MS) this.storage.kv.delete(PREFIX + r.id);
    rows = rows.filter(r => open(r) || (r.closedAt ?? r.admittedAt) >= now - WAMID_RETENTION_MS);
    if (rows.length + updates.length > MAX_ROWS || rows.filter(open).length + updates.length > WHATSAPP_INBOX_MAX_OPEN) throw new WhatsAppInboxFull();
    let seq = this.seq();
    for (const { update, wamid } of updates) {
      const updateId = Number((update as { update_id?: unknown }).update_id);
      if (!Number.isSafeInteger(updateId) || updateId <= WA_UPDATE_BASE + seq) throw new Error('whatsapp update out of sequence');
      seq = updateId - WA_UPDATE_BASE;
      const record: WhatsAppInboxRecord = { id: `wa-${updateId}`, updateId, wamid, subject, update, admittedAt: now, state: 'admitted' };
      this.storage.kv.put(PREFIX + record.id, record);
    }
    this.storage.kv.put(SEQ, seq);
    this.refreshDue();
  }

  /**
   * Claims the oldest waiting row in one step: running, with a new attempt and its deadline. Null only when no row waits, so a
   * drain that stops on null can never retry a row it could not claim.
   */
  claimNext(deadline: number): WhatsAppInboxRecord | null {
    return this.storage.transactionSync(() => {
      const r = this.next();
      if (!r) return null;
      r.state = 'running'; r.attempt = crypto.randomUUID(); r.deadline = deadline;
      this.storage.kv.put(PREFIX + r.id, r);
      this.refreshDue();
      return structuredClone(r);
    });
  }

  /** The run scope of a claimed row. `authority` says whether the row's sender is still this owner's bound, linked number. */
  scope(record: WhatsAppInboxRecord, signal: AbortSignal, authority: () => boolean): RunEffectScope {
    const admit = () => {
      const r = this.get(record.id);
      if (signal.aborted || !r || r.state !== 'running' || r.attempt !== record.attempt || this.now() >= (record.deadline ?? 0) || !authority()) throw new ClosedRunError();
    };
    return {
      runId: record.id, attempt: record.attempt!, deadline: record.deadline!, signal, admit,
      commit: work => this.storage.transactionSync(() => {
        admit();
        const result = work();
        if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('run commit must be synchronous');
        return result;
      }),
    };
  }

  /** After a drain that failed: the waiting rows wake again after `delayMs`, not at the floor. */
  deferWake(delayMs: number): void {
    this.storage.transactionSync(() => { if (this.next()) this.storage.kv.put(WHATSAPP_INBOX_DUE_KEY, this.now() + delayMs); });
  }

  /** Closes the claimed row. True when this call closed it as interrupted, so the caller owes the owner a notice. */
  settle(record: WhatsAppInboxRecord, completed: boolean): boolean {
    return this.storage.transactionSync(() => {
      const r = this.get(record.id);
      if (!r || r.state !== 'running' || r.attempt !== record.attempt) return false;
      this.close(r, completed ? 'completed' : 'interrupted');
      this.refreshDue();
      return !completed;
    });
  }

  /**
   * Inside the caller's transactionSync: every running row whose attempt is not live was cut off (an eviction, a deploy) and
   * may have had effects, so it closes as interrupted. Returns those rows for their notices, which the caller sends after the
   * transaction commits.
   */
  recover(live: ReadonlySet<string>): WhatsAppInboxRecord[] {
    const cut = this.records().filter(r => r.state === 'running' && !live.has(r.attempt ?? ''));
    for (const r of cut) this.close(r, 'interrupted');
    this.refreshDue();
    return cut;
  }

  /** Inside the caller's transactionSync, when the number is unlinked or moves: nothing queued for it runs, and a running turn stops at its next scope check. */
  revokeOpen(): number {
    const rows = this.records().filter(open);
    for (const r of rows) this.close(r, 'revoked');
    this.refreshDue();
    return rows.length;
  }

  /**
   * Literal owner forget: queued rows are redacted before they run. A running row is left alone (it is usually the forget
   * request itself) and its text goes when it closes; closed rows hold none. Returns the rows rewritten and the not-running
   * rows still holding a forgotten literal.
   */
  forget(redact: (text: string) => string, holds: (text: string) => boolean): Readonly<{ rewritten: number; remaining: number }> {
    let rewritten = 0;
    for (const r of this.records()) {
      if (r.state !== 'admitted' || !r.update || !texts(r.update).some(holds)) continue;
      r.update = redacted(r.update, redact);
      this.storage.kv.put(PREFIX + r.id, r); rewritten += 1;
    }
    return { rewritten, remaining: this.records().filter(r => r.state !== 'running' && texts(r.update).some(holds)).length };
  }

  private close(r: WhatsAppInboxRecord, state: 'completed' | 'interrupted' | 'revoked'): void {
    r.state = state; r.closedAt = this.now(); r.update = null;
    this.storage.kv.put(PREFIX + r.id, r);
  }
  private refreshDue(): void {
    const rows = this.records();
    const due = rows.some(r => r.state === 'admitted') ? this.now() + 250 : rows.some(r => r.state === 'running') ? this.now() + WHATSAPP_RUNNING_CHECK_MS : null;
    if (due === null) this.storage.kv.delete(WHATSAPP_INBOX_DUE_KEY); else this.storage.kv.put(WHATSAPP_INBOX_DUE_KEY, due);
  }
}

/** Literal owner forget for the queued WhatsApp messages, in one synchronous step: the forget purge's store for this inbox. */
export const redactWhatsAppInboxEntries = (storage: DurableObjectStorage, texts: readonly string[], marker: string): Readonly<{ rewritten: number; remaining: number }> => {
  const needles = [...new Set(texts.map(text => text.trim()).filter(Boolean))];
  if (!needles.length) return { rewritten: 0, remaining: 0 };
  const redact = literalTextRedactor(needles, marker), holds = (text: string) => needles.some(needle => carriesTopic(text, needle));
  return storage.transactionSync(() => new WhatsAppOwnerInbox(storage).forget(redact, holds));
};
