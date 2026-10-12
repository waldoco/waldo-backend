import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { canonicalJson } from '../src/devices/canonical-json';
import { base64url, frameSignatureBase, httpSignatureBase, sha256Hex } from '../src/devices/signing';
import { routerSignature } from '../src/identity/owner-directory';
import { consoleAccess } from '../src/channels/console';
import type { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import type { DeviceBridgeDO } from '../src/devices/device-bridge-do';

afterEach(() => vi.unstubAllGlobals());
it('runs owner console pair -> signed redeem/connect/heartbeat -> revoke through the real Worker', async () => {
  const secret = 'fictional-device-router-secret', owner = 'owner_fixture';
  let digest = '', consumed = false, exists = false, touched = 0;
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
    else if (path === 'redeem_device_pairing') { response = args.p_code_hash === digest && !consumed ? [{ device_id: 'dev_fixture', owner_id: owner }] : []; if ((response as unknown[]).length) { consumed = true; exists = true; } }
    else if (path === 'device_for_auth') response = exists && args.p_device_id === 'dev_fixture' ? [{ owner_id: owner, pubkey: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg', capabilities: 'machine_state_query' }] : [];
    else if (path === 'device_touch') { if (exists) touched++; response = exists; }
    else if (path === 'list_devices') response = exists ? [{ device_id: 'dev_fixture', label: '<script>bad</script>', capabilities: 'machine_state_query', created_at: 'fixture', last_seen_at: null }] : [];
    else if (path === 'revoke_device') { response = args.p_do_name === owner && args.p_device_id === 'dev_fixture' && exists; if (response) exists = false; }
    else throw new Error(`Unexpected fictional RPC ${path}`);
    return Response.json(response);
  });
  const ownerStub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(owner)) as DurableObjectStub<TelegramOwnerDO>;
  let session = '', csrf = '';
  await runInDurableObject(ownerStub, async (_instance, state) => {
    state.storage.kv.put('do_name', owner);
    session = await consoleAccess(state.storage).grant();
    csrf = (await consoleAccess(state.storage).session(session))!.csrf;
  });
  const cookie = `waldo_console=${session}; waldo_owner=${owner}.session_fixture.${await routerSignature(secret, 0, `cookie.${owner}.session_fixture`)}`;
  const call = (request: Request) => worker.fetch(request, env, {} as ExecutionContext);
  const action = (name: string, token = csrf) => { const form = new FormData(); form.set('action', name); form.set('csrf', token); form.set('id', 'dev_fixture'); return call(new Request('https://bridge.test/console/action', { method: 'POST', body: form, headers: { cookie }, redirect: 'manual' })); };
  expect((await action('device.pair', 'wrong')).status).toBe(403);
  const issued = await action('device.pair'); expect(issued.status).toBe(200); expect(issued.headers.get('cache-control')).toBe('no-store');
  const code = (await issued.text()).split('\n')[0]!; expect(code).toHaveLength(43);
  const seed = new Uint8Array(32).map((_, index) => index), pkcs8 = new Uint8Array(48);
  pkcs8.set([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]); pkcs8.set(seed,16);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  const sign = async (base: string) => base64url(new Uint8Array(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(base))));
  const headers = async (method: string, path: string, body = '') => {
    const timestamp = String(Math.floor(Date.now()/1000)), nonce = base64url(crypto.getRandomValues(new Uint8Array(16)));
    return { 'x-waldo-timestamp': timestamp, 'x-waldo-nonce': nonce, 'x-waldo-signature': await sign(httpSignatureBase(timestamp, nonce, method, path, await sha256Hex(new TextEncoder().encode(body)))) };
  };
  const redeem = canonicalJson({ code, device_pubkey: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg', label: 'Test Mac', declared_capabilities: ['machine_state_query'], contract_version: '0.2.3' });
  const redeemRequest = async () => call(new Request('https://bridge.test/devices/redeem', { method: 'POST', body: redeem, headers: await headers('POST', '/devices/redeem', redeem) }));
  expect((await redeemRequest()).status).toBe(200);
  expect((await redeemRequest()).status).toBe(401);
  const path = '/devices/connect?contract_version=0.2.3&declared_capabilities=machine_state_query';
  const connect = async (target = path) => call(new Request(`https://bridge.test${target}`, { headers: { ...await headers('GET', target), 'x-waldo-device-id': 'dev_fixture', upgrade: 'websocket' } }));
  const rejects = [
    `${path}&extra=1`,
    '/devices/connect?declared_capabilities=machine_state_query&contract_version=0.2.3',
    '/devices/connect?contract_version=0.2.3&declared_capabilities=machine_state_query%2Cnotify_local',
    '/devices/connect?contract_version=0.2.3&declared_capabilities=notify_local',
    '/devices/connect?contract_version=0.2.2&declared_capabilities=machine_state_query',
  ];
  for (const target of rejects) { const response = await connect(target); expect(response.status).toBe(401); expect(await response.text()).toBe('{"error":"invalid_request"}'); }
  for (const extra of [{ 'x-waldo-device-id': 'unknown_device' }, { 'x-waldo-timestamp': '1' }, { 'x-waldo-signature': 'A'.repeat(86) }]) {
    const response = await call(new Request(`https://bridge.test${path}`, { headers: { ...await headers('GET', path), 'x-waldo-device-id': 'dev_fixture', upgrade: 'websocket', ...extra } }));
    expect(response.status).toBe(401); expect(await response.text()).toBe('{"error":"invalid_request"}');
  }
  const replayHeaders = { ...await headers('GET', path), 'x-waldo-device-id': 'dev_fixture', upgrade: 'websocket' };
  const replayResponse = await call(new Request(`https://bridge.test${path}`, { headers: replayHeaders }));
  expect(replayResponse.status).toBe(101); replayResponse.webSocket!.accept();
  expect((await call(new Request(`https://bridge.test${path}`, { headers: replayHeaders }))).status).toBe(401);
  const replaced = new Promise<number>((resolve) => replayResponse.webSocket!.addEventListener('close', (event) => resolve(event.code)));
  const connected = await connect(); expect(connected.status).toBe(101);
  const socket = connected.webSocket!; socket.accept(); expect(await replaced).toBe(1008);
  const frame = { contract_version: '0.2.3', type: 'heartbeat', message_id: '01ARZ3NDEKTSV4RRFFQ69G5FAZ', device_id: 'dev_fixture', owner_id: owner, timestamp: Math.floor(Date.now()/1000), nonce: base64url(crypto.getRandomValues(new Uint8Array(16))), payload: { declared_capabilities: ['machine_state_query'], outbox_depth: 0 } };
  const signature = await sign(frameSignatureBase(frame.timestamp, frame.type, frame.message_id, frame.nonce, await sha256Hex(new TextEncoder().encode(canonicalJson(frame)))));
  socket.send(canonicalJson({ ...frame, signature }));
  await vi.waitFor(() => expect(touched).toBe(1));
  const deviceStub = env.DEVICE_BRIDGE_DO!.get(env.DEVICE_BRIDGE_DO!.idFromName('dev_fixture')) as DurableObjectStub<DeviceBridgeDO>;
  const page = await call(new Request('https://bridge.test/console/devices', { headers: { cookie } }));
  const html = await page.text(); expect(html).toContain('Online'); expect(html).not.toContain('<script>bad</script>');
  const originalClosed = new Promise<number>((resolve) => socket.addEventListener('close', (event) => resolve(event.code)));
  const conflictingFrame = { ...frame, nonce: base64url(crypto.getRandomValues(new Uint8Array(16))), payload: { ...frame.payload, outbox_depth: 1 } };
  const conflictSignature = await sign(frameSignatureBase(conflictingFrame.timestamp, conflictingFrame.type, conflictingFrame.message_id, conflictingFrame.nonce, await sha256Hex(new TextEncoder().encode(canonicalJson(conflictingFrame)))));
  const invalidFrames: (string | ArrayBuffer)[] = [
    canonicalJson({ ...conflictingFrame, signature: conflictSignature }),
    new Uint8Array([1,2,3]).buffer,
    'x'.repeat(8193),
    ` ${canonicalJson({ ...frame, signature })}`,
    canonicalJson({ ...frame, signature, extra: 1 }),
    canonicalJson({ ...frame, signature, owner_id: 'another_owner' }),
    canonicalJson({ ...frame, signature, device_id: 'another_device' }),
    canonicalJson({ ...frame, signature: 'A'.repeat(86), nonce: base64url(crypto.getRandomValues(new Uint8Array(16))) }),
    canonicalJson({ ...frame, signature }),
    canonicalJson({ ...frame, signature, type: 'receipt' }),
    canonicalJson({ ...frame, signature, contract_version: '0.2.2' }),
  ];
  for (const invalid of invalidFrames) {
    const response = await connect(); expect(response.status).toBe(101); const peer = response.webSocket!; peer.accept();
    let received = 0; peer.addEventListener('message', () => received++);
    const closed = new Promise<number>((resolve) => peer.addEventListener('close', (event) => resolve(event.code)));
    peer.send(invalid); expect(await closed).toBe(1008); expect(received).toBe(0); expect(touched).toBe(1);
  }
  expect(await originalClosed).toBe(1008);
  const backstop = await connect(); backstop.webSocket!.accept();
  const backstopClosed = new Promise<number>((resolve) => backstop.webSocket!.addEventListener('close', (event) => resolve(event.code)));
  const afterDelete = { ...frame, message_id: '01ARZ3NDEKTSV4RRFFQ69G5FAW', nonce: base64url(crypto.getRandomValues(new Uint8Array(16))) };
  const afterDeleteSignature = await sign(frameSignatureBase(afterDelete.timestamp, afterDelete.type, afterDelete.message_id, afterDelete.nonce, await sha256Hex(new TextEncoder().encode(canonicalJson(afterDelete)))));
  exists = false;
  backstop.webSocket!.send(canonicalJson({ ...afterDelete, signature: afterDeleteSignature }));
  expect(await backstopClosed).toBe(1008); expect(touched).toBe(1);
  exists = true;
  const finalResponse = await connect(); const finalSocket = finalResponse.webSocket!; finalSocket.accept();
  const closed = new Promise<number>((resolve) => finalSocket.addEventListener('close', (event) => resolve(event.code)));
  const racingRequest = new Request(`https://bridge.test${path}`, { headers: { ...await headers('GET', path), 'x-waldo-device-id': 'dev_fixture', upgrade: 'websocket' } });
  await runInDurableObject(deviceStub, async (instance) => {
    const internal = instance as unknown as { rearm(): Promise<void> };
    const original = internal.rearm.bind(instance); let held = false, release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const alarm = vi.spyOn(internal, 'rearm').mockImplementationOnce(async () => { held = true; await gate; }).mockImplementation(original);
    try {
      const connecting = instance.fetch(racingRequest);
      await vi.waitFor(() => expect(held).toBe(true));
      await instance.revoke(); release();
      expect((await connecting).status).toBe(401);
    } finally { release(); alarm.mockRestore(); }
  });
  expect((await action('device.revoke')).status).toBe(303); expect(await closed).toBe(1008);
  expect((await connect()).status).toBe(401);
});
