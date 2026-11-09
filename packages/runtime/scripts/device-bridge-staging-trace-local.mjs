#!/usr/bin/env node
// Runs the exact staging trace flow against an isolated local wrangler + fictional RPC stub, so every
// assertion the staging run makes is proven locally first. No hosted resource, real cookie or secret is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startLocalBridge } from './device-bridge-local-harness.mjs';
import { runDeviceBridgeTrace } from './device-bridge-staging-flow.mjs';

const report = line => console.log(`LOCAL staging-flow: ${line}`);
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// A target that redirects must stop the flow before the cookie can follow the Location to another host.
async function redirectIsRefused(redirectPath) {
  const sinkHits = [];
  const sink = createServer((request, response) => { sinkHits.push(request.headers.cookie ?? ''); response.end('{"ok":true}'); });
  const sinkPort = await listen(sink);
  const target = createServer((request, response) => {
    if (request.url === redirectPath) { response.writeHead(302, { location: `http://127.0.0.1:${sinkPort}${redirectPath}?leak=1` }); response.end(); return; }
    if (request.url === '/healthz') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true}'); return; }
    response.writeHead(401, { 'content-type': 'application/json' }); response.end('{"error":"invalid_request"}');
  });
  const targetPort = await listen(target);
  try {
    let failure = '';
    await runDeviceBridgeTrace({ origin: `http://127.0.0.1:${targetPort}`, cookie: 'waldo_owner=x; waldo_console=y', report: () => {} }).catch(error => { failure = error.message; });
    assert.ok(failure.includes(`${redirectPath} answered with redirect HTTP 302`), `redirect on ${redirectPath} must fail the trace`);
    assert.ok(!failure.includes('leak') && !failure.includes('waldo_console'), 'redirect failure must not print Location or cookie');
    assert.equal(sinkHits.length, 0, `redirect on ${redirectPath} must not be followed`);
  } finally { await new Promise(resolve => target.close(resolve)); await new Promise(resolve => sink.close(resolve)); }
}

let bridge;
try {
  for (const path of ['/healthz', '/console/devices']) await redirectIsRefused(path);
  report('redirecting /healthz and /console/devices are refused; Location never followed; cookie not printed');
  bridge = await startLocalBridge();
  const cookie = await bridge.login();
  await runDeviceBridgeTrace({ origin: bridge.origin, cookie, report });
  assert.equal(bridge.stubFailure(), null, 'every signed RPC must match fixture schema and HMAC');
  assert.equal(bridge.devices.size, 0, 'trace must leave no device binding behind');
  report(`local harness clean: signed RPCs matched fixtures; no device left; ${bridge.codes.size} pairing code(s) issued`);
} catch (error) {
  // Do not serialize request/response objects or assertion actual values (cookies/codes).
  console.error(`LOCAL staging-flow: FAIL ${bridge?.stubFailure() ?? error.message}`); process.exitCode = 1;
} finally {
  if (bridge) await bridge.close();
}
