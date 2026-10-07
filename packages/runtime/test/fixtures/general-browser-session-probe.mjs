// Local Chromium/CDP acceptance. Each driver operation connects and releases a
// real transport. No Cloudflare lifecycle, host, model or account claim is made.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url), { chromium } = require(process.argv[2] ?? 'playwright');
const executablePath = process.argv[3]; if (!executablePath) throw Error('Local Chromium executable required');
const { cloudflareGeneralBrowser } = await import(process.argv[4] ? pathToFileURL(process.argv[4]).href : '../../src/channels/cloudflare-general-browser.ts');
const probeDeadline = Date.now() + 60000;
async function withinHarness(operation) {
  const remaining = probeDeadline - Date.now(); if (remaining <= 0) throw Error('Local fixture deadline exceeded');
  let timer;
  try { return await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Local fixture deadline exceeded')), remaining); })]); }
  finally { clearTimeout(timer); }
}
const requests = [], connections = [], profile = await mkdtemp(join(tmpdir(), 'waldo-local-browser-session-'));
const server = createServer((request, response) => {
  requests.push(request.url); response.setHeader('content-type', 'text/html');
  const name = request.url === '/two' ? 'Two' : 'One';
  response.end(`<html><title>Public ${name}</title><body><h1>Useful public tab ${name}</h1><label>Note<input type="text" value="original"></label><button onclick="document.querySelector('#result').textContent='Completed local button action'">Continue</button><p id="result">Ready for local action</p></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let processHandle, processExit, observer;
// This watchdog controls only the synthetic local process, not provider/task budgets.
const watchdog = setTimeout(() => processHandle?.kill('SIGKILL'), Math.max(0, probeDeadline - Date.now()));
try {
  processHandle = spawn(executablePath, ['--headless', '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-extensions', '--disable-sync', '--metrics-recording-only', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  processExit = new Promise(resolve => processHandle.once('exit', resolve));
  await withinHarness(() => new Promise((resolve, reject) => {
    let stderr = '';
    const ready = data => { stderr += data.toString(); if (stderr.includes('DevTools listening on ws://')) { processHandle.stderr.off('data', ready); resolve(); } };
    processHandle.stderr.on('data', ready); processHandle.once('error', reject); processHandle.once('exit', () => reject(Error('Local Chromium exited before CDP readiness')));
  }));
  const [port, socketPath] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
  const endpoint = `http://127.0.0.1:${port}`, endpointSocket = `ws://127.0.0.1:${port}${socketPath}`, origin = `http://127.0.0.1:${server.address().port}`;
  const providerSessionId = 'local-owned-CDP', now = Date.now(); let admitted = true;
  const session = { id: 'local-owner-session', ownerId: 'owner-a', provider: 'cloudflare_playwright', providerSessionId, contextHandle: null, mode: 'public', state: 'active', generation: 1, expiresAt: probeDeadline, updatedAt: now };
  const sessions = async () => {
    try { const response = await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(1000) }); const version = await response.json(); return response.ok && version.webSocketDebuggerUrl === endpointSocket ? [{ sessionId: providerSessionId }] : []; }
    catch { return []; }
  };
  const sdk = {
    connect: async (_binding, options) => {
      assert.deepEqual(options, { sessionId: providerSessionId, persistent: true });
      const connection = await withinHarness(() => chromium.connectOverCDP(endpoint)); connections.push(connection);
      assert.equal(connection.contexts().length, 1); return connection;
    }, sessions,
    acquire: async () => { throw Error('No allocation or replacement is allowed'); },
  };
  const driver = cloudflareGeneralBrowser({ ownerId: session.ownerId, binding: {}, loadSdk: async () => sdk, now: Date.now, deadline: () => session.expiresAt,
    admit: async () => { if (!admitted) throw Error('Existing host authority withdrawn'); }, maxScreenshotBytes: 1024 * 1024,
    authorizeRequest: async (url, method) => new URL(url).origin === origin && method === 'GET' });
  const useful = (snapshot, text) => { assert(snapshot.observation.text.includes(text)); assert.deepEqual([...snapshot.image.bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]); assert(snapshot.image.bytes.length > 100); };
  const detached = async () => { assert(connections.every(connection => !connection.isConnected())); assert.equal((await sessions()).length, 1); };
  const first = await driver.navigate(session, origin + '/one'); useful(first, 'Useful public tab One'); await detached();
  const noteRef = first.observation.elements.find(element => element.name === 'Note' && element.tag === 'input').ref;
  const filled = await driver.act(session, first, { operation: 'fill', element_ref: noteRef, value: 'retained owner note' }, async () => {}); await detached();
  assert.equal(filled.state.elements.find(element => element.tag === 'input').value, 'retained owner note');
  const second = await driver.openTab(session, origin + '/two'); useful(second, 'Useful public tab Two'); await detached();
  assert.equal(second.observation.tabs.length, 2); assert.notEqual(second.targetId, first.targetId);
  const resumed = await driver.observe(session, first.observation.tab_ref); useful(resumed, 'Useful public tab One'); await detached();
  assert.equal(resumed.targetId, first.targetId); assert.equal(resumed.state.elements.find(element => element.tag === 'input').value, 'retained owner note');
  assert.deepEqual(resumed.observation.tabs.map(tab => tab.ref).sort(), second.observation.tabs.map(tab => tab.ref).sort());
  const other = await driver.observe(session, second.observation.tab_ref); useful(other, 'Useful public tab Two'); await detached(); assert.equal(other.targetId, second.targetId);
  const acted = await driver.act(session, other, { operation: 'click', element_ref: other.observation.elements.find(element => element.name === 'Continue').ref }, async () => {});
  useful(acted, 'Completed local button action'); await detached();
  const fresh = await driver.observe(session, first.observation.tab_ref);
  observer = await withinHarness(() => chromium.connectOverCDP(endpoint));
  const retained = observer.contexts()[0].pages().find(page => page.url() === origin + '/one');
  await retained.evaluate(() => { document.querySelector('h1').textContent = 'Useful public tab One changed by local human'; });
  await observer.close(); observer = undefined;
  await assert.rejects(driver.act(session, fresh, { operation: 'click', element_ref: fresh.observation.elements.find(element => element.name === 'Continue').ref }, async () => { throw Error('Stale action must not reach approval'); }), error => error.code === 'stale_observation');
  await detached();
  const cancelled = await driver.observe(session, second.observation.tab_ref);
  await assert.rejects(driver.act(session, cancelled, { operation: 'click', element_ref: cancelled.observation.elements.find(element => element.name === 'Continue').ref }, async () => { admitted = false; }), error => error.code === 'rejected');
  await detached();
  const before = connections.length; await assert.rejects(driver.observe(session), error => error.code === 'rejected'); assert.equal(connections.length, before);
  // CDP command acknowledgement can precede actual local process shutdown.
  // Preserve the driver's conservative uncertainty, then explicitly exercise
  // absence confirmation after the actual operating-system process exit event.
  const physicalClosure = processExit;
  let initialCleanupConfirmed = true;
  try { await withinHarness(() => driver.terminate(session)); }
  catch (error) { assert.equal(error.code, 'cleanup_unconfirmed'); initialCleanupConfirmed = false; }
  await withinHarness(() => physicalClosure);
  assert.deepEqual(await sessions(), []);
  await withinHarness(() => driver.terminate(session));
  assert.deepEqual(await sessions(), []); assert.equal(processHandle.exitCode, 0);
  await assert.rejects(chromium.connectOverCDP(endpoint, { timeout: 1000 }));
  assert(connections.every(connection => !connection.isConnected()));
  assert.deepEqual(requests, ['/one', '/two']);
  process.stdout.write(JSON.stringify({ localOnly: true, provider: false, realCDPDisconnectReconnect: true, retainedTabs: 2, retainedInput: true, usefulTextAndPng: true, secondTurnObservationAction: true, staleRejected: true, authorityCancellationBeforeEffect: true, exactPhysicalClosure: true, actualProcessExit: true, initialCleanupConfirmed, explicitAbsenceConfirmation: true, connections: connections.length, screenshotBytes: [first.image.bytes.length, second.image.bytes.length, acted.image.bytes.length] }) + '\n');
} finally { clearTimeout(watchdog); if (processHandle?.pid && processHandle.exitCode === null) { processHandle.kill('SIGKILL'); await processExit; } await observer?.close().catch(() => {}); await new Promise(resolve => server.close(resolve)); await rm(profile, { recursive: true, force: true }); }
