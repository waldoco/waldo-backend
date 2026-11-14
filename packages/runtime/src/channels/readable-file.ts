import type { LLMAttachment } from '@waldo/contracts';
import { detectBinary } from '@waldo/workspace';
import { isOfficeType, OFFICE_TYPES, officeText } from './office-text';

// Which files the model can read, shared by every surface a file reaches Waldo on (WhatsApp, the app, iMessage, agent mail,
// Telegram). A file is judged by what it declares and, once its bytes are in hand, by what its bytes are: a sender's file
// often arrives with no name, a name without an extension, or a generic type (a forwarded WhatsApp document, a mailed
// "image/jpg"), and a name alone must not decide that a PDF cannot be read.
export type ReadableFile = Omit<LLMAttachment, 'data_base64'>;

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
// Types senders use for these images that are not their registered names.
const IMAGE_ALIASES: Readonly<Record<string, string>> = { 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'image/x-png': 'image/png' };
const FILE_EXTENSIONS: Readonly<Record<string, string>> = {
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json', html: 'text/html', xml: 'application/xml',
  csv: 'text/csv', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  rtf: 'application/rtf', odt: 'application/vnd.oasis.opendocument.text', ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const EXTENSION_OF: Readonly<Record<string, string>> = Object.fromEntries([...Object.entries(FILE_EXTENSIONS).map(([ext, mime]) => [mime, ext]).reverse(), ['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'], ['image/gif', 'gif']]);
const FILE_TYPES = new Set(Object.values(FILE_EXTENSIONS));
// A type that says nothing about the file: the bytes decide.
const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/unknown', 'application/x-download', 'application/download']);

const typeOf = (mime: string | null | undefined): string => {
  const bare = (mime ?? '').split(';')[0]!.trim().toLowerCase();
  return IMAGE_ALIASES[bare] ?? bare;
};
const extensionOf = (filename: string): string => {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
};
// Providers read a file's kind from its name too (OpenAI's file input goes by the extension), so a readable file without
// the extension of its type is named with one.
const named = (filename: string, mime: string): string => {
  const ext = EXTENSION_OF[mime];
  return !ext || extensionOf(filename) === ext || (ext === 'jpg' && extensionOf(filename) === 'jpeg') ? filename : `${filename}.${ext}`;
};

// A file the model can read, from what it declares: an image by its type, any other file by its type or its extension. Any
// text type reads as text. Null when neither says it is readable.
export const readableFile = (mimeType: string | null, filename: string): ReadableFile | null => {
  const mime = typeOf(mimeType);
  if (IMAGE_TYPES.has(mime)) return { kind: 'image', mime_type: mime, filename: named(filename, mime) };
  const fileMime = FILE_TYPES.has(mime) ? mime : mime.startsWith('text/') ? 'text/plain' : FILE_EXTENSIONS[extensionOf(filename)];
  return fileMime ? { kind: 'file', mime_type: fileMime, filename: named(filename, fileMime) } : null;
};

// Whether a file's declared type leaves its bytes to decide what it is.
export const typeUndeclared = (mimeType: string | null): boolean => GENERIC_TYPES.has(typeOf(mimeType));

const starts = (bytes: Uint8Array, magic: readonly number[], at = 0) => magic.every((byte, index) => bytes[at + index] === byte);
const imageOf = (bytes: Uint8Array): string | null =>
  starts(bytes, [0xff, 0xd8, 0xff]) ? 'image/jpeg'
    : starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ? 'image/png'
      : starts(bytes, [0x47, 0x49, 0x46, 0x38]) ? 'image/gif'
        : starts(bytes, [0x52, 0x49, 0x46, 0x46]) && starts(bytes, [0x57, 0x45, 0x42, 0x50], 8) ? 'image/webp' : null;
const isPdf = (bytes: Uint8Array) => starts(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
// Plain text: no known binary signature, valid UTF-8, and no control characters but tab, line feed, form feed and carriage
// return.
const isText = (bytes: Uint8Array): boolean => {
  if (bytes.length === 0 || detectBinary(bytes) !== null) return false;
  let text: string;
  try { text = utf8.decode(bytes); } catch { return false; }
  return !/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text);
};

// A file the model can read, once its bytes are in hand. The bytes of a PDF or an image say what it is whatever its name
// or declared type claims; an image keeps the type its bytes show, which the providers check. A file whose type is not
// declared and that is plain text reads as text. Otherwise the file is judged as readableFile judges it.
export const readableBytes = (bytes: Uint8Array, mimeType: string | null, filename: string): ReadableFile | null => {
  if (isPdf(bytes)) return { kind: 'file', mime_type: 'application/pdf', filename: named(filename, 'application/pdf') };
  const image = imageOf(bytes);
  if (image) return { kind: 'image', mime_type: image, filename: named(filename, image) };
  const declared = readableFile(mimeType, filename);
  if (declared) return declared;
  return typeUndeclared(mimeType) && isText(bytes) ? { kind: 'file', mime_type: 'text/plain', filename: named(filename, 'text/plain') } : null;
};

export const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

const ZIP = [0x50, 0x4b, 0x03, 0x04];
// What the model is handed for a file it can read: the file itself, or for a Word, Excel or PowerPoint file the text read
// out of it, as plain text that either provider takes (`extracted`). An office file whose text cannot be read goes as
// itself, for a provider that reads the format. A zip that declares no type is tried as each office format. `file` is what
// the original is (its type and name), for keeping it. Null when nothing in it is readable.
export type ModelFile = Readonly<{ file: ReadableFile; attachment: LLMAttachment; extracted: boolean }>;
export const modelFile = async (bytes: Uint8Array, mimeType: string | null, filename: string): Promise<ModelFile | null> => {
  const file = readableBytes(bytes, mimeType, filename)
    ?? (typeUndeclared(mimeType) && starts(bytes, ZIP) ? await officeOf(bytes, filename) : null);
  if (!file) return null;
  if (isOfficeType(file.mime_type)) {
    const text = await officeText(bytes, file.mime_type);
    if (text) return { file, attachment: { kind: 'file', mime_type: 'text/plain', filename: `${file.filename}.txt`, data_base64: toBase64(new TextEncoder().encode(text)) }, extracted: true };
  }
  return { file, attachment: { ...file, data_base64: toBase64(bytes) }, extracted: false };
};
const officeOf = async (bytes: Uint8Array, filename: string): Promise<ReadableFile | null> => {
  for (const mime of Object.values(OFFICE_TYPES)) if (await officeText(bytes, mime)) return { kind: 'file', mime_type: mime, filename: named(filename, mime) };
  return null;
};
