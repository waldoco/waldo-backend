// Device-bridge trace flow: a simulated device against a Worker origin, driven with the owner's console session.
// The staging entry point supplies a guarded https origin; the local runner supplies an isolated wrangler origin.
// Every assertion carries an explicit message so failures never print cookies, CSRF, pairing codes or keys.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import WebSocket from 'ws';
import { TRACE_PLAN } from './device-bridge-staging-plan.mjs';

const CONTRACT = '0.2.3';
const capabilities = ['machine_state_query', 'notify_local'];
const connectPath = `/devices/connect?contract_version=${CONTRACT}&declared_capabilities=${capabilities.join(',')}`;
const GENERIC_REJECT = '{"error":"invalid_request"}';
const LABEL = 'Staging Trace Device';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const nowSeconds = () => Math.floor(Date.now() / 1000);
const nonce = () => randomBytes(16).toString('base64url');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const messageId = () => {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let value = (BigInt(Date.now()) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`), id = '';
  for (let i = 0; i < 26; i++) { id = alphabet[Number(value & 31n)] + id; value >>= 5n; }
  return id;
};
// Valid trace values use the normative code-point ordering, not UTF-16 ordering.
export const canonical = value => {
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

export async function runDeviceBridgeTrace({ origin, cookie, report }) {
  const keypair = generateKeyPairSync('ed25519');
  const publicKey = keypair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const wsOrigin = origin.replace(/^http/, 'ws');
  let cursor = 0;
  // The dry-run plan is the contract for what this run touches; walking off it is a failure.
  const step = key => { assert.equal(TRACE_PLAN[cursor]?.key, key, `trace step "${key}" drifted from the dry-run plan`); cursor++; };
  // Never follow redirects: a redirecting target could carry the cookie header to another host.
  const request = (path, options = {}) => fetch(`${origin}${path}`, { signal: AbortSignal.timeout(15000), ...options, redirect: 'manual' });
  const noRedirect = (response, what) => assert.ok(response.status < 300 || response.status >= 400, `${what} answered with redirect HTTP ${response.status}; refusing to follow`);
  const rejected = async (response, what) => {
    assert.equal(response.status, 401, `${what}: expected generic pre-auth status 401, got ${response.status}`);
    assert.equal(response.headers.get('content-type'), 'application/json', `${what}: expected exact pre-auth content type`);
    assert.equal(await response.text(), GENERIC_REJECT, `${what}: expected exact pre-auth bytes`);
  };
  const httpHeaders = (method, path, body = '', deviceId, key = keypair.privateKey) => {
    const timestamp = `${nowSeconds()}`, n = nonce();
    return { 'X-Waldo-Timestamp': timestamp, 'X-Waldo-Nonce': n,
      'X-Waldo-Signature': sign(null, Buffer.from([timestamp, n, method, path, sha256(body)].join('\n')), key).toString('base64url'),
      ...(deviceId ? { 'X-Waldo-Device-Id': deviceId } : {}) };
  };
  const signedFrame = logical => {
    const frame = { ...logical, timestamp: nowSeconds(), nonce: nonce() };
    const base = [frame.timestamp, frame.type, frame.message_id, frame.nonce, sha256(canonical(frame))].join('\n');
    return { ...frame, signature: sign(null, Buffer.from(base), keypair.privateKey).toString('base64url') };
  };
  const heartbeat = (device, depth = 0, id = messageId()) => signedFrame({ contract_version: CONTRACT, device_id: device.device_id, owner_id: device.owner_id,
    message_id: id, type: 'heartbeat', payload: { declared_capabilities: capabilities, outbox_depth: depth } });
  const commandReply = (device, command, type, payload) => ({ contract_version: CONTRACT, device_id: device.device_id, owner_id: device.owner_id,
    command_id: command.command_id, revision: command.revision, idempotency_key: command.idempotency_key, message_id: messageId(), type, payload });
  const nextFrame = async (socket, what) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { if (socket.traceInbox.length) return socket.traceInbox.shift(); await delay(25); }
    throw new Error(`${what} frame deadline exceeded`);
  };
  const openSocket = device => new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsOrigin}${connectPath}`, { headers: httpHeaders('GET', connectPath, '', device.device_id) });
    socket.traceInbox = [];
    socket.on('message', data => { const text = data.toString(); try { assert.equal(canonical(JSON.parse(text)), text); socket.traceInbox.push(JSON.parse(text)); } catch { socket.traceError = 'backend frame must be canonical JSON'; } });
    socket.on('error', () => {});
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error('socket open deadline exceeded')); }, 5000);
    let status;
    socket.once('upgrade', response => { status = response.statusCode; });
    socket.once('open', () => { clearTimeout(timeout); if (status !== 101) reject(new Error('signed socket must upgrade 101')); else resolve(socket); });
    socket.once('unexpected-response', (_request, response) => { clearTimeout(timeout); response.resume(); reject(new Error(`signed socket refused with HTTP ${response.statusCode}`)); });
  });
  const rejectedSocket = device => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('rejected socket deadline exceeded')), 5000);
    const socket = new WebSocket(`${wsOrigin}${connectPath}`, { headers: httpHeaders('GET', connectPath, '', device.device_id) });
    socket.once('open', () => { clearTimeout(timeout); socket.terminate(); reject(new Error('revoked socket unexpectedly opened')); });
    socket.on('error', () => {});
    socket.once('unexpected-response', (_request, response) => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        clearTimeout(timeout);
        if (response.statusCode !== 401 || response.headers['content-type'] !== 'application/json' || Buffer.concat(chunks).toString('utf8') !== GENERIC_REJECT)
          reject(new Error('revoked socket must receive exact generic rejection'));
        else resolve();
      });
    });
  });
  const closedWithoutFrame = (socket, what) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${what}: socket close deadline exceeded`)), 5000);
    socket.once('message', () => { clearTimeout(timeout); reject(new Error(`${what}: unexpected frame before close`)); });
    socket.once('close', code => { clearTimeout(timeout); if (code !== 1008) reject(new Error(`${what}: expected policy close 1008, got ${code}`)); else resolve(); });
  });
  const checkCommand = (command, device, cls) => {
    assert.equal(command.type, 'command', `expected a command frame, got ${command.type}`);
    assert.equal(command.class, cls, `expected a ${cls} command, got ${command.class}`);
    assert.equal(command.contract_version, CONTRACT, 'command contract version');
    assert.ok(command.device_id === device.device_id && command.owner_id === device.owner_id && command.revision === 1, 'command must bind this device, owner and revision 1');
    assert.ok(!('signature' in command) && !('timestamp' in command) && !('nonce' in command), 'backend commands use TLS only');
    assert.ok(command.expires_at > nowSeconds() && command.expires_at <= nowSeconds() + 86400, 'command expiry must be within 24h');
  };
  const checkReceipt = (receipt, result) => {
    assert.equal(receipt.type, 'receipt', `expected a receipt frame, got ${receipt.type}`);
    assert.equal(receipt.payload?.result_message_id, result.message_id, 'receipt must name the result message_id');
    for (const key of ['device_id', 'owner_id', 'command_id', 'revision', 'idempotency_key']) assert.equal(receipt[key], result[key], `receipt ${key} must match the result`);
    assert.ok(!('signature' in receipt) && !('timestamp' in receipt) && !('nonce' in receipt), 'backend receipts use TLS only');
  };

  const sockets = [];
  let deviceId = '', csrf = '';
  const action = (name, id = '', fields = {}) => request('/console/action', { method: 'POST', headers: { cookie },
    body: new URLSearchParams({ action: name, id, value: '', csrf, ...fields }) });
  const consoleDevices = async () => {
    const page = await request('/console/devices', { headers: { cookie } });
    noRedirect(page, '/console/devices');
    assert.equal(page.status, 200, `console session must be accepted, got HTTP ${page.status}`);
    return page.text();
  };
  try {
    step('healthz');
    const health = await request('/healthz'); noRedirect(health, '/healthz');
    assert.equal(health.status, 200, `/healthz must answer 200, got ${health.status}`); report(`healthz ${(await health.text()).slice(0, 200)}`);

    step('unsigned_redeem');
    await rejected(await request('/devices/redeem', { method: 'POST', body: '{}' }), 'unsigned redeem'); report('unsigned redeem rejected with the exact generic 401');

    step('console_devices');
    csrf = (await consoleDevices()).match(/name="csrf" value="([a-f0-9]+)"/)?.[1] ?? '';
    assert.ok(csrf, 'console form must expose CSRF');

    step('pair');
    const pair = await action('device.pair'); noRedirect(pair, 'device.pair');
    assert.equal(pair.status, 200, `device.pair must answer 200, got ${pair.status}`);
    assert.ok(pair.headers.get('cache-control')?.includes('no-store'), 'pair response must be no-store');
    const code = (await pair.text()).match(/\b[A-Za-z0-9_-]{43}\b/)?.[0];
    assert.ok(code && Buffer.from(code, 'base64url').length === 32, 'pair must yield a 256-bit code'); report('pair code issued (value not printed)');
    const body = canonical({ code, device_pubkey: publicKey, label: LABEL, declared_capabilities: capabilities, contract_version: CONTRACT });
    const redeem = (payload = body, key) => request('/devices/redeem', { method: 'POST', headers: { ...httpHeaders('POST', '/devices/redeem', payload, undefined, key), 'content-type': 'application/json' }, body: payload });

    step('redeem');
    const redemption = await redeem(); assert.equal(redemption.status, 200, `signed redeem must answer 200, got ${redemption.status}`);
    const device = await redemption.json(); deviceId = device.device_id;
    assert.deepEqual(Object.keys(device).sort(), ['accepted_contract_version', 'device_id', 'owner_id'], 'redeem response keys');
    assert.equal(device.accepted_contract_version, CONTRACT, 'redeem must accept contract 0.2.3');
    report(`signed redeem 200 for device ${deviceId}`);

    step('connect');
    const socket = await openSocket(device); sockets.push(socket); report('signed socket 101');

    step('heartbeat_online');
    socket.send(canonical(heartbeat(device)));
    let online = false;
    for (let i = 0; i < 40 && !online; i++) { const text = await consoleDevices(); online = text.includes(LABEL) && /\bonline\b/i.test(text); if (!online) await delay(250); }
    assert.ok(online, 'console must show the device online'); report('heartbeat accepted; console shows online');

    step('query');
    const queried = await action('device.query', deviceId, { request_id: randomUUID(), query_kind: 'session_status' });
    assert.equal(queried.status, 303, `device.query must answer 303, got ${queried.status}`);
    const query = await nextFrame(socket, 'query command'); checkCommand(query, device, 'machine_state_query');
    socket.send(canonical(signedFrame(commandReply(device, query, 'ack', { state: 'accepted' }))));
    const answered = commandReply(device, query, 'result', { status: 'answered', answer: { query_id: query.payload.query_id, query_kind: query.payload.query_kind, state: 'unknown' } });
    socket.send(canonical(signedFrame(answered)));
    checkReceipt(await nextFrame(socket, 'query receipt'), answered);
    report('query -> command -> ack -> answered -> receipt');

    step('revoke');
    const revokeClose = closedWithoutFrame(socket, 'revoke');
    const revoked = await action('device.revoke', deviceId);
    assert.equal(revoked.status, 303, `device.revoke must answer 303, got ${revoked.status}`); report('owner revoke accepted');
    deviceId = '';
    await revokeClose; report('socket closed 1008 after revoke');

    step('revoked_reconnect');
    await rejectedSocket(device); report('revoked reconnect rejected with the exact generic 401');
    for (const s of sockets) assert.equal(s.traceError, undefined, s.traceError);
    assert.equal(cursor, TRACE_PLAN.length, 'trace must complete every planned step');
    report('PASS device-bridge trace; real Kennel client, Mac keychain, sleep/wake and OS notifications UNVERIFIED');
  } finally {
    for (const socket of sockets) socket.terminate();
    if (deviceId) {
      try {
        const cleanup = await action('device.revoke', deviceId);
        report(cleanup.status === 303 ? 'cleanup revoked test device' : `cleanup revoke answered HTTP ${cleanup.status}; revoke "${LABEL}" on /console/devices by hand`);
      } catch (error) { report(`cleanup revoke failed (${error?.name ?? 'error'}); revoke "${LABEL}" on /console/devices by hand`); }
    }
  }
}
