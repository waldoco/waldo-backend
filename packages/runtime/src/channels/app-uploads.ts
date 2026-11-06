import { APP_CHAT_PHOTO_TYPES, APP_CHAT_UPLOAD_TTL_MS, APP_CHAT_UPLOADS_WAITING_MAX, APP_CHAT_VOICE_TYPES, type AppChatUploadKind } from '../../../contracts/src/app/core';

// A chat attachment from the app, staged in the owner's own object between its upload and its message's turn. Waiting, it
// expires after APP_CHAT_UPLOAD_TTL_MS; once a message takes it, it has no expiry of its own and lives exactly as long as
// that message's payload: the inbox drops it wherever it clears the message's text, and an owner erase drops it with
// everything else. Bytes are split into parts so no one stored value comes near the storage value limit.
const META = 'app_upload:';
const PART = 'app_upload_part:';
const PART_BYTES = 512 * 1024;

export type AppUploadRef = Readonly<{ id: string; kind: AppChatUploadKind; mime: string; name: string; bytes: number }>;
type Meta = AppUploadRef & Readonly<{ owner: string; parts: number; expiresAt: number | null; takenBy?: string }>;
type SyncKv = DurableObjectStorage['kv'];

const newUploadId = (): string => `up_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;

export const dropAppUpload = (kv: SyncKv, id: string): void => {
  const meta = kv.get<Meta>(META + id);
  for (let part = 0; part < (meta?.parts ?? 0); part += 1) kv.delete(`${PART}${id}:${part}`);
  kv.delete(META + id);
};

const waiting = (kv: SyncKv): Meta[] => [...kv.list<Meta>({ prefix: META })].map(([, meta]) => meta).filter(meta => meta.takenBy === undefined);

// Drops every untaken upload past its expiry. The app inbox's wake includes the next expiry (appUploadsDue), so the alarm
// runs this on time whether or not attachments are still switched on.
export const sweepAppUploads = (kv: SyncKv, now: number): void => {
  for (const meta of waiting(kv)) if (meta.expiresAt !== null && meta.expiresAt <= now) dropAppUpload(kv, meta.id);
};
export const appUploadsDue = (kv: SyncKv): number | null => waiting(kv).reduce<number | null>((soonest, meta) =>
  meta.expiresAt !== null && (soonest === null || meta.expiresAt < soonest) ? meta.expiresAt : soonest, null);
// Whether another upload may wait, asked before its bytes are read; staging asks again in its own transaction.
export const appUploadRoom = (storage: DurableObjectStorage, now: number): boolean => storage.transactionSync(() => {
  sweepAppUploads(storage.kv, now);
  return waiting(storage.kv).length < APP_CHAT_UPLOADS_WAITING_MAX;
});

export const stageAppUpload = (storage: DurableObjectStorage, upload: Readonly<{ owner: string; kind: AppChatUploadKind; mime: string; name: string; data: Uint8Array }>, now: number)
  : Readonly<{ id: string; expiresAt: number }> | 'capacity' => storage.transactionSync(() => {
  const kv = storage.kv;
  sweepAppUploads(kv, now);
  if (waiting(kv).length >= APP_CHAT_UPLOADS_WAITING_MAX) return 'capacity';
  const id = newUploadId(), parts = Math.ceil(upload.data.length / PART_BYTES), expiresAt = now + APP_CHAT_UPLOAD_TTL_MS;
  for (let part = 0; part < parts; part += 1) kv.put(`${PART}${id}:${part}`, upload.data.slice(part * PART_BYTES, (part + 1) * PART_BYTES));
  const meta: Meta = { id, owner: upload.owner, kind: upload.kind, mime: upload.mime, name: upload.name, bytes: upload.data.length, parts, expiresAt };
  kv.put(META + id, meta);
  return { id, expiresAt };
});

// Within the inbox's admitting transaction: the upload becomes the message's, or the send is refused. An upload staged under
// another owner name, one already taken, or one past its expiry is not there to take.
export const takeAppUpload = async (txn: DurableObjectTransaction, id: string, owner: string, messageId: string, now: number): Promise<AppUploadRef | null> => {
  const meta = await txn.get<Meta>(META + id);
  if (!meta || meta.owner !== owner || meta.takenBy !== undefined || meta.expiresAt === null || meta.expiresAt <= now) return null;
  await txn.put(META + id, { ...meta, takenBy: messageId, expiresAt: null });
  return { id: meta.id, kind: meta.kind, mime: meta.mime, name: meta.name, bytes: meta.bytes };
};

export const readAppUpload = (kv: SyncKv, id: string): Uint8Array => {
  const meta = kv.get<Meta>(META + id);
  if (!meta) throw new Error('app upload is gone');
  const data = new Uint8Array(meta.bytes);
  for (let part = 0, at = 0; part < meta.parts; part += 1) {
    const chunk = kv.get<Uint8Array>(`${PART}${id}:${part}`);
    if (!chunk) throw new Error('app upload is incomplete');
    data.set(chunk, at); at += chunk.length;
  }
  return data;
};

// The name an upload is read under: a voice note or photo by its type (the transcriber reads the format from the name), a
// file by the plain name the owner gave it. Refused 'type': its kind does not take that type; 'name': a file without a
// plain name.
export const appUploadName = (kind: AppChatUploadKind, mime: string, given: string | null): Readonly<{ name: string }> | Readonly<{ refused: 'type' | 'name' }> => {
  const typed = kind === 'voice' ? APP_CHAT_VOICE_TYPES : kind === 'photo' ? APP_CHAT_PHOTO_TYPES : null;
  if (typed) return Object.hasOwn(typed, mime) ? { name: `${kind}.${typed[mime]}` } : { refused: 'type' };
  if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(mime)) return { refused: 'type' };
  return given !== null && /^[^/\\\p{Cc}]{1,128}$/u.test(given) && !given.startsWith('.') ? { name: given } : { refused: 'name' };
};

// An app message as the shared turn reads it: its words, or its attachment with the words as the caption. The attachment's
// file id is its upload id, which the app runtime's media reader opens. A JPEG photo reads as a photo; any other image or
// file as a document of its own type.
export const appMessageBody = (text: string, upload?: AppUploadRef) => {
  if (!upload) return { text };
  const caption = text ? { caption: text } : {}, file = { file_id: upload.id, file_size: upload.bytes };
  if (upload.kind === 'voice') return { ...caption, voice: { ...file, mime_type: upload.mime, file_name: upload.name } };
  if (upload.mime === 'image/jpeg') return { ...caption, photo: [file] };
  return { ...caption, document: { ...file, mime_type: upload.mime, file_name: upload.name } };
};

// The input an app message is admitted under: its words, or for a message that is only an attachment, a note saying what
// kind it is (never its name, which someone else may have chosen). It is the admission's text only; the model reads the
// attachment's own note and transcript from the media reader.
export const appTurnText = (record: Readonly<{ text: string; upload?: AppUploadRef }>): string =>
  record.text || (record.upload ? `[Owner sent a ${record.upload.kind === 'voice' ? 'voice note' : record.upload.kind}.]` : '');
