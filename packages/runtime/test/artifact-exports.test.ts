import { testByteCustody } from './helpers/byte-custody';
import { describe, expect, it, vi } from 'vitest';
import { exportArtifactArgsSchema } from '@waldo/contracts';
import { artifactBook, inMemoryArtifactBodies, type ArtifactMeta } from '../src/channels/artifacts';
import { artifactExports, exportArtifactHandler, inMemoryArtifactBinaries, r2ArtifactBinaries } from '../src/channels/artifact-exports';

type Row = ArtifactMeta;
const fakeSql = () => {
  const rows = new Map<string, Row>();
  const history = new Map<string, string>();
  const exportsRows: unknown[][] = [];
  return {
    rows,
    exec(query: string, ...args: unknown[]) {
      if (query.startsWith('PRAGMA')) return { toArray: () => [{ name: 'sha256' }] };
      if (query.startsWith('CREATE TABLE')) return { toArray: () => [] as Row[] };
      if (query.startsWith('INSERT OR IGNORE INTO artifact_revisions')) { history.set(`${args[0]}:${args[1]}`, args[2] as string); return { toArray: () => [] }; }
      if (query.startsWith('SELECT metadata_json FROM artifact_revisions')) return { toArray: () => [...history.entries()].filter(([key]) => args.length === 2 ? key === `${args[0]}:${args[1]}` : key.startsWith(`${args[0]}:`)).map(([, metadata_json]) => ({ metadata_json })) };
      if (query.startsWith('INSERT INTO artifacts')) {
        const [id, name, kind, revision, byte_size, r2_key, provenance, taint, created_at, updated_at, sha256] = args as [string, string, Row['kind'], number, number, string, string, string, number, number, string];
        rows.set(id, { id, name, kind, revision, byte_size, r2_key, provenance, taint, created_at, updated_at, sha256 });
        return { toArray: () => [] as Row[] };
      }
      if (query.startsWith('UPDATE artifacts SET')) {
        const [revision, byte_size, r2_key, provenance, updated_at, sha256, id, expected] = args as [number, number, string, string, number, string, string, number];
        const row = rows.get(id)!;
        if (row?.revision === expected) rows.set(id, { ...row, revision, byte_size, r2_key, provenance, updated_at, sha256 });
        return { toArray: () => [] as Row[] };
      }
      if (query.startsWith('SELECT * FROM artifacts WHERE id')) {
        const row = rows.get(args[0] as string);
        return { toArray: () => (row ? [row] : []) };
      }
      if (query.startsWith('SELECT * FROM artifacts WHERE kind')) {
        return { toArray: () => [...rows.values()].filter((r) => r.kind === args[0]).sort((a, b) => b.updated_at - a.updated_at) };
      }
      if (query.startsWith('SELECT * FROM artifacts ORDER BY')) {
        return { toArray: () => [...rows.values()].sort((a, b) => b.updated_at - a.updated_at) };
      }
      if (query.startsWith('INSERT INTO artifact_exports')) { exportsRows.push(args as never); return { toArray: () => [] as Row[] }; }
      if (query.startsWith('DELETE FROM artifact_exports')) { const at = exportsRows.findIndex((r) => (r as unknown[])[0] === args[0]); if (at >= 0) exportsRows.splice(at, 1); return { toArray: () => [] as Row[] }; }
      if (query.startsWith('SELECT * FROM artifact_exports')) return { toArray: () => exportsRows.filter((r) => (r as unknown[])[1] === args[0] && (args.length < 3 || ((r as unknown[])[2] === args[1] && (r as unknown[])[3] === args[2]))).map((a) => { const [id, source_artifact_id, source_revision, format, mime_type, byte_size, sha256, r2_key, created_at] = a as unknown[]; return { id, source_artifact_id, source_revision, format, mime_type, byte_size, sha256, r2_key, created_at }; }) as never };
      throw new Error(`unexpected query: ${query}`);
    },
  };
};


const clock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-10-02T01:00:00Z') };
const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
const setup = async (body: string, newId: () => string = () => 'e1') => {
  const sql = fakeSql(); const bodies = inMemoryArtifactBodies(); const bins = inMemoryArtifactBinaries();
  const book = artifactBook(sql as never, bodies, clock, () => 'abc');
  const meta = await book.create({ name: 'Brief', kind: 'note', body_markdown: body } as never, 'test');
  const ex = artifactExports(sql as never, book, bodies, bins, clock, newId);
  return { meta, ex, bins, bodies, handler: exportArtifactHandler(ex) };
};
const args = (id: string, rev = 1, format = 'pdf') => exportArtifactArgsSchema.parse({ artifact_id: id, expected_revision: rev, format });

describe('export_artifact', () => {
  it('unsupported format writes nothing', async () => {
    const { meta, ex, bins, handler } = await setup('# Hi\n\n- a');
    expect(await handler.handle(args(meta.id, 1, 'docx'))).toMatchObject({ ok: false, code: 'rejected', error: expect.stringContaining("'pdf'") });
    expect(ex.rows(meta.id)).toHaveLength(0);
    expect(await bins.getBytes(`${meta.id}/r1/exp:e1`)).toBeNull();
  });
  it('revision mismatch and unknown id write nothing', async () => {
    const { meta, ex, handler } = await setup('# Hi');
    expect(await handler.handle(args(meta.id, 5))).toMatchObject({ ok: false, code: 'rejected' });
    expect(await handler.handle(args('art:nope'))).toMatchObject({ ok: false, code: 'not_found' });
    expect(ex.rows(meta.id)).toHaveLength(0);
  });
  it('too large and non-Latin text give a typed receipt and write nothing', async () => {
    const big = await setup('x '.repeat(110_000));
    expect(await big.handler.handle(args(big.meta.id))).toMatchObject({ ok: false, error: expect.stringContaining('too large') });
    const dev = await setup('# नमस्ते');
    expect(await dev.handler.handle(args(dev.meta.id))).toMatchObject({ ok: false, error: expect.stringContaining('non-Latin') });
    const blank = await setup('   ');
    expect(await blank.handler.handle(args(blank.meta.id))).toMatchObject({ ok: false, error: expect.stringContaining('empty') });
    expect(blank.ex.rows(blank.meta.id)).toHaveLength(0);
    expect(dev.ex.rows(dev.meta.id)).toHaveLength(0);
    expect(await dev.bins.getBytes(`${dev.meta.id}/r1/exp:e1`)).toBeNull();
  });
  it('success stores real PDF bytes whose sha256 matches the receipt and the row', async () => {
    const { meta, ex, bins, handler } = await setup('# Trip\n\n- Delhi to Mumbai\n\nBody text.');
    const r = await handler.handle(args(meta.id)) as { ok: boolean; data: { status: string; sha256: string; bytes: number; delivery: { status: string; url: null } } };
    expect(r.data.status).toBe('exported');
    expect(r.data.delivery).toEqual({ status: 'saved_internal', url: null, audience: 'unverified' });
    const [row] = ex.rows(meta.id);
    const stored = (await bins.getBytes(row!.r2_key))!;
    expect(new TextDecoder().decode(stored.slice(0, 4))).toBe('%PDF');
    expect(await hex(stored)).toBe(r.data.sha256);
    expect(row).toMatchObject({ sha256: r.data.sha256, byte_size: r.data.bytes, source_revision: 1 });
    if (process.env.PDF_OUT) (await import('node:fs')).writeFileSync(process.env.PDF_OUT, stored);
  });
  it('a repeat export of the same revision returns the stored receipt and writes nothing new', async () => {
    const { meta, ex, handler } = await setup('# Hi\n\ntext');
    const first = await handler.handle(args(meta.id)) as { data: { sha256: string; deduped: boolean } };
    const second = await handler.handle(args(meta.id)) as { data: { sha256: string; deduped: boolean } };
    expect(first.data.deduped).toBe(false);
    expect(second.data).toMatchObject({ sha256: first.data.sha256, deduped: true });
    expect(ex.rows(meta.id)).toHaveLength(1);
  });
  it('a repeat export whose stored file is gone renders again: new id, readable new object, one row', async () => {
    let n = 0;
    const { meta, ex, bins, handler } = await setup('# Hi\n\ntext', () => `e${++n}`);
    const first = await handler.handle(args(meta.id)) as { data: { deduped: boolean } };
    const old = ex.rows(meta.id)[0]!;
    const realGet = bins.getBytes;
    (bins as { getBytes: typeof realGet }).getBytes = async (key: string, max?: number) => key === old.r2_key ? null : realGet(key, max); // the old object is gone
    const second = await handler.handle(args(meta.id)) as { ok: boolean; data: { deduped: boolean } };
    expect(first.data.deduped).toBe(false);
    expect(second).toMatchObject({ ok: true, data: { deduped: false } });
    const rows = ex.rows(meta.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(old.id);
    expect(new TextDecoder().decode((await bins.getBytes(rows[0]!.r2_key))!.slice(0, 5))).toBe('%PDF-');
  });
  it('a stored object that no longer fits its recorded size is treated as stale, not surfaced as an error', async () => {
    let n = 0;
    const { meta, ex, bins, handler } = await setup('# Hi\n\ntext', () => `e${++n}`);
    await handler.handle(args(meta.id));
    const old = ex.rows(meta.id)[0]!;
    const realGet = bins.getBytes;
    (bins as { getBytes: typeof realGet }).getBytes = async (key: string, max?: number) => { if (key === old.r2_key) throw new Error('artifact binary exceeds read bound'); return realGet(key, max); };
    expect(await handler.handle(args(meta.id))).toMatchObject({ ok: true, data: { deduped: false } });
    expect(ex.rows(meta.id)[0]!.id).not.toBe(old.id);
  });
  it('a same-size corrupted PDF is repaired instead of returning a false completed export receipt', async () => {
    let n = 0;
    const { meta, ex, bins, handler } = await setup('# Original\n\nSource detail', () => `e${++n}`);
    await handler.handle(args(meta.id));
    const old = ex.rows(meta.id)[0]!;
    const bytes = (await bins.getBytes(old.r2_key))!.slice(); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await bins.putBytes(old.r2_key, bytes);
    expect(await handler.handle(args(meta.id))).toMatchObject({ ok: true, data: { deduped: false } });
    const row = ex.rows(meta.id)[0]!;
    expect(row.id).not.toBe(old.id);
    expect(await hex((await bins.getBytes(row.r2_key))!)).toBe(row.sha256);
  });
  it('two exports of one revision racing across the write leave one row and both get the same receipt', async () => {
    let n = 0;
    const { meta, ex, handler } = await setup('# Hi\n\ntext', () => `e${++n}`);
    const [a, b] = await Promise.all([handler.handle(args(meta.id)), handler.handle(args(meta.id))]) as Array<{ data: { sha256: string } }>;
    expect(ex.rows(meta.id)).toHaveLength(1);
    expect(a!.data.sha256).toBe(b!.data.sha256);
  });
  it('owner-scoped R2 keys cannot read across owners', async () => {
    const store = new Map<string, Uint8Array>();
    const bucket = { put: async (k: string, v: Uint8Array) => { store.set(k, v); }, get: async (k: string) => (store.has(k) ? { arrayBuffer: async () => store.get(k)!.buffer } : null) } as never;
    const a = r2ArtifactBinaries(bucket, 'owner-a', testByteCustody()); const b = r2ArtifactBinaries(bucket, 'owner-b', testByteCustody());
    await a.putBytes('k', new Uint8Array([1, 2]));
    expect(await b.getBytes('k')).toBeNull();
    expect([...(await a.getBytes('k'))!]).toEqual([1, 2]);
    expect(() => r2ArtifactBinaries(bucket, ' ')).toThrow();
  });
});


it('export source fencing prevents body reads and withholds publication after a source change', async () => {
  const { meta, ex, bodies, bins } = await setup('Private fictional source');
  let current = false;
  const read = vi.spyOn(bodies, 'get');
  const put = vi.spyOn(bins, 'putBytes');
  const assertCurrent = async () => { if (!current) throw new Error('Task changed'); };
  await expect(ex.exportPdf(args(meta.id), assertCurrent)).rejects.toThrow('Task changed');
  expect(read).not.toHaveBeenCalled();
  current = true;
  read.mockImplementationOnce(async () => { current = false; return 'Private fictional source'; });
  await expect(ex.exportPdf(args(meta.id), assertCurrent)).rejects.toThrow('Task changed');
  expect(read).toHaveBeenCalledTimes(1);
  expect(put).not.toHaveBeenCalled();
});

describe('export_artifact delivery link', () => {
  it('returns the owner-authenticated link only when a link builder yields one; a failing builder degrades to saved internally', async () => {
    const { meta, ex } = await setup('# Hi\n\n- a');
    const linked = exportArtifactHandler(ex, async id => `https://staging.invalid/console/exports/${encodeURIComponent(id)}`);
    expect(await linked.handle(args(meta.id))).toMatchObject({ ok: true, data: { status: 'exported', delivery: { status: 'owner_link', url: 'https://staging.invalid/console/exports/exp%3Ae1', audience: 'owner_authenticated' } } });
    const failing = exportArtifactHandler(ex, async () => { throw new Error('origin unavailable'); });
    expect(await failing.handle(args(meta.id))).toMatchObject({ ok: true, data: { delivery: { status: 'saved_internal', url: null } } });
    const none = exportArtifactHandler(ex, async () => null);
    expect(await none.handle(args(meta.id))).toMatchObject({ ok: true, data: { delivery: { status: 'saved_internal', url: null } } });
  });
});
