// Local Chromium protocol proof. Supply an installed Playwright module path and
// browser executable as CLI args; no account, provider call or dependency install.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { generalPageState } from '../../src/channels/general-browser-observation.ts';
import { pathToFileURL } from 'node:url';
import { cloudflareGeneralBrowser } from '../../src/channels/cloudflare-general-browser.ts';
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] ?? 'playwright');
const executablePath = process.argv[3];
if (!executablePath) throw Error('A local Chromium executable is required');
const requests = [], targetRequests = [];
const targetServer = createServer((request, response) => {
  targetRequests.push(request.url);
  response.setHeader('set-cookie', 'redirect_cookie=target_only; Path=/');
  response.end('<h1>Foreign iframe payload</h1>');
});
await new Promise(resolve => targetServer.listen(0, '127.0.0.1', resolve));
const targetOrigin = `http://127.0.0.1:${targetServer.address().port}`;
const server = createServer((request, response) => {
  requests.push(request.url);
  const redirects = { '/start': '/middle', '/middle': '/denied', '/allowed-start': '/allowed-middle', '/allowed-middle': '/final', '/link-start': '/final', '/frame-start': targetOrigin + '/frame-final', '/asset-start': targetOrigin + '/asset-final' };
  if (redirects[request.url]) { response.writeHead(302, { location: redirects[request.url] }); response.end(); }
  else { response.setHeader('content-type', 'text/html'); response.end('<h1>Useful final public content</h1><a href="/link-start">Redirected link</a><iframe src="/frame-start"></iframe><img src="/asset-start">'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath });
  await browser.newContext({ serviceWorkers: 'block' });
  // Evaluate the actual tsx/esbuild-transformed function through Playwright's
  // real serializer and Chromium, so host-only compilation helpers cannot hide.
  const serializationPage = await browser.contexts()[0].newPage();
  await serializationPage.setContent('<h1>Serialization fixture</h1><label>Name<input></label><button>Continue</button>');
  const evaluated = await serializationPage.evaluate(process.argv[4] ? (await import(pathToFileURL(process.argv[4]).href)).generalPageState : generalPageState);
  assert.equal(evaluated.elements.find(element => element.tag === 'button').name, 'Continue');
  assert.equal(await serializationPage.locator(evaluated.elements.find(element => element.tag === 'button').selector).count(), 1);
  await serializationPage.close();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const sdk = { connect: async () => ({ contexts: () => browser.contexts(), close: async () => {} }) };
  const now = Date.now(), session = { id: 'local-host', ownerId: 'owner-a', provider: 'cloudflare_playwright', providerSessionId: 'local-simulation', contextHandle: null, mode: 'public', state: 'active', generation: 1, expiresAt: now + 60000, updatedAt: now };
  const driver = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: {}, loadSdk: async () => sdk, now: Date.now, deadline: () => now + 60000, admit: async () => {}, maxScreenshotBytes: 1024 * 1024,
    authorizeRequest: async url => { const target = new URL(url); return [origin, targetOrigin].includes(target.origin) && target.pathname !== '/denied'; } });
  const first = await driver.navigate(session, origin + '/allowed-start');
  await browser.contexts()[0].pages()[0].waitForLoadState('load');
  assert.deepEqual(targetRequests, []);
  assert(!(await browser.contexts()[0].cookies()).some(cookie => cookie.name === 'redirect_cookie'));
  assert.equal(first.observation.url, origin + '/final');
  assert(first.observation.text.includes('Useful final public content'));
  assert.deepEqual([...first.image.bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const clicked = await driver.act(session, first, { operation: 'click', element_ref: first.observation.elements.find(element => element.name === 'Redirected link').ref }, async () => {});
  assert.equal(clicked.observation.url, origin + '/final');
  await assert.rejects(driver.navigate(session, origin + '/start'), error => error.code === 'rejected');
  assert(!requests.includes('/denied'));
  await assert.rejects(driver.observe(session, first.observation.tab_ref), error => error.code === 'stale_observation');
  process.stdout.write(JSON.stringify({ localOnly: true, provider: false, serializedObservation: true, iframeOriginProtected: true, resourceCookieOriginProtected: true, allowedNavigation: true, redirectedClick: true, deniedDestinationRequests: 0, screenshotBytes: first.image.bytes.length, requests }) + '\n');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); await new Promise(resolve => targetServer.close(resolve)); }
