// Local SOURCE harness only: real workerd, fictional owner, signed in-memory RPC boundary.
// This intentionally proves neither PostgreSQL transactions nor hosted/Kennel TLS readiness.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const runtime = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const fixtureOwner = '11111111-2222-4333-8444-555555555555';
const doName = `owner-${fixtureOwner}`;
const fixtureEmail = 'device-trace@example.invalid';
const fixtureAuth = '22222222-3333-4444-8555-666666666666';
const otp = '123456';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const nowSeconds = () => Math.floor(Date.now() / 1000);
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const localFetch = (url, options = {}) => fetch(url, { signal: AbortSignal.timeout(5000), ...options });
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const freePort = async () => { const server = createServer(); const port = await listen(server); await new Promise(resolve => server.close(resolve)); return port; };

export async function startLocalBridge() {
  const publishableKey = `fictional-local-${randomBytes(16).toString('hex')}`;
  const routerSecret = randomBytes(32).toString('hex');
  const hmac = (at, message) => createHmac('sha256', routerSecret).update(`${at}.${message}`).digest('hex');
  const sessions = new Set(), codes = new Map(), devices = new Map(), buckets = new Map(), calls = new Map();
  let stubFailure = null;
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
      // The only external-looking URL in this harness is a local fake auth endpoint.
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

  let scratch, worker, workerOutput = '';
  const rpcPort = await listen(stub), workerPort = await freePort();
  assert.notEqual(workerPort, 8787, 'trace must avoid the live local agent');
  const origin = `http://127.0.0.1:${workerPort}`;
  const startWorker = async () => {
    worker = spawn(process.execPath, ['--no-warnings', join(runtime, 'node_modules/wrangler/wrangler-dist/cli.js'), 'dev', '--local', '--config', join(scratch, 'wrangler.json'), '--port', `${workerPort}`, '--persist-to', join(scratch, 'state')],
      { cwd: scratch, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const output of [worker.stdout, worker.stderr]) output.on('data', chunk => { workerOutput += chunk.toString(); });
    let workerExit; worker.once('exit', code => { workerExit = code; });
    let booted = false;
    const bootDeadline = Date.now() + 30000;
    for (let attempt = 0; attempt < 100 && Date.now() < bootDeadline; attempt++) {
      if (workerExit !== undefined) throw new Error('isolated wrangler exited before health');
      try { const response = await localFetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) }); if (response.ok && (await response.json()).ok) { booted = true; break; } } catch {}
      await delay(200);
    }
    assert.ok(booted, 'isolated worker health deadline');
  };
  const stopWorker = async () => {
    if (!worker || worker.exitCode !== null) return;
    worker.kill('SIGTERM');
    await Promise.race([new Promise(resolve => worker.once('exit', resolve)), delay(3000)]);
    if (worker.exitCode === null) { worker.kill('SIGKILL'); await new Promise(resolve => worker.once('exit', resolve)); }
  };
  const close = async () => {
    await stopWorker();
    if (stub.listening) await new Promise(resolve => stub.close(resolve));
    if (scratch) await rm(scratch, { recursive: true, force: true });
  };
  try {
    scratch = await mkdtemp(join(tmpdir(), 'waldo-device-trace-'));
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
    await writeFile(join(scratch, 'wrangler.json'), JSON.stringify(config), { mode: 0o600 });
    // Process arguments contain no secrets. Wrangler output is retained only in memory and
    // checked for leaks; the synthetic local keys never reach the terminal or evidence.
    await startWorker();
  } catch (error) { await close(); throw error; }

  // Synthetic owner signs in through the real console grant; returns both console cookies.
  const login = async () => {
    const response = await localFetch(`${origin}/console/verify`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ email: fixtureEmail, code: otp }) });
    assert.equal(response.status, 303, 'synthetic owner must sign in through real console grant');
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    assert.ok(cookie.includes('waldo_owner=') && cookie.includes('waldo_console='), 'both authenticated console cookies required');
    return cookie;
  };
  return { origin, login, startWorker, stopWorker, close, sessions, codes, devices, calls,
    stubFailure: () => stubFailure, workerOutput: () => workerOutput };
}
