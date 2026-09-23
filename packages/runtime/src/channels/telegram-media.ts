import type { LLMAttachment } from '@waldo/contracts';
import type { TelegramMedia } from './telegram-polling';

// Telegram bots can download files up to 20 MB.
export const TELEGRAM_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const FILE_EXTENSIONS: Readonly<Record<string, string>> = {
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json', html: 'text/html', xml: 'application/xml',
  csv: 'text/csv', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  rtf: 'application/rtf', odt: 'application/vnd.oasis.opendocument.text', ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export type TelegramFileDownloader = (fileId: string) => Promise<Uint8Array>;
export type Transcriber = (audio: Uint8Array, filename: string, mimeType: string) => Promise<string>;
export type MediaReaders = Readonly<{ download?: TelegramFileDownloader; transcribe?: Transcriber }>;

export type LoadedMedia = Readonly<{ note: string; attachment?: LLMAttachment }>;

export const createTelegramFileDownloader = (token: string, fetcher: typeof fetch = fetch): TelegramFileDownloader => async (fileId) => {
  const meta = await fetcher(`https://api.telegram.org/bot${token}/getFile`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file_id: fileId }),
  });
  const json = await meta.json() as { ok: boolean; result?: { file_path?: string }; error_code?: number };
  if (!json.ok || !json.result?.file_path) throw new Error(`telegram getFile failed: ${json.error_code ?? 'no file_path'}`);
  const file = await fetcher(`https://api.telegram.org/file/bot${token}/${json.result.file_path}`);
  if (!file.ok) throw new Error(`telegram file download failed: ${file.status}`);
  return new Uint8Array(await file.arrayBuffer());
};

const readableAs = (media: TelegramMedia): Omit<LLMAttachment, 'data_base64'> | null => {
  if (media.kind === 'photo') return { kind: 'image', mime_type: 'image/jpeg', filename: 'photo.jpg' };
  const filename = media.fileName ?? 'file';
  if (media.mimeType && IMAGE_TYPES.has(media.mimeType)) return { kind: 'image', mime_type: media.mimeType, filename };
  const mime = FILE_EXTENSIONS[filename.split('.').pop()?.toLowerCase() ?? ''];
  return mime ? { kind: 'file', mime_type: mime, filename } : null;
};

const label = (media: TelegramMedia): string =>
  media.kind === 'photo' ? 'photo' : media.kind === 'voice' ? 'voice note' : media.kind === 'audio' ? `audio file "${media.fileName ?? 'unnamed'}"` : `file "${media.fileName ?? 'unnamed'}"`;

export const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

// The note goes into the conversation text so later turns know what was shared;
// the bytes ride only on the turn that received them.
export const loadTelegramMedia = async (media: TelegramMedia, { download, transcribe }: MediaReaders): Promise<LoadedMedia> => {
  const what = label(media);
  if (media.kind === 'voice' || media.kind === 'audio') return transcribeMedia(media, what, download, transcribe);
  const readable = readableAs(media);
  if (!readable) return { note: `[Owner sent a ${what}. This file type cannot be read yet.]` };
  if (media.fileSize !== null && media.fileSize > TELEGRAM_DOWNLOAD_LIMIT_BYTES) return { note: `[Owner sent a ${what} larger than 20 MB, which cannot be downloaded here.]` };
  if (!download) return { note: `[Owner sent a ${what}, but file reading is not set up here.]` };
  try {
    const bytes = await download(media.fileId);
    if (bytes.length > TELEGRAM_DOWNLOAD_LIMIT_BYTES) return { note: `[Owner sent a ${what} larger than 20 MB, which cannot be read here.]` };
    return { note: `[Owner sent a ${what}, attached.]`, attachment: { ...readable, data_base64: toBase64(bytes) } };
  } catch {
    return { note: `[Owner sent a ${what}, but it could not be downloaded.]` };
  }
};

const transcribeMedia = async (media: TelegramMedia, what: string, download?: TelegramFileDownloader, transcribe?: Transcriber): Promise<LoadedMedia> => {
  if (media.fileSize !== null && media.fileSize > TELEGRAM_DOWNLOAD_LIMIT_BYTES) return { note: `[Owner sent a ${what} larger than 20 MB, which cannot be downloaded here.]` };
  if (!download || !transcribe) return { note: `[Owner sent a ${what}, but voice reading is not set up here.]` };
  try {
    const text = (await transcribe(await download(media.fileId), media.fileName ?? 'audio', media.mimeType ?? 'application/octet-stream')).trim();
    return { note: text.length > 0 ? `[Owner sent a ${what}. Transcript: ${text}]` : `[Owner sent a ${what} with no speech that could be made out.]` };
  } catch {
    return { note: `[Owner sent a ${what}, but it could not be transcribed.]` };
  }
};
