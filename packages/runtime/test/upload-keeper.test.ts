import { describe, expect, it } from 'vitest';
import { LIMITS, workspaceStore, type WorkspaceState } from '@waldo/workspace';
import { loadTelegramMedia } from '../src/channels/telegram-media';
import { uploadKeeper, uploadPath } from '../src/channels/upload-keeper';
import { ClosedRunError } from '../src/channels/run-effect-scope';

const id = (n: number) => `abcdefab-cdef-4abc-8abc-${n.toString(16).padStart(12, '0')}`;
const setup = async () => {
  let state: WorkspaceState = { binding: null, files: [], bodies: [], operations: [] }; let n = 10; const objects = new Map<string, Uint8Array>();
  const store = await workspaceStore({ binding: { ownerId: id(1), environment: 'test', namespace: 'ns', doName: 'owner', doId: 'do', stateVersion: 1, mappingVersion: 1 }, admit: async () => ({ status: 'ok' }),
    metadata: { transaction(f) { const s = structuredClone(state); const r = f(s); state = s; return r; } },
    bodies: { put: async (b, v) => { objects.set(b.blob_id, v); }, get: async b => objects.get(b.blob_id) ?? null, remove: async b => { objects.delete(b.blob_id); } }, now: () => 0, newId: () => id(n++) });
  return { store, state: () => state, keep: uploadKeeper(async () => store, 'owner-1') };
};
const zipDoc = { kind: 'document' as const, fileId: 'tg-zip-1', fileName: 'a.zip', mimeType: 'application/zip', fileSize: 4 };
const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

describe('uploadPath', () => {
  it('keeps the owner\'s file name, makes it a valid single segment, and folds it under a per-file folder', async () => {
    expect(await uploadPath('k', 'report.zip')).toMatch(/^uploads\/[0-9a-f]{8}\/report\.zip$/);
    expect(await uploadPath('k', '../../etc/passwd')).toMatch(/^uploads\/[0-9a-f]{8}\/\.\._\.\._etc_passwd$/);
    expect(await uploadPath('k', '..')).toMatch(/\/file$/);
    expect(await uploadPath('k', 'a\u0000b\\c.txt')).toMatch(/\/a_b_c\.txt$/);
    expect(new TextEncoder().encode(await uploadPath('k', `${'é'.repeat(300)}.pdf`)).length).toBeLessThanOrEqual(240);
    expect(await uploadPath('k', `${'é'.repeat(300)}.pdf`)).toMatch(/\.pdf$/);
    expect(await uploadPath('k', 'x')).not.toBe(await uploadPath('other', 'x'));
  });
});

describe('every owner upload is kept (WALDO_FILE_TOOLS on)', () => {
  it('saves a type the model cannot read and names the saved path instead of "cannot be read"', async () => {
    const w = await setup();
    const loaded = await loadTelegramMedia(zipDoc, { download: async () => bytes, keep: w.keep });
    expect(loaded.attachment).toBeUndefined();
    const file = w.state().files[0]!;
    expect(file).toMatchObject({ provenance: 'owner_upload', mime: 'application/zip', path: expect.stringMatching(/^uploads\/[0-9a-f]{8}\/a\.zip$/) });
    expect(loaded.parts).toEqual([{ authorship: 'media_note', text: `[Owner sent a file "a.zip". Saved in their workspace as ${file.path} (file_id ${file.file_id}, revision 1). It is not attached here; open it with the workspace tools.]` }]);
  });

  it('a forwarded file is kept as an import, not as the owner\'s own upload', async () => {
    const w = await setup();
    await loadTelegramMedia({ ...zipDoc, forwarded: true }, { download: async () => bytes, keep: w.keep });
    expect(w.state().files[0]).toMatchObject({ provenance: 'provider_import' });
  });

  it('still attaches a readable type and saves it too', async () => {
    const w = await setup();
    const loaded = await loadTelegramMedia({ kind: 'document', fileId: 'tg-pdf', fileName: 'Plan.pdf', mimeType: 'application/pdf', fileSize: 2 }, { download: async () => new Uint8Array([104, 105]), keep: w.keep });
    expect(loaded.attachment).toMatchObject({ kind: 'file', mime_type: 'application/pdf' });
    expect(loaded.parts[0]!.text).toMatch(/^\[Owner sent a file "Plan\.pdf", attached\. Saved in their workspace as uploads\/[0-9a-f]{8}\/Plan\.pdf \(file_id .+, revision 1\)\. In a later message it is no longer attached; workspace_read opens it again\.\]$/);
  });

  it('keeps files from one batch of messages loaded together, one save at a time', async () => {
    const w = await setup();
    const loaded = await Promise.all(['a', 'b', 'c'].map(n => loadTelegramMedia({ ...zipDoc, fileId: `tg-${n}`, fileName: `${n}.zip` }, { download: async () => bytes, keep: w.keep })));
    expect(w.state().files.map(file => file.path.split('/').at(-1)).sort()).toEqual(['a.zip', 'b.zip', 'c.zip']);
    expect(loaded.every(one => one.parts[0]!.text.includes('Saved in their workspace'))).toBe(true);
  });

  it('a redelivered message is the same saved file, not a second one', async () => {
    const w = await setup();
    const first = await loadTelegramMedia(zipDoc, { download: async () => bytes, keep: w.keep });
    const again = await loadTelegramMedia(zipDoc, { download: async () => bytes, keep: w.keep });
    expect(again).toEqual(first);
    expect(w.state().operations).toHaveLength(1);
  });

  it('says honestly when a file is over the workspace file size', async () => {
    const w = await setup();
    const big = new Uint8Array(LIMITS.fileBytes + 1);
    const loaded = await loadTelegramMedia({ ...zipDoc, fileSize: big.length }, { download: async () => big, keep: w.keep });
    expect(loaded.parts[0]!.text).toBe('[Owner sent a file "a.zip". It is larger than the 10 MB a workspace file can hold, so it was not saved and cannot be opened here.]');
    expect(w.state().files).toEqual([]);
  });

  it('says honestly when the workspace is full', async () => {
    const w = await setup();
    const chunk = new Uint8Array(5 * 1024 * 1024);
    for (let i = 0; i < 20; i++) await w.store.write({ path: `fill/${i}`, bytes: chunk, mime: 'application/octet-stream', expected_revision: 0, provenance: 'agent_generated', operation_id: id(500 + i) });
    const loaded = await loadTelegramMedia(zipDoc, { download: async () => bytes, keep: w.keep });
    expect(loaded.parts[0]!.text).toBe('[Owner sent a file "a.zip". Their workspace is full, so it was not saved and cannot be opened here.]');
  });

  it('a closed run stops the save instead of being reported as a failure', async () => {
    const keep = uploadKeeper(async () => { throw new ClosedRunError(); }, 'owner-1');
    await expect(loadTelegramMedia(zipDoc, { download: async () => bytes, keep })).rejects.toBeInstanceOf(ClosedRunError);
  });

  it('a workspace that cannot be reached leaves a readable file attached and says it was not saved', async () => {
    const keep = uploadKeeper(async () => { throw new Error('down'); }, 'owner-1');
    const loaded = await loadTelegramMedia({ kind: 'photo', fileId: 'p', fileName: null, mimeType: 'image/jpeg', fileSize: 3 }, { download: async () => new Uint8Array([1, 2, 3]), keep });
    expect(loaded.attachment).toMatchObject({ kind: 'image' });
    expect(loaded.parts[0]!.text).toBe('[Owner sent a photo, attached. It could not be saved to their workspace.]');
  });

  it('keeps the old behaviour exactly when the switch is off (no keeper)', async () => {
    const loaded = await loadTelegramMedia(zipDoc, { download: async () => bytes });
    expect(loaded).toEqual({ parts: [{ authorship: 'media_note', text: '[Owner sent a file "a.zip". This file type cannot be read yet.]' }] });
  });
});
