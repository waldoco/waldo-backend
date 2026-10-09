#!/usr/bin/env node
// STAGING trace: simulated device against a deployed staging Worker with the owner's own console session.
// Creates one test device, exercises pair, connect, heartbeat, query and revoke, then revokes it. No spend, no secrets stored.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import WebSocket from 'ws';
import { stagingTarget } from './device-bridge-staging-target.mjs';

const { origin, cookie } = stagingTarget(process.env);
const capabilities = ['machine_state_query', 'notify_local'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const nowSeconds = () => Math.floor(Date.now() / 1000);
const nonce = () => randomBytes(16).toString('base64url');
const messageId = () => {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let value = (BigInt(Date.now()) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`), id = '';
  for (let i = 0; i < 26; i++) { id = alphabet[Number(value & 31n)] + id; value >>= 5n; }
  return id;
};
const report = line => console.log(`STAGING: ${line}`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const localFetch = (url, options = {}) => fetch(url, { signal: AbortSignal.timeout(15000), ...options });
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
  const socket = new WebSocket(`${origin.replace('https:', 'wss:')}${connectPath}`, { headers: httpHeaders('GET', connectPath, '', device.device_id) });
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
  const socket = new WebSocket(`${origin.replace('https:', 'wss:')}${connectPath}`, { headers: httpHeaders('GET', connectPath, '', device.device_id) });
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

const sockets = [];
let deviceId = '', csrf = '';
const action = (name, id = '', fields = {}) => localFetch(`${origin}/console/action`, { method: 'POST', redirect: 'manual', headers: { cookie },
  body: new URLSearchParams({ action: name, id, value: '', csrf, ...fields }) });
try {
  const health = await localFetch(`${origin}/healthz`); assert.equal(health.status, 200); report(`healthz ${await health.text()}`);
  await rejected(await localFetch(`${origin}/devices/redeem`, { method: 'POST', body: '{}' }).then(r => r)); report('unsigned redeem rejected with the exact generic 401');
  const page = await localFetch(`${origin}/console/devices`, { headers: { cookie } });
  assert.equal(page.status, 200, 'console session must be accepted');
  csrf = (await page.text()).match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
  assert.ok(csrf, 'console form must expose CSRF');
  const pair = await action('device.pair'); assert.equal(pair.status, 200);
  const code = (await pair.text()).match(/\b[A-Za-z0-9_-]{43}\b/)?.[0];
  assert.ok(code, 'pair must yield a code'); report('pair code issued (value not printed)');
  const body = canonical({ code, device_pubkey: publicKey, label: 'Staging Trace Device', declared_capabilities: capabilities, contract_version: '0.2.3' });
  const redemption = await localFetch(`${origin}/devices/redeem`, { method: 'POST', headers: { ...httpHeaders('POST', '/devices/redeem', body), 'content-type': 'application/json' }, body });
  assert.equal(redemption.status, 200, 'signed redeem'); const device = await redemption.json(); deviceId = device.device_id;
  report(`signed redeem 200 for device ${deviceId}`);
  const socket = await openSocket(origin, device); sockets.push(socket); report('signed socket 101');
  socket.send(canonical(heartbeat(device)));
  let online = false;
  for (let i = 0; i < 40 && !online; i++) { const text = await (await localFetch(`${origin}/console/devices`, { headers: { cookie } })).text(); online = text.includes('Staging Trace Device') && /\bonline\b/i.test(text); if (!online) await delay(250); }
  assert.ok(online, 'console must show the device online'); report('heartbeat accepted; console shows online');
  assert.equal((await action('device.query', deviceId, { request_id: randomUUID(), query_kind: 'session_status' })).status, 303);
  const query = await nextFrame(socket); assert.equal(query.class, 'machine_state_query');
  socket.send(canonical(signedFrame(commandReply(device, query, 'ack', { state: 'accepted' }))));
  const answered = commandReply(device, query, 'result', { status: 'answered', answer: { query_id: query.payload.query_id, query_kind: query.payload.query_kind, state: 'unknown' } });
  socket.send(canonical(signedFrame(answered)));
  const receipt = await nextFrame(socket); assert.equal(receipt.type, 'receipt'); assert.equal(receipt.payload.result_message_id, answered.message_id);
  report('query -> command -> ack -> answered -> receipt');
  assert.equal((await action('device.revoke', deviceId)).status, 303); report('owner revoke accepted');
  await closedWithoutFrame(socket); report('socket closed 1008 after revoke');
  await rejectedSocket(origin, device); report('revoked reconnect rejected with the exact generic 401');
  deviceId = '';
  report('PASS staging trace; real Kennel client, Mac keychain, sleep/wake and OS notifications UNVERIFIED');
} finally {
  for (const socket of sockets) socket.terminate();
  if (deviceId) { try { await action('device.revoke', deviceId); console.error('STAGING: cleanup revoked test device'); } catch (error) { console.error(`STAGING: cleanup revoke failed: ${error}`); } }
}
