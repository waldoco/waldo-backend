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
    const timer = setTimeout(() => controller.abort(), WHATSAPP_API_TIMEOUT_MS);
    try {
      const response = await fetcher(`https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`whatsapp ${response.status}: ${(await response.text()).slice(0, 200)}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  };

export const sendWhatsAppText = (call: WhatsAppCall, to: string, text: string) =>
  call({ to, type: 'text', text: { body: text } });

// Telegram-shaped compatibility caller. WhatsApp currently uses explicit text
// instructions for approvals and exact URL text for link buttons. Unsupported
// Telegram operations return no receipt, never a fabricated successful result.
export type TelegramShimCall = (method: string, body: object) => Promise<unknown>;

export const whatsappTelegramShim = (token: string, phoneNumberId: string, to: string, fetcher: typeof fetch = fetch): TelegramShimCall => {
  const call = createWhatsAppCaller(token, phoneNumberId, fetcher);
  return async (method, body) => {
    if (method === 'sendMessage') {
      const b = body as { text: string; fallback_text?: string; reply_markup?: { inline_keyboard?: { text: string; callback_data?: string; url?: string }[][] } };
      const buttons = (b.reply_markup?.inline_keyboard ?? []).flat().filter((x) => x.callback_data || x.url);
      const suffix = buttons.length ? `\n\n${buttons.map((x) => x.url ? `- ${x.text}: ${x.url}` : `- ${x.text}: reply "${x.callback_data}"`).join('\n')}` : '';
      return sendWhatsAppText(call, to, (b.fallback_text ?? b.text) + suffix);
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

export const WA_UPDATE_BASE = 9_000_000_000_000;

export type WaIngressMessage = Readonly<{ id?: string; from?: string; type?: string; text?: { body?: string }; audio?: { id?: string; mime_type?: string; voice?: boolean }; image?: { id?: string; mime_type?: string; caption?: string } }>;
export type WaSyntheticUpdate = Readonly<Record<string, unknown>>;

// Pure normalization for /whatsapp-turn: each of the owner's text messages becomes a
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
    if (message.type === 'audio' && message.audio?.id) {
      seq += 1;
      const audio = message.audio;
      const media = audio.voice === false
        ? { audio: { file_id: audio.id, ...(audio.mime_type ? { mime_type: audio.mime_type } : {}) } }
        : { voice: { file_id: audio.id, ...(audio.mime_type ? { mime_type: audio.mime_type } : {}) } };
      updates.push({ update_id: WA_UPDATE_BASE + seq, message: { from: { id: ownerNum }, chat: { id: ownerNum, type: 'private' }, ...media } });
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
          from: { id: ownerNum }, chat: { id: ownerNum, type: 'private' },
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
    if (/^([aseu]):(\S+)$/.exec(text)) {
      updates.push({ update_id: WA_UPDATE_BASE + seq, callback_query: { id: `wa-${message.id ?? seq}`, from: { id: ownerNum }, data: text, message: { message_id: 0, chat: { id: ownerNum } } } });
      continue;
    }
    const q = quarantineArtifacts(text);
    const clean = q.kinds.length === 0 ? text : onlyArtifacts(q) ? `[quarantined: ${q.kinds.join('/')} artifact - see your WhatsApp thread]` : q.text;
    updates.push({ update_id: WA_UPDATE_BASE + seq, message: { from: { id: ownerNum }, chat: { id: ownerNum, type: 'private' }, text: clean } });
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
