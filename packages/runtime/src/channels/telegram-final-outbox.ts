import { TelegramRejection } from './telegram-api';

export const FINAL_OUTBOX_KEY = 'telegram_final_outbox_v1';
export const FINAL_OUTBOX_DUE_KEY = 'telegram_final_outbox_due_v1';
const MAX_RECORDS = 256;
const MAX_ATTEMPTS = 3;
export type FinalPayload = Readonly<{ chat_id: number; text: string; parse_mode?: 'HTML' }>;
export type FinalRecord = {
  id: string; trace: string; payload: FinalPayload; digest: string;
  receiptUrls?: string[]; ownerSubject: string; doName: string; status: 'pending' | 'attempting' | 'delivered' | 'quarantined' | 'blocked';
  dueAt: number; createdAt: number; attempts: number; settled?: boolean; messageId?: number; reason?: string;
  reaction?: { message_id: number; emoji: string };
  reminder?: { id: string; occurrence: number; runId: string; schedulerRunId: string | null; once: boolean };
};
type Kv = Pick<DurableObjectStorage['kv'], 'get' | 'put'>;
const digest = async (payload: unknown) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload))))].map(x => x.toString(16).padStart(2, '0')).join('');

export class TelegramFinalOutbox {
  constructor(private readonly kv: Kv, private readonly now: () => number = Date.now, private readonly persist?: (rows: FinalRecord[], due: number | null) => Promise<void>) {}
  records(): FinalRecord[] { return this.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY) ?? []; }
  private async save(rows: FinalRecord[]): Promise<void> {
    const due = rows.filter(r => r.status === 'pending' || r.status === 'attempting' || !r.settled).map(r => r.dueAt);
    const bound = due.length ? Math.min(...due) : null;
    if (this.persist) await this.persist(rows, bound);
    else { this.kv.put(FINAL_OUTBOX_KEY, rows); this.kv.put(FINAL_OUTBOX_DUE_KEY, bound); }
  }
  async enqueue(input: Omit<FinalRecord, 'digest' | 'status' | 'dueAt' | 'createdAt' | 'attempts'>): Promise<void> {
    const hash = await digest(input);
    let rows = this.records();
    // After 24h retain content-free uncertainty metadata, never resend automatically.
    rows = rows.map(r => r.status === 'quarantined' && r.settled && this.now() - r.createdAt > 86400000 ? { ...r, payload: { chat_id: r.payload.chat_id, text: '' }, receiptUrls: [], reason: 'expired_ambiguous_metadata' } : r);
    const known = rows.find(r => r.id === input.id);
    if (known) {
      if (known.digest !== hash) throw new Error('final outbox identity conflict');
      return;
    }
    // Evict only terminal records. Never silently discard a pending/ambiguous final.
    if (rows.length >= MAX_RECORDS) {
      const index = rows.findIndex(r => (r.status === 'delivered' || r.status === 'blocked' || r.reason === 'expired_ambiguous_metadata') && r.settled);
      if (index < 0) throw new Error('final outbox capacity');
      rows = rows.filter((_, i) => i !== index);
    }
    rows.push({ ...input, payload: { ...input.payload }, digest: hash, status: 'pending', dueAt: this.now() + 250, createdAt: this.now(), attempts: 0 });
    await this.save(rows);
  }
  async drain(options: {
    allowed(record: FinalRecord): Promise<boolean>;
    send(payload: FinalPayload): Promise<unknown>;
    settled(record: FinalRecord): Promise<void>;
  }): Promise<void> {
    const rows = this.records();
    // attempting persisted before network is an uncertainty boundary after restart.
    for (const row of rows) if (row.status === 'attempting') {
      row.status = 'quarantined'; row.reason = 'restart_during_send';
    }
    await this.save(rows);
    // Reconcile an ACK persisted before lifecycle bookkeeping without sending again.
    for (const row of rows) if (row.status !== 'pending' && !row.settled) {
      await options.settled(row); row.settled = true; await this.save(rows);
    }
    const row = rows.find(r => r.status === 'pending' && r.dueAt <= this.now());
    if (!row) return;
    let allowed = false;
    try { allowed = await options.allowed(row); } catch { /* fail closed */ }
    if (!allowed) { row.status = 'blocked'; row.reason = 'owner_binding'; await this.save(rows); await options.settled(row); row.settled = true; await this.save(rows); return; }
    row.status = 'attempting'; row.attempts += 1;
    await this.save(rows);
    try {
      const result = await options.send({ ...row.payload });
      const ack = result as { message_id?: unknown; chat?: { id?: unknown } } | undefined;
      const messageId = ack?.message_id;
      if (!Number.isSafeInteger(messageId) || (messageId as number) <= 0 || ack?.chat?.id !== row.payload.chat_id) {
        row.status = result === undefined ? 'blocked' : 'quarantined'; row.reason = result === undefined ? 'egress_blocked' : 'invalid_ack';
      } else { row.status = 'delivered'; row.messageId = messageId as number; }
    } catch (error) {
      if (error instanceof TelegramRejection && error.retryable && row.attempts < MAX_ATTEMPTS) {
        row.status = 'pending'; row.reason = 'provider_rejected';
        row.dueAt = this.now() + Math.max(30_000 * row.attempts, (typeof error.retryAfter === 'number' && Number.isFinite(error.retryAfter) && error.retryAfter >= 0 ? Math.min(3600, error.retryAfter) : 0) * 1_000);
      } else {
        row.status = 'quarantined'; row.reason = error instanceof TelegramRejection ? 'provider_rejected_terminal' : 'send_unknown';
      }
    }
    await this.save(rows);
    await options.settled(row);
    if (row.status !== 'pending') { row.settled = true; await this.save(rows); }
  }
}
