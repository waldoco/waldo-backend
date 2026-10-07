// Installed-SDK protocol proof against a local fake binding; no network/account.
import assert from 'node:assert/strict';
import { cloudflareGeneralBrowser } from '../../src/channels/cloudflare-general-browser.ts';
const calls = [];
const binding = { fetch: async (url, init) => {
  const target = new URL(url);
  calls.push({ path: target.pathname, method: init?.method ?? 'GET', body: init?.body });
  if (init?.method === 'POST') return Response.json({ sessionId: 'sdk-probe-id' });
  if (target.pathname === '/v1/sessions') return Response.json({ sessions: [] });
  return Response.json({ code: 'usage_limit', message: 'SECRET_PROVIDER_BODY' }, { status: 402, headers: { 'x-request-id': 'sdk-request' } });
} };
globalThis.__fixtureWorkerEnv = { BROWSER: binding };
const sdk = await import('@cloudflare/playwright');
const driver = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding, loadSdk: async () => sdk, now: () => 1, admit: async () => {}, authorizeRequest: async () => true, maxScreenshotBytes: 1024 });
const id = await driver.start(['docs.example'], 60000, async () => {}, async () => {});
assert.equal(id, 'sdk-probe-id');
assert.deepEqual(JSON.parse(calls[0].body), { guardrails: { allowedDomains: ['docs.example'] } });
const session = { id: 'host-id', ownerId: 'owner-a', provider: 'cloudflare_playwright', providerSessionId: id, contextHandle: null, mode: 'public', state: 'active', generation: 1, expiresAt: 60000, updatedAt: 0 };
await assert.rejects(driver.observe(session), error => {
  assert.equal(error.code, 'provider_unavailable');
  assert.deepEqual(error.diagnostic, { status: 402, code: 'usage_limit', request_id: 'sdk-request' });
  assert(!error.message.includes('SECRET_PROVIDER_BODY'));
  return true;
});
assert.equal(calls[1].path, '/v1/devtools/browser/sdk-probe-id');
await driver.terminate(session);
assert.equal(calls.filter(call => call.method === 'POST').length, 1);
process.stdout.write('installed SDK: acquire guard, exact-session connect, bounded 402 and absence check passed\n');
