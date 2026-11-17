import { CHAT_URL, ChatRequestError, request } from './chat-model';

// A chat attachment from the console, sent the way the app sends one (packages/contracts/src/app/core.ts, the upload route): the raw
// bytes under their own content type, the kind and the percent-encoded name in headers, then a send that names the upload id with the
// words as its caption. One attachment per message. The values below are the contract's; chat-attachments.test checks they agree.
// They are copied rather than imported because core.ts would bring zod and every app schema into the page.
export const UPLOAD_URL = `${CHAT_URL}/uploads`;
export const UPLOAD_KIND_HEADER = 'x-waldo-upload-kind';
export const UPLOAD_NAME_HEADER = 'x-waldo-upload-name';
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const CAPTION_MAX_CHARS = 1024;
// The image types the upload route takes as a photo. Any other file, an image of another type included, goes as a file.
export const PHOTO_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
// The longest name the route takes for a file.
export const NAME_MAX_CHARS = 128;

export type AttachmentKind = 'photo' | 'file';
export type UploadResult = { upload_id: string; bytes: number };

// The type a file is sent under: what the browser says it is, without parameters, or a plain byte stream when it says nothing.
// The route takes any well-formed type for a file; Waldo reads a file by its name's extension.
export const uploadType = (file: Pick<File, 'type'>): string => {
  const type = file.type.split(';')[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(type) ? type : 'application/octet-stream';
};
export const kindOf = (file: Pick<File, 'type'>): AttachmentKind => PHOTO_TYPES.includes(uploadType(file)) ? 'photo' : 'file';

// A name the route takes: one plain name with no path, no control characters and no leading dot, at most NAME_MAX_CHARS long,
// shortened before its extension so the extension still says what the file is.
export const plainName = (raw: string): string => {
  const last = raw.split(/[\\/]/).pop() ?? '';
  let name = last.replace(/\p{Cc}/gu, '').trim().replace(/^\.+/, '');
  if (!name) return 'file';
  const chars = [...name];
  if (chars.length > NAME_MAX_CHARS) {
    const dot = name.lastIndexOf('.'), ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = chars.slice(0, NAME_MAX_CHARS - [...ext].length).join('').trimEnd() + ext;
  }
  return name;
};

// The status the route would answer for this file before any of it is sent, or null when it would take it. The route stays the
// authority; this only saves sending what it would refuse.
export const uploadRefusal = (file: Pick<File, 'size'>): 400 | 413 | null => file.size <= 0 ? 400 : file.size > UPLOAD_MAX_BYTES ? 413 : null;

export const ATTACHMENTS_OFF = 'Waldo doesn’t take attachments here yet.';
export const ATTACHMENT_GONE = 'That attachment is no longer available to send. Attach it again.';
export const ONE_ATTACHMENT = 'One attachment per message. Send or remove this one first.';
export const ONLY_FIRST = 'One attachment per message, so only the first was attached.';
const MB = Math.round(UPLOAD_MAX_BYTES / (1024 * 1024));

// What the chip says when an upload did not go, from its status (0 is the network), never the server's own words.
export const uploadFailureLine = (status: number, kind: AttachmentKind): string => {
  const what = kind === 'photo' ? 'image' : 'file';
  switch (status) {
    case 400: return `Waldo couldn’t take that ${what}. Try a different one.`;
    case 404: return ATTACHMENTS_OFF;
    case 413: return `That ${what} is too big. The limit is ${MB} MB.`;
    case 415: return `Waldo can’t take that kind of ${what}.`;
    case 429: return 'Too many attachments at once, or too fast. Send or remove one, then try again in a moment.';
    default: return `The ${what} didn’t upload. Try again.`;
  }
};
// Only a busy server or a dropped connection is worth trying again with the same bytes.
export const retryable = (status: number) => status === 0 || status === 429 || status >= 500;

export const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

const obj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export const uploadChatAttachment = async (file: File, signal?: AbortSignal): Promise<UploadResult> => {
  const value = await request(UPLOAD_URL, { method: 'POST', body: file, signal, headers: {
    'content-type': uploadType(file), [UPLOAD_KIND_HEADER]: kindOf(file), [UPLOAD_NAME_HEADER]: encodeURIComponent(plainName(file.name)),
  } });
  if (!obj(value) || typeof value.upload_id !== 'string' || !/^up_[A-Za-z0-9_-]{22}$/.test(value.upload_id) || typeof value.bytes !== 'number')
    throw new ChatRequestError(500, 'Waldo took the file but its receipt was unreadable.');
  return { upload_id: value.upload_id, bytes: value.bytes };
};
