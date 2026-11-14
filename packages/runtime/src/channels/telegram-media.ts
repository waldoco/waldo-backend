import type { LLMAttachment } from '@waldo/contracts';
import type { InboundPart } from './owner-inbound-turn';
import type { TelegramMedia } from './telegram-polling';
import type { RunEffectScope } from './run-effect-scope';
import { keptNote, type UploadKeeper } from './upload-keeper';
import { modelFile, readableFile, typeUndeclared, type ModelFile, type ReadableFile } from './readable-file';

// Telegram bots can download files up to 20 MB.
export const TELEGRAM_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

export type TelegramFileDownloader = (fileId: string) => Promise<Uint8Array>;
// signal: when given, the provider's request ends with it, so a turn cut short leaves no transcription still running.
export type Transcriber = (audio: Uint8Array, filename: string, mimeType: string, signal?: AbortSignal) => Promise<string>;
// keep: present with WALDO_FILE_TOOLS on. Every photo and document is then downloaded and kept in the owner's workspace,
// whatever its type; the model still gets the readable ones attached.
// keeper: the host's factory for it, bound to the running turn's scope.
export type MediaReaders = Readonly<{ download?: TelegramFileDownloader; transcribe?: Transcriber; keep?: UploadKeeper; keeper?: (scope: RunEffectScope) => UploadKeeper }>;

export type LoadedMedia = Readonly<{ parts: readonly InboundPart[]; attachment?: LLMAttachment }>;
const noted = (text: string): readonly InboundPart[] => [{ authorship: 'media_note', text }];

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

// A file the model can read, by what it declares. A photo is an image; its bytes, once read, say which kind.
export const readableAs = (media: TelegramMedia): ReadableFile | null =>
  media.kind === 'photo' ? { kind: 'image', mime_type: 'image/jpeg', filename: 'photo.jpg' } : readableFile(media.mimeType, media.fileName ?? 'file');
// What the model is handed for the downloaded file, judged again by its bytes.
const fileOf = (media: TelegramMedia, bytes: Uint8Array): Promise<ModelFile | null> =>
  modelFile(bytes, media.kind === 'photo' ? 'image/jpeg' : media.mimeType, media.kind === 'photo' ? 'photo.jpg' : media.fileName ?? 'file');

// A download that failed is logged by the reader's own error text, which names the step and the provider's status and
// never a token, URL or file name.
const downloadFailed = (media: TelegramMedia, error: unknown) =>
  console.log(JSON.stringify({ hop: 'media_download', ok: false, kind: media.kind, error: error instanceof Error ? error.message.slice(0, 120) : 'unknown' }));

// An office file reaches the model as the text read out of it, which the note says, so the model does not describe layout,
// images or formulas it never saw.
const asText = (file: ModelFile): string => file.extracted ? ' as its text only' : '';

const label = (media: TelegramMedia): string =>
  media.kind === 'photo' ? 'photo' : media.kind === 'voice' ? 'voice note' : media.kind === 'audio' ? `audio file "${media.fileName ?? 'unnamed'}"` : `file "${media.fileName ?? 'unnamed'}"`;

export { toBase64 } from './readable-file';

// The note joins the conversation so later turns know what was shared; the bytes ride only on the turn
// that received them. A transcript is its own part: the speaker may be someone other than the owner.
export const loadTelegramMedia = async (media: TelegramMedia, { download, transcribe, keep }: MediaReaders): Promise<LoadedMedia> => {
  const noun = `${media.forwarded ? 'forwarded ' : ''}${label(media)}`, what = `${/^[aeiou]/.test(noun) ? 'an' : 'a'} ${noun}`;
  if (media.kind === 'voice' || media.kind === 'audio') return transcribeMedia(media, what, download, transcribe);
  if (keep && download && (media.fileSize === null || media.fileSize <= TELEGRAM_DOWNLOAD_LIMIT_BYTES)) return keepMedia(media, what, download, keep);
  // A file that declares no type may still be one the model reads, so its bytes are read to tell.
  if (!readableAs(media) && !typeUndeclared(media.mimeType)) return { parts: noted(`[Owner sent ${what}. This file type cannot be read yet.]`) };
  if (media.fileSize !== null && media.fileSize > TELEGRAM_DOWNLOAD_LIMIT_BYTES) return { parts: noted(`[Owner sent ${what} larger than 20 MB, which cannot be downloaded here.]`) };
  if (!download) return { parts: noted(`[Owner sent ${what}, but file reading is not set up here.]`) };
  let bytes: Uint8Array;
  try { bytes = await download(media.fileId); } catch (error) {
    downloadFailed(media, error);
    return { parts: noted(`[Owner sent ${what}, but it could not be downloaded.]`) };
  }
  if (bytes.length > TELEGRAM_DOWNLOAD_LIMIT_BYTES) return { parts: noted(`[Owner sent ${what} larger than 20 MB, which cannot be read here.]`) };
  const file = await fileOf(media, bytes);
  if (!file) return { parts: noted(`[Owner sent ${what}. This file type cannot be read yet.]`) };
  return { parts: noted(`[Owner sent ${what}, attached${asText(file)}.]`), attachment: file.attachment };
};

const keepMedia = async (media: TelegramMedia, what: string, download: TelegramFileDownloader, keep: UploadKeeper): Promise<LoadedMedia> => {
  let bytes: Uint8Array;
  try { bytes = await download(media.fileId); } catch (error) {
    downloadFailed(media, error);
    return { parts: noted(`[Owner sent ${what}, but it could not be downloaded.]`) };
  }
  if (bytes.length > TELEGRAM_DOWNLOAD_LIMIT_BYTES) return { parts: noted(`[Owner sent ${what} larger than 20 MB, which cannot be read here.]`) };
  const file = await fileOf(media, bytes);
  const filename = file?.file.filename ?? media.fileName ?? 'file';
  const kept = await keep({ bytes, filename, mime: file?.file.mime_type ?? media.mimeType, key: `media:${media.fileId}`, ...(media.forwarded ? { forwarded: true } : {}) });
  return { parts: noted(keptNote(what, kept, file !== null, file?.extracted)), ...(file ? { attachment: file.attachment } : {}) };
};

const transcribeMedia = async (media: TelegramMedia, what: string, download?: TelegramFileDownloader, transcribe?: Transcriber): Promise<LoadedMedia> => {
  if (media.fileSize !== null && media.fileSize > TELEGRAM_DOWNLOAD_LIMIT_BYTES) return { parts: noted(`[Owner sent ${what} larger than 20 MB, which cannot be downloaded here.]`) };
  if (!download || !transcribe) return { parts: noted(`[Owner sent ${what}, but voice reading is not set up here.]`) };
  try {
    const text = (await transcribe(await download(media.fileId), media.fileName ?? 'audio', media.mimeType ?? 'application/octet-stream')).trim();
    // Telegram marks a forward, so a forwarded recording is someone else speaking, whatever it says.
    return { parts: text.length > 0 ? [...noted(`[Owner sent ${what}.]`), { authorship: media.forwarded ? 'forwarded' : 'file_transcript', text }] : noted(`[Owner sent ${what} with no speech that could be made out.]`) };
  } catch {
    return { parts: noted(`[Owner sent ${what}, but it could not be transcribed.]`) };
  }
};
