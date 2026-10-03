import { TelegramRejection } from './telegram-api';

export const FINAL_OUTBOX_KEY = 'telegram_final_outbox_v1';
export const FINAL_OUTBOX_DUE_KEY = 'telegram_final_outbox_due_v1';
const MAX_RECORDS = 256;
const MAX_ATTEMPTS = 3;
export type FinalPayload = Readonly<{ chat_id: number; text: string; parse_mode?: 'HTML' }>;
export type HeartbeatReceipt = { id: string; occurrence: number; schedulerRunId: string; runId?: string; loops: { id: string; due: string }[] };
export type MailFollowupReceipt = { loopId: string; due: string; sourceRef: string; timezone: string; messageId: string };
export type FinalRecord = {
  id: string; trace: string; payload: FinalPayload; digest: string;
  expiresAt?: number; bot?: string;
  receiptUrls?: string[]; ownerSubject: string; doName: string; status: 'pending' | 'attempting' | 'delivered' | 'quarantined' | 'blocked';
  dueAt: number; createdAt: number; attempts: number; settled?: boolean; messageId?: number; deliveredAt?: number; reason?: string;
  inbox?: { id: string; runId: string; attempt: string };
  heartbeat?: HeartbeatReceipt;
  mailFollowup?: MailFollowupReceipt;
  reaction?: { message_id: number; emoji: string };
  reminder?: { id: string; occurrence: number; runId: string; schedulerRunId: string | null; once: boolean };
};
type Kv = Pick<DurableObjectStorage['kv'], 'get' | 'put'>;
const digest = async (payload: unknown) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload))))].map(x => x.toString(16).padStart(2, '0')).join('');

export class TelegramFinalOutbox {
  constructor(private readonly kv: Kv, private readonly now: () => number = Date.now, private readonly persist?: (rows: FinalRecord[], due: number | null) => Promise<void>) {}
  records(): FinalRecord[] { return this.kv.get<FinalRecord[]>(FINAL_OUTBOX_KEY) ?? []; }
  private due(rows: FinalRecord[]): number | null {
    const due = rows.flatMap(r => r.status === 'pending' || r.status === 'attempting' || !r.settled ? [r.dueAt] : r.payload.text ? [r.createdAt + 86400000] : []);
    return due.length ? Math.min(...due) : null;
  }
  private async save(rows: FinalRecord[]): Promise<void> {
    const bound = this.due(rows);
    if (this.persist) await this.persist(rows, bound);
    else { this.kv.put(FINAL_OUTBOX_KEY, rows); this.kv.put(FINAL_OUTBOX_DUE_KEY, bound); }
  }
  async maintain(): Promise<void> {
    const rows = this.records().map(r => r.settled && r.status !== 'pending' && this.now() >= r.createdAt + 86400000
      ? { ...r, payload: { chat_id: r.payload.chat_id, text: '' }, receiptUrls: [], reason: r.status === 'quarantined' ? 'expired_ambiguous_metadata' : r.reason } : r);
    await this.save(rows);
  }
  async enqueue(input: Omit<FinalRecord, 'digest' | 'status' | 'dueAt' | 'createdAt' | 'attempts'>): Promise<void> {
    const hash = await digest(input);
    let rows = this.records();
    await this.maintain(); rows = this.records();
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
  // Hash before entering the caller-owned atomic fence. The caller commits inbox closure
  // in the same synchronous transaction as these outbox writes, then rearms the shared alarm.
  async enqueueFenced(input: Omit<FinalRecord, 'digest' | 'status' | 'dueAt' | 'createdAt' | 'attempts'>,
    commit: (work: () => void) => void): Promise<void> {
    const hash = await digest(input);
    commit(() => {
      let rows = this.records();
      const known = rows.find(r => r.id === input.id);
      if (known) { if (known.digest !== hash) throw new Error('final outbox identity conflict'); return; }
      if (rows.length >= MAX_RECORDS) {
        const index = rows.findIndex(r => (r.status === 'delivered' || r.status === 'blocked' || r.reason === 'expired_ambiguous_metadata') && r.settled);
        if (index < 0) throw new Error('final outbox capacity');
        rows = rows.filter((_, i) => i !== index);
      }
      rows.push({ ...input, payload: { ...input.payload }, digest: hash, status: 'pending', dueAt: this.now() + 250, createdAt: this.now(), attempts: 0 });
      this.kv.put(FINAL_OUTBOX_KEY, rows);
      this.kv.put(FINAL_OUTBOX_DUE_KEY, this.due(rows));
    });
  }
  // Only a known pre-send denial can re-arm the same frozen mail intent. Ambiguous
  // attempts remain quarantined and are never retried through this path.
  async retryBlockedMailFollowup(id: string): Promise<boolean> {
    const rows = this.records();
    const row = rows.find(record => record.id === id);
    if (!row?.mailFollowup || row.status !== 'blocked' || !['owner_binding', 'egress_blocked'].includes(row.reason ?? '')) return false;
    row.status = 'pending'; row.dueAt = this.now() + 250; row.settled = false;
    await this.save(rows); return true;
  }
  async drain(options: {
    allowed(record: FinalRecord): Promise<boolean>;
    send(payload: FinalPayload): Promise<unknown>;
    defer?(record: FinalRecord): Promise<number | null>;
    settled(record: FinalRecord): Promise<void>;
  }): Promise<void> {
    await this.maintain();
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
    // A quiet-hours hold keeps the frozen intent pending; it is not a rejection.
    const deferred = await options.defer?.(row);
    if (deferred !== undefined && deferred !== null && deferred > this.now()) {
      row.dueAt = deferred; await this.save(rows); return;
    }
    let allowed = false;
    try { allowed = (row.expiresAt === undefined || this.now() < row.expiresAt) && await options.allowed(row); } catch { /* fail closed */ }
    if (!allowed) { row.status = 'blocked'; row.reason = 'owner_binding'; await this.save(rows); await options.settled(row); row.settled = true; await this.save(rows); return; }
    row.status = 'attempting'; row.attempts += 1;
    await this.save(rows);
    try {
      const result = await options.send({ ...row.payload });
      const ack = result as { message_id?: unknown; chat?: { id?: unknown } } | undefined;
      const messageId = ack?.message_id;
      if (!Number.isSafeInteger(messageId) || (messageId as number) <= 0 || ack?.chat?.id !== row.payload.chat_id) {
        row.status = result === undefined ? 'blocked' : 'quarantined'; row.reason = result === undefined ? 'egress_blocked' : 'invalid_ack';
      } else { row.status = 'delivered'; row.messageId = messageId as number; row.deliveredAt = this.now(); }
    } catch (error) {
      if (error instanceof TelegramRejection && error.retryable && !(typeof error.retryAfter === 'number' && error.retryAfter > 3600) && row.attempts < MAX_ATTEMPTS) {
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
