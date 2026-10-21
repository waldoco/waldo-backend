import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { canonicalJson } from '../src/devices/canonical-json';
import { newMessageId } from '../src/devices/command-store';
import { base64url, frameSignatureBase, httpSignatureBase, sha256Hex } from '../src/devices/signing';
import { routerSignature } from '../src/identity/owner-directory';
import { consoleAccess } from '../src/channels/console';
import { CHANNEL_RECEIPT_BOOK_KEY } from '../src/channels/dashboard-channel-controls';
import type { DeviceBridgeDO } from '../src/devices/device-bridge-do';

// Kennel pairing and device controls in the new console, through the real Worker. Every credential is fictional.
// Pairing-code expiry is enforced in SQL and proved by supabase/tests/waldo_device_bridge.sql ('exact expiry boundary refused').
const SECRET = 'fictional-device-router-secret', OWNER_UUID = 'e2e00000-0000-4000-8000-0000000000aa', PUBKEY = 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg';
type Read = { csrf: string; revision: string; data: { actions: string[]; devices: { id: string; label: string; capabilities: string[]; created_at: string; actions: string[] }[]; query_kinds: string[]; notification_bodies: string[] }; status: { devices: { id: string; online: boolean; last_seen_at: string | null; commands: { class: string; state: string; result_state: string | null }[] }[] } };
type Acted = { status: number; body: { receipt?: { state: string; message: string }; duplicate?: boolean; reveal?: { kind: string; value: string }; error?: string }; cache: string | null };
afterEach(() => vi.unstubAllGlobals());

async function world() {
  const owner = `owner_dash_${crypto.randomUUID().slice(0, 8)}`, device = `dev_dash_${crypto.randomUUID().slice(0, 8)}`;
  const issued = new Set<string>(), used = new Set<string>();
  const directory = { exists: false, seen: 0, mints: 0, stalled: 0 };
  const gates = new Map<string, Promise<void>>();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.split('/').at(-1)!;
    const args = JSON.parse(String(init?.body)) as Record<string, string | number>;
    const tags: Record<string, string> = {
      console_session_touch: `consolesess.touch.${args.p_do_name}.${args.p_session_hash}`,
      issue_device_pairing_code_owned: `devpairowner.${args.p_do_name}.${args.p_code_hash}`,
      device_bridge_throttle: `devthrottle.${args.p_key}.${args.p_limit}.${args.p_window_seconds}`,
      redeem_device_pairing_v030: `devredeem030.${args.p_code_hash}.${args.p_pubkey}.${[...new TextEncoder().encode(String(args.p_label))].map((byte) => byte.toString(16).padStart(2, '0')).join('')}.${args.p_capabilities}.${args.p_session_consent}`,
      device_for_auth_v030: `devauth030.${args.p_device_id}`, device_touch: `devtouch.${args.p_device_id}`,
      list_devices: `devlist.${args.p_do_name}`, revoke_device: `devrevoke.${args.p_do_name}.${args.p_device_id}`, delete_owner: `delown.${args.p_do_name}`,
    };
    if (!tags[path]) throw new Error(`Unexpected fictional RPC ${path}`);
    expect(args.p_sig).toBe(await routerSignature(SECRET, Number(args.p_at), tags[path]!));
    const gate = gates.get(path);
    if (gate) { directory.stalled++; await gate; }
    let response: unknown;
    if (path === 'console_session_touch' || path === 'device_bridge_throttle') response = true;
    else if (path === 'issue_device_pairing_code_owned') { directory.mints++; issued.add(String(args.p_code_hash)); response = args.p_do_name === owner ? OWNER_UUID : null; }
    else if (path === 'redeem_device_pairing_v030') { const fresh = issued.has(String(args.p_code_hash)) && !used.has(String(args.p_code_hash)); if (fresh) { used.add(String(args.p_code_hash)); directory.exists = true; } response = fresh ? [{ device_id: device, owner_id: owner }] : []; }
    else if (path === 'device_for_auth_v030') response = directory.exists && args.p_device_id === device ? [{ owner_id: owner, do_name: owner, contract_version: '0.3.0', pubkey: PUBKEY, capabilities: 'machine_state_query,notify_local' }] : [];
    else if (path === 'device_touch') { if (directory.exists) directory.seen++; response = directory.exists; }
    else if (path === 'delete_owner') response = args.p_do_name === owner;
    else if (path === 'list_devices') response = directory.exists && args.p_do_name === owner ? [{ device_id: device, label: '<b>Fictional Mac</b>', capabilities: 'machine_state_query,notify_local', created_at: 'fixture', last_seen_at: directory.seen ? `seen-${directory.seen}` : null }] : [];
    else { response = args.p_do_name === owner && args.p_device_id === device && directory.exists; if (response) directory.exists = false; }
    return Response.json(response);
  });
  const ownerStub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(owner));
  const deviceStub = env.DEVICE_BRIDGE_DO!.get(env.DEVICE_BRIDGE_DO!.idFromName(device)) as DurableObjectStub<DeviceBridgeDO>;
  let session = '';
  await runInDurableObject(ownerStub, async (_i, state) => { state.storage.kv.put('do_name', owner); session = await consoleAccess(state.storage).grant(); });
  const cookie = `waldo_console=${session}; waldo_owner=${owner}.session_fixture.${await routerSignature(SECRET, 0, `cookie.${owner}.session_fixture`)}`;
  const call = (request: Request) => worker.fetch(request, env, {} as ExecutionContext);
  const read = async (): Promise<Read> => {
    const response = await call(new Request('https://bridge.test/console/dashboard/api/v1/controls?view=devices', { headers: { cookie, accept: 'application/json' } }));
    expect(response.status).toBe(200);
    return response.json();
  };
  let n = 0;
  const act = async (action: string, fields: Record<string, string> = {}, over: { csrf?: string; revision?: string; request_id?: string } = {}): Promise<Acted> => {
    const current = over.revision && over.csrf ? null : await read();
    const body = new URLSearchParams({ csrf: over.csrf ?? current!.csrf, revision: over.revision ?? current!.revision, view: 'devices', action, request_id: over.request_id ?? `device-request-${++n}`, ...fields });
    const response = await call(new Request('https://bridge.test/console/dashboard/api/v1/actions', { method: 'POST', headers: { cookie, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body }));
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  };
  const seed = new Uint8Array(32).map((_, index) => index), pkcs8 = new Uint8Array(48);
  pkcs8.set([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]); pkcs8.set(seed, 16);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  const sign = async (base: string) => base64url(new Uint8Array(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(base))));
  const headers = async (method: string, path: string, body = '') => { const timestamp = String(Math.floor(Date.now() / 1000)), nonce = base64url(crypto.getRandomValues(new Uint8Array(16))); return { 'x-waldo-timestamp': timestamp, 'x-waldo-nonce': nonce, 'x-waldo-signature': await sign(httpSignatureBase(timestamp, nonce, method, path, await sha256Hex(new TextEncoder().encode(body)))) }; };
  const redeem = async (code: string) => {
    const body = canonicalJson({ code, device_pubkey: PUBKEY, label: 'Fictional Mac', declared_capabilities: ['machine_state_query', 'notify_local'], contract_version: '0.3.0', session_consent: false });
    return call(new Request('https://bridge.test/devices/redeem', { method: 'POST', body, headers: await headers('POST', '/devices/redeem', body) }));
  };
  const connect = async () => {
    const path = '/devices/connect?contract_version=0.3.0&declared_capabilities=machine_state_query,notify_local';
    const response = await call(new Request(`https://bridge.test${path}`, { headers: { ...await headers('GET', path), 'x-waldo-device-id': device, upgrade: 'websocket' } }));
    expect(response.status).toBe(101);
    const socket = response.webSocket!; socket.accept();
    const heartbeat = async (depth: number) => {
      const timestamp = Math.floor(Date.now() / 1000), nonce = base64url(crypto.getRandomValues(new Uint8Array(16)));
      const frame = { contract_version: '0.3.0', type: 'heartbeat', message_id: newMessageId(timestamp), device_id: device, owner_id: owner, payload: { declared_capabilities: ['machine_state_query', 'notify_local'], outbox_depth: depth }, timestamp, nonce };
      socket.send(canonicalJson({ ...frame, signature: await sign(frameSignatureBase(timestamp, frame.type, frame.message_id, nonce, await sha256Hex(new TextEncoder().encode(canonicalJson(frame))))) }));
    };
    return { socket, heartbeat };
  };
  // Everything the owner DO holds: every storage key and every SQL row.
  const stored = () => runInDurableObject(ownerStub, async (_i, state) => {
    const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB '_cf_*' AND name NOT GLOB 'sqlite_*'").toArray();
    return JSON.stringify({ keys: [...(await state.storage.list()).entries()], rows: tables.map(({ name }) => [name, state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray()]) });
  });
  const commands = () => runInDurableObject(deviceStub, async (_i, state) => state.storage.sql.exec<{ request_id: string; class: string }>('SELECT request_id,class FROM commands ORDER BY rowid').toArray());
  // Holds one fictional RPC until the returned release is called.
  const stall = (path: string) => { let release!: () => void; gates.set(path, new Promise<void>((resolve) => { release = resolve; })); return () => { gates.delete(path); release(); }; };
  const removeAccount = async () => {
    const read = await call(new Request('https://bridge.test/console/dashboard/api/v1/owner?view=account', { headers: { cookie, accept: 'application/json' } }));
    const current = await read.json() as { csrf: string; revision: string };
    const body = new URLSearchParams({ csrf: current.csrf, revision: current.revision, view: 'account', action: 'account.delete', confirmation: 'DELETE', request_id: 'erase-request-0001' });
    const response = await call(new Request('https://bridge.test/console/dashboard/api/v1/owner/actions', { method: 'POST', headers: { cookie, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body }));
    return { status: response.status, body: await response.json() as { receipt?: { state: string; signed_out?: boolean } } };
  };
  return { owner, device, directory, ownerStub, deviceStub, read, act, redeem, connect, stored, commands, stall, removeAccount };
}

it('pairs Kennel from the new console: one copyable code, shown once, never stored, and single use', async () => {
  const w = await world();
  const empty = await w.read();
  expect(empty.data).toEqual({ actions: ['device.pair'], devices: [], query_kinds: ['session_status', 'attempt_status', 'worktree_watch'], notification_bodies: ['Your Mac is connected.', 'Your Mac needs attention.', 'Status update'] });
  expect((await w.act('device.pair', {}, { csrf: 'wrong', revision: empty.revision })).status).toBe(403);
  expect((await w.act('device.pair', {}, { csrf: empty.csrf, revision: 'f'.repeat(64) })).body).toMatchObject({ error: 'stale_read' });
  expect(w.directory.mints).toBe(0);

  const issued = await w.act('device.pair', {}, { request_id: 'device-pair-once' });
  expect(issued.status).toBe(200);
  expect(issued.cache).toBe('private, no-store');
  expect(issued.body.reveal).toEqual({ kind: 'pairing_code', value: expect.stringMatching(new RegExp(`^wp1\\.${OWNER_UUID}\\.[A-Za-z0-9_-]{43}$`)) });
  const value = issued.body.reveal!.value, code = value.split('.').at(-1)!;
  expect(await w.stored()).toContain(CHANNEL_RECEIPT_BOOK_KEY);
  expect(await w.stored()).not.toContain(code);
  const replay = await w.act('device.pair', {}, { csrf: empty.csrf, revision: empty.revision, request_id: 'device-pair-once' });
  expect(replay.body).toEqual({ receipt: issued.body.receipt, duplicate: true });
  expect(w.directory.mints).toBe(1);
  expect((await w.redeem(code)).status).toBe(200);
  expect((await w.redeem(code)).status).toBe(401);
});

it('reads a paired Mac and queues only owner-chosen commands; a heartbeat between read and action never makes it stale', async () => {
  const w = await world();
  expect((await w.redeem((await w.act('device.pair')).body.reveal!.value.split('.').at(-1)!)).status).toBe(200);
  const offline = await w.read();
  expect(offline.data.devices).toEqual([{ id: w.device, label: '<b>Fictional Mac</b>', capabilities: ['machine_state_query', 'notify_local'], created_at: 'fixture', actions: ['device.revoke', 'device.query', 'device.notify'] }]);
  expect(offline.status.devices).toEqual([{ id: w.device, online: false, last_seen_at: null, commands: [] }]);

  const { socket, heartbeat } = await w.connect();
  await heartbeat(1);
  await vi.waitFor(async () => expect((await w.deviceStub.status()).online).toBe(true));
  const online = await w.read();
  expect(online.revision).toBe(offline.revision);
  expect(online.status.devices[0]).toMatchObject({ online: true, last_seen_at: 'seen-1' });

  const query = await w.act('device.query', { id: w.device, query_kind: 'session_status' }, { csrf: online.csrf, revision: online.revision, request_id: 'device-query-0001' });
  expect(query.body.receipt).toEqual({ state: 'recorded', message: 'Queued for your Mac. Its answer shows in this device’s history once your Mac replies.' });
  for (const fields of [{ body: 'Arbitrary private content', severity: 'info' }, { body: 'Your Mac is connected.', severity: 'critical' }]) {
    expect((await w.act('device.notify', { id: w.device, ...fields })).body.receipt).toMatchObject({ state: 'rejected' });
  }
  expect((await w.act('device.query', { id: w.device, query_kind: 'arbitrary_task' })).body.receipt).toMatchObject({ state: 'rejected' });
  expect((await w.act('device.notify', { id: w.device, body: 'Your Mac is connected.', severity: 'info' }, { request_id: 'device-notify-0001' })).body.receipt).toMatchObject({ state: 'recorded' });
  expect(await w.commands()).toEqual([{ request_id: 'device-query-0001', class: 'machine_state_query' }, { request_id: 'device-notify-0001', class: 'notify_local' }]);
  expect((await w.act('device.query', { id: 'dev_someone_else', query_kind: 'session_status' })).body).toMatchObject({ error: 'no_longer_eligible' });

  const closed = new Promise<number>((resolve) => socket.addEventListener('close', (event) => resolve(event.code)));
  expect((await w.act('device.revoke', { id: w.device })).body.receipt).toEqual({ state: 'recorded', message: 'Device revoked. It can no longer connect to your Waldo.' });
  expect(await closed).toBe(1008);
  expect((await w.read()).data.devices).toEqual([]);
});

it('answers device reads and actions while a turn holds the owner queue', async () => {
  const w = await world();
  expect((await w.redeem((await w.act('device.pair')).body.reveal!.value.split('.').at(-1)!)).status).toBe(200);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await runInDurableObject(w.ownerStub, (instance) => { void (instance as unknown as { serial(work: () => Promise<void>): Promise<void> }).serial(() => held); });
  try {
    expect((await w.read()).data.devices.map((device) => device.id)).toEqual([w.device]);
    expect((await w.act('device.revoke', { id: w.device })).body.receipt).toEqual({ state: 'recorded', message: 'Device revoked. It can no longer connect to your Waldo.' });
  } finally { release(); }
}, 10_000);

it('erases owner storage only after an in-flight device action settles, so that action never writes it back', async () => {
  const w = await world();
  const release = w.stall('issue_device_pairing_code_owned');
  const pairing = w.act('device.pair');
  await vi.waitFor(() => expect(w.directory.stalled).toBe(1));
  const erasing = w.removeAccount();
  const early = await Promise.race([erasing.then(() => 'erased'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 500))]);
  release();
  expect(early).toBe('waiting');
  expect((await pairing).body.receipt).toMatchObject({ state: 'recorded' });
  expect((await erasing).body.receipt).toMatchObject({ state: 'recorded', signed_out: true });
  expect(JSON.parse(await w.stored())).toEqual({ keys: [], rows: [] });
}, 15_000);
