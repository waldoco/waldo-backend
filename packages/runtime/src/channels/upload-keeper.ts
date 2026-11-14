import { LIMITS, mimeForName, WorkspaceError, type Provenance, type WorkspaceStore } from '@waldo/workspace';
import { workspaceOperationId } from '../tools/live/workspace-operation';
import { ClosedRunError } from './run-effect-scope';

// Every file the owner sends is kept in their workspace (WALDO_FILE_TOOLS), whether or not the model can read its type,
// so later turns and the file tools can open it. The bytes no longer ride only on the turn that received them.
export type KeepFile = Readonly<{
  bytes: Uint8Array; filename: string; mime: string | null;
  // Stable for this file on its surface (a Telegram file id, a WhatsApp media id, a message and index), so a redelivered
  // message is the same write, not a second file.
  key: string;
  // Someone else's file the owner passed on (a forward): kept as an import, never as the owner's own upload.
  forwarded?: boolean;
}>;
export type KeptUpload =
  | Readonly<{ status: 'saved'; path: string; file_id: string; revision: number }>
  | Readonly<{ status: 'too_large' | 'workspace_full' | 'not_saved' }>;
export type UploadKeeper = (file: KeepFile) => Promise<KeptUpload>;

const MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
const NAME_BYTES = 200;
const bytesOf = (text: string) => new TextEncoder().encode(text).length;

// The owner's file name as one valid path segment. Separators and control characters become "_"; a name that is only
// dots is "file"; a long name is cut from the stem so its extension survives.
const segment = (filename: string): string => {
  let name = filename.normalize('NFC').replace(/[\\/\x00-\x1f\x7f]/g, '_').trim();
  if (!name || /^\.+$/.test(name)) name = 'file';
  if (bytesOf(name) <= NAME_BYTES) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && bytesOf(name.slice(dot)) <= 16 ? name.slice(dot) : '';
  let stem = [...name.slice(0, extension ? dot : undefined)];
  while (stem.length && bytesOf(stem.join('') + extension) > NAME_BYTES) stem.pop();
  return stem.join('') + extension || 'file';
};

// uploads/<folder>/<name>: the folder comes from the file's key, so two files with one name never collide and a retry
// lands on the same path.
export const uploadPath = async (key: string, filename: string, root = 'uploads'): Promise<string> =>
  `${root}/${(await workspaceOperationId([key], 'upload_folder')).slice(0, 8)}/${segment(filename)}`;

// Saves run one at a time: the workspace holds one pending write, so files from one batch of messages, loaded together,
// would otherwise refuse each other as pending.
export const uploadKeeper = (open: () => Promise<WorkspaceStore>, ownerRef: string, provenance: Provenance = 'owner_upload', root = 'uploads'): UploadKeeper => {
  let queue: Promise<unknown> = Promise.resolve();
  return file => {
    const saved = queue.then(() => keepOne(open, ownerRef, provenance, root, file));
    queue = saved.catch(() => undefined);
    return saved;
  };
};

const keepOne = async (open: () => Promise<WorkspaceStore>, ownerRef: string, provenance: Provenance, root: string, file: KeepFile): Promise<KeptUpload> => {
  if (file.bytes.byteLength > LIMITS.fileBytes) return { status: 'too_large' };
  const mime = file.mime && MIME.test(file.mime) && file.mime !== 'application/octet-stream' ? file.mime : mimeForName(file.filename);
  try {
    const store = await open();
    const meta = await store.write({ path: await uploadPath(`${ownerRef}:${file.key}`, file.filename, root), bytes: file.bytes, mime, expected_revision: 0, provenance: file.forwarded ? 'provider_import' : provenance,
      operation_id: await workspaceOperationId([ownerRef, file.key], 'owner_upload') });
    return { status: 'saved', path: meta.path, file_id: meta.file_id, revision: meta.revision };
  } catch (error) {
    if (error instanceof ClosedRunError) throw error;
    if (error instanceof WorkspaceError && (error.code === 'quota' || error.code === 'capacity')) return { status: 'workspace_full' };
    console.warn(JSON.stringify({ hop: 'upload_keep', ok: false, code: error instanceof WorkspaceError ? error.code : 'unavailable' }));
    return { status: 'not_saved' };
  }
};

// The note's words for where the file went. `what` names the file with its article ("a photo", "an audio file …"); `opened`
// says whether the model has it attached on this turn, `asText` that what is attached is the text read out of an office
// file; a later turn reads the same note with the file no longer attached.
export const keptNote = (what: string, kept: KeptUpload, opened: boolean, asText = false): string => {
  const head = `[Owner sent ${what}${opened ? `, attached${asText ? ' as its text only' : ''}` : ''}.`;
  if (kept.status === 'saved') return `${head} Saved in their workspace as ${kept.path} (file_id ${kept.file_id}, revision ${kept.revision}).${opened ? ' In a later message it is no longer attached; workspace_read opens it again.' : ' It is not attached here; open it with the workspace tools.'}]`;
  if (opened) return `${head} It could not be saved to their workspace.]`;
  if (kept.status === 'too_large') return `${head} It is larger than the ${LIMITS.fileBytes / (1024 * 1024)} MB a workspace file can hold, so it was not saved and cannot be opened here.]`;
  if (kept.status === 'workspace_full') return `${head} Their workspace is full, so it was not saved and cannot be opened here.]`;
  return `${head} It could not be saved to their workspace, so it cannot be opened here.]`;
};
