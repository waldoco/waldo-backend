// A fake Kennel (the Mac-side v0.3.0 device client) for end-to-end tests through the real Worker and DeviceBridgeDO. It signs
// its connect request and every frame with a fixed Ed25519 test key, keeps every frame Waldo sends it, and answers commands
// the way the Mac app does: ack, then one result. The directory is a stubbed fetch that checks each RPC's router signature.
// No real Mac, Kennel build or Supabase is involved.
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, vi } from 'vitest';
import worker from '../../src/index';
import { canonicalJson } from '../../src/devices/canonical-json';
import { newMessageId } from '../../src/devices/command-store';
import { base64url, frameSignatureBase, httpSignatureBase, sha256Hex } from '../../src/devices/signing';
import { routerSignature } from '../../src/identity/owner-directory';
import type { DeviceBridgeDO } from '../../src/devices/device-bridge-do';
import type { OwnerDO } from '../../src/channels/owner-do';

export const KENNEL_PUBKEY = 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg';
export const MAC_CAPABILITIES = ['shell_exec', 'session_query', 'session_control'] as const;
export type KennelFrame = Record<string, unknown> & { payload: Record<string, unknown> };

// Answers the device directory RPCs for one owner and one paired Mac; any other RPC fails the test.
export const stubDeviceDirectory = (owner: string, device: string, secret: string, capabilities: readonly string[] = MAC_CAPABILITIES) =>
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input instanceof Request ? input.url : input)).pathname.split('/').at(-1)!;
    const args = JSON.parse(String(init?.body)) as Record<string, string | number>;
    const tags: Record<string, string> = { device_for_auth_v030: `devauth030.${args.p_device_id}`, device_touch: `devtouch.${args.p_device_id}`, list_devices: `devlist.${args.p_do_name}` };
    if (!tags[path]) throw new Error(`Unexpected fictional RPC ${path}`);
    expect(args.p_sig).toBe(await routerSignature(secret, Number(args.p_at), tags[path]));
    if (path === 'device_for_auth_v030') return Response.json(args.p_device_id === device ? [{ owner_id: owner, do_name: owner, contract_version: '0.3.0', pubkey: KENNEL_PUBKEY, capabilities: capabilities.join(',') }] : []);
    if (path === 'device_touch') return Response.json(args.p_device_id === device);
    return Response.json(args.p_do_name === owner ? [{ device_id: device, label: 'Fictional Mac', capabilities: capabilities.join(','), created_at: 'fixture', last_seen_at: null }] : []);
  });

export async function fakeKennel(owner: string, device: string, capabilities: readonly string[] = MAC_CAPABILITIES) {
  const seed = new Uint8Array(32).map((_, index) => index), pkcs8 = new Uint8Array(48);
  pkcs8.set([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]); pkcs8.set(seed, 16);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  const sign = async (base: string) => base64url(new Uint8Array(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(base))));
  const call = (request: Request) => worker.fetch(request, env, {} as ExecutionContext);
  const bridge = env.DEVICE_BRIDGE_DO!.get(env.DEVICE_BRIDGE_DO!.idFromName(device)) as DurableObjectStub<DeviceBridgeDO>;
  const ownerStub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(owner)) as DurableObjectStub<OwnerDO>;
  const path = `/devices/connect?contract_version=0.3.0&declared_capabilities=${capabilities.join(',')}`;
  const received: KennelFrame[] = [];
  let socket: WebSocket | null = null, closedWith: number | null = null;
  const now = () => Math.floor(Date.now() / 1000);
  const send = async (logical: Record<string, unknown>) => {
    const timestamp = now(), nonce = base64url(crypto.getRandomValues(new Uint8Array(16))), frame = { ...logical, timestamp, nonce };
    socket!.send(canonicalJson({ ...frame, signature: await sign(frameSignatureBase(timestamp, String(logical.type), String(logical.message_id), nonce, await sha256Hex(new TextEncoder().encode(canonicalJson(frame))))) }));
  };
  const reference = (command: KennelFrame, type: 'ack' | 'result', payload: Record<string, unknown>) => ({ contract_version: '0.3.0', type, message_id: newMessageId(now()), device_id: device, owner_id: owner, command_id: command.command_id, revision: 1, idempotency_key: command.idempotency_key, payload });
  const commands = () => received.filter(frame => frame.type === 'command');
  const kennel = {
    bridge, ownerStub, received, commands,
    closedWith: () => closedWith,
    // The owner's DO knows its own name, as it does once any surface bound it.
    async bindOwner() { await runInDurableObject(ownerStub, (_instance, state) => { state.storage.kv.put('do_name', owner); }); },
    async connect() {
      const timestamp = String(now()), nonce = base64url(crypto.getRandomValues(new Uint8Array(16)));
      const signature = await sign(httpSignatureBase(timestamp, nonce, 'GET', path, await sha256Hex(new Uint8Array())));
      const response = await call(new Request(`https://bridge.test${path}`, { headers: { 'x-waldo-timestamp': timestamp, 'x-waldo-nonce': nonce, 'x-waldo-signature': signature, 'x-waldo-device-id': device, upgrade: 'websocket' } }));
      expect(response.status).toBe(101);
      socket = response.webSocket!; socket.accept(); closedWith = null;
      socket.addEventListener('message', event => { received.push(JSON.parse(String(event.data)) as KennelFrame); });
      socket.addEventListener('close', event => { closedWith = event.code; });
    },
    async disconnect() {
      const closed = new Promise<void>(resolve => socket!.addEventListener('close', () => resolve()));
      socket!.close(1000); await closed; socket = null;
      await vi.waitFor(async () => expect((await bridge.status()).online).toBe(false));
    },
    // outbox_depth 0 tells Waldo the Mac has nothing unreconciled, which lets new work go out.
    async heartbeat(depth = 0) { await send({ contract_version: '0.3.0', type: 'heartbeat', message_id: newMessageId(now()), device_id: device, owner_id: owner, payload: { declared_capabilities: [...capabilities], outbox_depth: depth } }); },
    async online(depth = 0) { await kennel.heartbeat(depth); await vi.waitFor(async () => expect((await bridge.status()).online).toBe(true)); },
    async nextCommand(count: number) { await vi.waitFor(() => expect(commands()).toHaveLength(count)); return commands()[count - 1]!; },
    async ack(command: KennelFrame, payload: Record<string, unknown> = { state: 'accepted' }) { await send(reference(command, 'ack', payload)); },
    async result(command: KennelFrame, payload: Record<string, unknown>) { const frame = reference(command, 'result', payload); await send(frame); return frame; },
    async sessionEvent(payload: Record<string, unknown>) { await send({ contract_version: '0.3.0', type: 'session_event', message_id: newMessageId(now()), device_id: device, owner_id: owner, payload }); },
    // The follow-ups the bridge handed to the owner's DO, in order.
    async ownerInbox() {
      return runInDurableObject(ownerStub, (_instance, state) => {
        try { return state.storage.sql.exec<{ id: string; body: string }>('SELECT id, body FROM mac_result_inbox ORDER BY rowid').toArray().map(row => ({ id: row.id, ...JSON.parse(row.body) as Record<string, unknown> })); }
        catch { return []; }
      });
    },
  };
  return kennel;
}
