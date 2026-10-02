import { describe, expect, it } from 'vitest';
import { renderMarkdownPdf } from '../src/channels/artifact-export';
import { artifactExports, inMemoryArtifactBinaries, r2ArtifactBinaries, type ArtifactBinaries, type ExportRow } from '../src/channels/artifact-exports';
import { ARTIFACT_EXPORT_MAX_BYTES, ARTIFACT_EXPORT_PATH, artifactExportDownload } from '../src/channels/artifact-export-download';

const sha = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
const allow = { limit: async () => ({ success: true }) } as unknown as RateLimit;
const deny = { limit: async () => ({ success: false }) } as unknown as RateLimit;
const boom = { limit: async () => { throw new Error('limiter exploded sk-secret'); } } as unknown as RateLimit;

// One owner's store: a row plus its bytes, built the way the exporter builds them.
const store = async (id: string, text = '# Brief\n\nhello') => {
  const rendered = await renderMarkdownPdf(text);
  if (rendered.status !== 'exported') throw new Error('render failed');
  const key = `art:one/r1/${id}`;
  const bins = inMemoryArtifactBinaries();
  await bins.putBytes(key, rendered.bytes);
  const row: ExportRow = { id, source_artifact_id: 'art:one', source_revision: 1, format: 'pdf', mime_type: 'application/pdf', byte_size: rendered.bytes.length, sha256: rendered.sha256, r2_key: key, created_at: 1 };
  const rows = new Map<string, ExportRow>([[id, row]]);
  return { row, rows, bins, bytes: rendered.bytes, exports: { byId: (x: string) => rows.get(x) ?? null } };
};
const get = (id: string, init?: RequestInit) => new Request(`https://x.test${ARTIFACT_EXPORT_PATH}/${encodeURIComponent(id)}`, init);
const run = (s: { exports: { byId(id: string): ExportRow | null }; bins: ArtifactBinaries }, request: Request, limiter: RateLimit | null = allow) =>
  artifactExportDownload(request, { exports: s.exports, binaries: s.bins, limiter: limiter ?? undefined, ownerScope: 'owner-A' });
const text = async (r: Response | null) => (r === null ? null : await r.text());

describe('artifact export download', () => {
  it('serves the exact stored bytes as an attachment with fixed safe headers', async () => {
    const s = await store('exp:e1');
    const r = (await run(s, get('exp:e1')))!;
    expect(r.status).toBe(200);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(s.bytes);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="artifact.pdf"');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(r.headers.get('content-length')).toBe(String(s.bytes.length));
  });

  it('is inert for other paths and answers only GET', async () => {
    const s = await store('exp:e1');
    expect(await run(s, new Request('https://x.test/console/artifacts/art:one'))).toBeNull();
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) expect((await run(s, get('exp:e1', { method })))!.status).toBe(405);
  });

  it('rejects malformed ids before any store access', async () => {
    let touched = 0;
    const s = { exports: { byId: () => { touched += 1; return null; } }, bins: inMemoryArtifactBinaries() };
    for (const bad of ['art:one', 'exp:', 'exp:a/b', 'exp:a b', 'EXP:e1', `exp:${'a'.repeat(129)}`, 'exp:..%2f..']) {
      expect((await run(s, new Request(`https://x.test${ARTIFACT_EXPORT_PATH}/${bad.includes('%') ? bad : encodeURIComponent(bad)}`)))!.status).toBe(404);
    }
    expect(touched).toBe(0);
  });

  it('limiter absent is 503, denied is 429, a throwing limiter is 503 with no detail, all before any store access', async () => {
    let touched = 0;
    const s = { exports: { byId: () => { touched += 1; return null; } }, bins: inMemoryArtifactBinaries() };
    expect((await run(s, get('exp:e1'), null))!.status).toBe(503);
    expect((await run(s, get('exp:e1'), deny))!.status).toBe(429);
    const thrown = (await run(s, get('exp:e1'), boom))!;
    expect(thrown.status).toBe(503);
    expect(await thrown.text()).not.toContain('secret');
    expect(touched).toBe(0);
  });

  it('unknown id and missing bytes are 404 with a fixed body', async () => {
    const s = await store('exp:e1');
    expect(await text(await run(s, get('exp:nope')))).toBe('not found');
    await s.bins.putBytes(s.row.r2_key, new Uint8Array(0));
    const gone = { ...s, bins: inMemoryArtifactBinaries() };
    const r = (await run(gone, get('exp:e1')))!;
    expect(r.status).toBe(404);
    expect(await r.text()).toBe('not found');
  });

  it('a length, digest or header mismatch is 503 and never returns bytes', async () => {
    const s = await store('exp:e1');
    const flipped = new Uint8Array(s.bytes); flipped[flipped.length - 3] = (flipped[flipped.length - 3] ?? 0) ^ 0xff;
    for (const bytes of [flipped, s.bytes.slice(0, s.bytes.length - 1), new Uint8Array([...s.bytes, 0]), new TextEncoder().encode('<html>not a pdf</html>')]) {
      const bins = inMemoryArtifactBinaries(); await bins.putBytes(s.row.r2_key, bytes);
      const r = (await run({ ...s, bins }, get('exp:e1')))!;
      expect(r.status).toBe(503);
      expect(await r.text()).toBe('temporarily unavailable');
    }
    // right length and digest of non-PDF content still fails the %PDF- check
    const html = new TextEncoder().encode('<html>x</html>');
    const bins = inMemoryArtifactBinaries(); await bins.putBytes('k', html);
    const rows = new Map([['exp:h', { ...s.row, id: 'exp:h', r2_key: 'k', byte_size: html.length, sha256: await sha(html) }]]);
    const r = (await run({ exports: { byId: (x: string) => rows.get(x) ?? null }, bins }, get('exp:h')))!;
    expect(r.status).toBe(503);
    expect(r.headers.get('content-type')).not.toBe('application/pdf');
  });

  it('a malformed row is 503: wrong format or mime, bad size, bad digest, empty key, over the byte cap', async () => {
    const s = await store('exp:e1');
    const variants: Partial<ExportRow>[] = [
      { format: 'docx' }, { mime_type: 'text/html' }, { byte_size: 0 }, { byte_size: -1 }, { byte_size: 1.5 },
      { byte_size: ARTIFACT_EXPORT_MAX_BYTES + 1 }, { sha256: 'ABC' }, { sha256: 'g'.repeat(64) }, { r2_key: '' },
    ];
    for (const v of variants) {
      const rows = new Map([['exp:e1', { ...s.row, ...v }]]);
      const r = (await run({ exports: { byId: (x: string) => rows.get(x) ?? null }, bins: s.bins }, get('exp:e1')))!;
      expect(r.status).toBe(503);
    }
  });

  it('stored bytes larger than the cap are refused even when the row claims a small size', async () => {
    const s = await store('exp:e1');
    const big = new Uint8Array(ARTIFACT_EXPORT_MAX_BYTES + 1); big.set(new TextEncoder().encode('%PDF-'));
    const bins = inMemoryArtifactBinaries(); await bins.putBytes(s.row.r2_key, big);
    expect((await run({ ...s, bins }, get('exp:e1')))!.status).toBe(503);
  });

  it('a throwing store is 503 and no error text carries keys, ids or digests', async () => {
    const s = await store('exp:e1');
    const bins: ArtifactBinaries = { putBytes: async () => {}, getBytes: async () => { throw new Error(`r2 failed ${s.row.r2_key} ${s.row.sha256}`); } };
    const r = (await run({ ...s, bins }, get('exp:e1')))!;
    expect(r.status).toBe(503);
    const body = await r.text();
    for (const leak of [s.row.r2_key, s.row.sha256, 'exp:e1', 'r2 failed']) expect(body).not.toContain(leak);
  });

  it('error bodies are the fixed strings only', async () => {
    const s = await store('exp:e1');
    const bodies = new Set<string>();
    for (const r of [await run(s, get('exp:e1', { method: 'POST' })), await run(s, get('exp:x')), await run(s, get('exp:e1'), deny), await run(s, get('exp:e1'), null), await run(s, get('bad'))]) bodies.add(await r!.text());
    expect([...bodies].sort()).toEqual(['method not allowed', 'not found', 'temporarily unavailable', 'too many requests']);
  });

  it('owner B cannot read owner A export through B\'s store, and each owner gets only their own bytes for a shared id', async () => {
    const a = await store('exp:shared', '# Owner A secret plan');
    const b = await store('exp:onlyb', '# Owner B notes');
    expect((await run(b, get('exp:shared')))!.status).toBe(404);
    expect((await run(a, get('exp:onlyb')))!.status).toBe(404);
    const b2 = await store('exp:shared', '# Owner B different');
    const ra = new Uint8Array(await (await run(a, get('exp:shared')))!.arrayBuffer());
    const rb = new Uint8Array(await (await run(b2, get('exp:shared')))!.arrayBuffer());
    expect(ra).toEqual(a.bytes);
    expect(rb).toEqual(b2.bytes);
    expect(ra).not.toEqual(rb);
  });

  it('a snapshot stays downloadable after its source moved on (no expiry, no revision check)', async () => {
    const s = await store('exp:e1');
    s.rows.set('exp:e1', { ...s.row, source_revision: 1 });
    expect((await run(s, get('exp:e1')))!.status).toBe(200);
  });

  it('byId on the real export store returns the row or null', async () => {
    const calls: Array<{ q: string; a: unknown[] }> = [];
    const row = { id: 'exp:e9', source_artifact_id: 'art:one', source_revision: 1, format: 'pdf', mime_type: 'application/pdf', byte_size: 5, sha256: 'a'.repeat(64), r2_key: 'k', created_at: 1 };
    const sql = { exec: (q: string, ...a: unknown[]) => { calls.push({ q, a }); return { toArray: () => (q.startsWith('SELECT * FROM artifact_exports WHERE id') && a[0] === 'exp:e9' ? [row] : []) }; } };
    const ex = artifactExports(sql as never, {} as never, {} as never, inMemoryArtifactBinaries(), { timezone: 'UTC', now: () => new Date(0) }, () => 'x');
    expect(ex.byId('exp:e9')).toEqual(row);
    expect(ex.byId('exp:none')).toBeNull();
  });
});

describe('read bound', () => {
  it('in-memory binaries refuse an object over maxBytes', async () => {
    const b = inMemoryArtifactBinaries();
    await b.putBytes('k', new Uint8Array(10));
    await expect(b.getBytes('k', 9)).rejects.toThrow('read bound');
    expect((await b.getBytes('k', 10))?.length).toBe(10);
  });
  it('r2 binaries refuse before reading the body', async () => {
    let read = false;
    const bucket = { get: async () => ({ size: 100, arrayBuffer: async () => { read = true; return new ArrayBuffer(100); } }) } as unknown as R2Bucket;
    const b = r2ArtifactBinaries(bucket, 'o1');
    await expect(b.getBytes('k', 50)).rejects.toThrow('read bound');
    expect(read).toBe(false);
  });
});
