#!/usr/bin/env node
// Local SOURCE trace only: real workerd, fictional owner, signed in-memory RPC boundary.
// This intentionally proves neither PostgreSQL transactions nor hosted/Kennel TLS readiness.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign, timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const traceStarted = performance.now();
const runtime = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureOwner = '11111111-2222-4333-8444-555555555555';
const doName = `owner-${fixtureOwner}`;
const fixtureEmail = 'device-trace@example.invalid';
const fixtureAuth = '22222222-3333-4444-8555-666666666666';
const otp = '123456';
const publishableKey = `fictional-local-${randomBytes(16).toString('hex')}`;
const routerSecret = randomBytes(32).toString('hex');
const capabilities = ['machine_state_query', 'notify_local'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hmac = (at, message) => createHmac('sha256', routerSecret).update(`${at}.${message}`).digest('hex');
const nowSeconds = () => Math.floor(Date.now() / 1000);
const nonce = () => randomBytes(16).toString('base64url');
const messageId = () => {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let value = (BigInt(Date.now()) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`), id = '';
  for (let i = 0; i < 26; i++) { id = alphabet[Number(value & 31n)] + id; value >>= 5n; }
  return id;
};
const sessions = new Set(), codes = new Map(), devices = new Map(), buckets = new Map();
const calls = new Map();
let stubFailure = null;
const report = line => console.log(`SOURCE local: ${line}`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const localFetch = (url, options = {}) => fetch(url, { signal: AbortSignal.timeout(5000), ...options });

// Schema dispatch is explicit so an unimplemented RPC cannot silently pass the trace.
const dispatchRpc = (name, p) => {
  switch (name) {
    case 'console_auth_throttle':
      return [`throttle.${p.p_key}.${p.p_limit}.${p.p_window_seconds}`, () => true];
    case 'owner_for_auth':
      return [`owner.${p.p_auth_user}.${p.p_email}.${p.p_phone}.${p.p_code_hash}`, () =>
        p.p_auth_user === fixtureAuth && p.p_email === fixtureEmail && p.p_phone === '' && p.p_code_hash === '' ? doName : null];
    case 'console_session_open':
      return [`consolesess.open.${p.p_do_name}.${p.p_session_hash}`, () => {
        if (p.p_do_name !== doName) return false;
        sessions.add(p.p_session_hash); return true;
      }];
    case 'console_session_touch':
      return [`consolesess.touch.${p.p_do_name}.${p.p_session_hash}`, () => p.p_do_name === doName && sessions.has(p.p_session_hash)];
    case 'issue_device_pairing_code':
      return [`devpair.${p.p_do_name}.${p.p_code_hash}`, () => {
        if (p.p_do_name !== doName || codes.has(p.p_code_hash)) return false;
        const live = [...codes.values()].filter(c => !c.used && c.expires > nowSeconds());
        if (live.length >= 5) return false;
        codes.set(p.p_code_hash, { owner: fixtureOwner, expires: nowSeconds() + 600, used: false }); return true;
      }];
    case 'redeem_device_pairing':
      return [`devredeem.${p.p_code_hash}.${p.p_pubkey}.${Buffer.from(p.p_label).toString('hex')}.${p.p_capabilities}`, () => {
        const code = codes.get(p.p_code_hash);
        if (!code || code.used || code.expires <= nowSeconds() || [...devices.values()].some(d => d.pubkey === p.p_pubkey)) return [];
        // No awaits between conditional consumption and insert: the fake models an atomic RPC.
        const id = randomUUID();
        code.used = true;
        devices.set(id, { device_id: id, owner_id: code.owner, pubkey: p.p_pubkey, label: p.p_label,
          capabilities: p.p_capabilities, created_at: new Date().toISOString(), last_seen_at: null });
        return [{ device_id: id, owner_id: code.owner }];
      }];
    case 'device_for_auth':
      return [`devauth.${p.p_device_id}`, () => {
        const d = devices.get(p.p_device_id);
        return d ? [{ owner_id: d.owner_id, pubkey: d.pubkey, capabilities: d.capabilities }] : [];
      }];
    case 'device_touch':
      return [`devtouch.${p.p_device_id}`, () => {
        const d = devices.get(p.p_device_id); if (!d) return false;
        d.last_seen_at = new Date().toISOString(); return true;
      }];
    case 'list_devices':
      return [`devlist.${p.p_do_name}`, () => p.p_do_name === doName ? [...devices.values()].map(({ pubkey, owner_id, ...d }) => d) : []];
    case 'revoke_device':
      return [`devrevoke.${p.p_do_name}.${p.p_device_id}`, () => p.p_do_name === doName && devices.get(p.p_device_id)?.owner_id === fixtureOwner ? devices.delete(p.p_device_id) : false];
    case 'device_bridge_throttle':
      return [`devthrottle.${p.p_key}.${p.p_limit}.${p.p_window_seconds}`, () => {
        const cut = nowSeconds() - p.p_window_seconds;
        const active = (buckets.get(p.p_key) ?? []).filter(at => at > cut);
        if (active.length >= p.p_limit) return false;
        active.push(nowSeconds()); buckets.set(p.p_key, active); return true;
      }];
    default: throw new Error(`unsupported local RPC: ${name}`);
  }
};

const stub = createServer(async (request, response) => {
  try {
    // The only external-looking URL in this trace is a local fake auth endpoint.
    if (request.method !== 'POST' || request.headers.apikey !== publishableKey) throw new Error('local stub authentication rejected');
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const p = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    let result;
    if (request.url === '/auth/v1/verify') {
      result = p.type === 'email' && p.email === fixtureEmail && p.token === otp
        ? { user: { id: fixtureAuth, email: fixtureEmail } } : null;
    } else {
      if (!request.url.startsWith('/rest/v1/rpc/') || request.headers['content-profile'] !== 'waldo') throw new Error('local stub route rejected');
      const name = request.url.slice('/rest/v1/rpc/'.length);
      const [message, apply] = dispatchRpc(name, p);
      // Validate the production router HMAC convention and freshness before state changes.
      const expected = Buffer.from(hmac(p.p_at, message), 'hex');
      const given = typeof p.p_sig === 'string' && /^[a-f0-9]{64}$/.test(p.p_sig) ? Buffer.from(p.p_sig, 'hex') : Buffer.alloc(0);
      if (!Number.isInteger(p.p_at) || Math.abs(nowSeconds() - p.p_at) > 300 || given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error(`local signed RPC rejected: ${name}`);
      calls.set(name, (calls.get(name) ?? 0) + 1);
      result = apply();
    }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
  } catch (error) {
    stubFailure = error.message;
    response.writeHead(500, { 'content-type': 'application/json' }); response.end('{"error":"fixture_rejected"}');
  }
});
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const freePort = async () => { const server = createServer(); const port = await listen(server); await new Promise(resolve => server.close(resolve)); return port; };

// Valid trace values use the normative code-point ordering, not UTF-16 ordering.
const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const compare = (a, b) => {
      const aa = [...a].map(c => c.codePointAt(0)), bb = [...b].map(c => c.codePointAt(0));
      for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
      return aa.length - bb.length;
    };
    return `{${Object.keys(value).sort(compare).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const keypair = generateKeyPairSync('ed25519');
const publicKey = keypair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
const httpHeaders = (method, path, body = '', deviceId) => {
  const timestamp = `${nowSeconds()}`, n = nonce();
  return { 'X-Waldo-Timestamp': timestamp, 'X-Waldo-Nonce': n,
    'X-Waldo-Signature': sign(null, Buffer.from([timestamp, n, method, path, sha256(body)].join('\n')), keypair.privateKey).toString('base64url'),
    ...(deviceId ? { 'X-Waldo-Device-Id': deviceId } : {}) };
};
const heartbeat = device => {
  const frame = { contract_version: '0.2.3', device_id: device.device_id, owner_id: device.owner_id,
    message_id: messageId(), type: 'heartbeat', timestamp: nowSeconds(), nonce: nonce(),
    payload: { declared_capabilities: capabilities, outbox_depth: 0 } };
  const base = [frame.timestamp, frame.type, frame.message_id, frame.nonce, sha256(canonical(frame))].join('\n');
  return { ...frame, signature: sign(null, Buffer.from(base), keypair.privateKey).toString('base64url') };
};
const connectPath = '/devices/connect?contract_version=0.2.3&declared_capabilities=machine_state_query,notify_local';
const rejected = async response => {
  assert.equal(response.status, 401, 'expected generic pre-auth status');
  assert.equal(response.headers.get('content-type'), 'application/json', 'expected exact pre-auth content type');
  assert.equal(await response.text(), '{"error":"invalid_request"}', 'expected exact pre-auth bytes');
};
const openSocket = (origin, device) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}${connectPath}`, { headers: httpHeaders('GET', connectPath, '', device.device_id) });
  const timeout = setTimeout(() => { socket.terminate(); reject(new Error('socket open deadline exceeded')); }, 5000);
  let status;
  socket.once('upgrade', response => { status = response.statusCode; });
  socket.once('open', () => { clearTimeout(timeout); if (status !== 101) reject(new Error('signed socket must upgrade101')); else resolve(socket); });
  socket.once('error', () => { clearTimeout(timeout); reject(new Error('signed socket failed to open')); });
  socket.once('unexpected-response', (_request, response) => { clearTimeout(timeout); response.resume(); reject(new Error(`signed socket refused with HTTP ${response.statusCode}`)); });
});
const rejectedSocket = (origin, device) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('rejected socket deadline exceeded')), 5000);
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}${connectPath}`, { headers: httpHeaders('GET', connectPath, '', device.device_id) });
  socket.once('open', () => { clearTimeout(timeout); socket.terminate(); reject(new Error('revoked socket unexpectedly opened')); });
  socket.once('error', () => {});
  socket.once('unexpected-response', (_request, response) => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => {
      clearTimeout(timeout);
      if (response.statusCode !== 401 || response.headers['content-type'] !== 'application/json' || Buffer.concat(chunks).toString('utf8') !== '{"error":"invalid_request"}') {
        reject(new Error('revoked socket must receive exact generic rejection')); return;
      }
      resolve();
    });
  });
});
const closedWithoutFrame = socket => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('socket close deadline exceeded')), 5000);
  socket.once('message', () => { clearTimeout(timeout); reject(new Error('unexpected post-auth frame')); });
  socket.once('close', code => { clearTimeout(timeout); if (code !== 1008) reject(new Error('expected policy close 1008')); else resolve(); });
});

let scratch, worker;
const sockets = [];
try {
  scratch = await mkdtemp(join(tmpdir(), 'waldo-device-trace-'));
  const rpcPort = await listen(stub), workerPort = await freePort();
  assert.notEqual(workerPort, 8787, 'trace must avoid the live local agent');
  // A dedicated generated config prevents consuming an existing .dev.vars or hosted binding.
  const classes = ['RuntimeProbeDO', 'RunLoopDO', 'TracerDO', 'TelegramOwnerDO', 'DeviceBridgeDO'];
  const bindings = ['RUNTIME_DO', 'RUN_LOOP_DO', 'TRACER_DO', 'TELEGRAM_OWNER_DO', 'DEVICE_BRIDGE_DO'];
  const config = { name: 'waldo-device-bridge-local-trace', main: join(runtime, 'src/index.ts'), compatibility_date: '2026-06-16',
    vars: { WALDO_ENVIRONMENT: 'preview', WALDO_RELEASE: 'local-source-trace', WALDO_OWNER_DO_NAMESPACE: '', WALDO_OWNER_TELEGRAM_ID: '',
      WALDO_EGRESS_ALLOWLIST: '', LANGFUSE_CAPTURE_TEXT: 'false', SUPABASE_PROJECT_URL: `http://127.0.0.1:${rpcPort}`,
      SUPABASE_PUBLISHABLE_KEY: publishableKey, WALDO_ROUTER_HMAC_SECRET: routerSecret },
    durable_objects: { bindings: classes.map((class_name, i) => ({ name: bindings[i], class_name })) },
    migrations: [{ tag: 'local-trace-only-v1', new_sqlite_classes: classes }],
    ratelimits: [{ name: 'RESPONSIBILITY_RATE_LIMITER', namespace_id: '99123', simple: { limit: 120, period: 60 } }],
    observability: { enabled: false } };
  const configFile = join(scratch, 'wrangler.json');
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  // Process arguments contain no secrets. Wrangler output is retained only in memory and
  // checked for leaks; the synthetic local keys never reach the terminal or evidence.
  let workerOutput = '';
  worker = spawn(process.execPath, ['--no-warnings', join(runtime, 'node_modules/wrangler/wrangler-dist/cli.js'), 'dev', '--local', '--config', configFile, '--port', `${workerPort}`, '--persist-to', join(scratch, 'state')],
    { cwd: scratch, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const output of [worker.stdout, worker.stderr]) output.on('data', chunk => { workerOutput += chunk.toString(); });
  let workerExit; worker.once('exit', code => { workerExit = code; });
  const origin = `http://127.0.0.1:${workerPort}`;
  let booted = false;
  const bootDeadline = Date.now() + 30000;
  for (let attempt = 0; attempt < 100 && Date.now() < bootDeadline; attempt++) {
    if (workerExit !== undefined) throw new Error('isolated wrangler exited before health');
    try { const response = await localFetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) }); if (response.ok && (await response.json()).ok) { booted = true; break; } } catch {}
    await delay(200);
  }
  assert.ok(booted, 'isolated worker health deadline'); report('isolated worker health 200');
  const login = await localFetch(`${origin}/console/verify`, { method: 'POST', redirect: 'manual',
    body: new URLSearchParams({ email: fixtureEmail, code: otp }) });
  assert.equal(login.status, 303, 'synthetic owner must sign in through real console grant');
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.ok(cookie.includes('waldo_owner=') && cookie.includes('waldo_console='), 'both authenticated console cookies required');
  assert.equal(sessions.size, 1, 'owner session persisted at signed RPC boundary');
  const page = await localFetch(`${origin}/console/devices`, { headers: { cookie } });
  assert.equal(page.status, 200, 'authenticated devices console required');
  const html = await page.text();
  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
  assert.ok(csrf, 'real console form must expose CSRF');
  const action = (action, id = '') => localFetch(`${origin}/console/action`, { method: 'POST', redirect: 'manual', headers: { cookie },
    body: new URLSearchParams({ action, id, value: '', csrf }) });
  const pair = await action('device.pair');
  assert.equal(pair.status, 200); assert.ok(pair.headers.get('cache-control')?.includes('no-store'));
  const code = (await pair.text()).match(/\b[A-Za-z0-9_-]{43}\b/)?.[0];
  assert.ok(code && Buffer.from(code, 'base64url').length === 32, 'pair must yield a 256-bit code');
  assert.ok(codes.has(sha256(code)), 'only exact case-sensitive digest is stored');
  report('console pair code length 43; expiry 600 seconds; code withheld');
  const body = canonical({ code, device_pubkey: publicKey, label: 'Synthetic Trace Mac', declared_capabilities: capabilities, contract_version: '0.2.3' });
  const redeem = () => localFetch(`${origin}/devices/redeem`, { method: 'POST', headers: { ...httpHeaders('POST', '/devices/redeem', body), 'content-type': 'application/json' }, body });
  const redemption = await redeem(); assert.equal(redemption.status, 200);
  const device = await redemption.json();
  assert.deepEqual(Object.keys(device).sort(), ['accepted_contract_version', 'device_id', 'owner_id']);
  assert.equal(device.owner_id, fixtureOwner); assert.equal(device.accepted_contract_version, '0.2.3');
  report('signed redeem HTTP 200; keys accepted_contract_version,device_id,owner_id');
  await rejected(await redeem()); assert.equal(devices.size, 1, 'reused code must not create another device'); report('code reuse HTTP 401 exact generic rejection');
  let socket = await openSocket(origin, device); sockets.push(socket); report('signed socket HTTP 101');
  socket.send(canonical(heartbeat(device)));
  let online = false;
  for (let i = 0; i < 30; i++) {
    const view = await localFetch(`${origin}/console/devices`, { headers: { cookie } });
    const text = await view.text();
    if (view.status === 200 && text.includes('Synthetic Trace Mac') && /\bonline\b/i.test(text) && devices.get(device.device_id)?.last_seen_at) { online = true; break; }
    await delay(100);
  }
  assert.ok(online, 'heartbeat must durably touch binding and console must show online');
  report('signed heartbeat accepted; console shows online');
  const beforeForged = devices.get(device.device_id).last_seen_at;
  const forged = heartbeat(device); forged.signature = randomBytes(64).toString('base64url');
  const forgedClose = closedWithoutFrame(socket); socket.send(canonical(forged)); await forgedClose;
  assert.equal(devices.get(device.device_id).last_seen_at, beforeForged, 'forged frame cannot touch device');
  report('forged frame closes 1008 with no frame or effect');
  socket = await openSocket(origin, device); sockets.push(socket); socket.send(canonical(heartbeat(device)));
  await delay(150);
  const revokeClose = closedWithoutFrame(socket);
  const revocation = await action('device.revoke', device.device_id);
  assert.ok([200, 303].includes(revocation.status), 'owner revoke must succeed');
  await revokeClose; assert.equal(devices.has(device.device_id), false);
  report('owner revoke deletes binding and closes socket 1008');
  await rejectedSocket(origin, device);
  report('revoked reconnect HTTP 401 exact generic rejection');
  assert.equal(stubFailure, null, 'every signed RPC must match fixture schema and HMAC');
  assert.ok(!workerOutput.includes(code), 'pairing code must never reach worker logs');
  // Wrangler masks local binding values; any code leakage is a hard failure above.
  report(`PASS slice 1 local trace in ${((performance.now() - traceStarted) / 1000).toFixed(2)}s; real Kennel TLS and hosted resources UNVERIFIED`);
} catch (error) {
  // Do not serialize request/response objects or assertion actual values (cookies/codes).
  console.error(`SOURCE local: FAIL ${stubFailure ?? error.message}`); process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.terminate();
  if (worker && worker.exitCode === null) {
    worker.kill('SIGTERM');
    await Promise.race([new Promise(resolve => worker.once('exit', resolve)), delay(3000)]);
    if (worker.exitCode === null) worker.kill('SIGKILL');
  }
  if (stub.listening) await new Promise(resolve => stub.close(resolve));
  if (scratch) await rm(scratch, { recursive: true, force: true });
}
