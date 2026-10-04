import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { canonicalJson } from '../src/devices/canonical-json';
import { newMessageId } from '../src/devices/command-store';
import { base64url, frameSignatureBase, httpSignatureBase, sha256Hex } from '../src/devices/signing';
import { routerSignature } from '../src/identity/owner-directory';
import { consoleAccess } from '../src/channels/console';
import type { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import type { DeviceBridgeDO } from '../src/devices/device-bridge-do';
afterEach(() => vi.unstubAllGlobals());
it('round-trips owner commands, reconciles old results before new work, and re-receipts across restart', async () => {
  const owner = 'owner_command_fixture', device = 'dev_command_fixture', secret = 'fictional-device-router-secret';
  let digest = '', exists = false;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.split('/').at(-1)!;
    const args = JSON.parse(String(init?.body)) as Record<string, string | number>;
    const tags: Record<string, string> = {
      console_session_touch: `consolesess.touch.${args.p_do_name}.${args.p_session_hash}`,
      issue_device_pairing_code: `devpair.${args.p_do_name}.${args.p_code_hash}`,
      device_bridge_throttle: `devthrottle.${args.p_key}.${args.p_limit}.${args.p_window_seconds}`,
      redeem_device_pairing: `devredeem.${args.p_code_hash}.${args.p_pubkey}.${[...new TextEncoder().encode(String(args.p_label))].map((byte) => byte.toString(16).padStart(2, '0')).join('')}.${args.p_capabilities}`,
      device_for_auth: `devauth.${args.p_device_id}`, device_touch: `devtouch.${args.p_device_id}`,
      list_devices: `devlist.${args.p_do_name}`, revoke_device: `devrevoke.${args.p_do_name}.${args.p_device_id}`,
    };
    expect(args.p_sig).toBe(await routerSignature(secret, Number(args.p_at), tags[path]!));
    let response: unknown;
    if (path === 'console_session_touch' || path === 'device_bridge_throttle') response = true;
    else if (path === 'issue_device_pairing_code') { digest = String(args.p_code_hash); response = true; }
    else if (path === 'redeem_device_pairing') { exists = args.p_code_hash === digest && !exists; response = exists ? [{ device_id: device, owner_id: owner }] : []; }
    else if (path === 'device_for_auth') response = exists && args.p_device_id === device ? [{ owner_id: owner, pubkey: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg', capabilities: 'machine_state_query,notify_local' }] : [];
    else if (path === 'device_touch') response = exists;
    else if (path === 'list_devices') response = exists && args.p_do_name === owner ? [{ device_id: device, label: 'Fictional Mac', capabilities: 'machine_state_query,notify_local', created_at: 'fixture', last_seen_at: null }] : [];
    else if (path === 'revoke_device') { response = args.p_do_name === owner && args.p_device_id === device && exists; if (response) exists = false; }
    else throw new Error(`Unexpected fictional RPC ${path}`);
    return Response.json(response);
  });
  const ownerStub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(owner)) as DurableObjectStub<TelegramOwnerDO>;
  const deviceStub = env.DEVICE_BRIDGE_DO!.get(env.DEVICE_BRIDGE_DO!.idFromName(device)) as DurableObjectStub<DeviceBridgeDO>;
  let session = '', csrf = '';
  await runInDurableObject(ownerStub, async (_instance, state) => { state.storage.kv.put('do_name', owner); session = await consoleAccess(state.storage).grant(); csrf = (await consoleAccess(state.storage).session(session))!.csrf; });
  const cookie = `waldo_console=${session}; waldo_owner=${owner}.session_fixture.${await routerSignature(secret, 0, `cookie.${owner}.session_fixture`)}`;
  const call = (request: Request) => worker.fetch(request, env, {} as ExecutionContext);
  const action = (action: string, fields: Record<string, string> = {}) => { const form = new FormData(); for (const [key, value] of Object.entries({ action, csrf, id: device, ...fields })) form.set(key, value); return call(new Request('https://bridge.test/console/action', { method: 'POST', body: form, headers: { cookie }, redirect: 'manual' })); };
  const pair = await action('device.pair'); expect(pair.status).toBe(200); const code = (await pair.text()).split('\n')[0]!;
  const seed = new Uint8Array(32).map((_, index) => index), pkcs8 = new Uint8Array(48);
  pkcs8.set([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]); pkcs8.set(seed,16);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  const sign = async (base: string) => base64url(new Uint8Array(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(base))));
  const headers = async (method: string, path: string, body = '') => { const timestamp = String(Math.floor(Date.now()/1000)), nonce = base64url(crypto.getRandomValues(new Uint8Array(16))); return { 'x-waldo-timestamp': timestamp, 'x-waldo-nonce': nonce, 'x-waldo-signature': await sign(httpSignatureBase(timestamp, nonce, method, path, await sha256Hex(new TextEncoder().encode(body)))) }; };
  const redeem = canonicalJson({ code, device_pubkey: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg', label: 'Fictional Mac', declared_capabilities: ['machine_state_query', 'notify_local'], contract_version: '0.2.3' });
  expect((await call(new Request('https://bridge.test/devices/redeem', { method: 'POST', body: redeem, headers: await headers('POST', '/devices/redeem', redeem) }))).status).toBe(200);
  const path = '/devices/connect?contract_version=0.2.3&declared_capabilities=machine_state_query,notify_local';
  let socket!: WebSocket;
  type Frame = Record<string, unknown> & { payload: Record<string, unknown> };
  const received: Frame[] = [];
  const connect = async () => { const response = await call(new Request(`https://bridge.test${path}`, { headers: { ...await headers('GET', path), 'x-waldo-device-id': device, upgrade: 'websocket' } })); expect(response.status).toBe(101); socket = response.webSocket!; socket.accept(); socket.addEventListener('message', (event) => { received.push(JSON.parse(String(event.data)) as Frame); }); };
  const send = async (logical: Record<string, unknown>) => { const timestamp = Math.floor(Date.now()/1000), nonce = base64url(crypto.getRandomValues(new Uint8Array(16))); const frame = { ...logical, timestamp, nonce }; socket.send(canonicalJson({ ...frame, signature: await sign(frameSignatureBase(timestamp, String(logical.type), String(logical.message_id), nonce, await sha256Hex(new TextEncoder().encode(canonicalJson(frame))))) })); };
  const heartbeat = (depth: number) => send({ contract_version: '0.2.3', type: 'heartbeat', message_id: newMessageId(Math.floor(Date.now()/1000)), device_id: device, owner_id: owner, payload: { declared_capabilities: ['machine_state_query', 'notify_local'], outbox_depth: depth } });
  const reference = (command: Frame, type: string, payload: Record<string, unknown>) => ({ contract_version: '0.2.3', type, message_id: newMessageId(Math.floor(Date.now()/1000)), device_id: device, owner_id: owner, command_id: command.command_id, revision: 1, idempotency_key: command.idempotency_key, payload });
  const query = (id: string) => action('device.query', { request_id: id, query_kind: 'session_status' });
  expect((await query('query_roundtrip')).status).toBe(303);
  const notifyFields = { request_id: 'notify_roundtrip', notification_id: 'notification_roundtrip', title: 'Waldo status', body: 'Your Mac is connected.', severity: 'info' };
  expect((await action('device.notify', { ...notifyFields, body: 'Arbitrary private content' })).status).toBe(400);
  await connect(); expect(received).toHaveLength(0);
  await heartbeat(1); await vi.waitFor(async () => expect((await deviceStub.status()).online).toBe(true)); expect(received).toHaveLength(0);
  await heartbeat(0); await vi.waitFor(() => expect(received).toHaveLength(1));
  const command = received[0]!; expect(command).toMatchObject({ type: 'command', class: 'machine_state_query', revision: 1 }); expect(Object.hasOwn(command, 'signature')).toBe(false);
  expect((await action('device.notify', notifyFields)).status).toBe(303); expect(received).toHaveLength(1);
  await send(reference(command, 'ack', { state: 'accepted' })); await vi.waitFor(async () => expect((await deviceStub.listCommands()).find(row => row.command_id === command.command_id)?.state).toBe('acked'));
  const result = reference(command, 'result', { status: 'answered', answer: { query_id: 'query_roundtrip', query_kind: 'session_status', state: 'unknown' } });
  await send(result); await vi.waitFor(() => expect(received).toHaveLength(2)); const receipt = received[1]!; expect(receipt).toMatchObject({ type: 'receipt', payload: { result_message_id: result.message_id } });
  await send(result); await vi.waitFor(() => expect(received).toHaveLength(3)); expect(received[2]!.message_id).not.toBe(receipt.message_id); expect(received[2]!.payload.result_message_id).toBe(result.message_id);
  await heartbeat(1); await vi.waitFor(async () => expect((await deviceStub.listCommands()).some(row => row.state === 'answered')).toBe(true)); expect(received).toHaveLength(3);
  await heartbeat(0); await vi.waitFor(() => expect(received).toHaveLength(4)); const notification = received[3]!; expect(notification).toMatchObject({ type: 'command', class: 'notify_local', payload: { body: 'Your Mac is connected.' } });
  await send(reference(notification, 'ack', { state: 'accepted' }));
  const delivered = reference(notification, 'result', { status: 'delivered' }); await send(delivered); await vi.waitFor(() => expect(received).toHaveLength(5));
  const beforeRestart = received[4]!.message_id;
  const closed = new Promise<void>(resolve => socket.addEventListener('close', () => resolve())); socket.close(1000); await closed;
  await evictDurableObject(deviceStub);
  await connect(); await send(delivered); await vi.waitFor(() => expect(received).toHaveLength(6)); expect(received[5]!.message_id).not.toBe(beforeRestart); expect(received[5]!.payload.result_message_id).toBe(delivered.message_id);
  await runInDurableObject(deviceStub, (_instance, state) => { const row = state.storage.sql.exec('SELECT wire,fingerprint,result_fingerprint FROM commands WHERE command_id=?', notification.command_id as string).one(); expect(row.wire).toBeNull(); expect(String(row.fingerprint)).toHaveLength(64); expect(String(row.result_fingerprint)).toHaveLength(64); });
  const conflictClose = new Promise<number>(resolve => socket.addEventListener('close', event => resolve(event.code)));
  await send({ ...delivered, payload: { status: 'failed', reason: 'delivery_unknown' } }); expect(await conflictClose).toBe(1008); expect(received).toHaveLength(6);
  await connect(); await heartbeat(0);
  const page = await call(new Request('https://bridge.test/console/devices', { headers: { cookie } })); expect(await page.text()).toContain('delivered');
  expect((await query('query_cancelled')).status).toBe(303);
  expect((await query('query_queued_cancelled')).status).toBe(303);
  const revoked = new Promise<number>(resolve => socket.addEventListener('close', event => resolve(event.code))); expect((await action('device.revoke')).status).toBe(303); expect(await revoked).toBe(1008);
  expect((await deviceStub.listCommands()).find(row => row.state === 'cancelled')).toBeDefined();
}, 15000);
