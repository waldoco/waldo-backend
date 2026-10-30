import { z } from 'zod';
import { onlyArtifacts, quarantineArtifacts } from '../security/artifact-hygiene';
import { splitTelegramText } from './telegram-api';
// WhatsApp Cloud API surface (WHATSAPP_CHANNEL_SPEC W2-W4): the raw caller for the webhook's
// link-code replies, the telegram-shaped send shim the owner DO wraps in the same
// gatedCaller/egressGuardedCaller gate as Telegram (W3), the two-step media downloader that
// feeds voice notes to the shared transcriber (W4), and the ingress normalization below.
export type WhatsAppCall = (body: object) => Promise<unknown>;

// Match the existing Telegram transport bound. A timed-out POST is uncertain,
// so this caller never retries and never reports a successful acknowledgement.
export const WHATSAPP_API_TIMEOUT_MS = 15_000;
export const WHATSAPP_GRAPH_VERSION = 'v26.0';
// https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages , text object: "Maximum 4096 characters".
export const WHATSAPP_TEXT_MAX_CHARS = 4096;
// A Graph refusal with Meta's numeric error code (error.code in the JSON body), or null when the body has none.
export class WhatsAppApiError extends Error {
  readonly code: number | null;
  readonly #body: string;
  constructor(readonly status: number, body: string) {
    super(`whatsapp ${status}: ${body.slice(0, 200)}`);
    this.#body = body.slice(0, 4096);
    let code: unknown = null;
    try { code = (JSON.parse(body) as { error?: { code?: unknown } }).error?.code; } catch { /* not JSON */ }
    this.code = typeof code === 'number' && Number.isSafeInteger(code) ? code : null;
  }

  // Graph's answer (its first 4096 characters), read only by the webhook's staging debug log. A getter over a private
  // field, so serializing the error never carries it.
  get body(): string { return this.#body; }
}

// Graph can quote the token it was sent back in an auth refusal ("Malformed access token ..."), so every form of the token,
// as stored and trimmed of whitespace and quotes, is masked before Graph's answer becomes an error. A form shorter than 8
// characters is no real token and is left alone, so it cannot garble the answer.
const maskToken = (text: string, token: string): string => {
  let masked = text;
  for (const form of new Set([token, token.trim(), token.trim().replace(/^["']+|["']+$/g, '')])) {
    if (form.length >= 8) masked = masked.split(form).join('[token]');
  }
  return masked;
};

// https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages/ , "WhatsApp user phone
// number formats": a `to` without its plus gets the business number's country calling code prepended. Callers pass the
// stored E.164 digits, so an all-digit `to` goes out with its plus. A BSUID goes in `recipient`, which is sent as given.
const e164To = (body: object): object => {
  const { to } = body as { to?: unknown };
  return typeof to === 'string' && /^\d+$/.test(to) ? { ...body, to: `+${to}` } : body;
};

export const createWhatsAppCaller = (token: string, phoneNumberId: string, fetcher: typeof fetch = fetch): WhatsAppCall =>
  async (body) => {
    const controller = new AbortController();
    let timer:ReturnType<typeof setTimeout>;
    const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('whatsapp send timed out; delivery uncertain'));},WHATSAPP_API_TIMEOUT_MS);});
    try {
      const response = await Promise.race([fetcher(`https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', ...e164To(body) }),
        signal: controller.signal,
      }),timeout]);
      if (!response.ok) throw new WhatsAppApiError(response.status, maskToken(await Promise.race([response.text(),timeout]), token));
      return await Promise.race([response.json(),timeout]);
    } finally {
      clearTimeout(timer!);
    }
  };

// A text longer than one WhatsApp message went out in parts and a later part failed: the owner already has the first `sent`
// parts, so the caller must not send the whole text again. `ack` is the last part that went out; `remaining` are the parts
// that did not.
export class WhatsAppPartialSend extends Error {
  constructor(readonly sent: number, readonly ack: unknown, readonly remaining: readonly string[], override readonly cause: unknown) {
    super(`whatsapp send stopped after part ${sent}`, { cause });
  }
}

// preview_url makes WhatsApp fetch the first http(s) link with no tap from the owner, so it is opt-in per send.
export const sendWhatsAppText = (call: WhatsAppCall, to: string, text: string, preview = false) =>
  call({ to, type: 'text', text: { body: text, ...(preview && /https?:\/\//i.test(text) ? { preview_url: true } : {}) } });

// Telegram-shaped compatibility caller. WhatsApp currently uses explicit text
// instructions for approvals and exact URL text for link buttons. sendDocument
// uploads the file and sends it by media id (deliverWhatsAppFile is its caller).
// Unsupported Telegram operations return no receipt, never a fabricated successful result.
export type TelegramShimCall = (method: string, body: object) => Promise<unknown>;

// Meta shows the typing indicator for up to 25 seconds or until the reply, and each call also marks the message read, so the
// listener's 4-second typing ticks are thinned to one call per 20 seconds for the same message.
export const WHATSAPP_TYPING_REFRESH_MS = 20_000;
// The owner DO keeps the id of the owner's latest admitted message here, for the read receipt and typing indicator.
export const WA_LAST_INBOUND_ID_KEY = 'wa_last_inbound_id';
export type WhatsAppShimOptions = Readonly<{ lastInbound?: () => string | null; now?: () => number }>;

export const whatsappTelegramShim = (token: string, phoneNumberId: string, to: string, fetcher: typeof fetch = fetch, options: WhatsAppShimOptions = {}): TelegramShimCall => {
  const call = createWhatsAppCaller(token, phoneNumberId, fetcher);
  const upload = createWhatsAppMediaUploader(token, phoneNumberId, fetcher);
  const now = options.now ?? Date.now;
  let typed: { id: string; at: number } | null = null;
  return async (method, body) => {
    // Typing marks the owner's latest message read (blue ticks) and shows "typing…". It needs that message's id.
    if (method === 'sendChatAction') {
      const id = options.lastInbound?.() ?? null;
      if (!id || (typed?.id === id && now() - typed.at < WHATSAPP_TYPING_REFRESH_MS)) return undefined;
      typed = { id, at: now() };
      return call({ status: 'read', message_id: id, typing_indicator: { type: 'text' } });
    }
    // An approved template with no variables: agent text never rides in a template.
    if (method === 'sendTemplate') {
      const { name, language } = body as { name: string; language: string };
      return call({ to, type: 'template', template: { name, language: { code: language } } });
    }
    if (method === 'sendDocument') {
      const { file } = body as { file: WhatsAppOutboundFile };
      const kind = whatsappOutboundKind(file);
      const id = await upload(file);
      return call({ to, type: kind, [kind]: kind === 'document' ? { id, filename: file.filename } : { id } });
    }
    if (method === 'sendMessage') {
      const b = body as { text: string; fallback_text?: string; link_preview_options?: { is_disabled?: boolean }; reply_markup?: { inline_keyboard?: { text: string; callback_data?: string; url?: string }[][] } };
      const buttons = (b.reply_markup?.inline_keyboard ?? []).flat().filter((x) => x.callback_data || x.url);
      const suffix = buttons.length ? `\n\n${buttons.map((x) => x.url ? `- ${x.text}: ${x.url}` : `- ${x.text}: reply "${x.callback_data}"`).join('\n')}` : '';
      // A text message carries at most 4,096 characters, so a longer one goes in parts on the same split as the surface adapter.
      const parts = splitTelegramText((b.fallback_text ?? b.text) + suffix, WHATSAPP_TEXT_MAX_CHARS);
      let ack: unknown;
      for (let index = 0; index < parts.length; index += 1) {
        try { ack = await sendWhatsAppText(call, to, parts[index]!, b.link_preview_options?.is_disabled !== true); }
        catch (error) { if (index === 0) throw error; throw new WhatsAppPartialSend(index, ack, parts.slice(index), error); }
      }
      return ack;
    }
    console.log(JSON.stringify({ hop: 'whatsapp_shim', ok: false, skipped: method, code: 'unsupported_surface_action' }));
    return undefined;
  };
};

// W4 media download: same 20 MB ceiling as Telegram; the transcriber path reports an honest
// "could not be transcribed" note when the cap trips.
export const WHATSAPP_MEDIA_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

export type WhatsAppMediaDownloader = (mediaId: string) => Promise<Uint8Array>;

// Cloud API media is a two-step read: GET /{media-id} (bearer) returns a short-lived download
// URL, then GET that URL (bearer again) returns the bytes. The bearer is sent to Meta media
// hosts only - a signed payload can name any media id, and the returned URL is attacker-shaped
// input until its host is checked.
const WHATSAPP_MEDIA_HOST = /(^|\.)(fbsbx\.com|whatsapp\.net|facebook\.com)$/;

export const createWhatsAppMediaDownloader = (token: string, fetcher: typeof fetch = fetch): WhatsAppMediaDownloader => async (mediaId) => {
  if (mediaId.length === 0 || mediaId.length > 256) throw new Error('whatsapp media id invalid');
  const auth = { authorization: `Bearer ${token}` };
  const meta = await fetcher(`https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${encodeURIComponent(mediaId)}`, { headers: auth });
  if (!meta.ok) throw new Error(`whatsapp media lookup failed: ${meta.status}`);
  const { url } = await meta.json() as { url?: string };
  const host = url ? new URL(url).host : '';
  if (!url || !WHATSAPP_MEDIA_HOST.test(host)) throw new Error('whatsapp media lookup returned no usable url');
  const file = await fetcher(url, { headers: auth });
  if (!file.ok) throw new Error(`whatsapp media download failed: ${file.status}`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > WHATSAPP_MEDIA_DOWNLOAD_LIMIT_BYTES) throw new Error('whatsapp media exceeds download limit');
  return bytes;
};

// Outbound files: a file reaches a WhatsApp chat as a media id, so the bytes are uploaded first
// (POST /{phone-number-id}/media, multipart) and the message then names that id. Uploaded media
// persists for 30 days on Meta's side.
export type WhatsAppOutboundFile = Readonly<{ bytes: Uint8Array; mime: string; filename: string }>;
export type WhatsAppFileRefusal = 'unsupported_type' | 'too_large' | 'empty' | 'invalid_filename';
export class WhatsAppFileRefused extends Error {
  constructor(readonly reason: WhatsAppFileRefusal) { super(`whatsapp file refused: ${reason}`); }
}

const MB = 1024 * 1024;
// Meta's supported outbound types and per-type caps
// (https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media , "Supported media types").
// Every cap is also held to the existing 20 MB media ceiling. Images must be JPEG or PNG; WebP is
// sticker-only and is left out. A type missing here is refused, never guessed.
const OUTBOUND: Readonly<Record<string, Readonly<{ kind: 'image' | 'document' | 'audio' | 'video'; maxBytes: number }>>> = {
  'image/jpeg': { kind: 'image', maxBytes: 5 * MB },
  'image/png': { kind: 'image', maxBytes: 5 * MB },
  'application/pdf': { kind: 'document', maxBytes: 100 * MB },
  'text/plain': { kind: 'document', maxBytes: 100 * MB },
  'application/msword': { kind: 'document', maxBytes: 100 * MB },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { kind: 'document', maxBytes: 100 * MB },
  'application/vnd.ms-excel': { kind: 'document', maxBytes: 100 * MB },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { kind: 'document', maxBytes: 100 * MB },
  'application/vnd.ms-powerpoint': { kind: 'document', maxBytes: 100 * MB },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { kind: 'document', maxBytes: 100 * MB },
  'audio/aac': { kind: 'audio', maxBytes: 16 * MB },
  'audio/amr': { kind: 'audio', maxBytes: 16 * MB },
  'audio/mpeg': { kind: 'audio', maxBytes: 16 * MB },
  'audio/mp4': { kind: 'audio', maxBytes: 16 * MB },
  'video/mp4': { kind: 'video', maxBytes: 16 * MB },
  'video/3gpp': { kind: 'video', maxBytes: 16 * MB },
};

export const whatsappOutboundKind = (file: WhatsAppOutboundFile): 'image' | 'document' | 'audio' | 'video' => {
  const rule = OUTBOUND[file.mime.toLowerCase()];
  if (!rule) throw new WhatsAppFileRefused('unsupported_type');
  if (!file.filename.trim() || file.filename.length > 240 || /[\u0000-\u001f\\/]/.test(file.filename)) throw new WhatsAppFileRefused('invalid_filename');
  if (file.bytes.byteLength === 0) throw new WhatsAppFileRefused('empty');
  if (file.bytes.byteLength > Math.min(rule.maxBytes, WHATSAPP_MEDIA_DOWNLOAD_LIMIT_BYTES)) throw new WhatsAppFileRefused('too_large');
  return rule.kind;
};

export type WhatsAppMediaUploader = (file: WhatsAppOutboundFile) => Promise<string>;

// The bound grows with the payload: the 15 s message bound would cut off a large upload mid-body.
const uploadTimeoutMs = (bytes: number) => WHATSAPP_API_TIMEOUT_MS + Math.ceil(bytes / (512 * 1024)) * 1000;

export const createWhatsAppMediaUploader = (token: string, phoneNumberId: string, fetcher: typeof fetch = fetch): WhatsAppMediaUploader => async (file) => {
  whatsappOutboundKind(file);
  const form = new FormData();
  form.set('messaging_product', 'whatsapp');
  form.set('type', file.mime);
  form.set('file', new File([file.bytes], file.filename, { type: file.mime }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), uploadTimeoutMs(file.bytes.byteLength));
  try {
    const response = await fetcher(`https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${encodeURIComponent(phoneNumberId)}/media`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form, signal: controller.signal,
    });
    if (!response.ok) throw new Error(`whatsapp media upload ${response.status}`);
    const { id } = await response.json() as { id?: unknown };
    if (typeof id !== 'string' || !id.trim()) throw new Error('whatsapp media upload returned no id');
    return id;
  } finally {
    clearTimeout(timer);
  }
};

type Caller = (method: string, body: object) => Promise<unknown>;
// What a held send answers instead of a provider receipt: the text is in Waldo's custody and goes out on the owner's next
// message (whatsapp-window.ts). It is not a delivery, and no caller may read it as one.
export const WHATSAPP_HELD = Object.freeze({ held: 'whatsapp_window' as const });
export const whatsappHeld = (result: unknown): boolean => (result as { held?: unknown } | null | undefined)?.held === WHATSAPP_HELD.held;
// Why the owner got a link text instead of the file: WhatsApp cannot carry it, the service window was closed, or earlier
// messages were still held and the file must not land ahead of them.
export type WhatsAppFileLinkReason = WhatsAppFileRefusal | 'window_closed' | 'behind_held';
// degraded: the link text was sent. held: the window layer holds the link text until the owner's next message.
export type WhatsAppFileOutcome =
  | Readonly<{ status: 'sent'; providerMessageId: string }>
  | Readonly<{ status: 'degraded'; reason: WhatsAppFileLinkReason }>
  | Readonly<{ status: 'held'; reason: WhatsAppFileLinkReason }>
  | Readonly<{ status: 'blocked' }>;

const REFUSAL_WORDS: Readonly<Record<WhatsAppFileRefusal, string>> = {
  unsupported_type: 'this file type', too_large: 'a file this large', empty: 'an empty file', invalid_filename: 'this file name',
};
export const whatsappFileLinkText = (file: WhatsAppOutboundFile, reason: WhatsAppFileLinkReason, link: string): string =>
  reason === 'window_closed' || reason === 'behind_held' ? `Here is ${file.filename}. ${link}` : `WhatsApp can't carry ${file.filename} (${REFUSAL_WORDS[reason]}). ${link}`;
// What a link text's send answered: nothing (the owner gate blocked it), held for the owner's next message, or sent.
export const whatsappLinkOutcome = (sent: unknown, reason: WhatsAppFileLinkReason): WhatsAppFileOutcome =>
  sent === undefined ? { status: 'blocked' } : whatsappHeld(sent) ? { status: 'held', reason } : { status: 'degraded', reason };

// Sends one file through the owner's gated, egress-guarded caller. A file WhatsApp cannot carry is a
// definite refusal made before any upload, so the owner gets a plain text instead, naming the file
// and carrying the caller's fallback (normally the owner-authenticated link), which is built only then. Any failure after the
// upload starts propagates: the document may have gone out, so no second message is sent.
export const deliverWhatsAppFile = async (call: Caller, chatId: number, file: WhatsAppOutboundFile, fallback: () => Promise<string>): Promise<WhatsAppFileOutcome> => {
  let ack: unknown;
  try {
    ack = await call('sendDocument', { chat_id: chatId, file });
  } catch (error) {
    if (!(error instanceof WhatsAppFileRefused)) throw error;
    return whatsappLinkOutcome(await call('sendMessage', { chat_id: chatId, text: whatsappFileLinkText(file, error.reason, await fallback()) }), error.reason);
  }
  if (ack === undefined) return { status: 'blocked' };
  const id = (ack as { messages?: { id?: unknown }[] }).messages?.[0]?.id;
  if (typeof id !== 'string' || !id) throw new Error('invalid WhatsApp acknowledgement');
  return { status: 'sent', providerMessageId: id };
};

export const WA_UPDATE_BASE = 9_000_000_000_000;

// The Cloud API marks a forward in a message's context, which can also carry reply context: only the two flags are read.
const waForwardContextSchema = z.object({ forwarded: z.boolean().optional(), frequently_forwarded: z.boolean().optional() });

type WaLocation = { latitude?: unknown; longitude?: unknown; name?: unknown; address?: unknown };
type WaContactCard = { name?: { formatted_name?: unknown }; phones?: { phone?: unknown }[]; emails?: { email?: unknown }[] };
export type WaIngressMessage = Readonly<{
  id?: string; from?: string; type?: string; context?: Readonly<z.infer<typeof waForwardContextSchema>>; text?: { body?: string };
  audio?: { id?: string; mime_type?: string; voice?: boolean }; image?: { id?: string; mime_type?: string; caption?: string };
  document?: { id?: string; filename?: string; mime_type?: string; caption?: string }; location?: WaLocation; contacts?: WaContactCard[];
}>;
export type WaSyntheticUpdate = Readonly<Record<string, unknown>>;

// A context that does not match the schema counts as a forward: text Waldo cannot vouch for is never the owner's command.
export const whatsappForwarded = (message: WaIngressMessage): boolean => {
  if (message.context === undefined) return false;
  const context = waForwardContextSchema.safeParse(message.context);
  return !context.success || context.data.forwarded === true || context.data.frequently_forwarded === true;
};

// Normalization for WhatsApp ingress: each of the owner's text messages becomes a
// telegram-shaped update (subject digits double as the numeric owner/chat id; ids live in the
// 9e12 namespace so they never collide with telegram update ids). An approval reply "a:p12"
// synthesizes the equivalent callback_query because WhatsApp buttons carry no callback_data.
// An audio message becomes the voice/audio media update the shared transcriber path already
// reads (file_id carries the WhatsApp media id; the owner DO's per-channel downloader resolves
// it through the Graph two-step). An image message becomes the photo update the shared media
// path reads (A6), and a document the document update (PDFs, office files and the rest go through the shared file path's
// own type and size checks); a caption is owner text, so it gets the same artifact quarantine as a text body. A shared
// location or contact card becomes text in the sender's words. A type Waldo cannot open (video, sticker, anything new)
// becomes a bare message the shared parser classes as unsupported, so the owner gets the honest unsupported reply rather
// than silence. A reaction, a system notice and a welcome request need no answer; they and any foreign sender are skipped.
const SILENT_TYPES = new Set(['reaction', 'system', 'request_welcome']);
const quarantined = (text: string): string => {
  const q = quarantineArtifacts(text);
  return q.kinds.length === 0 ? text : onlyArtifacts(q) ? `[quarantined: ${q.kinds.join('/')} artifact - see your WhatsApp thread]` : q.text;
};
const captionOf = (caption: string | undefined) => {
  const text = (caption ?? '').trim();
  return text ? { caption: quarantined(text).slice(0, 1024) } : {};
};
const fieldText = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const locationText = (location: WaLocation | undefined): string | null => {
  const { latitude, longitude } = location ?? {};
  if (typeof latitude !== 'number' || typeof longitude !== 'number' || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const label = [fieldText(location?.name), fieldText(location?.address)].filter(Boolean).join(', ');
  return `Shared a location: ${label ? `${label} ` : ''}(${latitude}, ${longitude})`;
};
const contactsText = (contacts: readonly WaContactCard[] | undefined): string | null => {
  const cards = (Array.isArray(contacts) ? contacts : []).map(card => [
    fieldText(card?.name?.formatted_name),
    ...(Array.isArray(card?.phones) ? card.phones.map((phone: { phone?: unknown } | undefined) => fieldText(phone?.phone)) : []),
    ...(Array.isArray(card?.emails) ? card.emails.map((email: { email?: unknown } | undefined) => fieldText(email?.email)) : []),
  ].filter(Boolean).join(', ')).filter(Boolean);
  return cards.length === 0 ? null : `${cards.length === 1 ? 'Shared a contact' : 'Shared contacts'}: ${cards.join('; ')}`;
};

export const whatsappIngressUpdates = (messages: readonly WaIngressMessage[], subject: string, seqStart: number): { updates: WaSyntheticUpdate[]; seq: number } => {
  let seq = seqStart;
  const ownerNum = Number(subject);
  const updates: WaSyntheticUpdate[] = [];
  for (const message of messages) {
    if (message.from !== subject) continue;
    // A forward carries Bot API's MessageOrigin, the mark isForward and the turn parser read, so it runs as someone else's
    // text and never as a command or an approval reply. WhatsApp names neither the original sender nor when it was first
    // sent: the origin is a hidden user, and the time Waldo received it stands in.
    const forwarded = whatsappForwarded(message);
    const origin = forwarded ? { forward_origin: { type: 'hidden_user', date: Math.floor(Date.now() / 1000) } } : {};
    const push = (content: object) => { seq += 1; updates.push({ update_id: WA_UPDATE_BASE + seq, message: { from: { id: ownerNum, is_bot: false }, chat: { id: ownerNum, type: 'private' }, ...origin, ...content } }); };
    if (message.type === 'audio' || message.type === 'image' || message.type === 'document') {
      if (message.type === 'audio' && message.audio?.id) {
        const { id, mime_type, voice } = message.audio;
        push({ [voice === false ? 'audio' : 'voice']: { file_id: id, ...(mime_type ? { mime_type } : {}) } });
      } else if (message.type === 'image' && message.image?.id) {
        push({ photo: [{ file_id: message.image.id }], ...captionOf(message.image.caption) });
      } else if (message.type === 'document' && message.document?.id) {
        const { id, filename, mime_type, caption } = message.document;
        push({
          document: { file_id: id, ...(fieldText(filename) ? { file_name: fieldText(filename)!.slice(0, 256) } : {}), ...(fieldText(mime_type) ? { mime_type: fieldText(mime_type)!.slice(0, 128) } : {}) },
          ...captionOf(caption),
        });
      }
      continue;
    }
    if (message.type === 'location' || message.type === 'contacts') {
      const text = message.type === 'location' ? locationText(message.location) : contactsText(message.contacts);
      push(text ? { text: quarantined(text).slice(0, 4096) } : { whatsapp_type: message.type });
      continue;
    }
    if (message.type !== 'text') {
      if (!SILENT_TYPES.has(message.type ?? '')) push({ whatsapp_type: message.type ?? 'unknown' });
      continue;
    }
    const text = (message.text?.body ?? '').trim();
    if (!text) continue;
    seq += 1;
    // E1 (issue #150): verification artifacts in the owner's inbound text are redacted before the
    // update exists, so no downstream consumer (turn pipeline, episodes, traces) ever sees the raw
    // code or link. The original stays owner-inspectable in their own WhatsApp thread. Approval
    // replies are channel commands that can never carry an artifact, so they skip the filter.
    if (!forwarded && /^([aseud]):(\S+)$/.exec(text)) {
      updates.push({ update_id: WA_UPDATE_BASE + seq, callback_query: { id: `wa-${message.id ?? seq}`, from: { id: ownerNum, is_bot: false }, data: text, message: { message_id: 0, chat: { id: ownerNum } } } });
      continue;
    }
    updates.push({ update_id: WA_UPDATE_BASE + seq, message: { from: { id: ownerNum, is_bot: false }, chat: { id: ownerNum, type: 'private' }, ...origin, text: quarantined(text) } });
  }
  return { updates, seq };
};

// Meta redelivers a webhook until it gets a 200, for up to 7 days
// (https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks/ , "Webhook delivery failure").
// A message id (wamid) is therefore remembered for 7 days from first sight. First sight is never earlier
// than Meta's first attempt, so a retry cannot outlive the record. A message is marked as it is accepted
// (at-most-once): a replayed turn could repeat effects, a failed one is reported to the owner by a fixed notice (whatsappTurn) and can be resent.
// Two wordings: a message whose turn never started is safe to resend; one whose turn started may have had effects.
export const WHATSAPP_UNSTARTED_NOTICE = 'I could not handle your last WhatsApp message. Please send it again.';
export const WHATSAPP_PARTIAL_NOTICE = 'I may have only partly handled your last WhatsApp message. Please check what happened before you resend it.';
export const WAMID_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
type WamidKv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void; delete(key: string): unknown; list<T>(options: { prefix: string }): Iterable<[string, T]> }>;
export const claimNewWhatsAppMessages = <M extends Readonly<{ id?: string }>>(kv: WamidKv, messages: readonly M[], now: number): M[] => {
  for (const [key, seen] of [...kv.list<number>({ prefix: 'wamid:' })]) if (now - seen >= WAMID_RETENTION_MS) kv.delete(key);
  const fresh: M[] = [];
  for (const message of messages) {
    if (typeof message.id !== 'string' || message.id === '') { fresh.push(message); continue; }
    const key = `wamid:${message.id}`;
    if (kv.get<number>(key) !== undefined) continue;
    kv.put(key, now);
    fresh.push(message);
  }
  return fresh;
};
