// Advanced semantic controls on the same local Chromium/CDP harness.
// Lifecycle/transport setup is copied from general-browser-session-probe.mjs;
// that independently runnable probe remains unchanged.
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
  response.end(`<html><title>Public filter research</title><body>
    <h1>Public restaurant filters</h1>
    <label for="cuisine">Cuisine</label><select id="cuisine"><option value="all">All cuisines</option><option value="vegetarian">Vegetarian</option><option value="unavailable" disabled>Unavailable cuisine</option></select>
    <label><input id="open" type="checkbox">Open now</label>
    <label>Password<input id="password" type="password" value="LOCAL_PASSWORD_CANARY_894"></label>
    <div contenteditable="true" role="textbox" aria-label="Research note">Initial public note</div>
    <p id="results">Choose public filters</p><div id="shadow-host"></div>
    <button id="apply" onclick="document.querySelector('#results').textContent='Vegetarian restaurant matches: The Green Table'">Apply filters</button>
    <script>
      const shadow=document.querySelector('#shadow-host').attachShadow({mode:'open'});
      shadow.innerHTML='<label>Neighbourhood<input id="area" type="text" value="Old town"></label><a href="/details" aria-label="Restaurant details">Read details</a>';
    </script>
  </body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let processHandle, processExit;
// This watchdog controls only the synthetic local process, not provider/task budgets.
const watchdog = setTimeout(() => processHandle?.kill('SIGKILL'), Math.max(0, probeDeadline - Date.now()));
try {
  processHandle = spawn(executablePath, ['--headless', '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-extensions','--disable-component-extensions-with-background-pages','--disable-features=MediaRouter', '--disable-sync', '--metrics-recording-only', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  processExit = new Promise(resolve => processHandle.once('exit', resolve));
  await withinHarness(() => new Promise((resolve, reject) => {
    let stderr = '';
    const ready = data => { stderr += data.toString(); if (stderr.includes('DevTools listening on ws://')) { processHandle.stderr.off('data', ready); resolve(); } };
    processHandle.stderr.on('data', ready); processHandle.once('error', reject); processHandle.once('exit', () => reject(Error('Local Chromium exited before CDP readiness')));
  }));
  const [port, socketPath] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
  const endpoint = `http://127.0.0.1:${port}`, endpointSocket = `ws://127.0.0.1:${port}${socketPath}`, origin = `http://127.0.0.1:${server.address().port}`;
  const providerSessionId = 'local-owned-CDP', now = Date.now();
  const session = { id: 'local-owner-session', ownerId: 'owner-a', provider: 'cloudflare_playwright', providerSessionId, contextHandle: null, mode: 'public', state: 'active', generation: 1, expiresAt: probeDeadline, updatedAt: now };
  const sessions = async () => {
    try { const response = await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(1000) }); const version = await response.json(); return response.ok && version.webSocketDebuggerUrl === endpointSocket ? [{ sessionId: providerSessionId }] : []; }
    catch { return []; }
  };
  const sdk = {
    connect: async (_binding, options) => {
      assert.deepEqual(options, { sessionId: providerSessionId, persistent: true });
      const connection = await withinHarness(() => chromium.connectOverCDP(endpoint)); connections.push(connection);
      assert.equal(connection.contexts().length, 1);if(connection.contexts()[0].serviceWorkers().length)throw Error('Local fixture has pre-existing service workers: '+JSON.stringify(connection.contexts()[0].serviceWorkers().map(worker=>worker.url())));return connection;
    }, sessions,
    acquire: async () => { throw Error('No allocation or replacement is allowed'); },
  };
  let turnAdmitted = true, allocations = 0;
  sdk.acquire = async () => { allocations++; throw Error('No allocation or replacement is allowed'); };
  const driver = cloudflareGeneralBrowser({ ownerId: session.ownerId, binding: {}, loadSdk: async () => sdk,
    publicRead: true, retainConnection: true, now: Date.now, deadline: () => session.expiresAt,
    admit: async () => { if (!turnAdmitted) throw Error('Existing host authority withdrawn'); },
    maxScreenshotBytes: 1024 * 1024,
    authorizeRequest: async (url, method) => new URL(url).origin === origin && method === 'GET' });
  const find = (snapshot, name, tag) => {
    const element = snapshot.observation.elements.find(item => item.name.trim() === name && (!tag || item.tag === tag));
    assert(element, `Missing semantic ${tag ?? 'element'} ${name}`); return element.ref;
  };
  const state = (snapshot, name) => {
    const element = snapshot.state.elements.find(item => item.name.trim() === name);
    assert(element, `Missing state ${name}`); return element;
  };
  const inspect = snapshot => {
    assert(snapshot.observation.text.includes('Public restaurant filters'));
    assert.deepEqual([...snapshot.image.bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(typeof snapshot.observation.accessibility_snapshot, 'string');
    assert(snapshot.observation.accessibility_snapshot.includes('Cuisine'));
    assert(snapshot.observation.accessibility_snapshot.includes('Neighbourhood'));
    assert(snapshot.observation.accessibility_snapshot.includes('Restaurant details'));
    const leaked = [...Object.entries(snapshot.state).filter(([, value]) => JSON.stringify(value).includes('LOCAL_PASSWORD_CANARY_894')).map(([key]) => 'state.' + key), ...Object.entries(snapshot.observation).filter(([, value]) => JSON.stringify(value).includes('LOCAL_PASSWORD_CANARY_894')).map(([key]) => 'observation.' + key)];
    assert(!JSON.stringify(snapshot).includes('LOCAL_PASSWORD_CANARY_894'), 'Password values must never enter snapshot/state/AX evidence: ' + JSON.stringify(leaked));
  };
  const first = await driver.navigate(session, origin + '/filters');
  if (process.argv.includes('--ax-tree-probe')) {
    const connection = connections.at(-1), context = connection.contexts().find(item => item.pages().some(page => page.url() === origin + '/filters'));
    const page = context.pages().find(item => item.url() === origin + '/filters');
    const cdp = await context.newCDPSession(page);
    try {
      const tree = await cdp.send('Accessibility.getFullAXTree');
      const named = name => tree.nodes.find(node => node.name?.value === name);
      process.stderr.write(JSON.stringify({ nativeCdpAxProbe: true, passwordCanaryAbsent: !JSON.stringify(tree).includes('LOCAL_PASSWORD_CANARY_894'), passwordControlPresent: Boolean(named('Password')), passwordValueMasked: Boolean(named('Password')) && named('Password').value?.value !== 'LOCAL_PASSWORD_CANARY_894', cuisineNamePresent: Boolean(named('Cuisine')), cuisineComboboxRole: named('Cuisine')?.role?.value === 'combobox', neighbourhoodNamePresent: Boolean(named('Neighbourhood')), restaurantDetailsLinkRole: named('Restaurant details')?.role?.value === 'link' }) + '\n');
    } finally { await cdp.detach(); }
  }
  inspect(first);
  const options = state(first, 'Cuisine').options;
  assert.deepEqual(options.map(option => [option.value, option.label, option.disabled, option.selected]), [
    ['all', 'All cuisines', false, true], ['vegetarian', 'Vegetarian', false, false], ['unavailable', 'Unavailable cuisine', true, false],
  ]);
  let snapshot = await driver.act(session, first, { operation: 'select', element_ref: find(first, 'Cuisine'), value: 'vegetarian' }, async () => {});
  assert.equal(state(snapshot, 'Cuisine').value, 'vegetarian');
  assert.equal(state(snapshot, 'Cuisine').options.find(option => option.value === 'vegetarian').selected, true);
  snapshot = await driver.act(session, snapshot, { operation: 'set_checked', element_ref: find(snapshot, 'Open now', 'input'), checked: true }, async () => {});
  assert.equal(state(snapshot, 'Open now').checked, true);
  snapshot = await driver.act(session, snapshot, { operation: 'set_checked', element_ref: find(snapshot, 'Open now', 'input'), checked: true }, async () => {});
  assert.equal(state(snapshot, 'Open now').checked, true, 'Desired state must be idempotent, never a toggle');
  snapshot = await driver.act(session, snapshot, { operation: 'set_checked', element_ref: find(snapshot, 'Open now', 'input'), checked: false }, async () => {});
  assert.equal(state(snapshot, 'Open now').checked, false);
  snapshot = await driver.act(session, snapshot, { operation: 'fill', element_ref: find(snapshot, 'Neighbourhood', 'input'), value: 'Riverside' }, async () => {});
  assert.equal(state(snapshot, 'Neighbourhood').value, 'Riverside'); inspect(snapshot);
  assert.equal(state(snapshot, 'Research note').editable, true);
  assert.equal(state(snapshot, 'Research note').readOnly, false);
  snapshot = await driver.act(session, snapshot, { operation: 'fill', element_ref: find(snapshot, 'Research note', 'div'), value: 'Owner research note: vegetarian choices' }, async () => {});
  assert(snapshot.observation.text.includes('Owner research note: vegetarian choices'));
  assert(snapshot.observation.accessibility_snapshot.includes('Owner research note: vegetarian choices'));
  inspect(snapshot);
  const shadowLink = snapshot.observation.elements.find(item => item.ref === find(snapshot, 'Restaurant details', 'a'));
  assert.equal(shadowLink.role, 'link');
  const liveConnection = connections.at(-1), liveContext = liveConnection.contexts().find(context => context !== liveConnection.contexts()[0]);
  assert(liveContext); const livePage = liveContext.pages()[0];
  turnAdmitted = false;
  assert.equal(await livePage.evaluate(async () => { try { await fetch('/idle-post', { method: 'POST', body: 'Must not send' }); return 'sent'; } catch { return 'blocked'; } }), 'blocked');
  // Existing owner authority resumes the retained browser; no pause command or allocation.
  await livePage.locator('#cuisine').selectOption('all');
  turnAdmitted = true;
  const resumed = await driver.observe(session, snapshot.observation.tab_ref); inspect(resumed);
  assert.equal(resumed.targetId, first.targetId); assert.equal(state(resumed, 'Cuisine').value, 'all');
  assert.notEqual(resumed.observation.revision, snapshot.observation.revision);
  const applied = await driver.act(session, resumed, { operation: 'click', element_ref: find(resumed, 'Apply filters') }, async () => {});
  assert(applied.observation.text.includes('Vegetarian restaurant matches: The Green Table'));
  assert.equal(connections.length, 1, 'Owner resume must reuse the retained connection');
  const linked = await driver.act(session, applied, { operation: 'click', element_ref: find(applied, 'Restaurant details', 'a') }, async () => {});
  assert.equal(linked.observation.url, origin + '/details'); inspect(linked);
  const beforeLost = connections.length;
  await liveConnection.close();
  await assert.rejects(driver.observe(session, linked.observation.tab_ref), error => error.code === 'session_lost');
  assert.equal(allocations, 0); assert.equal(connections.length, beforeLost); assert.equal((await sessions()).length, 1);
  // Explicit navigation reconstructs documents within the same provider session;
  // lost-reference operations above must not perform this recovery implicitly.
  const fresh = await driver.navigate(session, origin + '/filters');
  const changedConnection = connections.at(-1), changedContext = changedConnection.contexts().find(context => context !== changedConnection.contexts()[0]);
  await changedContext.pages()[0].locator('#cuisine').selectOption('vegetarian');
  let staleEffects = 0;
  await assert.rejects(driver.act(session, fresh, { operation: 'click', element_ref: find(fresh, 'Apply filters') }, async () => { staleEffects++; }), error => error.code === 'stale_observation');
  assert.equal(staleEffects, 0); assert.equal(allocations, 0);
  assert.equal(connections.length, beforeLost + 1);
  // Invalid actions release documents, so isolate disabled-option rejection in
  // one deliberately reconstructed context without any provider allocation.
  const disabled = await driver.navigate(session, origin + '/filters');
  let disabledEffects = 0;
  await assert.rejects(driver.act(session, disabled, { operation: 'select', element_ref: find(disabled, 'Cuisine'), value: 'unavailable' }, async () => { disabledEffects++; }), error => error.code === 'rejected');
  assert.equal(disabledEffects, 0); assert.equal(allocations, 0);
  assert.equal(connections.length, beforeLost + 2);
  turnAdmitted = false; await driver.disconnect();
  assert(connections.every(connection => !connection.isConnected()));
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
  assert.deepEqual(requests, ['/filters', '/details', '/filters', '/filters']);
  process.stdout.write(JSON.stringify({ localOnly: true, provider: false, semanticSelectOptions: true,
    nativeDesiredCheckboxState: true, idempotentCheckedState: true, openShadowInputAndLink: true, nativeContenteditableFill: true, disabledOptionRejectedBeforeEffect: true,
    accessibilitySnapshot: true, passwordExcluded: true, ownerPauseResume: true, freshOwnerChoiceObservation: true,
    staleHumanChangeRejected: true, idlePostDenied: true, retainedConnectionReuse: true, hiddenReplacementAbsent: true,
    lostConnectionRefsRejected: true, exactPhysicalClosure: true, actualProcessExit: true,
    initialCleanupConfirmed, explicitAbsenceConfirmation: true, allocations, connections: connections.length,
    screenshotBytes: [first.image.bytes.length, applied.image.bytes.length] }) + '\n');
} finally { clearTimeout(watchdog); if (processHandle?.pid && processHandle.exitCode === null) { processHandle.kill('SIGKILL'); await processExit; } await new Promise(resolve => server.close(resolve)); await rm(profile, { recursive: true, force: true }); }
