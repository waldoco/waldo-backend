import { describe, expect, it, vi } from 'vitest';
import { ARCHIVE_LIMITS, ArchiveError, extractArchive, readZipDirectory } from '../src/archive';
import { LIMITS, workspaceStore, type Admission, type OwnerBinding, type WorkspaceHost, type WorkspaceState } from '../src/store';
import { buildZip } from './zip-fixture';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const binding: OwnerBinding = { ownerId: id(1), environment: 'staging', namespace: 'owner-do-staging', doName: 'owner-name', doId: 'opaque', stateVersion: 1, mappingVersion: 1 };
const host = () => {
  let state: WorkspaceState = { binding: null, files: [], bodies: [], operations: [] };
  const objects = new Map<string, Uint8Array>(); let n = 100;
  const h: WorkspaceHost = { binding, admit: vi.fn<Admission>(async () => ({ status: 'ok' })), metadata: { transaction(work) { const next = structuredClone(state); const result = work(next); state = next; return result; } },
    bodies: { put: vi.fn(async (b, v) => { objects.set(b.blob_id, v.slice()); }), get: vi.fn(async b => objects.get(b.blob_id)?.slice() ?? null), remove: vi.fn(async b => { objects.delete(b.blob_id); }) }, now: () => 1000, newId: () => id(n++) };
  return { h, state: () => state };
};
let op = 5000;
const opFor = () => async () => id(op++);
const upload = async (bytes: Uint8Array, path = 'uploads/report.zip') => {
  const f = host(); const store = await workspaceStore(f.h);
  const meta = await store.write({ path, bytes, mime: 'application/zip', expected_revision: 0, provenance: 'owner_upload', operation_id: id(10) });
  return { f, store, meta };
};
const fails = async (bytes: Uint8Array, code: string) => {
  const { store, meta } = await upload(bytes);
  await expect(extractArchive(store, { file_id: meta.file_id, revision: 1, operationIdFor: opFor() })).rejects.toMatchObject({ code });
};

describe('extractArchive', () => {
  it('unpacks a small archive whole into a folder beside it, keeping its provenance', async () => {
    const zip = await buildZip([{ name: 'notes/a.txt', text: 'alpha', deflate: true }, { name: 'notes/', text: '' }, { name: 'b.csv', text: 'x,y\n1,2\n' }]);
    const { store, meta } = await upload(zip);
    const out = await extractArchive(store, { file_id: meta.file_id, revision: 1, operationIdFor: opFor() });
    expect(out.folder).toBe('uploads/report');
    expect(out.written.map(w => w.path)).toEqual(['uploads/report/notes/a.txt', 'uploads/report/b.csv']);
    expect(out.skipped).toEqual([]);
    const listed = (await store.list(undefined, 50, 'uploads/report/')).files;
    expect(listed.every(f => f.provenance === 'owner_upload')).toBe(true);
    const a = listed.find(f => f.path.endsWith('a.txt'))!;
    expect((await store.read(a.file_id, 1, 0, 100)).text).toBe('alpha');
  });

  it('is the same write when retried with the same operation ids', async () => {
    const zip = await buildZip([{ name: 'a.txt', text: 'alpha' }]);
    const { f, store, meta } = await upload(zip);
    const ids = (entry: string) => Promise.resolve(id(entry === 'a.txt' ? 900 : 901));
    const first = await extractArchive(store, { file_id: meta.file_id, revision: 1, operationIdFor: ids });
    const again = await extractArchive(store, { file_id: meta.file_id, revision: 1, operationIdFor: ids });
    expect(again.written).toEqual(first.written);
    expect(f.state().operations).toHaveLength(2);
  });

  it('lists a large archive without writing, then writes only what was chosen', async () => {
    const many = Array.from({ length: ARCHIVE_LIMITS.entriesPerCall + 5 }, (_, i) => ({ name: `f${i}.txt`, text: String(i) }));
    const { store, meta } = await upload(await buildZip(many));
    const listed = await extractArchive(store, { file_id: meta.file_id, revision: 1, operationIdFor: opFor() });
    expect(listed.written).toEqual([]);
    expect(listed.entries_total).toBe(many.length);
    expect(listed.stopped).toBe('per_call_limit');
    const chosen = await extractArchive(store, { file_id: meta.file_id, revision: 1, entries: ['f3.txt', 'missing.txt'], operationIdFor: opFor() });
    expect(chosen.written.map(w => w.entry)).toEqual(['f3.txt']);
    expect(chosen.skipped).toEqual([{ entry: 'missing.txt', reason: 'not_in_archive' }]);
  });

  it('counts refused entries toward the per-call limit, so a call cannot inflate entry after refused entry', async () => {
    const bad = Array.from({ length: ARCHIVE_LIMITS.entriesPerCall + 5 }, (_, i) => ({ name: `bad-${i}.txt`, text: 'payload', deflate: true, crc: 1 }));
    const zip = await buildZip([...bad, { name: 'good.txt', text: 'fine' }]);
    const { store, meta } = await upload(zip);
    const out = await extractArchive(store, { file_id: meta.file_id, revision: 1, prefix: '', operationIdFor: opFor() });
    expect(out.written).toEqual([]);
    expect(out.skipped).toHaveLength(ARCHIVE_LIMITS.entriesPerCall);
    expect(out.stopped).toBe('per_call_limit');
  });

  it('refuses the whole archive when any entry escapes its folder', async () => {
    for (const name of ['../evil.txt', '/etc/passwd', 'a/../../b', 'C:/x.txt', '..\\..\\win.ini']) await fails(await buildZip([{ name: 'ok.txt', text: 'fine' }, { name, text: 'x' }]), 'unsafe_path');
  });

  it('never writes a symlink or an encrypted entry, and says why', async () => {
    const zip = await buildZip([{ name: 'link', text: '/etc/passwd', symlink: true }, { name: 'secret.txt', text: 'x', encrypted: true }, { name: 'ok.txt', text: 'fine' }]);
    const { store, meta } = await upload(zip);
    const out = await extractArchive(store, { file_id: meta.file_id, revision: 1, operationIdFor: opFor() });
    expect(out.written.map(w => w.entry)).toEqual(['ok.txt']);
    expect(out.skipped).toEqual([{ entry: 'link', reason: 'symlink' }, { entry: 'secret.txt', reason: 'encrypted' }]);
  });

  it('stops a zip bomb on the bytes it actually inflates, whatever its header claims', async () => {
    const zeros = new Uint8Array(4 * 1024 * 1024);
    // Honest header: the ratio refuses it before inflating.
    const honest = await buildZip([{ name: 'bomb.bin', data: zeros, deflate: true }]);
    // Lying header: claims 100 bytes, so only the streamed count can catch it.
    const lying = await buildZip([{ name: 'bomb.bin', data: zeros, deflate: true, declaredSize: 100 }]);
    for (const zip of [honest, lying]) {
      const { store, meta, f } = await upload(zip);
      const out = await extractArchive(store, { file_id: meta.file_id, revision: 1, operationIdFor: opFor() });
      expect(out.written).toEqual([]);
      expect(['compression_ratio', 'corrupt']).toContain(out.skipped[0]!.reason);
      expect(f.state().files).toHaveLength(1);
    }
  });

  it('refuses an entry larger than the per-file cap', async () => {
    const big = new Uint8Array(LIMITS.fileBytes + 1).map((_, i) => (i * 7919) & 0xff);
    const { store, meta } = await upload(await buildZip([{ name: 'big.bin', data: big.subarray(0, 64), declaredSize: big.length }]));
    const out = await extractArchive(store, { file_id: meta.file_id, revision: 1, operationIdFor: opFor() });
    expect(out.skipped).toEqual([{ entry: 'big.bin', reason: 'too_large' }]);
  });

  it('gives a clear error for a corrupt or non-zip file and skips an entry whose checksum is wrong', async () => {
    await fails(new TextEncoder().encode('just some text, not a zip at all'), 'not_zip');
    const zip = await buildZip([{ name: 'a.txt', text: 'alpha' }]);
    await fails(zip.subarray(0, zip.length - 30), 'corrupt');
    const { store, meta } = await upload(await buildZip([{ name: 'a.txt', text: 'alpha', crc: 1 }]));
    const out = await extractArchive(store, { file_id: meta.file_id, revision: 1, operationIdFor: opFor() });
    expect(out.skipped).toEqual([{ entry: 'a.txt', reason: 'corrupt' }]);
    expect(new ArchiveError('corrupt').message).toMatch(/damaged/);
  });

  it('refuses overlapping entries that would count the same bytes twice', async () => {
    const zip = await buildZip([{ name: 'a.txt', text: 'alpha' }, { name: 'b.txt', text: 'beta' }]);
    const view = new DataView(zip.buffer);
    const cd = view.getUint32(zip.length - 6, true);
    const second = cd + 46 + 'a.txt'.length;
    view.setUint32(second + 42, 0, true);
    expect(() => readZipDirectory(zip)).toThrow(ArchiveError);
  });

  it('writes a nested archive as a file and does not open it', async () => {
    const inner = await buildZip([{ name: 'deep.txt', text: 'deep' }]);
    const { store, meta } = await upload(await buildZip([{ name: 'inner.zip', data: inner }]));
    const out = await extractArchive(store, { file_id: meta.file_id, revision: 1, operationIdFor: opFor() });
    expect(out.written).toEqual([expect.objectContaining({ path: 'uploads/report/inner.zip', mime: 'application/zip' })]);
    expect((await store.list(undefined, 50)).files.map(f => f.path)).not.toContain('uploads/report/inner/deep.txt');
  });

  it('stops at the workspace quota and reports it, keeping what was written', async () => {
    const chunk = new Uint8Array(5 * 1024 * 1024).map((_, i) => (i * 31) & 0xff);
    const { store, meta, f } = await upload(await buildZip([{ name: 'a.bin', data: chunk }]));
    for (let i = 0; i < 18; i++) await store.write({ path: `fill/${i}`, bytes: chunk, mime: 'application/octet-stream', expected_revision: 0, provenance: 'agent_generated', operation_id: id(200 + i) });
    const out = await extractArchive(store, { file_id: meta.file_id, revision: 1, operationIdFor: opFor() });
    expect(out.stopped).toBe('workspace_full');
    expect(out.written).toEqual([]);
    expect(f.state().operations.filter(o => o.status === 'pending')).toEqual([]);
  });

  it('says not_found for an archive deleted before it is read', async () => {
    const { store, meta } = await upload(await buildZip([{ name: 'a.txt', text: 'alpha' }]));
    await store.tombstone(meta.file_id, 1);
    await expect(extractArchive(store, { file_id: meta.file_id, revision: 1, operationIdFor: opFor() })).rejects.toThrow('workspace_not_found');
  });
});
