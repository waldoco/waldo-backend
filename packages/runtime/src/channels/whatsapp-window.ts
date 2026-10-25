import { OUTBOX_CUSTODY, SEND_NOW_ONLY, routedDelivery, type OutboxRoute } from './delivery-routes';
import { carriesTopic } from '../memory/forget-guard';
import { rememberWhatsAppSubject, waitingForWhatsApp } from './proactive-surface';
import { retireSurfaceRecords, type DeliveryReceipt, type FinalRecord, type TelegramFinalOutbox } from './telegram-final-outbox';
import { WHATSAPP_HELD, WhatsAppApiError, WhatsAppFileRefused, WhatsAppPartialSend, deliverWhatsAppFile, whatsappFileLinkText, whatsappHeld, whatsappLinkOutcome, whatsappOutboundKind, type WhatsAppFileLinkReason, type WhatsAppFileOutcome, type WhatsAppOutboundFile } from './whatsapp-api';

// WhatsApp's customer service window: a business may send free-form messages only within 24 hours
// of the user's last message; outside it, only an approved template goes through
// (https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages ,
// "Customer service windows"). This is a platform rule, so it is enforced here deterministically.
// Outside the window Waldo holds the real message, sends one approved template (a "door knock" the
// owner can answer), and delivers what it held as soon as the owner replies.
export const WHATSAPP_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
// Meta's clock and ours can disagree by a little; knocking a few minutes early beats a refused send.
const WINDOW_MARGIN_MS = 5 * 60 * 1000;
// Error 131047: "More than 24 hours have passed since the recipient last replied to the sender number."
// (https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes)
export const WHATSAPP_REENGAGEMENT_ERROR = 131047;
// Meta keeps trying an undeliverable message for up to 30 days; a held message older than that is dropped, not sent late.
export const WHATSAPP_HELD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const WA_LAST_INBOUND_KEY = 'wa_last_inbound_ms';
const KNOCKED_KEY = 'wa_knocked_for';
// Meta can refuse a send for the window after accepting it (a failed status with 131047). The marker is the inbound time
// the window was refused under, so the window counts as closed until the owner writes again.
const REFUSED_KEY = 'wa_window_refused_for';
const REHELD_PREFIX = 'wa_reheld:';
const HELD_SEQ_KEY = 'wa_held_seq';
export const WA_HELD_PREFIX = 'wa_held:';

type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void; delete(key: string): unknown; list<T>(options: { prefix: string }): Iterable<[string, T]> }>;
type Caller = (method: string, body: object) => Promise<unknown>;
type Held = Readonly<{ heldAt: number; body: object }>;
export { WHATSAPP_HELD, whatsappHeld };
// What an OUTBOX_CUSTODY send answers when the window refused it, by our clock or by Meta's 131047: nothing went out and
// nothing was kept here; the outbox keeps the record and sends it again once the owner writes.
export const WHATSAPP_REFUSED = Object.freeze({ refused: 'whatsapp_window' as const });
const whatsappRefused = (result: unknown): boolean => (result as { refused?: unknown } | null | undefined)?.refused === WHATSAPP_REFUSED.refused;
// Marks a send that must not overtake held messages: while anything is held it is held after them, even with the window
// open. A symbol key, so it never reaches a provider's JSON body.
export const SEND_BEHIND_HELD: unique symbol = Symbol('whatsapp.behind_held');
const anyHeld = (kv: Kv): boolean => [...kv.list({ prefix: WA_HELD_PREFIX })].length > 0;
export type WhatsAppTemplate = Readonly<{ name: string; language: string }>;
type Log = (event: Readonly<Record<string, string | number | boolean>>) => void;

// Template name and language are deploy config, set once the template is approved in WhatsApp Manager.
export const whatsappTemplateConfig = (env: Readonly<{ WHATSAPP_REENGAGE_TEMPLATE?: string; WHATSAPP_REENGAGE_TEMPLATE_LANGUAGE?: string }>): WhatsAppTemplate | null => {
  const name = env.WHATSAPP_REENGAGE_TEMPLATE?.trim() ?? '';
  const language = env.WHATSAPP_REENGAGE_TEMPLATE_LANGUAGE?.trim() ?? '';
  return /^[a-z0-9_]{1,512}$/.test(name) && /^[a-z]{2,3}(_[A-Z]{2})?$/.test(language) ? { name, language } : null;
};

// The window opens at the message's own send time, not when Waldo received it: Meta redelivers a webhook
// for up to 7 days, and a late redelivery must not reopen a window that has closed. A missing or unreadable
// timestamp falls back to receipt time; a future one is clamped to now. The record only ever moves forward.
export const recordWhatsAppInbound = (kv: Kv, messages: readonly object[], now: number): void => {
  const previous = kv.get<number>(WA_LAST_INBOUND_KEY) ?? 0;
  let latest = previous;
  for (const message of messages) {
    const { timestamp } = message as { timestamp?: unknown };
    const seconds = typeof timestamp === 'string' && /^\d{1,12}$/.test(timestamp) ? Number(timestamp) : NaN;
    latest = Math.max(latest, Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, now) : now);
  }
  if (latest > previous) kv.put(WA_LAST_INBOUND_KEY, latest);
};

export const whatsappWindowOpen = (kv: Kv, now: number): boolean => {
  const last = kv.get<number>(WA_LAST_INBOUND_KEY);
  return last !== undefined && kv.get<number>(REFUSED_KEY) !== last && now - last < WHATSAPP_SERVICE_WINDOW_MS - WINDOW_MARGIN_MS;
};

// Holding also drops held messages past retention, so an owner who never replies does not keep them longer.
const holdBody = (kv: Kv, body: object, now: number): void => {
  for (const [key, record] of [...kv.list<Held>({ prefix: WA_HELD_PREFIX })]) if (now - record.heldAt >= WHATSAPP_HELD_RETENTION_MS) kv.delete(key);
  const seq = (kv.get<number>(HELD_SEQ_KEY) ?? 0) + 1;
  kv.put(HELD_SEQ_KEY, seq);
  kv.put(`${WA_HELD_PREFIX}${String(seq).padStart(12, '0')}`, { heldAt: now, body } satisfies Held);
};

// One knock per closed window: the marker is the inbound time it answered, so the next reply re-arms it.
// With no template there is no knock to mark, so a template configured later still knocks for this window.
// The marker goes down before the send, so a second send during this one cannot knock again. Only a definite refusal
// takes it back for a retry; a timed-out knock may have gone out, so it stays marked.
export const whatsappKnock = async (kv: Kv, knock: (template: WhatsAppTemplate) => Promise<unknown>, template: WhatsAppTemplate | null, log: Log): Promise<void> => {
  const opening = kv.get<number>(WA_LAST_INBOUND_KEY) ?? 0;
  if (kv.get<number>(KNOCKED_KEY) === opening) { log({ hop: 'whatsapp_window', ok: true, held: true, knocked: false }); return; }
  if (!template) { log({ hop: 'whatsapp_window', ok: false, held: true, code: 'template_unconfigured' }); return; }
  const previous = kv.get<number>(KNOCKED_KEY);
  kv.put(KNOCKED_KEY, opening);
  try {
    await knock(template);
    log({ hop: 'whatsapp_window', ok: true, held: true, knocked: true });
  } catch (error) {
    // Only a definite refusal (a 4xx) takes the marker back for a retry; a 5xx or a timeout may have sent the knock.
    if (error instanceof WhatsAppApiError && error.status < 500) { if (previous === undefined) kv.delete(KNOCKED_KEY); else kv.put(KNOCKED_KEY, previous); }
    log({ hop: 'whatsapp_window', ok: false, held: true, code: error instanceof WhatsAppApiError && error.code !== null ? error.code : 'knock_failed' });
  }
};
const reengagement = (error: unknown): boolean => error instanceof WhatsAppApiError && error.code === WHATSAPP_REENGAGEMENT_ERROR;

// Wraps the WhatsApp shim beneath the owner's egress gate, so a held message and the knock have already
// passed the same ownership check and link redaction as any other send. A held message answers WHATSAPP_HELD.
// A long text the shim split goes out part by part; when the window refuses a later part, only the parts not yet
// sent are held, and the receipt of the last part that went out is returned. A SEND_NOW_ONLY send is never held: outside
// the window it answers nothing (not sent), and the owner still gets the knock, so a reply lets Waldo offer it afresh. A
// SEND_BEHIND_HELD send is held after what is already held, even inside the window, and answers WHATSAPP_HELD. An
// OUTBOX_CUSTODY send is never held either: refused, it answers WHATSAPP_REFUSED and the owner gets the knock.
export const whatsappWindowCaller = (inner: Caller, options: Readonly<{ kv: Kv; template: WhatsAppTemplate | null; now?: () => number; log: Log }>): Caller => {
  const { kv, template, log } = options;
  const now = options.now ?? Date.now;
  return async (method, body) => {
    if (method !== 'sendMessage') return inner(method, body);
    const nowOnly = (body as { [SEND_NOW_ONLY]?: unknown })[SEND_NOW_ONLY] === true;
    const custody = (body as { [OUTBOX_CUSTODY]?: unknown })[OUTBOX_CUSTODY] === true;
    const { [SEND_BEHIND_HELD]: behindFlag, ...plain } = body as { [SEND_BEHIND_HELD]?: unknown };
    const behind = behindFlag === true && anyHeld(kv);
    let held: readonly object[] = [plain];
    let receipt: unknown = WHATSAPP_HELD;
    if (!behind && whatsappWindowOpen(kv, now())) {
      try { return await inner(method, body); }
      catch (error) {
        if ((nowOnly || custody) && error instanceof WhatsAppPartialSend) throw error;
        if (error instanceof WhatsAppPartialSend && reengagement(error.cause)) {
          const { chat_id } = body as { chat_id?: unknown };
          held = error.remaining.map(text => ({ chat_id, text }));
          receipt = error.ack;
        } else if (!reengagement(error)) throw error;
        // Meta's clock closed the window before ours: it stays closed until the owner writes, so the next send waits.
        kv.put(REFUSED_KEY, kv.get<number>(WA_LAST_INBOUND_KEY) ?? 0);
      }
    }
    if (nowOnly || custody) {
      log({ hop: 'whatsapp_window', ok: false, held: false, code: nowOnly ? 'now_only_window_closed' : 'outbox_window_refused' });
      await whatsappKnock(kv, t => inner('sendTemplate', t), template, log);
      return nowOnly ? undefined : WHATSAPP_REFUSED;
    }
    for (const part of held) holdBody(kv, part, now());
    // Held behind earlier messages in an open window, there is nothing to knock for: the next delivery of held messages sends it.
    if (!whatsappWindowOpen(kv, now())) await whatsappKnock(kv, t => inner('sendTemplate', t), template, log);
    return receipt;
  };
};

// A WhatsApp send acknowledges with one message id and the contact it went to; it names no chat the way Telegram does.
// The receipt is honest only for that shape, and only when the contact is the owner's bound subject. It proves Meta accepted
// the message, not that it arrived: Meta can still refuse it for the window, or fail it, by a later status. So the receipt
// asks the outbox to wait for Meta's report of arrival, for as long as Meta keeps trying (its 30-day retention).
export const whatsappReceipt = (ack: unknown, subject: string, now: number = Date.now()): DeliveryReceipt | 'held' | 'refused' | null => {
  if (whatsappHeld(ack)) return 'held';
  if (whatsappRefused(ack)) return 'refused';
  const { messages, contacts } = (ack ?? {}) as { messages?: unknown; contacts?: unknown };
  if (!Array.isArray(messages) || messages.length !== 1 || !Array.isArray(contacts) || contacts.length !== 1) return null;
  const id = (messages[0] as { id?: unknown } | null)?.id, waId = (contacts[0] as { wa_id?: unknown } | null)?.wa_id;
  return typeof id === 'string' && id.trim() !== '' && waId === subject ? { providerMessageId: id, arrivalBy: now + WHATSAPP_HELD_RETENTION_MS } : null;
};

// The outbox route to a WhatsApp owner. While the window is closed a record stays pending in the outbox, so the outbox's
// own checks (cancellation, owner forget, expiry, quiet hours) still apply when it finally goes. Its sends are the outbox's
// custody: one the window refuses, by our clock or Meta's, goes back to pending in the outbox rather than into the held
// store, and a sent record settles only on Meta's report that it arrived (observeSurfaceStatuses). The knock waits for the
// route's checks too: a record the route itself still holds or would refuse never knocks. A record still waiting after
// Meta's 30-day retention ends as lapsed, blocked if nothing went out and quarantined if any part did. releaseWhatsAppOutbox sends what waited once the owner writes again.
export const whatsappWindowRoute = (route: OutboxRoute, options: Readonly<{ kv: Kv; subject: string; template: WhatsAppTemplate | null;
  knock: (template: WhatsAppTemplate) => Promise<unknown>; now?: () => number; log: Log }>): OutboxRoute => {
  const { kv, subject, template, knock, log } = options;
  const now = options.now ?? Date.now;
  const lapsed = (record: { createdAt: number }) => !whatsappWindowOpen(kv, now()) && now() - record.createdAt >= WHATSAPP_HELD_RETENTION_MS;
  return { ...route,
    defer: async record => {
      if (whatsappWindowOpen(kv, now())) return route.defer(record);
      if (lapsed(record)) { log({ hop: 'whatsapp_window', ok: false, held: true, code: 'retention_lapsed' }); return null; }
      const own = await route.defer(record);
      if (own !== null && own > now()) return own;
      if (!(await route.allowed(record))) return null;
      await whatsappKnock(kv, knock, template, log);
      return record.createdAt + WHATSAPP_HELD_RETENTION_MS;
    },
    lapsed: record => lapsed(record) || (route.lapsed?.(record) ?? false),
    allowed: async record => !lapsed(record) && route.allowed(record),
    send: (payload, record) => route.send({ ...payload, [OUTBOX_CUSTODY]: true } as typeof payload, record),
    receipt: ack => whatsappReceipt(ack, subject, now()),
  };
};

// Meta refused a send it had accepted, because the window had closed on its clock. Unless the owner has written since the
// refusal (Meta redelivers status callbacks for days, and a late one must not close a reopened window), the window counts
// as closed until the owner writes again, so later sends wait and knock instead of failing the same way. The text itself is
// the outbox's to send again when the refused message was an outbox record (`kept`); a direct reply's text is gone, and
// the line says so. Once per message id. Storage only, so it can run before the request is acknowledged; answers whether
// the window closed, in which case the caller knocks (whatsappKnock) in its serial work.
export const whatsappWindowRefused = (kv: Kv, refusal: Readonly<{ providerMessageId: string; refusedAt: number }>, kept: boolean, now: number, log: Log): boolean => {
  const marker = `${REHELD_PREFIX}${refusal.providerMessageId}`;
  if (kv.get<number>(marker) !== undefined) return false;
  for (const [key, at] of kv.list<number>({ prefix: REHELD_PREFIX })) if (now - at >= WHATSAPP_HELD_RETENTION_MS) kv.delete(key);
  kv.put(marker, now);
  const last = kv.get<number>(WA_LAST_INBOUND_KEY) ?? 0, closes = refusal.refusedAt > last;
  if (closes) kv.put(REFUSED_KEY, last);
  log({ hop: 'whatsapp_status', ok: false, code: WHATSAPP_REENGAGEMENT_ERROR, closed: closes, detail: kept ? 'outbox_kept' : 'text_unavailable' });
  return closes;
};

// Owner forget reaches held text the way it reaches a pending outbox record: a held message carrying a forgotten literal is
// cancelled, never sent. Answers the outbox redactors' shape; nothing is left behind, so remaining is always 0.
export const forgetHeldWhatsApp = (kv: Kv, texts: readonly string[]): Readonly<{ rewritten: number; remaining: number }> => {
  const needles = [...new Set(texts.map(text => text.trim()).filter(Boolean))];
  let rewritten = 0;
  if (needles.length) for (const [key, record] of kv.list<Held>({ prefix: WA_HELD_PREFIX })) {
    const { text, fallback_text } = record.body as { text?: unknown; fallback_text?: unknown };
    const words = [text, fallback_text].filter((value): value is string => typeof value === 'string');
    if (needles.some(needle => words.some(value => carriesTopic(value, needle)))) { kv.delete(key); rewritten += 1; }
  }
  return { rewritten, remaining: 0 };
};

// The owner wrote, so the window is open: outbox records it kept waiting go out now, before the reply's turn, through the
// same route and checks as the alarm's pass. Only records addressed to this route are touched. There is always one pass, so
// records Meta's reports have finished settle even when nothing waits.
export const releaseWhatsAppOutbox = async (outbox: TelegramFinalOutbox, route: OutboxRoute, settled: (record: FinalRecord) => Promise<void>): Promise<void> => {
  const pending = await outbox.wake(record => route.addressed(record));
  const delivery = { ...routedDelivery([route]), select: (record: FinalRecord) => route.addressed(record), settled };
  for (let pass = 0; pass < Math.max(1, pending); pass += 1) await outbox.drain(delivery);
};

// The window, the held text and the refusal and knock markers belong to one WhatsApp number. When the owner's number
// changes or is unlinked they all go: text held for one number must never reach another, and a new number's window opens
// only when that number writes. The outbox's records for that chat are retired too, since Meta's reports about them no
// longer reach this owner: an unsent one is blocked and a sent one ends unconfirmed, and neither goes to the next number.
// An owner with the app (`appFallback`) keeps the scheduled messages nothing went out for: they go to the app instead
// (waitingForWhatsApp), so the old number is remembered for that. Storage only, so callers run it in the same transaction
// as the binding change, before the bound number changes; answers the ids of the retired records, for the caller to settle.
export const clearWhatsAppNumber = (kv: Kv, appFallback = false): readonly string[] => {
  const old = kv.get<string>('whatsapp_subject');
  const toApp = old && appFallback ? waitingForWhatsApp(new Set([old])) : () => false;
  const kept = (record: FinalRecord) => record.status === 'pending' && toApp(record);
  const retired = old ? retireSurfaceRecords(kv, record => record.ownerSubject === old && String(record.payload.chat_id) === old && !kept(record)) : [];
  if (old && appFallback) rememberWhatsAppSubject(kv, old);
  for (const prefix of [WA_HELD_PREFIX, REHELD_PREFIX]) for (const [key] of [...kv.list<unknown>({ prefix })]) kv.delete(key);
  for (const key of [WA_LAST_INBOUND_KEY, KNOCKED_KEY, REFUSED_KEY]) kv.delete(key);
  return retired;
};

// Binds this owner's WhatsApp to a number, or unbinds it (null): a confirmed link, the first admission, a reconcile at
// admission, an unlink. Whatever belonged to another number goes first; binding the number already bound keeps its state. A
// bound number is linked, so an older unlinked flag goes with any bind. Storage only: callers run it inside the
// transactionSync that decides the binding, rebuild their runtimes after, and settle the outbox records it answers
// (TelegramFinalOutbox.settleEnded), since no pass for the old chat runs again. `appFallback` as for clearWhatsAppNumber.
export const bindWhatsAppNumber = (kv: Kv, subject: string | null, appFallback = false): readonly string[] => {
  let retired: readonly string[] = [];
  if (subject === null || kv.get<string>('whatsapp_subject') !== subject) {
    retired = clearWhatsAppNumber(kv, appFallback);
    if (subject === null) kv.delete('whatsapp_subject'); else kv.put('whatsapp_subject', subject);
  }
  if (subject !== null) kv.delete('whatsapp_unlinked');
  return retired;
};

// Runs when the owner's reply has reopened the window, before that reply's turn, so the turn's context
// matches what the owner has seen. A closed window means the pass does nothing: sending would only re-hold.
// Each record is removed before its send (at most once, like the wamid claim), and what the send answers decides:
// - a receipt: delivered;
// - nothing (the owner gate blocked it, e.g. the presence check failed): never sent, so the record goes back
//   under its own key and the pass stops, keeping the order for the next reply;
// - WHATSAPP_HELD (the window layer held it again under a new key): the pass stops, nothing is put back;
// - a throw: the send may have gone out, so the record stays removed and the pass stops.
// A record held for another number (a pass still running for the old number can put one back after clearWhatsAppNumber)
// is dropped unsent: the call goes to the number bound now.
export const deliverHeldWhatsApp = async (kv: Kv, call: Caller, now: number, log: Log, subject: string): Promise<void> => {
  if (!whatsappWindowOpen(kv, now)) return;
  const held = [...kv.list<Held>({ prefix: WA_HELD_PREFIX })].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  let expired = 0, misaddressed = 0;
  for (const [key, record] of held) {
    // A pass that overlapped this one may already have claimed it; it is sent once, by that pass.
    if (kv.get<Held>(key) === undefined) continue;
    kv.delete(key);
    if (String((record.body as { chat_id?: unknown }).chat_id) !== subject) { misaddressed += 1; continue; }
    if (now - record.heldAt >= WHATSAPP_HELD_RETENTION_MS) { expired += 1; continue; }
    let result: unknown;
    try { result = await call('sendMessage', record.body); }
    catch (error) {
      log({ hop: 'whatsapp_held', ok: false, code: error instanceof WhatsAppApiError && error.code !== null ? error.code : 'send_failed' });
      break;
    }
    if (result === undefined) { kv.put(key, record); log({ hop: 'whatsapp_held', ok: false, code: 'not_sent' }); break; }
    if (whatsappHeld(result)) { log({ hop: 'whatsapp_held', ok: false, code: 'held_again' }); break; }
  }
  if (expired) log({ hop: 'whatsapp_held', ok: true, expired });
  if (misaddressed) log({ hop: 'whatsapp_held', ok: false, code: 'other_number', dropped: misaddressed });
};

// File bytes leave only while the window is open and nothing is held. Outside the window a document would be refused
// after its upload, and while a reply is held a document would land before the reply it follows. So the owner gets the
// link text instead, sent through the window layer marked SEND_BEHIND_HELD: outside the window, or while anything is held,
// the layer holds it after what it already holds, so it goes out in order on the next delivery of held messages.
export const deliverWhatsAppFileInWindow = async (kv: Kv, now: number, call: Caller, chatId: number, file: WhatsAppOutboundFile, fallback: () => Promise<string>): Promise<WhatsAppFileOutcome> => {
  let reason: WhatsAppFileLinkReason | null = null;
  try { whatsappOutboundKind(file); } catch (error) { if (!(error instanceof WhatsAppFileRefused)) throw error; reason = error.reason; }
  const open = whatsappWindowOpen(kv, now);
  if (reason === null && open && !anyHeld(kv)) return deliverWhatsAppFile(call, chatId, file, fallback);
  reason ??= open ? 'behind_held' : 'window_closed';
  return whatsappLinkOutcome(await call('sendMessage', { chat_id: chatId, text: whatsappFileLinkText(file, reason, await fallback()), [SEND_BEHIND_HELD]: true }), reason);
};
