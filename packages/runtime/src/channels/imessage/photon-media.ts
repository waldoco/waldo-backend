import { z } from 'zod';
import { LLM_ATTACHMENTS_MAX, opaqueIMessageIdSchema as id, type IMessageEvent, type LLMAttachment } from '@waldo/contracts';
import { normaliseHost } from '../../security/public-host';
import type { InboundPart } from '../owner-inbound-turn';
import { readableAs, toBase64 } from '../telegram-media';
import { PHOTON_ID } from './photon';

// Photos and files sent to Waldo on iMessage. A host forwards only Photon's metadata for each attachment; the owner's
// turn fetches the bytes from Photon itself, after Photon confirms the attachment is on a message that owner sent.
// The routes are the HTTP ones Photon's SDKs use: a project token from the Spectrum cloud (Basic project id and secret),
// then GET /v1/messages/{guid} and GET /v1/attachments/{guid}/data on the iMessage server (Bearer token).

export const PHOTON_ORIGINS = { token: 'https://spectrum.photon.codes', imessage: 'https://imessage.spectrum.photon.codes' } as const;
const PHOTON_HOSTS = new Set(Object.values(PHOTON_ORIGINS).map(origin => new URL(origin).hostname));
// One message's files sit in memory twice for the model call (the bytes, then base64): 20 MiB, what one Telegram file
// may carry, keeps that well inside a Worker's 128 MiB.
export const IMESSAGE_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
export const IMESSAGE_MEDIA_TIMEOUT_MS = 30_000;

/** What crosses from the bridge to the owner: Photon attachments carry Photon's id; a Mac host's files have none. */
export const iMessageMediaSchema = z.strictObject({
  messageGuid: id,
  files: z.array(z.strictObject({ id: id.optional(), name: id, mimeType: id, size: z.int().nonnegative() })).min(1),
});
export type IMessageMedia = z.infer<typeof iMessageMediaSchema>;
type MediaFile = IMessageMedia['files'][number];

export const iMessageMediaOf = (event: Pick<Extract<IMessageEvent, { kind: 'message' }>, 'messageGuid' | 'attachments' | 'photonAttachments'>): IMessageMedia | undefined => {
  const files: MediaFile[] = [
    ...(event.photonAttachments ?? []).map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size })),
    ...event.attachments.map(file => ({ name: file.filename, mimeType: file.mimeType, size: file.byteLength })),
  ];
  return files.length ? { messageGuid: event.messageGuid, files } : undefined;
};

export type PhotonMediaEnv = Readonly<{ PHOTON_PROJECT_ID?: string; PHOTON_PROJECT_SECRET?: string }>;
export type PhotonMediaCode = 'egress_refused' | 'token_refused' | 'token_unsupported' | 'not_in_message' | 'too_large' | 'attachment_unavailable' | 'unexpected_response' | 'unreachable';
export type PhotonAttachmentRequest = Readonly<{
  messageGuid: string; sender: string; files: readonly Readonly<{ id: string; mimeType: string }>[]; maxBytes: number; signal: AbortSignal;
}>;
export type PhotonAttachmentSource = (request: PhotonAttachmentRequest) => Promise<{ ok: true; bytes: readonly Uint8Array[] } | { ok: false; code: PhotonMediaCode }>;

class Refused extends Error { constructor(readonly code: PhotonMediaCode) { super(code); } }

const tokenSchema = z.object({ succeed: z.literal(true), data: z.discriminatedUnion('type', [
  z.object({ type: z.literal('shared'), token: z.string().min(1) }), z.object({ type: z.literal('dedicated') }),
]) });
// Proto3 JSON leaves out fields at their default, so an absent isFromMe is false.
const messageSchema = z.object({ message: z.object({
  isFromMe: z.boolean().optional(), sender: z.object({ address: z.string() }).optional(),
  content: z.object({ attachments: z.array(z.object({ guid: z.string(), mimeType: z.string().optional(), totalBytes: z.coerce.number().int().nonnegative().optional() })).optional() }).optional(),
}) });

const allowedOrigin = (origin: string): string | null => {
  try {
    const url = new URL(origin), host = normaliseHost(url.hostname);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && host !== null && PHOTON_HOSTS.has(host) ? url.origin : null;
  } catch { return null; }
};

const readBounded = async (response: Response, budget: number): Promise<Uint8Array> => {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > budget) { await reader.cancel(); throw new Refused('too_large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
};

/**
 * The seam to Photon. Every failure is a fixed code: no URL, id, token or secret reaches a result, a log or an error.
 * Redirects are never followed, so no answer can send a request off the two allowlisted hosts.
 */
export const photonAttachmentSource = (env: PhotonMediaEnv, fetcher: typeof fetch = fetch, origins: Readonly<{ token: string; imessage: string }> = PHOTON_ORIGINS): PhotonAttachmentSource | null => {
  const projectId = env.PHOTON_PROJECT_ID ?? '', secret = env.PHOTON_PROJECT_SECRET ?? '';
  if (!PHOTON_ID.test(projectId) || !secret) return null;
  return async ({ messageGuid, sender, files, maxBytes, signal }) => {
    const tokenOrigin = allowedOrigin(origins.token), imessageOrigin = allowedOrigin(origins.imessage);
    if (!tokenOrigin || !imessageOrigin) return { ok: false, code: 'egress_refused' };
    try {
      const minted = await fetcher(`${tokenOrigin}/projects/${encodeURIComponent(projectId)}/imessage/tokens`,
        { method: 'POST', headers: { authorization: `Basic ${btoa(`${projectId}:${secret}`)}` }, redirect: 'manual', signal });
      if (!minted.ok) throw new Refused('token_refused');
      const issued = tokenSchema.safeParse(await minted.json());
      if (!issued.success) throw new Refused('unexpected_response');
      if (issued.data.data.type !== 'shared') throw new Refused('token_unsupported');
      const headers = { authorization: `Bearer ${issued.data.data.token}` };
      const found = await fetcher(`${imessageOrigin}/v1/messages/${encodeURIComponent(messageGuid)}`, { headers, redirect: 'manual', signal });
      if (!found.ok) throw new Refused('not_in_message');
      const read = messageSchema.safeParse(await found.json());
      if (!read.success) throw new Refused('unexpected_response');
      const message = read.data.message, held = message.content?.attachments ?? [];
      const described = files.map(file => held.find(attachment => attachment.guid === file.id && attachment.mimeType === file.mimeType));
      if (message.isFromMe === true || message.sender?.address !== sender || described.some(attachment => !attachment)) throw new Refused('not_in_message');
      if (described.reduce((sum, attachment) => sum + (attachment!.totalBytes ?? 0), 0) > maxBytes) throw new Refused('too_large');
      const bytes: Uint8Array[] = [];
      let budget = maxBytes;
      for (const file of files) {
        const data = await fetcher(`${imessageOrigin}/v1/attachments/${encodeURIComponent(file.id)}/data`, { headers, redirect: 'manual', signal });
        if (data.status === 404 || data.status === 410) throw new Refused('attachment_unavailable');
        if (!data.ok) throw new Refused('unexpected_response');
        const body = await readBounded(data, budget);
        budget -= body.length; bytes.push(body);
      }
      return { ok: true, bytes };
    } catch (error) {
      return { ok: false, code: error instanceof Refused ? error.code : 'unreachable' };
    }
  };
};

const isVoice = (file: MediaFile) => file.mimeType.toLowerCase().startsWith('audio/') || file.name.toLowerCase().endsWith('.caf');
const phrasing = (files: readonly MediaFile[]) => {
  const many = files.length > 1, photos = files.every(file => file.mimeType.toLowerCase().startsWith('image/'));
  return { what: `${photos ? 'photo' : 'file'}${many ? 's' : ''}`, it: many ? 'them' : 'it', is: many ? 'they are' : 'it is' };
};
// Fixed copy: each states what Waldo could not do with what it received, and where it can be done instead.
export const IMESSAGE_MEDIA_REPLIES = {
  voice: "I can't listen to voice notes here yet; type it out or send it in the app.",
  unreadable: "I couldn't read your last message: it reached me with nothing I can open. If it was a long paste, send it in a few shorter parts.",
  unopened: (files: readonly MediaFile[]) => { const s = phrasing(files); return `I got your ${s.what} but couldn't open ${s.it} here; send ${s.it} in the app.`; },
  format: (files: readonly MediaFile[]) => { const s = phrasing(files); return `I got your ${s.what} but can't read that format here; send ${s.it} in the app.`; },
  size: (files: readonly MediaFile[]) => { const s = phrasing(files); return `I got your ${s.what} but ${s.is} too large to open here; send ${s.it} in the app.`; },
  tooMany: (files: readonly MediaFile[]) => `I got your ${phrasing(files).what} but can open at most ${LLM_ATTACHMENTS_MAX} at once here; send them in smaller batches or in the app.`,
} as const;

/** What the owner sent, as the model and the conversation read it beside the files. */
export const iMessageMediaNotes = (files: readonly MediaFile[]): readonly InboundPart[] => files.map(file => ({ authorship: 'media_note',
  text: readableAs({ kind: 'document', fileId: '', fileName: file.name, mimeType: file.mimeType, fileSize: file.size })?.kind === 'image'
    ? '[Owner sent a photo, attached.]' : `[Owner sent a file "${file.name}", attached.]` }));

export type OpenedIMessageMedia =
  | Readonly<{ kind: 'opened'; parts: readonly InboundPart[]; attachments: readonly LLMAttachment[] }>
  | Readonly<{ kind: 'reply'; text: string }>;
export type OpenIMessageMediaDeps = Readonly<{ enabled: boolean; source: PhotonAttachmentSource | null; sender: string; signal: AbortSignal; admit: () => void }>;

/** Either every file reaches the model, or the owner gets one fixed reply saying why none did. Logs carry codes only. */
export const openIMessageMedia = async (media: IMessageMedia, deps: OpenIMessageMediaDeps): Promise<OpenedIMessageMedia> => {
  const { files } = media;
  const reply = (text: string, code: string): OpenedIMessageMedia => {
    console.log(JSON.stringify({ hop: 'imessage_media', ok: false, code }));
    return { kind: 'reply', text };
  };
  if (files.some(isVoice)) return reply(IMESSAGE_MEDIA_REPLIES.voice, 'voice_note');
  if (!deps.enabled) return reply(IMESSAGE_MEDIA_REPLIES.unopened(files), 'media_off');
  if (files.length > LLM_ATTACHMENTS_MAX) return reply(IMESSAGE_MEDIA_REPLIES.tooMany(files), 'too_many');
  const readable = files.map(file => readableAs({ kind: 'document', fileId: '', fileName: file.name, mimeType: file.mimeType, fileSize: file.size }));
  if (readable.some(kind => kind === null)) return reply(IMESSAGE_MEDIA_REPLIES.format(files), 'unreadable_type');
  if (files.reduce((sum, file) => sum + file.size, 0) > IMESSAGE_MEDIA_MAX_BYTES) return reply(IMESSAGE_MEDIA_REPLIES.size(files), 'too_large');
  const ids = files.map(file => file.id);
  if (!deps.source || ids.some(fileId => fileId === undefined)) return reply(IMESSAGE_MEDIA_REPLIES.unopened(files), deps.source ? 'not_on_photon' : 'photon_unconfigured');
  deps.admit();
  const fetched = await deps.source({ messageGuid: media.messageGuid, sender: deps.sender, files: files.map(file => ({ id: file.id!, mimeType: file.mimeType })),
    maxBytes: IMESSAGE_MEDIA_MAX_BYTES, signal: AbortSignal.any([deps.signal, AbortSignal.timeout(IMESSAGE_MEDIA_TIMEOUT_MS)]) });
  deps.admit();
  if (!fetched.ok || fetched.bytes.length !== files.length) return reply(IMESSAGE_MEDIA_REPLIES.unopened(files), fetched.ok ? 'unexpected_response' : fetched.code);
  console.log(JSON.stringify({ hop: 'imessage_media', ok: true, files: files.length }));
  return {
    kind: 'opened',
    parts: iMessageMediaNotes(files),
    attachments: readable.map((kind, index) => ({ ...kind!, data_base64: toBase64(fetched.bytes[index]!) })),
  };
};
