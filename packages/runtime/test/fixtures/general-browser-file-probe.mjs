// Actual local Chromium observation -> public HTTP stream -> existing workspace
// write/export proof. Supply installed Playwright/executable paths; no live provider.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { cloudflareGeneralBrowser } from '../../src/channels/cloudflare-general-browser.ts';
import { workspaceStore } from '../../../workspace/src/store.ts';
const require = createRequire(import.meta.url), { chromium } = require(process.argv[2] ?? 'playwright');
const executablePath = process.argv[3]; if (!executablePath) throw Error('Local Chromium executable required');
const expected = Uint8Array.from({ length: 1031 }, (_, index) => index % 256), requests = [];
const server = createServer((request, response) => {
  requests.push({ path: request.url, cookie: request.headers.cookie ?? null, authorization: request.headers.authorization ?? null });
  if (request.url === '/file-start') { response.writeHead(302, { location: '/file.bin' }); response.end(); }
  else if (request.url === '/file.bin') { response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(expected.length), 'content-disposition': 'attachment; filename="../../hostile.bin"' }); response.write(expected.slice(0, 23)); response.end(expected.slice(23)); }
  else { response.setHeader('content-type', 'text/html'); response.end('<h1>Public file fixture</h1><a href="/file-start">Retrieve public file</a>'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath }); await browser.newContext({ serviceWorkers: 'block' });
  const origin = `http://127.0.0.1:${server.address().port}`, ownerId = '00000000-0000-4000-8000-000000000001', now = Date.now();
  const row = { id: 'local-host', ownerId, provider: 'cloudflare_playwright', providerSessionId: 'local-simulation', contextHandle: null, mode: 'public', state: 'active', generation: 1, expiresAt: now + 60000, updatedAt: now };
  const sdk = { connect: async () => ({ contexts: () => browser.contexts(), close: async () => {} }) };
  const driver = cloudflareGeneralBrowser({ ownerId, binding: {}, loadSdk: async () => sdk, now: Date.now, deadline: () => row.expiresAt, admit: async () => {}, maxScreenshotBytes: 1024 * 1024, authorizeRequest: async (url, method) => new URL(url).origin === origin && method === 'GET' });
  let state = { binding: null, files: [], bodies: [], operations: [] }, serial = 2, captured;
  const blobs = new Map(), binding = { ownerId, environment: 'local-test', namespace: 'local-test', doName: 'fixture', doId: 'local-fixture', stateVersion: 1, mappingVersion: 1 };
  const store = await workspaceStore({ binding, now: Date.now, newId: () => `00000000-0000-4000-8000-${String(serial++).padStart(12, '0')}`,
    admit: async admitted => { assert.equal(admitted.ownerId, ownerId); return { status: 'ok' }; },
    metadata: { transaction: work => { const before = structuredClone(state); try { return work(state); } catch (error) { state = before; throw error; } } },
    bodies: { put: async (body, bytes) => { blobs.set(body.blob_id, bytes.slice()); }, get: async body => blobs.get(body.blob_id)?.slice() ?? null, remove: async body => { blobs.delete(body.blob_id); } },
  });
  await browser.contexts()[0].addCookies([{ name: 'browser_only', value: 'fixture', url: origin }]);
  const first = await driver.navigate(row, origin + '/page');
  const result = await driver.retrieveFile(row, first, first.observation.elements.find(element => element.name === 'Retrieve public file').ref, {
    maxBytes: 2048, signal: new AbortController().signal, fetch: globalThis.fetch, beforeFileCapture: async () => {},
    persist: async (file, signal) => { assert.equal(signal.aborted, false); assert.equal(file.ownerId, ownerId); captured = file;
      return store.write({ path: 'downloads/public-fixture.bin', bytes: file.bytes, mime: file.mime, expected_revision: 0, provenance: file.provenance, operation_id: '00000000-0000-4000-8000-000000000010' }); },
  });
  const retrieved = await store.export(result.file.file_id, result.file.revision);
  assert.deepEqual(retrieved.bytes, expected); assert.equal(result.file.sha256, createHash('sha256').update(expected).digest('hex'));
  assert.equal(result.file.provenance, 'provider_import'); assert.equal(result.file.source_taint, 'external');
  assert.equal(captured.observationRevision, first.observation.revision); assert.equal(captured.observedSourceUrl, origin + '/file-start'); assert.equal(captured.sourceUrl, origin + '/file.bin'); assert.equal(captured.transport, 'public_http');
  assert.equal(result.file.path, 'downloads/public-fixture.bin');
  assert.equal(state.bodies[0].binding.ownerId, ownerId);
  assert.equal(result.source.observation_revision, first.observation.revision);
  assert(!JSON.stringify(result).includes(origin));
  for (const request of requests.filter(request => request.path.startsWith('/file'))) { assert.equal(request.cookie, null); assert.equal(request.authorization, null); }
  assert.equal(requests.filter(request => request.path === '/file-start').length, 1); assert.equal(requests.filter(request => request.path === '/file.bin').length, 1);
  process.stdout.write(JSON.stringify({ localOnly: true, provider: false, realChromiumObservation: true, transport: 'public_http', bytes: retrieved.bytes.length, hashVerified: true, actualWorkspaceWriteExport: true, provenance: result.file.provenance, sourceTaint: result.file.source_taint, requests: requests.map(request => request.path) }) + '\n');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
