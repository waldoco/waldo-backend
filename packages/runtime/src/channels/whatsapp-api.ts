import { z } from 'zod';
import { onlyArtifacts, quarantineArtifacts } from '../security/artifact-hygiene';
// WhatsApp Cloud API surface (WHATSAPP_CHANNEL_SPEC W2-W4): the raw caller for the webhook's
// link-code replies, the telegram-shaped send shim the owner DO wraps in the same
// gatedCaller/egressGuardedCaller gate as Telegram (W3), the two-step media downloader that
// feeds voice notes to the shared transcriber (W4), and the ingress normalization below.
export type WhatsAppCall = (body: object) => Promise<unknown>;

// Match the existing Telegram transport bound. A timed-out POST is uncertain,
// so this caller never retries and never reports a successful acknowledgement.
export const WHATSAPP_API_TIMEOUT_MS = 15_000;
export const WHATSAPP_GRAPH_VERSION = 'v21.0';
export const createWhatsAppCaller = (token: string, phoneNumberId: string, fetcher: typeof fetch = fetch): WhatsAppCall =>
  async (body) => {
    const controller = new AbortController();
    let timer:ReturnType<typeof setTimeout>;
    const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('whatsapp send timed out; delivery uncertain'));},WHATSAPP_API_TIMEOUT_MS);});
    try {
      const response = await Promise.race([fetcher(`https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
        signal: controller.signal,
      }),timeout]);
      if (!response.ok) throw new Error(`whatsapp ${response.status}: ${(await Promise.race([response.text(),timeout])).slice(0, 200)}`);
      return await Promise.race([response.json(),timeout]);
    } finally {
      clearTimeout(timer!);
    }
  };

// preview_url makes WhatsApp fetch the first http(s) link with no tap from the owner, so it is opt-in per send.
export const sendWhatsAppText = (call: WhatsAppCall, to: string, text: string, preview = false) =>
  call({ to, type: 'text', text: { body: text, ...(preview && /https?:\/\//i.test(text) ? { preview_url: true } : {}) } });

// Telegram-shaped compatibility caller. WhatsApp currently uses explicit text
// instructions for approvals and exact URL text for link buttons. sendDocument
// uploads the file and sends it by media id (deliverWhatsAppFile is its caller).
// Unsupported Telegram operations return no receipt, never a fabricated successful result.
export type TelegramShimCall = (method: string, body: object) => Promise<unknown>;

export const whatsappTelegramShim = (token: string, phoneNumberId: string, to: string, fetcher: typeof fetch = fetch): TelegramShimCall => {
  const call = createWhatsAppCaller(token, phoneNumberId, fetcher);
  const upload = createWhatsAppMediaUploader(token, phoneNumberId, fetcher);
  return async (method, body) => {
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
      return sendWhatsAppText(call, to, (b.fallback_text ?? b.text) + suffix, b.link_preview_options?.is_disabled !== true);
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
export type WhatsAppFileOutcome =
  | Readonly<{ status: 'sent'; providerMessageId: string }>
  | Readonly<{ status: 'degraded'; reason: WhatsAppFileRefusal }>
  | Readonly<{ status: 'blocked' }>;

const REFUSAL_WORDS: Readonly<Record<WhatsAppFileRefusal, string>> = {
  unsupported_type: 'this file type', too_large: 'a file this large', empty: 'an empty file', invalid_filename: 'this file name',
};

// Sends one file through the owner's gated, egress-guarded caller. A file WhatsApp cannot carry is a
// definite refusal made before any upload, so the owner gets a plain text instead, naming the file
// and carrying the caller's fallback (normally the owner-authenticated link). Any failure after the
// upload starts propagates: the document may have gone out, so no second message is sent.
export const deliverWhatsAppFile = async (call: Caller, chatId: number, file: WhatsAppOutboundFile, fallback: string): Promise<WhatsAppFileOutcome> => {
  let ack: unknown;
  try {
    ack = await call('sendDocument', { chat_id: chatId, file });
  } catch (error) {
    if (!(error instanceof WhatsAppFileRefused)) throw error;
    const sent = await call('sendMessage', { chat_id: chatId, text: `WhatsApp can't carry ${file.filename} (${REFUSAL_WORDS[error.reason]}). ${fallback}` });
    return sent === undefined ? { status: 'blocked' } : { status: 'degraded', reason: error.reason };
  }
  if (ack === undefined) return { status: 'blocked' };
  const id = (ack as { messages?: { id?: unknown }[] }).messages?.[0]?.id;
  if (typeof id !== 'string' || !id) throw new Error('invalid WhatsApp acknowledgement');
  return { status: 'sent', providerMessageId: id };
};

export const WA_UPDATE_BASE = 9_000_000_000_000;

// The Cloud API marks a forward in a message's context, which can also carry reply context: only the two flags are read.
const waForwardContextSchema = z.object({ forwarded: z.boolean().optional(), frequently_forwarded: z.boolean().optional() });

export type WaIngressMessage = Readonly<{ id?: string; from?: string; type?: string; context?: Readonly<z.infer<typeof waForwardContextSchema>>; text?: { body?: string }; audio?: { id?: string; mime_type?: string; voice?: boolean }; image?: { id?: string; mime_type?: string; caption?: string } }>;
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
// path reads (A6); its caption is owner text, so it gets the same artifact quarantine as a
// text body. Other types and any foreign sender are skipped.
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
    if (message.type === 'audio' && message.audio?.id) {
      seq += 1;
      const audio = message.audio;
      const media = audio.voice === false
        ? { audio: { file_id: audio.id, ...(audio.mime_type ? { mime_type: audio.mime_type } : {}) } }
        : { voice: { file_id: audio.id, ...(audio.mime_type ? { mime_type: audio.mime_type } : {}) } };
      updates.push({ update_id: WA_UPDATE_BASE + seq, message: { from: { id: ownerNum, is_bot: false }, chat: { id: ownerNum, type: 'private' }, ...origin, ...media } });
      continue;
    }
    if (message.type === 'image' && message.image?.id) {
      seq += 1;
      const image = message.image;
      const caption = (image.caption ?? '').trim();
      const q = caption ? quarantineArtifacts(caption) : null;
      updates.push({
        update_id: WA_UPDATE_BASE + seq,
        message: {
          from: { id: ownerNum, is_bot: false }, chat: { id: ownerNum, type: 'private' }, ...origin,
          photo: [{ file_id: image.id }],
          ...(q === null ? {} : { caption: q.kinds.length === 0 ? caption : onlyArtifacts(q) ? `[quarantined: ${q.kinds.join('/')} artifact - see your WhatsApp thread]` : q.text }),
        },
      });
      continue;
    }
    if (message.type !== 'text') continue;
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
    const q = quarantineArtifacts(text);
    const clean = q.kinds.length === 0 ? text : onlyArtifacts(q) ? `[quarantined: ${q.kinds.join('/')} artifact - see your WhatsApp thread]` : q.text;
    updates.push({ update_id: WA_UPDATE_BASE + seq, message: { from: { id: ownerNum, is_bot: false }, chat: { id: ownerNum, type: 'private' }, ...origin, text: clean } });
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
