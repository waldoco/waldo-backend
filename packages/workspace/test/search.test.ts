import { describe, expect, it } from 'vitest';
import { workspaceHandlers } from '../src/handlers';
import { workspaceStore, type WorkspaceState } from '../src/store';

// RED first: literal-substring search over the owner's own workspace files, current revisions only.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const make = async (owner = 1) => {
  let state: WorkspaceState = { binding: null, files: [], bodies: [], operations: [] }; const map = new Map<string, Uint8Array>(); let n = owner * 1000;
  const store = await workspaceStore({ binding: { ownerId: id(owner), environment: 'staging', namespace: 'ns', doName: 'name', doId: 'id', stateVersion: 1, mappingVersion: 1 }, admit: async () => ({ status: 'ok' }), metadata: { transaction(f) { const draft = structuredClone(state); const r = f(draft); state = draft; return r; } }, bodies: { put: async (b, v) => { map.set(b.blob_id, v); }, get: async b => map.get(b.blob_id) ?? null, remove: async b => { map.delete(b.blob_id); } }, now: () => 0, newId: () => id(n++) });
  const h = workspaceHandlers(store); let op = owner * 100000;
  const put = (path: string, text: string, expected_revision = 0) => h.write({ path, text, mime: 'text/markdown', expected_revision, operation_id: id(op++) });
  return { store, h, put, state: () => state };
};

describe('workspace search (literal, current revisions, own workspace only)', () => {
  it('finds a literal match with file_id, path, revision, byte offset and a bounded snippet', async () => {
    const { h, put } = await make(); await put('trip/packing.md', 'Passport\nCharger\nBlue umbrella for Lisbon');
    const r = await h.search({ query: 'umbrella' });
    expect(r).toMatchObject({ ok: true, source_taint: 'external', data: { truncated: false, hits: [{ path: 'trip/packing.md', revision: 1, offset: 'Passport\nCharger\nBlue '.length }] } });
    const hit = (r as any).data.hits[0]; expect(hit.snippet).toContain('umbrella'); expect(new TextEncoder().encode(hit.snippet).length).toBeLessThanOrEqual(240); expect(hit.file_id).toMatch(/^0000/);
  });
  it('is case-insensitive and literal: a regex-looking query matches only itself', async () => {
    const { h, put } = await make(); await put('a.md', 'Lisbon trip. a.c and abc'); 
    expect((await h.search({ query: 'LISBON' }) as any).data.hits).toHaveLength(1);
    expect((await h.search({ query: 'a.c' }) as any).data.hits).toHaveLength(1);
    expect((await h.search({ query: 'a.*c' }) as any).data.hits).toHaveLength(0);
  });
  it('offsets count UTF-8 bytes', async () => {
    const { h, put } = await make(); await put('u.md', 'café ☕ target');
    expect((await h.search({ query: 'target' }) as any).data.hits[0].offset).toBe(new TextEncoder().encode('café ☕ ').length);
  });
  it('no match is an empty ok result, not an error', async () => {
    const { h, put } = await make(); await put('a.md', 'hello');
    expect(await h.search({ query: 'zzz' })).toMatchObject({ ok: true, data: { hits: [], truncated: false } });
  });
  it('searches only the current revision of a file', async () => {
    const { h, put } = await make(); await put('a.md', 'old word here'); await put('a.md', 'new text only', 1);
    expect((await h.search({ query: 'old word' }) as any).data.hits).toHaveLength(0);
    expect((await h.search({ query: 'new text' }) as any).data.hits[0].revision).toBe(2);
  });
  it('path_prefix limits the scan and limit caps hits with truncated=true', async () => {
    const { h, put } = await make(); await put('a/1.md', 'needle one'); await put('a/2.md', 'needle two'); await put('b/3.md', 'needle three');
    expect((await h.search({ query: 'needle', path_prefix: 'b/' }) as any).data.hits.map((x: any) => x.path)).toEqual(['b/3.md']);
    const capped = await h.search({ query: 'needle', limit: 2 }) as any; expect(capped.data.hits).toHaveLength(2); expect(capped.data.truncated).toBe(true);
  });
  it('one owner never sees another owner file', async () => {
    const one = await make(1); const two = await make(2); await one.put('secret.md', 'owner one needle'); await two.put('mine.md', 'owner two text');
    expect((await two.h.search({ query: 'needle' }) as any).data.hits).toHaveLength(0);
  });
  it('a tombstoned file is not returned', async () => {
    const { h, put, store, state } = await make(); await put('gone.md', 'findable'); const f = state().files[0]!; await store.tombstone(f.file_id, 1);
    expect((await h.search({ query: 'findable' }) as any).data.hits).toHaveLength(0);
  });
  it('rejects empty, oversize and extra-key input', async () => {
    const { h } = await make();
    for (const bad of [{ query: '' }, { query: 'x'.repeat(201) }, { query: 'a', limit: 0 }, { query: 'a', limit: 21 }, { query: 'a', ownerId: 'x' }, {}]) expect(await h.search(bad)).toMatchObject({ ok: false, code: 'invalid' });
  });
  it('enforces the scan byte budget: a file past the budget is skipped, truncated is true, later small files still scan', async () => {
    const { h, store } = await make(); let op = 900000;
    const bytes = (n: number, tail: string) => new TextEncoder().encode('x'.repeat(n - tail.length) + tail);
    const put = (path: string, b: Uint8Array) => store.write({ path, bytes: b, mime: 'text/markdown', expected_revision: 0, provenance: 'agent_generated', operation_id: id(op++) });
    await put('a.md', bytes(3_000_000, 'needle in a')); await put('b.md', bytes(3_000_000, 'needle in b')); await put('c.md', new TextEncoder().encode('needle in c'));
    const r = await h.search({ query: 'needle' }) as any;
    expect(r.data.hits.map((x: any) => x.path)).toEqual(['a.md', 'c.md']);
    expect(r.data.truncated).toBe(true);
  });
  it('a single file larger than the whole budget is skipped without ending the scan', async () => {
    const { h, store } = await make(); let op = 800000;
    await store.write({ path: 'huge.md', bytes: new TextEncoder().encode('x'.repeat(4_500_000) + 'needle'), mime: 'text/markdown', expected_revision: 0, provenance: 'agent_generated', operation_id: id(op++) });
    await store.write({ path: 'small.md', bytes: new TextEncoder().encode('needle'), mime: 'text/markdown', expected_revision: 0, provenance: 'agent_generated', operation_id: id(op++) });
    const r = await h.search({ query: 'needle' }) as any; expect(r.data.hits.map((x: any) => x.path)).toEqual(['small.md']); expect(r.data.truncated).toBe(true);
  });
  it('hits are files: a second match in the same file is not a second hit', async () => {
    const { h, put } = await make(); await put('a.md', 'needle and another needle');
    expect((await h.search({ query: 'needle' }) as any).data.hits).toHaveLength(1);
  });
  it('a snippet never splits a surrogate pair', async () => {
    const { h, put } = await make(); await put('e.md', '😀'.repeat(200) + '.needle' + '😀'.repeat(200));
    const snippet = (await h.search({ query: 'needle' }) as any).data.hits[0].snippet as string;
    expect(snippet).toContain('needle'); expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(snippet)).toBe(false);
  });
});
