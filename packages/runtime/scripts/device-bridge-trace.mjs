#!/usr/bin/env node
// Local SOURCE trace only: real workerd, fictional owner, signed in-memory RPC boundary.
// This intentionally proves neither PostgreSQL transactions nor hosted/Kennel TLS readiness.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import WebSocket from 'ws';
import { delay, fixtureOwner, localFetch, sha256, startLocalBridge } from './device-bridge-local-harness.mjs';

const traceStarted = performance.now();
const capabilities = ['machine_state_query', 'notify_local'];
const nowSeconds = () => Math.floor(Date.now() / 1000);
const nonce = () => randomBytes(16).toString('base64url');
const messageId = () => {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let value = (BigInt(Date.now()) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`), id = '';
  for (let i = 0; i < 26; i++) { id = alphabet[Number(value & 31n)] + id; value >>= 5n; }
  return id;
};
const report = line => console.log(`SOURCE local: ${line}`);

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
const signedFrame = logical => {
  const frame = { ...logical, timestamp: nowSeconds(), nonce: nonce() };
  const base = [frame.timestamp, frame.type, frame.message_id, frame.nonce, sha256(canonical(frame))].join('\n');
  return { ...frame, signature: sign(null, Buffer.from(base), keypair.privateKey).toString('base64url') };
};
const heartbeat = (device, depth = 0) => signedFrame({ contract_version: '0.2.3', device_id: device.device_id, owner_id: device.owner_id,
  message_id: messageId(), type: 'heartbeat', payload: { declared_capabilities: capabilities, outbox_depth: depth } });
const commandReply = (device, command, type, payload) => ({ contract_version: '0.2.3', device_id: device.device_id, owner_id: device.owner_id,
  command_id: command.command_id, revision: command.revision, idempotency_key: command.idempotency_key, message_id: messageId(), type, payload });
const nextFrame = async socket => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (socket.traceInbox?.length) return socket.traceInbox.shift(); await delay(25); }
  throw new Error('command/receipt frame deadline exceeded');
};
const connectPath = '/devices/connect?contract_version=0.2.3&declared_capabilities=machine_state_query,notify_local';
const rejected = async response => {
  assert.equal(response.status, 401, 'expected generic pre-auth status');
  assert.equal(response.headers.get('content-type'), 'application/json', 'expected exact pre-auth content type');
  assert.equal(await response.text(), '{"error":"invalid_request"}', 'expected exact pre-auth bytes');
};
const openSocket = (origin, device) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}${connectPath}`, { headers: httpHeaders('GET', connectPath, '', device.device_id) });
  socket.traceInbox = [];
  socket.on('message', data => { const frame = JSON.parse(data.toString()); assert.equal(canonical(frame), data.toString(), 'backend frame must be canonical'); socket.traceInbox.push(frame); });
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

let bridge;
const sockets = [];
try {
  bridge = await startLocalBridge();
  const { origin, codes, devices, sessions } = bridge;
  const stopWorker = bridge.stopWorker, startWorker = bridge.startWorker;
  report('isolated worker health 200');
  const cookie = await bridge.login();
  assert.equal(sessions.size, 1, 'owner session persisted at signed RPC boundary');
  const page = await localFetch(`${origin}/console/devices`, { headers: { cookie } });
  assert.equal(page.status, 200, 'authenticated devices console required');
  const html = await page.text();
  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
  assert.ok(csrf, 'real console form must expose CSRF');
  const action = (action, id = '', fields = {}) => localFetch(`${origin}/console/action`, { method: 'POST', redirect: 'manual', headers: { cookie },
    body: new URLSearchParams({ action, id, value: '', csrf, ...fields }) });
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
  const effects = new Set(), outbox = new Map();
  const checkCommand = command => {
    assert.equal(command.type, 'command'); assert.equal(command.contract_version, '0.2.3');
    assert.equal(command.device_id, device.device_id); assert.equal(command.owner_id, device.owner_id); assert.equal(command.revision, 1);
    assert.ok(!('signature' in command) && !('timestamp' in command) && !('nonce' in command), 'backend commands use TLS only');
    assert.ok(command.expires_at > nowSeconds() && command.expires_at <= nowSeconds() + 86400);
    assert.ok(!effects.has(command.command_id), 'trace fake must apply a command effect once'); effects.add(command.command_id);
  };
  const checkReceipt = (receipt, result) => {
    assert.equal(receipt.type, 'receipt'); assert.equal(receipt.payload.result_message_id, result.message_id);
    for (const key of ['device_id','owner_id','command_id','revision','idempotency_key']) assert.equal(receipt[key], result[key]);
    assert.ok(!('signature' in receipt) && !('timestamp' in receipt) && !('nonce' in receipt));
  };
  const queryRequest = randomUUID();
  assert.equal((await action('device.query', device.device_id, { request_id: queryRequest, query_kind: 'session_status' })).status, 303);
  const query = await nextFrame(socket); checkCommand(query); assert.equal(query.class, 'machine_state_query');
  socket.send(canonical(signedFrame(commandReply(device, query, 'ack', { state: 'accepted' }))));
  const answered = commandReply(device, query, 'result', { status: 'answered', answer: { query_id: query.payload.query_id, query_kind: query.payload.query_kind, state: 'unknown' } });
  outbox.set(answered.message_id, answered); socket.send(canonical(signedFrame(answered)));
  const queryReceipt = await nextFrame(socket); checkReceipt(queryReceipt, answered); outbox.delete(answered.message_id);
  socket.send(canonical(signedFrame(answered))); const queryReceipt2 = await nextFrame(socket); checkReceipt(queryReceipt2, answered); assert.notEqual(queryReceipt2.message_id, queryReceipt.message_id);
  report('owner device.query -> command -> ack accepted -> answered unknown -> receipt; duplicate result -> fresh re-receipt');
  socket.send(canonical(heartbeat(device, outbox.size))); await delay(100);
  const notifyRequest = randomUUID(), notificationId = randomUUID();
  const notifyFields = { request_id: notifyRequest, notification_id: notificationId, title: 'Waldo status', body: 'Your Mac is connected.', severity: 'info' };
  assert.equal((await action('device.notify', device.device_id, { ...notifyFields, body: 'arbitrary text outside status scope' })).status, 400);
  assert.equal((await action('device.notify', device.device_id, notifyFields)).status, 303);
  const notification = await nextFrame(socket); checkCommand(notification); assert.equal(notification.class, 'notify_local'); assert.equal(notification.payload.body, notifyFields.body);
  socket.send(canonical(signedFrame(commandReply(device, notification, 'ack', { state: 'accepted' }))));
  const delivered = commandReply(device, notification, 'result', { status: 'delivered' }); outbox.set(delivered.message_id, delivered);
  // Pause device reads before flushing the result: its receipt is deliberately never observed or applied.
  socket.pause();
  await new Promise((resolve, reject) => socket.send(canonical(signedFrame(delivered)), error => { if (error) reject(new Error('result flush failed')); else resolve(); }));
  let committed = false;
  for (let i = 0; i < 50; i++) {
    const view = await localFetch(`${origin}/console/devices`, { headers: { cookie } });
    if (view.status === 200 && (await view.text()).includes('notify_local: delivered')) { committed = true; break; }
    await delay(50);
  }
  assert.ok(committed, 'result must commit despite deliberately lost receipt');
  assert.equal(outbox.size, 1, 'lost receipt leaves one fake-device outbox row');
  assert.equal(socket.traceInbox.length, 0, 'paused fake device must not observe a receipt');
  await stopWorker(); socket.terminate(); await startWorker();
  report('owner device.notify -> command -> ack accepted -> delivered committed; receipt deliberately unread; wrangler process stopped/restarted with identical persisted state');
  socket = await openSocket(origin, device); sockets.push(socket);
  socket.send(canonical(heartbeat(device, outbox.size))); await delay(100); assert.equal(socket.traceInbox.length, 0, 'reconnect cannot issue new work before outbox reconciliation');
  socket.send(canonical(signedFrame(delivered))); const notifyReceipt = await nextFrame(socket); checkReceipt(notifyReceipt, delivered); outbox.delete(delivered.message_id);
  assert.equal(outbox.size, 0); assert.equal(effects.size, 2, 'two classes each produce exactly one fake-device effect');
  socket.send(canonical(heartbeat(device, outbox.size))); await delay(100);
  report('same delivered result freshly signed after process restart -> receipt re-issued -> fake-device outbox cleared; one effect per class');
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
  assert.equal(bridge.stubFailure(), null, 'every signed RPC must match fixture schema and HMAC');
  assert.ok(!bridge.workerOutput().includes(code), 'pairing code must never reach worker logs');
  // Wrangler masks local binding values; any code leakage is a hard failure above.
  report(`PASS slices 1+2 local trace in ${((performance.now() - traceStarted) / 1000).toFixed(2)}s; real Kennel TLS and hosted resources UNVERIFIED`);
} catch (error) {
  // Do not serialize request/response objects or assertion actual values (cookies/codes).
  console.error(`SOURCE local: FAIL ${bridge?.stubFailure() ?? error.message}`); process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.terminate();
  if (bridge) await bridge.close();
}
