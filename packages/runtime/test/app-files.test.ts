import { describe, expect, it } from 'vitest';
import { renderMarkdownPdf } from '../src/channels/artifact-export';
import { inMemoryArtifactBinaries, type ExportRow } from '../src/channels/artifact-exports';
import { APP_FILES_PATH, appFileDownload } from '../src/channels/app-files';

const allow = { limit: async () => ({ success: true }) } as unknown as RateLimit;
const deny = { limit: async () => ({ success: false }) } as unknown as RateLimit;
const owner = async () => {
  const rendered = await renderMarkdownPdf('# E-ticket\n\nFictional flight WA 101');
  if (rendered.status !== 'exported') throw new Error('render failed');
  const bins = inMemoryArtifactBinaries(), key = 'art:ticket/r1/exp:t1';
  await bins.putBytes(key, rendered.bytes);
  const row: ExportRow = { id: 'exp:t1', source_artifact_id: 'art:ticket', source_revision: 1, format: 'pdf', mime_type: 'application/pdf', byte_size: rendered.bytes.length, sha256: rendered.sha256, r2_key: key, created_at: 1 };
  return { bytes: rendered.bytes, deps: (limiter: RateLimit = allow) => ({ exports: { byId: (id: string) => (id === row.id ? row : null) }, binaries: bins, limiter, ownerScope: 'owner-A' }) };
};
const get = (ref: string, init?: RequestInit) => new Request(`https://telegram-owner${APP_FILES_PATH}/${encodeURIComponent(ref)}`, init);

describe('app file download', () => {
  it('serves an owner\'s exported PDF by its file ref, exactly, with the same safe headers as the console', async () => {
    const o = await owner(), r = (await appFileDownload(get('exp:t1'), o.deps()))!;
    expect(r.status).toBe(200);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(o.bytes);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toContain('sandbox');
  });
  it('answers only its own path, only GET, and 404 for any ref this owner does not hold or that is not a file ref', async () => {
    const o = await owner();
    expect(await appFileDownload(new Request('https://telegram-owner/app/v1/chat'), o.deps())).toBeNull();
    expect((await appFileDownload(get('exp:t1', { method: 'POST' }), o.deps()))!.status).toBe(405);
    for (const ref of ['exp:other', 'art:ticket', 'exp:../t1', '', 'file:t1'])
      expect((await appFileDownload(get(ref), o.deps()))!.status, ref).toBe(404);
  });
  it('spends the owner\'s read allowance before touching the store', async () => {
    const o = await owner();
    expect((await appFileDownload(get('exp:t1'), o.deps(deny)))!.status).toBe(429);
  });
});
