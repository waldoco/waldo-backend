import { literalTextRedactor } from '@waldo/contracts';
import type { RunEffectScope } from './run-effect-scope';
import { TelegramRejection, TELEGRAM_MESSAGE_MAX_CHARS, sendTelegramFinal, splitTelegramText, type TelegramFinalPayload } from './telegram-api';
import { redactSecretUrls } from './egress-guard';
import { telegramRichReply } from './rich-format';

export const FINAL_OUTBOX_KEY = 'telegram_final_outbox_v1';
export const FINAL_OUTBOX_DUE_KEY = 'telegram_final_outbox_due_v1';
const MAX_RECORDS = 256;
const MAX_ATTEMPTS = 3;
export type FinalPayload = TelegramFinalPayload;
// One sendable sendMessage unit of a frozen final. Computed at enqueue and stored on the
// record so redelivery resumes per part instead of resending the whole message.
export type FinalPart = Readonly<{ text: string; fallback_text?: string }>;
export type HeartbeatReceipt = { id: string; occurrence: number; schedulerRunId: string; runId?: string; loops: { id: string; due: string }[] };
export type MailFollowupReceipt = { loopId: string; due: string; sourceRef: string; timezone: string; messageId: string };
export type CalendarPrepReceipt = { connectionId: string; calendarId: 'primary'; eventId: string; occurrence: string; start: string; revision: string | null; sourceDigest: string; timezone: string };
export type FinalRecord = {
  id: string; trace: string; payload: FinalPayload; digest: string;
  expiresAt?: number; bot?: string;
  receiptUrls?: string[]; ownerSubject: string; doName: string; status: 'pending' | 'attempting' | 'delivered' | 'quarantined' | 'blocked';
  dueAt: number; createdAt: number; attempts: number; settled?: boolean; messageId?: number; deliveredAt?: number; reason?: string;
  inbox?: { id: string; runId: string; attempt: string };
  parts?: FinalPart[];
  deliveredParts?: number;
  // Host-owned frozen settlement intent, committed with the physical final.
  commonExecution?: { request: Omit<import('../identity/common-execution-request').CommonExecutionRequest,'signature'>; settled?: boolean; disposition?:'indeterminate' };
  heartbeat?: HeartbeatReceipt;
  mailFollowup?: MailFollowupReceipt;
  calendarPrep?: CalendarPrepReceipt;
  reaction?: { message_id: number; emoji: string };
  reminder?: { id: string; occurrence: number; runId: string; schedulerRunId: string | null; once: boolean };
};
type Kv = Pick<DurableObjectStorage['kv'], 'get' | 'put'>;
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
    const rows = this.records().map(r => r.settled && r.status !== 'pending' && this.now() >= r.createdAt + 86400000
      ? { ...r, payload: { chat_id: r.payload.chat_id, text: '' }, parts: [], receiptUrls: [], reason: r.status === 'quarantined' ? 'expired_ambiguous_metadata' : r.reason } : r);
    await this.save(rows);
  }
  async enqueue(input: Omit<FinalRecord, 'digest' | 'status' | 'dueAt' | 'createdAt' | 'attempts'>): Promise<void> {
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
    if (row.expiresAt !== undefined && this.now() >= row.expiresAt) {
      row.status = 'blocked'; row.reason = 'expired';
      await this.save(rows); await options.settled(row); row.settled = true; await this.save(rows); return;
    }
    // A quiet-hours hold keeps the frozen intent pending; it is not a rejection.
    const deferred = await options.defer?.(row);
    if (deferred !== undefined && deferred !== null && deferred > this.now()) {
      row.dueAt = Math.min(deferred, row.expiresAt ?? Infinity); await this.save(rows); return;
    }
    let allowed = false;
    try { allowed = (row.expiresAt === undefined || this.now() < row.expiresAt) && await options.allowed(row); } catch { /* fail closed */ }
    if (!allowed) { row.status = 'blocked'; row.reason = 'owner_binding'; await this.save(rows); await options.settled(row); row.settled = true; await this.save(rows); return; }
    row.status = 'attempting'; row.attempts += 1;
    await this.save(rows);
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
    try {
      let fallbackInvalidated = false;
      // Records persisted before parts existed derive them from the payload on read.
      const parts = row.parts?.length ? row.parts : payloadParts(row.payload);
      for (let index = row.deliveredParts ?? 0; index < parts.length; index += 1) {
        const part = parts[index]!;
        const result = await sendTelegramFinal(options.send, {
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
        // Concurrent cancellation/forget owns the persisted record. Never overwrite
        // its disposition or restore its scrubbed bytes from this captured send.
        if (fallbackInvalidated || !currentAttempt()) return;
        const ack = result as { message_id?: unknown; chat?: { id?: unknown } } | undefined;
        const messageId = ack?.message_id;
        if (result === undefined) { row.status = 'blocked'; row.reason = 'egress_blocked'; break; }
        if (!Number.isSafeInteger(messageId) || (messageId as number) <= 0 || ack?.chat?.id !== row.payload.chat_id) {
          row.status = 'quarantined'; row.reason = 'invalid_ack'; break;
        }
        // Persist each ACKed part before the next send: a redelivery resumes at the first
        // undelivered part instead of resending the whole message.
        row.deliveredParts = index + 1;
        row.messageId = messageId as number;
        if (index + 1 === parts.length) { row.status = 'delivered'; row.deliveredAt = this.now(); }
        if (!(await saveCurrentRow())) return;
      }
    } catch (error) {
      if (!currentAttempt()) return;
      if (error instanceof TelegramRejection && error.retryable && !(typeof error.retryAfter === 'number' && error.retryAfter > 3600) && row.attempts < MAX_ATTEMPTS) {
        row.status = 'pending'; row.reason = 'provider_rejected';
        row.dueAt = this.now() + Math.max(30_000 * row.attempts, (typeof error.retryAfter === 'number' && Number.isFinite(error.retryAfter) && error.retryAfter >= 0 ? Math.min(3600, error.retryAfter) : 0) * 1_000);
      } else {
        row.status = 'quarantined'; row.reason = error instanceof TelegramRejection ? 'provider_rejected_terminal' : 'send_unknown';
      }
    }
    if (!(await saveCurrentRow())) return;
    await options.settled(row);
    if (row.status !== 'pending') { row.settled = true; await saveCurrentRow(); }
  }
}

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
    row.parts = payloadParts(row.payload); rewritten += 1;
    if (metadataChanged) row.calendarPrep = metadata;
    if (row.status === 'pending' || (row.status === 'blocked' && row.reason === 'owner_binding' && row.attempts === 0)) { row.status = 'blocked'; row.reason = 'owner_forget'; row.settled = false; }
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
