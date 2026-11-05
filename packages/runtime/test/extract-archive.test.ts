import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { ARCHIVE_LIMITS, workspaceStore, type WorkspaceState } from '@waldo/workspace';
import { EXTRACT_ARCHIVE_MAX_ENTRIES, extractArchiveArgsSchema, TOOL_PERMISSIONS } from '@waldo/contracts';
import { workspaceToolHandlers } from '../src/tools/live/workspace';
import { TOOL_RECORDS } from '../src/tools/records';

const id = (n: number) => `abcdefab-cdef-4abc-8abc-${n.toString(16).padStart(12, '0')}`;
const setup = async (fileTools = true) => {
  let state: WorkspaceState = { binding: null, files: [], bodies: [], operations: [] }; let n = 10; const objects = new Map<string, Uint8Array>();
  const store = await workspaceStore({ binding: { ownerId: id(1), environment: 'test', namespace: 'ns', doName: 'owner', doId: 'do', stateVersion: 1, mappingVersion: 1 }, admit: async () => ({ status: 'ok' }),
    metadata: { transaction(f) { const s = structuredClone(state); const r = f(s); state = s; return r; } },
    bodies: { put: async (b, v) => { objects.set(b.blob_id, v); }, get: async b => objects.get(b.blob_id) ?? null, remove: async b => { objects.delete(b.blob_id); } }, now: () => 0, newId: () => id(n++) });
  const handlers = workspaceToolHandlers(async () => store, { origin: async () => null, durable: true }, undefined, { fileTools });
  const tool = (name: string) => handlers.find(h => h.name === name);
  const ctx = (call: string) => ({ authenticatedUserId: 'owner', turnId: 'turn', toolCallId: call }) as never;
  const zipUpload = async (files: Record<string, string>) => {
    const zip = new JSZip(); for (const [name, text] of Object.entries(files)) zip.file(name, text);
    return store.write({ path: 'uploads/abc/notes.zip', bytes: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }), mime: 'application/zip', expected_revision: 0, provenance: 'owner_upload', operation_id: id(2) });
  };
  return { store, handlers, tool, ctx, zipUpload, state: () => state };
};

describe('extract_archive', () => {
  it('is offered only with WALDO_FILE_TOOLS on, beside the existing workspace tools', async () => {
    expect((await setup(true)).handlers.map(h => h.name)).toEqual(expect.arrayContaining(['workspace_list', 'workspace_read', 'workspace_search', 'workspace_write', 'workspace_render', 'extract_archive']));
    expect((await setup(false)).handlers.map(h => h.name)).not.toContain('extract_archive');
  });

  it('unpacks, then list and read reach the unpacked text', async () => {
    const w = await setup(); const zip = await w.zipUpload({ 'plan.md': '# Plan\nShip F1', 'data/rows.csv': 'a,b\n1,2' });
    const out: any = await w.tool('extract_archive')!.handle({ file_id: zip.file_id, revision: 1 } as never, w.ctx('x1'));
    expect(out).toMatchObject({ ok: true, source_taint: 'external', data: { folder: 'uploads/abc/notes', entries_total: 2 } });
    expect(out.data.written.map((f: { path: string }) => f.path).sort()).toEqual(['uploads/abc/notes/data/rows.csv', 'uploads/abc/notes/plan.md']);
    const listed: any = await w.tool('workspace_list')!.handle({ prefix: 'uploads/abc/notes/' } as never, w.ctx('l1'));
    const plan = listed.data.files.find((f: { path: string }) => f.path.endsWith('plan.md'));
    const read: any = await w.tool('workspace_read')!.handle({ file_id: plan.file_id, revision: 1 } as never, w.ctx('r1'));
    expect(read.data.text).toBe('# Plan\nShip F1');
  });

  it('a retried call is the same write; a later call reports what already exists', async () => {
    const w = await setup(); const zip = await w.zipUpload({ 'a.txt': 'alpha' });
    const first: any = await w.tool('extract_archive')!.handle({ file_id: zip.file_id, revision: 1 } as never, w.ctx('x1'));
    expect(await w.tool('extract_archive')!.handle({ file_id: zip.file_id, revision: 1 } as never, w.ctx('x1'))).toEqual(first);
    const later: any = await w.tool('extract_archive')!.handle({ file_id: zip.file_id, revision: 1 } as never, w.ctx('x2'));
    expect(later.data.skipped).toEqual([{ entry: 'a.txt', reason: 'exists' }]);
    expect(w.state().files).toHaveLength(2);
  });

  it('relays a clear error for a file that is not an archive, and for one deleted mid-turn', async () => {
    const w = await setup();
    const text = await w.store.write({ path: 'notes.txt', bytes: new TextEncoder().encode('hello'), mime: 'text/plain', expected_revision: 0, provenance: 'owner_upload', operation_id: id(3) });
    expect(await w.tool('extract_archive')!.handle({ file_id: text.file_id, revision: 1 } as never, w.ctx('x1'))).toMatchObject({ ok: false, code: 'invalid_args', error: 'This file is not a zip archive.' });
    const zip = await w.zipUpload({ 'a.txt': 'alpha' });
    await w.store.tombstone(zip.file_id, 1);
    expect(await w.tool('extract_archive')!.handle({ file_id: zip.file_id, revision: 1 } as never, w.ctx('x2'))).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('workspace_read describes a binary file when the switch is on, and keeps the old refusal when off', async () => {
    for (const on of [true, false]) {
      const w = await setup(on); const zip = await w.zipUpload({ 'a.txt': 'alpha' });
      const read: any = await w.tool('workspace_read')!.handle({ file_id: zip.file_id, revision: 1 } as never, w.ctx('r1'));
      if (on) expect(read).toMatchObject({ ok: true, data: { text: null, binary: { mime: 'application/zip', detected: 'zip archive' } } });
      else expect(read).toMatchObject({ ok: false, code: 'invalid_args' });
    }
  });

  it('has a schema the runtime cap matches, owner-turn permission, and an exempt, idempotent record', () => {
    expect(EXTRACT_ARCHIVE_MAX_ENTRIES).toBe(ARCHIVE_LIMITS.writesPerCall);
    expect(extractArchiveArgsSchema.safeParse({ file_id: 'f', revision: 1 }).success).toBe(true);
    expect(extractArchiveArgsSchema.safeParse({ file_id: 'f', revision: 1, path: '../x' }).success).toBe(false);
    expect(Object.entries(TOOL_PERMISSIONS).filter(([, tools]) => tools.includes('extract_archive')).map(([key]) => key)).toEqual(['user_message']);
    expect(TOOL_RECORDS.extract_archive).toMatchObject({ brain: 'workspace', claim: 'workspace_archive_extracted', replay: { replay: 'provider_idempotent' } });
  });
});
