import { expect, it } from 'vitest';
import { captureGeneralBrowserFile } from '../src/channels/general-browser-files';
const scope = { ownerId: 'owner-a', sessionId: 'host-session', generation: 1, targetId: 'target-a', observationRevision: 'observed-revision' };
function fixture(body = new Uint8Array([1, 2, 3])) {
  const calls: any[] = [];
  const options = { scope, sourceUrl: 'https://docs.example/file', maxBytes: 10, now: () => 1, deadline: () => 10000, signal: new AbortController().signal,
    admit: async () => {}, authorize: async (url: string) => { calls.push(['authorize', url]); }, beforeFileCapture: async () => { calls.push(['approval']); },
    fetch: async (url: any, init: any) => { calls.push(['fetch', url, init]); return new Response(body, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(body.length), 'content-disposition': 'attachment; filename="../../hostile.exe"' } }); },
    persist: async (file: any) => { calls.push(['persist', file]); return { file_id: '00000000-0000-4000-8000-000000000001', path: 'downloads/approved.bin', revision: 1, mime: file.mime, byte_size: file.bytes.length, sha256: file.sha256, provenance: file.provenance, source_taint: file.source_taint, created_at: 1, updated_at: 1, state: 'ready' }; },
  };
  return { options, calls };
}
it('streams exact public bytes into existing owner custody with import provenance and confirmed hash', async () => {
  const f = fixture(); const result = await captureGeneralBrowserFile(f.options as never);
  expect(result.file).toMatchObject({ byte_size: 3, provenance: 'provider_import', source_taint: 'external', path: 'downloads/approved.bin' });
  const captured = f.calls.find(call => call[0] === 'persist')[1];
  expect(captured).toMatchObject({ ...scope, sourceUrl: 'https://docs.example/file', transport: 'public_http', provenance: 'provider_import', source_taint: 'external' });
  expect([...captured.bytes]).toEqual([1, 2, 3]);
  const init = f.calls.find(call => call[0] === 'fetch')[2]; expect(init).toMatchObject({ method: 'GET', redirect: 'manual' });
  expect(init.headers).not.toHaveProperty('cookie');
});
it('rejects announced or actual oversize data before persistence', async () => {
  const f = fixture(new Uint8Array(11));
  await expect(captureGeneralBrowserFile(f.options as never)).rejects.toMatchObject({ code: 'file_oversize' });
  expect(f.calls.some(call => call[0] === 'persist')).toBe(false);
});
it('does not treat a denied HTTP response as useful file retrieval', async () => {
  const f = fixture(); f.options.fetch = async () => new Response('access denied', { status: 403 });
  await expect(captureGeneralBrowserFile(f.options as never)).rejects.toMatchObject({ code: 'file_unavailable', diagnostic: { status: 403 } });
  expect(f.calls.some(call => call[0] === 'persist')).toBe(false);
});
it('rejects an unconfirmed owner receipt instead of announcing file success', async () => {
  const f = fixture(), persist = f.options.persist;
  f.options.persist = async file => ({ ...await persist(file), sha256: 'wrong' });
  await expect(captureGeneralBrowserFile(f.options as never)).rejects.toMatchObject({ code: 'outcome_uncertain' });
});
it('does not fetch a rejected redirect hop', async () => {
  const f = fixture(); f.options.fetch = async (url, init) => { f.calls.push(['fetch', url, init]); return new Response(null, { status: 302, headers: { location: 'https://denied.example/file' } }); };
  f.options.authorize = async url => { if (url.includes('denied')) throw Error('not authorized'); };
  await expect(captureGeneralBrowserFile(f.options as never)).rejects.toMatchObject({ code: 'rejected' });
  expect(f.calls.filter(call => call[0] === 'fetch')).toHaveLength(1);
});
it('bounds a chunked response by actual bytes and cancels overflow', async () => {
  const f = fixture(); let canceled = false;
  f.options.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(6)); controller.enqueue(new Uint8Array(6)); }, cancel() { canceled = true; } }), { headers: { 'content-type': 'application/octet-stream' } });
  await expect(captureGeneralBrowserFile(f.options as never)).rejects.toMatchObject({ code: 'file_oversize' });
  expect(canceled).toBe(true); expect(f.calls.some(call => call[0] === 'persist')).toBe(false);
});
it('does not persist truncated bytes advertised as a complete file', async () => {
  const f = fixture(); f.options.fetch = async () => new Response(new Uint8Array([1]), { headers: { 'content-length': '2' } });
  await expect(captureGeneralBrowserFile(f.options as never)).rejects.toMatchObject({ code: 'file_unavailable' });
  expect(f.calls.some(call => call[0] === 'persist')).toBe(false);
});
it('rejects late source withdrawal while reading before any workspace write', async () => {
  const f = fixture(), controller = new AbortController(); f.options.signal = controller.signal; let pull = 0;
  f.options.fetch = async () => new Response(new ReadableStream({ pull(stream) { if (++pull === 1) stream.enqueue(new Uint8Array([1])); else controller.abort(); } }));
  await expect(captureGeneralBrowserFile(f.options as never)).rejects.toMatchObject({ code: 'rejected' });
  expect(f.calls.some(call => call[0] === 'persist')).toBe(false);
});
it('does not expose source URL query credentials or raw file bytes in the returned receipt', async () => {
  const f = fixture(); f.options.sourceUrl = 'https://docs.example/file?synthetic-private-token=fixture';
  const result = await captureGeneralBrowserFile(f.options as never);
  expect(JSON.stringify(result)).not.toContain('synthetic-private-token');
  expect(result.source.source_ref).toMatch(/^file-source:/); expect(result).not.toHaveProperty('bytes');
});
