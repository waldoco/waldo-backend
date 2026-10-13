import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import type { OwnerDO } from '../src/channels/owner-do';
import { durableConversationStore } from '../src/channels/conversation-store';
import { macInbox } from '../src/devices/mac-delivery';
import { DeviceCommandStore } from '../src/devices/command-store';

const model = vi.hoisted(() => ({ calls: 0 }));
vi.mock('openai', () => ({ default: class {
  responses = { create: async () => {
    model.calls++;
    return { id: 'fixture', output_text: 'Fixture result summary.', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
  } };
} }));
afterEach(() => vi.unstubAllGlobals());
const { createOwnerResponder } = await import('../src/channels/owner-turn');

it('recovers a saved Mac summary after restart without a second model call', async () => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName('mac_summary_recovery'));
  await runInDurableObject(stub, async (_instance, state) => {
    model.calls = 0;
    const store = durableConversationStore(state.storage);
    const timer = async <T>(_hop: string, work: () => Promise<T>) => work();
    const first = createOwnerResponder('fictional-key', store);
    const reply = await first.prompt('mac:result:request_fixture', 'telegram-700000001', 'Summarize this fixture Mac result.', timer, 'telegram', [], undefined, undefined, undefined, 'external');
    const restarted = createOwnerResponder('fictional-key', store);
    expect(await restarted.prompt('mac:result:request_fixture', 'telegram-700000001', 'Summarize this fixture Mac result.', timer, 'telegram', [], undefined, undefined, undefined, 'external')).toBe(reply);
    expect(model.calls).toBe(1);
  });
});

it('quarantines revoked result custody so the owner alarm can continue', async () => {
  const name = 'mac_revoked_recovery';
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)) as DurableObjectStub<OwnerDO>;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/device_for_auth_v030')) return Response.json([]);
    return Response.json(true);
  });
  await runInDurableObject(stub, async (instance, state) => {
    state.storage.kv.put('do_name', name);
    state.storage.kv.put('telegram_subject', '700000001');
    const inbox = macInbox(state.storage);
    expect(await inbox.admit({ kind: 'session_event', request_id: 'event_fixture', device_id: 'revoked_device', owner_id: 'owner_fixture', payload: { project: 'fixture', session_id: 'session_fixture', event: 'blocked_on_tool' } })).toBe(true);
    await expect(instance.alarm()).resolves.toBeUndefined();
    expect(inbox.pending()).toHaveLength(0);
  });
});

it('admits exactly one expired follow-up for a Mac command that arrives after its deadline', async () => {
  const stub = env.DEVICE_BRIDGE_DO!.get(env.DEVICE_BRIDGE_DO!.idFromName('mac_expired_ack'));
  await runInDurableObject(stub, async (_instance, state) => {
    const store = new DeviceCommandStore(state.storage);
    const result = await store.enqueue({ owner_id: 'owner_fixture', device_id: 'mac_expired_ack', request_id: 'expired_request', class: 'shell_exec', payload: { project: 'fixture', command: 'true', reason: 'Fixture expiry', timeout_seconds: 120 } }, 1000, ['shell_exec']);
    if (!result.accepted) throw new Error('fixture enqueue failed');
    const command = JSON.parse(store.pending(1000)[0]!.wire);
    store.markSent(result.command_id);
    const ack = { ...command, type: 'ack', timestamp: 1901, nonce: 'AAECAwQFBgcICQoLDA0ODw', signature: 'A'.repeat(86), payload: { state: 'expired', reason: 'expired' } };
    store.acceptAck(ack);
    store.acceptAck(ack);
    expect(store.deliveries()).toHaveLength(1);
    expect(JSON.parse(store.deliveries()[0]!.body)).toMatchObject({ kind: 'result', request_id: 'expired_request', payload: { status: 'expired' } });
  });
});
