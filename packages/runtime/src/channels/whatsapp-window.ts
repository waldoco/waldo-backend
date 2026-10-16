import { WhatsAppApiError } from './whatsapp-api';

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
const HELD_SEQ_KEY = 'wa_held_seq';
export const WA_HELD_PREFIX = 'wa_held:';

type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void; delete(key: string): unknown; list<T>(options: { prefix: string }): Iterable<[string, T]> }>;
type Caller = (method: string, body: object) => Promise<unknown>;
type Held = Readonly<{ heldAt: number; body: object }>;
// What a held send answers instead of a provider receipt: the text is in Waldo's custody and goes out on the owner's next
// message. It is not a delivery, and no caller may read it as one.
export const WHATSAPP_HELD = Object.freeze({ held: 'whatsapp_window' as const });
export const whatsappHeld = (result: unknown): boolean => (result as { held?: unknown } | null | undefined)?.held === WHATSAPP_HELD.held;
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
  return last !== undefined && now - last < WHATSAPP_SERVICE_WINDOW_MS - WINDOW_MARGIN_MS;
};

// Wraps the WhatsApp shim beneath the owner's egress gate, so a held message and the knock have already
// passed the same ownership check and link redaction as any other send. A held message answers WHATSAPP_HELD.
// Holding also drops held messages past retention, so an owner who never replies does not keep them longer.
export const whatsappWindowCaller = (inner: Caller, options: Readonly<{ kv: Kv; template: WhatsAppTemplate | null; now?: () => number; log: Log }>): Caller => {
  const { kv, template, log } = options;
  const now = options.now ?? Date.now;
  return async (method, body) => {
    if (method !== 'sendMessage') return inner(method, body);
    if (whatsappWindowOpen(kv, now())) {
      try { return await inner(method, body); }
      catch (error) { if (!(error instanceof WhatsAppApiError) || error.code !== WHATSAPP_REENGAGEMENT_ERROR) throw error; }
    }
    for (const [key, record] of [...kv.list<Held>({ prefix: WA_HELD_PREFIX })]) if (now() - record.heldAt >= WHATSAPP_HELD_RETENTION_MS) kv.delete(key);
    const seq = (kv.get<number>(HELD_SEQ_KEY) ?? 0) + 1;
    kv.put(HELD_SEQ_KEY, seq);
    kv.put(`${WA_HELD_PREFIX}${String(seq).padStart(12, '0')}`, { heldAt: now(), body } satisfies Held);
    // One knock per closed window: the marker is the inbound time it answered, so the next reply re-arms it.
    // With no template there is no knock to mark, so a template configured later still knocks for this window.
    const opening = kv.get<number>(WA_LAST_INBOUND_KEY) ?? 0;
    if (kv.get<number>(KNOCKED_KEY) === opening) { log({ hop: 'whatsapp_window', ok: true, held: true, knocked: false }); return WHATSAPP_HELD; }
    if (!template) { log({ hop: 'whatsapp_window', ok: false, held: true, code: 'template_unconfigured' }); return WHATSAPP_HELD; }
    // The marker goes down before the send, so a second send during this one cannot knock again. Only a definite refusal
    // takes it back for a retry; a timed-out knock may have gone out, so it stays marked.
    const previous = kv.get<number>(KNOCKED_KEY);
    kv.put(KNOCKED_KEY, opening);
    try {
      await inner('sendTemplate', template);
      log({ hop: 'whatsapp_window', ok: true, held: true, knocked: true });
    } catch (error) {
      if (error instanceof WhatsAppApiError) { if (previous === undefined) kv.delete(KNOCKED_KEY); else kv.put(KNOCKED_KEY, previous); }
      log({ hop: 'whatsapp_window', ok: false, held: true, code: error instanceof WhatsAppApiError && error.code !== null ? error.code : 'knock_failed' });
    }
    return WHATSAPP_HELD;
  };
};

// Runs when the owner's reply has reopened the window, before that reply's turn, so the turn's context
// matches what the owner has seen. A closed window means the pass does nothing: sending would only re-hold.
// Each record is removed before its send (at most once, like the wamid claim), and what the send answers decides:
// - a receipt: delivered;
// - nothing (the owner gate blocked it, e.g. the presence check failed): never sent, so the record goes back
//   under its own key and the pass stops, keeping the order for the next reply;
// - WHATSAPP_HELD (the window layer held it again under a new key): the pass stops, nothing is put back;
// - a throw: the send may have gone out, so the record stays removed and the pass stops.
export const deliverHeldWhatsApp = async (kv: Kv, call: Caller, now: number, log: Log): Promise<void> => {
  if (!whatsappWindowOpen(kv, now)) return;
  const held = [...kv.list<Held>({ prefix: WA_HELD_PREFIX })].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  let expired = 0;
  for (const [key, record] of held) {
    kv.delete(key);
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
};
