import { literalTextRedactor, type StandingGate } from '@waldo/contracts';
import type { CardId } from '../prompt/day-cards';
import type { RunEffectScope } from './run-effect-scope';
import { TelegramRejection, TELEGRAM_MESSAGE_MAX_CHARS, sendTelegramFinal, splitTelegramText, type TelegramFinalPayload } from './telegram-api';
import { redactSecretUrls } from './egress-guard';
import { telegramRichReply } from './rich-format';

export const FINAL_OUTBOX_KEY = 'telegram_final_outbox_v1';
// One report per occurrence: the producer and the scheduler both find a queued report by this id.
export const standingOrderFinalId = (orderId: string, occurrence: number): string => `standing-order:${orderId}:${occurrence}`;
export const FINAL_OUTBOX_DUE_KEY = 'telegram_final_outbox_due_v1';
// Statuses a surface reported for a message id before the outbox could match them to a record (the record was still being
// sent, or the id was never the outbox's). Kept briefly, so a record that finishes its send then picks up what arrived early.
export const EARLY_STATUS_KEY = 'telegram_final_outbox_status_v1';
const EARLY_STATUS_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_EARLY_STATUSES = 256;
const MAX_RECORDS = 256;
const MAX_ATTEMPTS = 3;
export type FinalPayload = TelegramFinalPayload;
// One sendable sendMessage unit of a frozen final. Computed at enqueue and stored on the
// record so redelivery resumes per part instead of resending the whole message.
export type FinalPart = Readonly<{ text: string; fallback_text?: string }>;
export type HeartbeatReceipt = { id: string; occurrence: number; schedulerRunId: string; runId?: string; loops: { id: string; due: string; status?: string }[] };
export type MailFollowupReceipt = { loopId: string; due: string; sourceRef: string; timezone: string; messageId: string };
export type CalendarPrepReceipt = { connectionId: string; calendarId: 'primary'; eventId: string; occurrence: string; start: string; revision: string | null; sourceDigest: string; timezone: string };
export type FinalRecord = {
  id: string; trace: string; payload: FinalPayload; digest: string;
  expiresAt?: number; bot?: string;
  // accepted: every part was accepted by a surface that confirms arrival later (WhatsApp); not yet delivered, not settled.
  receiptUrls?: string[]; ownerSubject: string; doName: string; status: 'pending' | 'attempting' | 'accepted' | 'delivered' | 'quarantined' | 'blocked';
  dueAt: number; createdAt: number; attempts: number; settled?: boolean; messageId?: number; deliveredAt?: number; reason?: string;
  // A surface whose receipt names its message by a string id (WhatsApp's wamid) records each part's id here, by part
  // index (null for a part that was held instead of sent), instead of messageId.
  providerMessageIds?: (string | null)[];
  // For such a surface, which parts it has reported reaching the recipient, by part index, and the time by which a record
  // with no report at all ends unconfirmed.
  arrived?: boolean[];
  arrivalBy?: number;
  // Owner forget reached this record after it went out: if the surface then refuses it, it is cancelled, not sent again.
  forgotten?: boolean;
  inbox?: { id: string; runId: string; attempt: string };
  parts?: FinalPart[];
  deliveredParts?: number;
  heartbeat?: HeartbeatReceipt;
  // A paused job's notice, naming the pause: the route holds it through quiet hours and drops it once that pause is lifted.
  scheduleNotice?: { scheduleId: string; until: number };
  mailFollowup?: MailFollowupReceipt;
  calendarPrep?: CalendarPrepReceipt;
  reaction?: { message_id: number; emoji: string };
  reminder?: { id: string; occurrence: number; runId: string; schedulerRunId: string | null; once: boolean };
  // A day card on a surface where sends can wait: once it is delivered the day plan records it sent and folds the updates
  // written up to foldUpTo, the time the card was written.
  dayCard?: { day: string; card: CardId; foldUpTo: number };
  // A standing order's report: the order's run finishes when the report is delivered, or when it ends unsent.
  standingOrder?: { runId: string; gate: StandingGate };
};
type Kv = Pick<DurableObjectStorage['kv'], 'get' | 'put'>;
// Whether the provider took any part of the record, whether or not it has arrived. Such a record is on the owner's phone in
// part, so it is never superseded, moved to another surface, or ended as "not sent".
export const tookPart = (record: Pick<FinalRecord, 'providerMessageIds'>): boolean => (record.providerMessageIds ?? []).some(Boolean);
// What a record that stops waiting without going out again ends as: blocked when nothing went out, quarantined when part did.
const endUnsent = (row: FinalRecord, reason: string): void => { row.status = tookPart(row) ? 'quarantined' : 'blocked'; row.reason = reason; };
// What a surface's acknowledgement proves was sent. arrivalBy marks a surface that only accepted the message and reports later
// whether it reached the recipient (or refused it); the record waits for that report until arrivalBy. 'held' is a surface
// that kept the text for later instead of sending it. 'refused' is a surface that sent nothing and leaves the record in the
// outbox's custody, to go again when the surface allows it.
export type DeliveryReceipt = Readonly<{ messageId?: number; providerMessageId?: string; arrivalBy?: number }>;
export type DeliveryAck = DeliveryReceipt | 'held' | 'refused' | null;
// A surface's later report on one message id: it reached the recipient, it was refused for now (the record goes back to
// pending and that part is sent again), or it failed for good.
export type SurfaceStatus = Readonly<{ id: string; kind: 'arrived' | 'refused' | 'failed'; at: number }>;
// Telegram's acknowledgement names the message and the chat it landed in, which must be the record's own.
export const telegramReceipt = (result: unknown, chatId: number): DeliveryAck => {
  const ack = result as { message_id?: unknown; chat?: { id?: unknown } } | undefined;
  return Number.isSafeInteger(ack?.message_id) && (ack!.message_id as number) > 0 && ack?.chat?.id === chatId ? { messageId: ack!.message_id as number } : null;
};
const digest = async (payload: unknown) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload))))].map(x => x.toString(16).padStart(2, '0')).join('');
const guardedPayload = (payload: FinalPayload): FinalPayload => {
  const fallback = payload.fallback_text === undefined ? undefined : redactSecretUrls(payload.fallback_text);
  // Redact before HTML escaping too: encoded ampersands must not conceal URL
  // state/code keys. Only generated finals carry the original presentation copy.
  if (fallback?.count && payload.parse_mode === 'HTML') return { ...payload, ...telegramRichReply(fallback.text) };
  return { ...payload, text: redactSecretUrls(payload.text).text,
    ...(fallback === undefined ? {} : { fallback_text: fallback.text }) };
};

// Sendable parts for a frozen payload. A rich reply splits on its plain source and
// re-renders per part: splitting rendered HTML could cut inside an entity, while each
// re-rendered part is valid on its own. A part whose rendering outgrows the cap (escaping
// expands bytes) subdivides until it fits. A short payload is a single part carrying the
// original bytes unchanged.
const payloadParts = (payload: FinalPayload): FinalPart[] => {
  if (payload.parse_mode === 'HTML' && payload.fallback_text !== undefined) {
    const pieces = splitTelegramText(payload.fallback_text);
    if (pieces.length === 1) return [{ text: payload.text, fallback_text: payload.fallback_text }];
    const parts: FinalPart[] = [];
    const walk = (plain: string): void => {
      if (plain === '') return;
      const rich = telegramRichReply(plain);
      if (rich.text.length <= TELEGRAM_MESSAGE_MAX_CHARS || plain.length === 1) {
        parts.push({ text: rich.text, fallback_text: plain });
        return;
      }
      const mid = Math.ceil(plain.length / 2);
      walk(plain.slice(0, mid));
      walk(plain.slice(mid));
    };
    for (const piece of pieces) walk(piece);
    return parts;
  }
  return splitTelegramText(payload.text).map(text => ({ text }));
};

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
    // A record a surface accepted but never reported on ends unconfirmed once its time to report has passed.
    const rows = this.records().map(r => r.status === 'accepted' && r.arrivalBy !== undefined && this.now() >= r.arrivalBy
      ? { ...r, status: 'quarantined' as const, reason: 'delivery_unconfirmed', settled: false, dueAt: this.now() } : r)
      .map(r => r.settled && r.status !== 'pending' && this.now() >= r.createdAt + 86400000
      ? { ...r, payload: { chat_id: r.payload.chat_id, text: '' }, parts: [], receiptUrls: [], reason: r.status === 'quarantined' ? 'expired_ambiguous_metadata' : r.reason } : r);
    await this.save(rows);
  }
  // `supersedes` names the waiting records the new one replaces (a newer report of the same order). In the same save, each of
  // them that never went out (pending, no part delivered or taken by the provider) ends blocked as superseded and settles on the
  // next drain. A record any part of which reached the provider is never touched: it was sent.
  async enqueue(input: Omit<FinalRecord, 'digest' | 'status' | 'dueAt' | 'createdAt' | 'attempts'>, options?: Readonly<{ supersedes?(record: FinalRecord): boolean }>): Promise<void> {
    input = { ...input, payload: guardedPayload(input.payload) };
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
    for (const row of rows) if (row.status === 'pending' && !row.deliveredParts && !tookPart(row) && options?.supersedes?.(row)) {
      row.status = 'blocked'; row.reason = 'superseded'; row.settled = false;
    }
    rows.push({ ...input, payload: { ...input.payload }, parts: payloadParts(input.payload), digest: hash, status: 'pending', dueAt: this.now() + 250, createdAt: this.now(), attempts: 0 });
    await this.save(rows);
  }
  // Hash before entering the caller-owned atomic fence. The caller commits inbox closure
  // in the same synchronous transaction as these outbox writes, then rearms the shared alarm.
  async enqueueFenced(input: Omit<FinalRecord, 'digest' | 'status' | 'dueAt' | 'createdAt' | 'attempts'>,
    commit: (work: () => void) => void): Promise<void> {
    input = { ...input, payload: guardedPayload(input.payload) };
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
      rows.push({ ...input, payload: { ...input.payload }, parts: payloadParts(input.payload), digest: hash, status: 'pending', dueAt: this.now() + 250, createdAt: this.now(), attempts: 0 });
      this.kv.put(FINAL_OUTBOX_KEY, rows);
      this.kv.put(FINAL_OUTBOX_DUE_KEY, this.due(rows));
    });
  }
  // Only a known pre-send denial can re-arm the same frozen mail intent. Ambiguous
  // attempts remain quarantined and are never retried through this path.
  async retryBlockedMailFollowup(id: string, commit?: (work: () => void) => void): Promise<boolean> {
    const rows = this.records();
    const row = rows.find(record => record.id === id);
    if (!row?.mailFollowup || row.status !== 'blocked' || row.reason !== 'owner_binding' || row.attempts !== 0 || !row.payload.text.trim() || this.now() >= row.createdAt + 86400000) return false;
    row.status = 'pending'; row.dueAt = this.now() + 250; row.settled = false;
    if (commit) commit(() => { this.kv.put(FINAL_OUTBOX_KEY, rows); this.kv.put(FINAL_OUTBOX_DUE_KEY, this.due(rows)); });
    else await this.save(rows);
    return true;
  }
  // The owner wrote again on a surface that kept records waiting: those records are due now. Answers how many are pending.
  async wake(addressed: (record: FinalRecord) => boolean): Promise<number> {
    const rows = this.records(), now = this.now();
    let pending = 0;
    for (const row of rows) if (row.status === 'pending' && addressed(row)) { pending += 1; row.dueAt = Math.min(row.dueAt, now); }
    if (pending) await this.save(rows);
    return pending;
  }
  async drain(options: {
    allowed(record: FinalRecord): Promise<boolean>;
    // Each part goes with the record it belongs to, so a caller can send it to the surface the record is addressed to.
    send(payload: FinalPayload, record: FinalRecord): Promise<unknown>;
    defer?(record: FinalRecord): Promise<number | null>;
    // A record that waited past the surface's retention without going out: it ends blocked as lapsed.
    lapsed?(record: FinalRecord): boolean;
    // How the surface the record went to acknowledges a part; Telegram's when absent.
    receipt?(result: unknown, record: FinalRecord): DeliveryAck;
    // Restricts which records this pass settles and sends. The restart sweep (attempting → quarantined) still covers every
    // record: an attempt left open by a restart is uncertain whoever drains next.
    select?(record: FinalRecord): boolean;
    settled(record: FinalRecord): Promise<void>;
  }): Promise<void> {
    const selected = options.select ?? (() => true);
    await this.maintain();
    const swept = this.records();
    // attempting persisted before network is an uncertainty boundary after restart.
    for (const row of swept) if (row.status === 'attempting') {
      row.status = 'quarantined'; row.reason = 'restart_during_send';
    }
    await this.save(swept);
    // The object takes other requests while this pass awaits the network (a knock in defer, a check in allowed, a settlement),
    // and a surface's status report, owner forget or a retired number can write the outbox then. So after an await the pass
    // writes back only the row it owns, and only if nothing changed that row meanwhile; a settled mark lands on the row as it
    // is now, provided it still has the status that was settled.
    const commit = async (row: FinalRecord, before: string): Promise<boolean> => {
      const latest = this.records();
      const index = latest.findIndex(current => current.id === row.id);
      if (index < 0 || JSON.stringify(latest[index]) !== before) return false;
      latest[index] = row;
      await this.save(latest);
      return true;
    };
    const markSettled = (row: FinalRecord) => this.markSettled(row);
    // Reconcile an ACK persisted before lifecycle bookkeeping without sending again. An accepted record waits for its report.
    for (const row of this.records()) if (row.status !== 'pending' && row.status !== 'accepted' && !row.settled && selected(row)) {
      await options.settled(row); await markSettled(row);
    }
    const row = this.records().find(r => r.status === 'pending' && r.dueAt <= this.now() && selected(r));
    if (!row) return;
    const before = JSON.stringify(row);
    if (row.expiresAt !== undefined && this.now() >= row.expiresAt) {
      endUnsent(row, 'expired');
      await this.save(this.records().map(current => current.id === row.id ? row : current)); await options.settled(row); await markSettled(row); return;
    }
    // A quiet-hours hold keeps the frozen intent pending; it is not a rejection.
    const deferred = await options.defer?.(row);
    if (deferred !== undefined && deferred !== null && deferred > this.now()) {
      row.dueAt = Math.min(deferred, row.expiresAt ?? Infinity); await commit(row, before); return;
    }
    if (options.lapsed?.(row)) { endUnsent(row, 'lapsed'); if (!(await commit(row, before))) return; await options.settled(row); await markSettled(row); return; }
    let allowed = false;
    try { allowed = (row.expiresAt === undefined || this.now() < row.expiresAt) && await options.allowed(row); } catch { /* fail closed */ }
    if (!allowed) { endUnsent(row, 'owner_binding'); if (!(await commit(row, before))) return; await options.settled(row); await markSettled(row); return; }
    row.status = 'attempting'; row.attempts += 1;
    if (!(await commit(row, before))) return;
    let persistedRow = JSON.stringify(row);
    const saveCurrentRow = async (): Promise<boolean> => {
      const latest = this.records();
      const index = latest.findIndex(current => current.id === row.id);
      if (index < 0 || JSON.stringify(latest[index]) !== persistedRow) return false;
      latest[index] = row;
      await this.save(latest);
      persistedRow = JSON.stringify(row);
      return true;
    };
    const currentAttempt = () => this.records().find(current => current.id === row.id
      && current.status === 'attempting' && current.digest === row.digest && current.attempts === row.attempts
      && JSON.stringify(current.payload) === JSON.stringify(row.payload));
    let fallbackInvalidated = false, held = false, awaiting = false;
    // Records persisted before parts existed derive them from the payload on read.
    const parts = row.parts?.length ? row.parts : payloadParts(row.payload);
    for (let index = row.deliveredParts ?? 0; index < parts.length; index += 1) {
      // A part the surface already took, on an earlier attempt that a later refusal sent back, does not go again.
      if (row.providerMessageIds?.[index]) {
        awaiting = true; row.deliveredParts = index + 1;
        if (index + 1 === parts.length && !held) this.accept(row);
        continue;
      }
      // Recommit attempting before each physical part, outside the transport catch.
      if (!(await saveCurrentRow())) return;
      const part = parts[index]!;
      let result: unknown;
      try {
        result = await sendTelegramFinal(part => options.send(part, row), {
          chat_id: row.payload.chat_id,
          text: part.text,
          ...(row.payload.parse_mode === undefined ? {} : { parse_mode: row.payload.parse_mode }),
          ...(part.fallback_text === undefined ? {} : { fallback_text: part.fallback_text }),
        }, async () => {
          const current = currentAttempt();
          if (!current) { fallbackInvalidated = true; return false; }
          const allowed = (current.expiresAt === undefined || this.now() < current.expiresAt) && await options.allowed(current);
          if (!currentAttempt()) { fallbackInvalidated = true; return false; }
          return allowed && (current.expiresAt === undefined || this.now() < current.expiresAt);
        });
      } catch (error) {
        if (!currentAttempt()) return;
        if (error instanceof TelegramRejection && error.retryable && !(typeof error.retryAfter === 'number' && error.retryAfter > 3600) && row.attempts < MAX_ATTEMPTS) {
          row.status = 'pending'; row.reason = 'provider_rejected';
          row.dueAt = this.now() + Math.max(30_000 * row.attempts, (typeof error.retryAfter === 'number' && Number.isFinite(error.retryAfter) && error.retryAfter >= 0 ? Math.min(3600, error.retryAfter) : 0) * 1_000);
        } else {
          row.status = 'quarantined'; row.reason = error instanceof TelegramRejection ? 'provider_rejected_terminal' : 'send_unknown';
        }
        break;
      }
      // Concurrent cancellation/forget owns the persisted record. Never overwrite
      // its disposition or restore its scrubbed bytes from this captured send.
      if (fallbackInvalidated || !currentAttempt()) return;
      if (result === undefined) { row.status = 'blocked'; row.reason = 'egress_blocked'; break; }
      const receipt = options.receipt ? options.receipt(result, row) : telegramReceipt(result, row.payload.chat_id);
      if (receipt === null) { row.status = 'quarantined'; row.reason = 'invalid_ack'; break; }
      // Refused for now: nothing went out for this part. The record goes back to pending from this part, keeping its id, expiry
      // and receipts; the route decides when it may go again.
      if (receipt === 'refused') { row.status = 'pending'; row.reason = 'window_refused'; row.deliveredParts = index; row.dueAt = this.now(); break; }
      // A held part is in the surface's custody, not delivered: the remaining parts are handed to it in order the same way,
      // and the record ends blocked rather than delivered.
      if (receipt === 'held') { held = true; row.reason = 'surface_held'; }
      else {
        if (receipt.messageId !== undefined) row.messageId = receipt.messageId;
        if (receipt.providerMessageId !== undefined) {
          const ids = [...(row.providerMessageIds ?? [])];
          while (ids.length < index) ids.push(null);
          ids[index] = receipt.providerMessageId;
          row.providerMessageIds = ids;
        }
        if (receipt.arrivalBy !== undefined) { awaiting = true; row.arrivalBy = receipt.arrivalBy; }
      }
      // Persist each ACKed part before the next send; storage faults must propagate.
      row.deliveredParts = index + 1;
      if (index + 1 === parts.length) {
        if (held) row.status = 'blocked';
        else if (awaiting) this.accept(row);
        else { row.status = 'delivered'; row.deliveredAt = this.now(); }
      }
      if (!(await saveCurrentRow())) return;
    }
    // Reports that reached the outbox while this record was still being sent apply now.
    // accept() and the early reports change the status where the compiler cannot follow, so it is read back unnarrowed.
    const ended = (): FinalRecord['status'] => row.status;
    if (ended() === 'accepted' || ended() === 'pending') applyEarlyStatuses(this.kv, row, this.now());
    if (!(await saveCurrentRow())) return;
    await options.settled(row);
    if (ended() !== 'pending' && ended() !== 'accepted') { row.settled = true; await saveCurrentRow(); }
  }
  private async markSettled(row: FinalRecord): Promise<void> {
    const latest = this.records();
    const current = latest.find(other => other.id === row.id);
    if (!current || current.status !== row.status) return;
    current.settled = true; row.settled = true;
    await this.save(latest);
  }
  // Settles, by id, records that ended outside a drain pass (an unlink retired them). It sends nothing and sweeps nothing, so it
  // is safe beside a pass that has a send in flight.
  async settleEnded(ids: readonly string[], settled: (record: FinalRecord) => Promise<void>): Promise<void> {
    for (const row of this.records()) {
      if (!ids.includes(row.id) || row.settled || row.status === 'pending' || row.status === 'accepted' || row.status === 'attempting') continue;
      await settled(row); await this.markSettled(row);
    }
  }
  // Every part went out to a surface that reports arrival later: the record waits for that report, or for arrivalBy.
  private accept(row: FinalRecord): void {
    row.status = 'accepted'; row.reason = undefined;
    row.dueAt = row.arrivalBy ?? this.now();
  }
  // Records a surface has accepted and not yet reported on: how many, and since when the oldest has waited.
  unconfirmed(): Readonly<{ count: number; oldestSince: number | null }> {
    const accepted = this.records().filter(row => row.status === 'accepted');
    return { count: accepted.length, oldestSince: accepted.length ? Math.min(...accepted.map(row => row.createdAt)) : null };
  }
}

// What the console says for a job whose message is still in the outbox's hands, by the job's run id: sent and waiting for
// the surface's report that it arrived, or refused for now and waiting for the owner's next message. Fixed lines only.
export const outboxRunNotes = (records: readonly FinalRecord[]): ReadonlyMap<string, string> => {
  const notes = new Map<string, string>();
  for (const record of records) {
    const runId = record.standingOrder?.runId ?? record.reminder?.runId ?? record.heartbeat?.runId;
    if (!runId) continue;
    if (record.status === 'accepted') notes.set(runId, 'sent, waiting for your phone');
    else if (record.status === 'pending' && record.reason === 'window_refused') notes.set(runId, 'waiting for your next message');
  }
  return notes;
};
// The day cards of one day that went out and are waiting for the surface's report that they arrived.
export const unconfirmedCards = (records: readonly FinalRecord[], day: string): ReadonlySet<CardId> =>
  new Set(records.flatMap(record => record.status === 'accepted' && record.dayCard?.day === day ? [record.dayCard.card] : []));

type StatusKv = Pick<DurableObjectStorage['kv'], 'get' | 'put'>;
type EarlyStatuses = Record<string, { kind: SurfaceStatus['kind']; at: number; seen: number }>;
const writeRows = (kv: StatusKv, rows: FinalRecord[]): void => {
  kv.put(FINAL_OUTBOX_KEY, rows);
  const due = rows.flatMap(row => row.status === 'pending' || row.status === 'attempting' || !row.settled ? [row.dueAt] : row.payload.text ? [row.createdAt + 86400000] : []);
  kv.put(FINAL_OUTBOX_DUE_KEY, due.length ? Math.min(...due) : null);
};

// One report on one part of a record the surface took. Only a record still waiting on that part changes: a report about a
// record that has already ended (delivered, blocked, expired, unconfirmed), about a part sent again since, or a refusal or
// failure about a part that already arrived (a replayed report) is ignored.
// Answers whether the record changed.
const applyStatus = (row: FinalRecord, index: number, kind: SurfaceStatus['kind'], now: number): boolean => {
  if (row.status !== 'accepted' && row.status !== 'pending') return false;
  const arrived = [...(row.arrived ?? [])];
  while (arrived.length < (row.parts?.length ?? 1)) arrived.push(false);
  if (kind === 'arrived') {
    if (arrived[index]) return false;
    arrived[index] = true; row.arrived = arrived;
    if (row.status === 'accepted' && arrived.every(Boolean)) { row.status = 'delivered'; row.deliveredAt = now; row.settled = false; row.dueAt = now; }
    return true;
  }
  if (arrived[index]) return false;
  if (kind === 'failed' || row.forgotten) {
    row.status = 'blocked'; row.reason = kind === 'failed' ? 'provider_failed' : 'owner_forget'; row.settled = false; row.dueAt = now;
    return true;
  }
  // Refused for now: this part goes again, in part order, with whatever else is still unsent.
  const ids = [...(row.providerMessageIds ?? [])];
  ids[index] = null; arrived[index] = false;
  row.providerMessageIds = ids; row.arrived = arrived;
  row.status = 'pending'; row.reason = 'window_refused'; row.dueAt = now;
  row.deliveredParts = Math.min(row.deliveredParts ?? 0, index);
  return true;
};

const applyEarlyStatuses = (kv: StatusKv, row: FinalRecord, now: number): void => {
  const early = kv.get<EarlyStatuses>(EARLY_STATUS_KEY) ?? {};
  let used = false;
  for (const [index, id] of (row.providerMessageIds ?? []).entries()) {
    const status = id ? early[id] : undefined;
    if (!status || !id) continue;
    applyStatus(row, index, status.kind, now); delete early[id]; used = true;
  }
  if (used) kv.put(EARLY_STATUS_KEY, early);
};

// The surface's reports on messages it accepted, applied to the records they name, with the outbox as the one writer.
// Storage only, so the caller commits it in the same synchronous step that acknowledges the reports; a report for a record
// still being sent, or for an id the outbox does not hold, is kept briefly for that record. Answers how many records changed.
export const observeSurfaceStatuses = (kv: StatusKv, statuses: readonly SurfaceStatus[], addressed: (record: FinalRecord) => boolean, now: number): number => {
  const rows = new TelegramFinalOutbox(kv).records();
  const stored = kv.get<EarlyStatuses>(EARLY_STATUS_KEY) ?? {};
  const early = Object.fromEntries(Object.entries(stored).filter(([, status]) => now - status.seen < EARLY_STATUS_TTL_MS));
  const changed = new Set<FinalRecord>();
  for (const status of statuses) {
    const row = rows.find(record => addressed(record) && record.providerMessageIds?.includes(status.id));
    if (!row || row.status === 'attempting') { early[status.id] ??= { kind: status.kind, at: status.at, seen: now }; continue; }
    if (applyStatus(row, row.providerMessageIds!.indexOf(status.id), status.kind, now)) changed.add(row);
  }
  // The surface also reports on messages that are not records (every direct reply and knock), and each of those lands here until
  // a record claims it. Uncapped, one storage value grows with the owner's chat volume until it outgrows what a value can hold;
  // the write that acknowledges the surface's reports then fails, and the reports a real record is waiting for are lost.
  // Beyond the cap the oldest go: only the one record being sent can still be waiting on one, and that is a handful of ids.
  const entries = Object.entries(early);
  const kept = entries.length > MAX_EARLY_STATUSES ? Object.fromEntries(entries.sort(([, a], [, b]) => a.seen - b.seen).slice(-MAX_EARLY_STATUSES)) : early;
  if (JSON.stringify(kept) !== JSON.stringify(stored)) kv.put(EARLY_STATUS_KEY, kept);
  if (changed.size) writeRows(kv, rows);
  return changed.size;
};

// The surface these records were addressed to is gone (the owner unlinked or replaced that number): its reports will never
// reach this owner again. A record nothing went out for is blocked; one that went out, or may have, ends unconfirmed. Neither
// is ever sent again. Storage only, so the caller runs it in the same transaction as the binding change; answers the ids of
// the records it retired, for the caller to settle.
export const retireSurfaceRecords = (kv: StatusKv, addressed: (record: FinalRecord) => boolean): readonly string[] => {
  const rows = new TelegramFinalOutbox(kv).records();
  const retired: string[] = [];
  for (const row of rows) {
    if (!addressed(row)) continue;
    // A record that already ended and still owes its settlement keeps how it ended, and is handed back to be settled: no pass for this surface runs again.
    if (row.status !== 'pending' && row.status !== 'accepted' && row.status !== 'attempting') { if (row.settled === false) retired.push(row.id); continue; }
    const sent = row.status !== 'pending' || tookPart(row);
    row.status = sent ? 'quarantined' : 'blocked'; row.reason = 'surface_unlinked'; row.settled = false; row.dueAt = 0;
    retired.push(row.id);
  }
  if (retired.length) writeRows(kv, rows);
  return retired;
};

// Literal owner-forget cleanup for source-derived copies only. Never replays or
// unblocks a send: pending intent is cancelled; uncertain transport stays uncertain.
const redactSourceFinalEntries = (kv: Kv, texts: readonly string[], marker: string, scope: RunEffectScope | undefined, matches: (row: FinalRecord) => boolean): Readonly<{ rewritten: number; remaining: number }> => {
  const needles = [...new Set(texts.map(text => text.trim()).filter(Boolean))];
  if (!needles.length) return { rewritten: 0, remaining: 0 };
  const redact = literalTextRedactor(needles, marker);
  const rows = new TelegramFinalOutbox(kv).records();
  let rewritten = 0;
  for (const row of rows) {
    if (!matches(row)) continue;
    const text = redact(row.payload.text);
    const fallback = row.payload.fallback_text === undefined ? undefined : redact(row.payload.fallback_text);
    const metadata = row.calendarPrep ? Object.fromEntries(Object.entries(row.calendarPrep).map(([key, value]) => [key, typeof value === 'string' ? redact(value) : value])) as CalendarPrepReceipt : undefined;
    const metadataChanged = metadata !== undefined && JSON.stringify(metadata) !== JSON.stringify(row.calendarPrep);
    if (text === row.payload.text && fallback === row.payload.fallback_text && !metadataChanged) continue;
    row.payload = { ...row.payload, text, ...(fallback === undefined ? {} : { fallback_text: fallback }) };
    // Once a part has gone out its message ids follow the parts by index, so the parts are redacted in place, never split again.
    const started = (row.deliveredParts ?? 0) > 0 || tookPart(row);
    row.parts = started && row.parts?.length
      ? row.parts.map(part => ({ text: redact(part.text), ...(part.fallback_text === undefined ? {} : { fallback_text: redact(part.fallback_text) }) }))
      : payloadParts(row.payload);
    rewritten += 1;
    if (metadataChanged) row.calendarPrep = metadata;
    if (row.status === 'accepted') row.forgotten = true;
    else if (row.status === 'pending' || (row.status === 'blocked' && row.reason === 'owner_binding' && row.attempts === 0)) { row.status = 'blocked'; row.reason = 'owner_forget'; row.settled = false; }
    else if (row.status === 'attempting') { row.status = 'quarantined'; row.reason = 'forget_during_uncertain_send'; row.settled = false; }
  }
  if (rewritten) {
    const write = () => {
      kv.put(FINAL_OUTBOX_KEY, rows);
      // Reuse the existing outbox wake key; settlement happens on its normal lane.
      const due = rows.flatMap(row => row.status === 'pending' || row.status === 'attempting' || !row.settled ? [row.dueAt] : row.payload.text ? [row.createdAt + 86400000] : []);
      kv.put(FINAL_OUTBOX_DUE_KEY, due.length ? Math.min(...due) : null);
    };
    if (scope) scope.commit(write); else write();
  }
  const remaining = new TelegramFinalOutbox(kv).records().filter(row => matches(row) && needles.some(needle => [row.payload.text, row.payload.fallback_text ?? '', ...Object.values(row.calendarPrep ?? {}).filter((value): value is string => typeof value === 'string')].some(value => value.toLowerCase().includes(needle.toLowerCase())))).length;
  return { rewritten, remaining };
};
export const redactMailFollowupEntries = (kv: Kv, texts: readonly string[], marker: string, scope?: RunEffectScope) => redactSourceFinalEntries(kv, texts, marker, scope, row => !!row.mailFollowup);
export const redactCalendarPrepEntries = (kv: Kv, texts: readonly string[], marker: string, scope?: RunEffectScope) => redactSourceFinalEntries(kv, texts, marker, scope, row => !!row.calendarPrep);
// Day cards, standing-order reports, heartbeat check-backs and reminder messages are written by the model from the
// calendar, mail, ledger, memory and conversation, and they can wait here for the owner (WhatsApp outside its window), so
// owner forget reaches them the same way. A reminder's message is such a copy too: the model writes it from the note and
// what its read tools find. Only the waiting message is cancelled; the reminder itself is the owner's and stays.
export const redactJobReportEntries = (kv: Kv, texts: readonly string[], marker: string, scope?: RunEffectScope) => redactSourceFinalEntries(kv, texts, marker, scope,
  row => !!row.dayCard || !!row.standingOrder || !!row.heartbeat || !!row.reminder);
