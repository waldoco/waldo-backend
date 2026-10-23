import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSessionState, type UseMacArgs } from '@waldo/contracts';
import { DeviceCommandStore } from '../src/devices/command-store';
import { MAC_APPROVAL_TTL_SECONDS } from '../src/devices/contract';
import { macResultNotice } from '../src/devices/mac-delivery';
import { sanitise } from '../src/scribe/sanitiser';
import { dispatchTool, type ToolDispatcherContext } from '../src/tools/dispatcher';
import { macAction, useMacHandler } from '../src/tools/live/use-mac';
import { fakeKennel, stubDeviceDirectory } from './helpers/fake-kennel';
import worker from '../src/index';
import { canonicalJson } from '../src/devices/canonical-json';
import { newMessageId } from '../src/devices/command-store';
import { base64url, frameSignatureBase, httpSignatureBase, sha256Hex } from '../src/devices/signing';
import { routerSignature } from '../src/identity/owner-directory';
import { consoleAccess } from '../src/channels/console';
import type { OwnerDO } from '../src/channels/owner-do';
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
      redeem_device_pairing_v030: `devredeem030.${args.p_code_hash}.${args.p_pubkey}.${[...new TextEncoder().encode(String(args.p_label))].map((byte) => byte.toString(16).padStart(2, '0')).join('')}.${args.p_capabilities}.${args.p_session_consent}`,
      device_for_auth_v030: `devauth030.${args.p_device_id}`, device_touch: `devtouch.${args.p_device_id}`,
      list_devices: `devlist.${args.p_do_name}`, revoke_device: `devrevoke.${args.p_do_name}.${args.p_device_id}`,
    };
    expect(args.p_sig).toBe(await routerSignature(secret, Number(args.p_at), tags[path]!));
    let response: unknown;
    if (path === 'console_session_touch' || path === 'device_bridge_throttle') response = true;
    else if (path === 'issue_device_pairing_code') { digest = String(args.p_code_hash); response = true; }
    else if (path === 'redeem_device_pairing_v030') { exists = args.p_code_hash === digest && !exists; response = exists ? [{ device_id: device, owner_id: owner }] : []; }
    else if (path === 'device_for_auth_v030') response = exists && args.p_device_id === device ? [{ owner_id: owner, do_name:owner,contract_version:'0.3.0',pubkey: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg', capabilities: 'machine_state_query,notify_local' }] : [];
    else if (path === 'device_touch') response = exists;
    else if (path === 'list_devices') response = exists && args.p_do_name === owner ? [{ device_id: device, label: 'Fictional Mac', capabilities: 'machine_state_query,notify_local', created_at: 'fixture', last_seen_at: null }] : [];
    else if (path === 'revoke_device') { response = args.p_do_name === owner && args.p_device_id === device && exists; if (response) exists = false; }
    else throw new Error(`Unexpected fictional RPC ${path}`);
    return Response.json(response);
  });
  const ownerStub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(owner)) as DurableObjectStub<OwnerDO>;
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
  const redeem = canonicalJson({ code, device_pubkey: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg', label: 'Fictional Mac', declared_capabilities: ['machine_state_query', 'notify_local'], contract_version: '0.3.0',session_consent:false });
  expect((await call(new Request('https://bridge.test/devices/redeem', { method: 'POST', body: redeem, headers: await headers('POST', '/devices/redeem', redeem) }))).status).toBe(200);
  const path = '/devices/connect?contract_version=0.3.0&declared_capabilities=machine_state_query,notify_local';
  let socket!: WebSocket;
  type Frame = Record<string, unknown> & { payload: Record<string, unknown> };
  const received: Frame[] = [];
  const connect = async () => { const response = await call(new Request(`https://bridge.test${path}`, { headers: { ...await headers('GET', path), 'x-waldo-device-id': device, upgrade: 'websocket' } })); expect(response.status).toBe(101); socket = response.webSocket!; socket.accept(); socket.addEventListener('message', (event) => { received.push(JSON.parse(String(event.data)) as Frame); }); };
  const send = async (logical: Record<string, unknown>) => { const timestamp = Math.floor(Date.now()/1000), nonce = base64url(crypto.getRandomValues(new Uint8Array(16))); const frame = { ...logical, timestamp, nonce }; socket.send(canonicalJson({ ...frame, signature: await sign(frameSignatureBase(timestamp, String(logical.type), String(logical.message_id), nonce, await sha256Hex(new TextEncoder().encode(canonicalJson(frame))))) })); };
  const heartbeat = (depth: number) => send({ contract_version: '0.3.0', type: 'heartbeat', message_id: newMessageId(Math.floor(Date.now()/1000)), device_id: device, owner_id: owner, payload: { declared_capabilities: ['machine_state_query', 'notify_local'], outbox_depth: depth } });
  const reference = (command: Frame, type: string, payload: Record<string, unknown>) => ({ contract_version: '0.3.0', type, message_id: newMessageId(Math.floor(Date.now()/1000)), device_id: device, owner_id: owner, command_id: command.command_id, revision: 1, idempotency_key: command.idempotency_key, payload });
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
  const read = await call(new Request('https://bridge.test/console/dashboard/api/v1/controls?view=devices', { headers: { cookie, accept: 'application/json' } }));
  expect((await read.json() as { status: { devices: { commands: { class: string; state: string }[] }[] } }).status.devices[0]!.commands).toContainEqual({ class: 'notify_local', state: 'delivered', result_state: null });
  expect((await query('query_cancelled')).status).toBe(303);
  expect((await query('query_queued_cancelled')).status).toBe(303);
  const revoked = new Promise<number>(resolve => socket.addEventListener('close', event => resolve(event.code))); expect((await action('device.revoke')).status).toBe(303); expect(await revoked).toBe(1008);
  expect((await deviceStub.listCommands()).find(row => row.state === 'cancelled')).toBeDefined();
}, 15000);

// The v0.3.0 session actions, end to end: use_mac (the real handler and production hooks) -> the real DeviceBridgeDO -> a
// signed WebSocket -> a fake Kennel that acks and answers like the Mac app -> the bridge's follow-up custody -> the owner's
// DO inbox. The owner DO's own device lookup is replaced by a direct enqueue to the one paired device.
describe('use_mac session actions through the device bridge and a fake Kennel', () => {
  const secret = 'fictional-device-router-secret';
  const common = { project: 'fixture', reason: 'Fixture check' };
  type Case = Readonly<{ args: UseMacArgs; class: string; approval: boolean; answer: Record<string, unknown> }>;
  const completed = (session_id: string) => ({ status: 'completed', exit_code: 0, output_tail: 'fixture output', truncated: false, session_id });
  const cases: readonly Case[] = [
    { args: { ...common, action: 'list_sessions' } as UseMacArgs, class: 'session_query', approval: false,
      answer: { status: 'answered', answer: { sessions: [{ session_id: 'session_fixture', project: 'fixture', agent: 'codex', status: 'running' }], truncated: false } } },
    { args: { ...common, action: 'read_session', session_id: 'session_fixture' } as UseMacArgs, class: 'session_query', approval: false,
      answer: { status: 'answered', answer: { session_id: 'session_fixture', status: 'running', output_tail: 'fixture output', truncated: false } } },
    { args: { ...common, action: 'start_session', agent: 'claude-code', prompt: 'Describe this project' } as UseMacArgs, class: 'session_control', approval: true, answer: completed('session_started') },
    { args: { ...common, action: 'message_session', session_id: 'session_fixture', prompt: 'Report status' } as UseMacArgs, class: 'session_control', approval: true, answer: completed('session_fixture') },
    { args: { ...common, action: 'interrupt_session', session_id: 'session_fixture' } as UseMacArgs, class: 'session_control', approval: false, answer: completed('session_fixture') },
    { args: { ...common, action: 'stop_session', session_id: 'session_fixture' } as UseMacArgs, class: 'session_control', approval: true, answer: completed('session_fixture') },
  ];
  let turn = 0;
  const context = (): ToolDispatcherContext => ({
    authenticatedUserId: 'owner_fixture', trigger: 'user_message', ownerInitiated: true, turnId: `mac_turn_${++turn}`, sourceTaint: null, toolArgSourceTaint: null,
    hasApproval: () => false, sanitise,
    session: buildSessionState({ trigger: 'user_message', canary_tokens: ['1'.repeat(16), '2'.repeat(16), '3'.repeat(16)], started_at: Date.now() }),
  });
  // A paired Mac for one test, and use_mac wired to it the way the owner DO wires it: one device, the owner's ids.
  const world = async (label: string) => {
    const owner = `owner_${label}`, device = `mac_${label}`;
    stubDeviceDirectory(owner, device, secret);
    const kennel = await fakeKennel(owner, device);
    await kennel.bindOwner();
    const handler = useMacHandler({ request: input => kennel.bridge.enqueueCommand({ ...input, owner_id: owner, device_id: device }) });
    const useMac = (args: UseMacArgs) => dispatchTool({ id: args.action, name: 'use_mac', args }, context(), { handlers: [handler] }) as Promise<Record<string, unknown>>;
    return { kennel, useMac };
  };
  const action = (c: Case) => c.args.action;

  it.each(cases.map(c => [action(c), c] as const))('%s: sent to the online Mac, acked, answered, and the result reaches the owner\'s inbox once', async (name, c) => {
    const { kennel, useMac } = await world(`ok_${name}`);
    await kennel.connect(); await kennel.online();
    const result = await useMac(c.args);
    expect(result).toMatchObject({ ok: true, data: { status: c.approval ? 'Sent to your Mac for approval.' : 'Sent to your Mac.' } });
    const command = await kennel.nextCommand(1);
    expect(command).toMatchObject({ type: 'command', class: c.class, payload: macAction(c.args).payload });
    await kennel.ack(command);
    const frame = await kennel.result(command, c.answer);
    await vi.waitFor(() => expect(kennel.received.filter(f => f.type === 'receipt').map(f => f.payload.result_message_id)).toEqual([frame.message_id]));
    await vi.waitFor(async () => expect(await kennel.ownerInbox()).toEqual([expect.objectContaining({ kind: 'result', payload: c.answer })]));
    // A retried result frame is receipted again and never becomes a second follow-up.
    await kennel.result(command, c.answer).catch(() => undefined);
    expect((await kennel.ownerInbox())).toHaveLength(1);
    expect((await kennel.bridge.listCommands())[0]).toMatchObject({ state: c.answer.status });
  });

  it.each(cases.map(c => [action(c), c] as const))('%s: refused as device_offline while the Mac is disconnected; nothing is queued or sent later', async (name, c) => {
    const { kennel, useMac } = await world(`offline_${name}`);
    const result = await useMac(c.args);
    expect(result).toMatchObject({ ok: false, error_code: 'rejected', blocked: 'device_offline', retryable: false });
    expect(await kennel.bridge.listCommands()).toEqual([]);
    // The Mac wakes afterwards: nothing was waiting for it, so nothing runs that the owner was told did not go out.
    await kennel.connect(); await kennel.online();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(kennel.commands()).toEqual([]);
    expect(await kennel.ownerInbox()).toEqual([]);
  });

  it.each(cases.map(c => [action(c), c] as const))('%s: the Mac reports it reached its deadline, and the owner gets one "expired" follow-up', async (name, c) => {
    const { kennel, useMac } = await world(`expired_${name}`);
    await kennel.connect(); await kennel.online();
    expect(await useMac(c.args)).toMatchObject({ ok: true });
    const command = await kennel.nextCommand(1);
    await kennel.ack(command, { state: 'expired', reason: 'expired' });
    await vi.waitFor(async () => expect(await kennel.ownerInbox()).toEqual([expect.objectContaining({ kind: 'result', payload: { status: 'expired' } })]));
    expect(macResultNotice((await kennel.ownerInbox())[0] as never)).toContain('Nothing was started.');
  });

  it.each(cases.filter(c => c.approval).map(c => [action(c), c] as const))('%s: the owner declines on the Mac, and the follow-up says nothing was started', async (name, c) => {
    const { kennel, useMac } = await world(`denied_${name}`);
    await kennel.connect(); await kennel.online();
    expect(await useMac(c.args)).toMatchObject({ ok: true, data: { status: 'Sent to your Mac for approval.' } });
    const command = await kennel.nextCommand(1);
    await kennel.ack(command);
    await kennel.result(command, { status: 'denied' });
    await vi.waitFor(async () => expect(await kennel.ownerInbox()).toEqual([expect.objectContaining({ payload: { status: 'denied' } })]));
    expect(macResultNotice((await kennel.ownerInbox())[0] as never)).toContain('Nothing was started.');
  });

  it('a request the Mac has not taken yet is reported queued, then lapses at its deadline unsent, with one "expired" follow-up', async () => {
    const { kennel, useMac } = await world('queued_lapse');
    // Connected, but still reconciling earlier results (outbox_depth 1): new work waits.
    await kennel.connect(); await kennel.online(1);
    const result = await useMac(cases[2]!.args);
    expect(result).toMatchObject({ ok: true, data: { status: expect.stringMatching(/^Queued for your Mac\./) } });
    expect(kennel.commands()).toEqual([]);
    await runInDurableObject(kennel.bridge, async (instance, state) => {
      new DeviceCommandStore(state.storage).pending(Math.floor(Date.now() / 1000) + MAC_APPROVAL_TTL_SECONDS + 1);
      await instance.alarm();
    });
    await vi.waitFor(async () => expect(await kennel.ownerInbox()).toEqual([expect.objectContaining({ payload: { status: 'expired' } })]));
    await kennel.heartbeat(0);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(kennel.commands()).toEqual([]);
  });

  it('a retry of a request the Mac already took answers with that request even after the Mac went offline', async () => {
    const { kennel } = await world('retry_offline');
    await kennel.connect(); await kennel.online();
    const input = { ...macAction(cases[0]!.args), request_id: 'request_retry_fixture', owner_id: 'owner_retry_offline', device_id: 'mac_retry_offline' };
    const first = await kennel.bridge.enqueueCommand(input);
    expect(first).toMatchObject({ accepted: true, state: 'sent', duplicate: false });
    await kennel.disconnect();
    expect(await kennel.bridge.enqueueCommand(input)).toMatchObject({ accepted: true, state: 'sent', duplicate: true });
  });

  it('a session event from the Mac reaches the owner\'s inbox once', async () => {
    const { kennel } = await world('session_event');
    await kennel.connect(); await kennel.online();
    await kennel.sessionEvent({ session_id: 'session_fixture', project: 'fixture', event: 'blocked_on_tool' });
    await vi.waitFor(async () => expect(await kennel.ownerInbox()).toEqual([expect.objectContaining({ kind: 'session_event', payload: { session_id: 'session_fixture', project: 'fixture', event: 'blocked_on_tool' } })]));
    expect(macResultNotice((await kennel.ownerInbox())[0] as never)).toContain('Owner input is required on the Mac.');
  });

  it('an answer for another session is refused: the socket closes and the owner gets nothing', async () => {
    const { kennel, useMac } = await world('wrong_session');
    await kennel.connect(); await kennel.online();
    await useMac(cases[3]!.args);
    const command = await kennel.nextCommand(1);
    await kennel.ack(command);
    await kennel.result(command, completed('session_other'));
    await vi.waitFor(() => expect(kennel.closedWith()).toBe(1008));
    expect(await kennel.ownerInbox()).toEqual([]);
  });
});
