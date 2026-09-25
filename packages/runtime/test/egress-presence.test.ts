import { describe, expect, it, vi } from 'vitest';
import { egressGate, gatedCaller } from '../src/channels/telegram-api';
import { consoleAuth } from '../src/identity/console-auth';

describe('Send-time presence re-check', () => {
  it('blocks a fresh owner with no presence row, so no outbound can precede a link', async () => {
    const call = vi.fn().mockResolvedValue({ message_id: 1 });
    const gated = gatedCaller(call, egressGate(() => false, async () => false));
    expect(await gated('sendMessage', { chat_id: 1, text: 'hello' })).toBeUndefined();
    expect(call).not.toHaveBeenCalled();
  });

  it('sends once the owner is linked, with the local flag clear and the presence row active', async () => {
    const call = vi.fn().mockResolvedValue({ message_id: 1 });
    const gated = gatedCaller(call, egressGate(() => false, async () => true));
    expect(await gated('sendMessage', { chat_id: 1, text: 'hello' })).toEqual({ message_id: 1 });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('blocks the old owner after a rebind while the new owner sends: the recheck, not DO memory, decides', async () => {
    // Database state after rebind (proven in the pgTAP row-level tests): the old owner's
    // presence is tombstoned, the new owner's is active. Each DO asks for its own do_name.
    const presence = new Map([['do-a', false], ['do-b', true]]);
    const callA = vi.fn().mockResolvedValue({ message_id: 1 });
    const callB = vi.fn().mockResolvedValue({ message_id: 2 });
    const oldDo = gatedCaller(callA, egressGate(() => false, async () => presence.get('do-a')!));
    const newDo = gatedCaller(callB, egressGate(() => false, async () => presence.get('do-b')!));
    expect(await oldDo('sendMessage', { chat_id: 1, text: 'close card' })).toBeUndefined();
    expect(await newDo('sendMessage', { chat_id: 1, text: 'close card' })).toEqual({ message_id: 2 });
    expect(callA).not.toHaveBeenCalled();
    expect(callB).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the presence RPC errors, so a database outage blocks rather than leaks', async () => {
    const call = vi.fn().mockResolvedValue({ message_id: 1 });
    const gated = gatedCaller(call, egressGate(() => false, async () => { throw new Error('postgrest down'); }));
    expect(await gated('sendMessage', { chat_id: 1, text: 'hello' })).toBeUndefined();
    expect(call).not.toHaveBeenCalled();
  });

  it('blocks on the local flag without spending an RPC', async () => {
    const recheck = vi.fn(async () => true);
    const call = vi.fn().mockResolvedValue({ message_id: 1 });
    const gated = gatedCaller(call, egressGate(() => true, recheck));
    expect(await gated('sendMessage', { chat_id: 1, text: 'after unlink' })).toBeUndefined();
    expect(call).not.toHaveBeenCalled();
    expect(recheck).not.toHaveBeenCalled();
  });

  it('keeps local-flag-only behavior when no database directory is wired (env fallback mode)', async () => {
    const call = vi.fn().mockResolvedValue({ message_id: 1 });
    const gated = gatedCaller(call, egressGate(() => false));
    expect(await gated('sendMessage', { chat_id: 1, text: 'local dev' })).toEqual({ message_id: 1 });
  });

  it('signs the presence assertion for this owner, channel, and subject only', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('true'));
    const env = { SUPABASE_PROJECT_URL: 'https://db.test', SUPABASE_PUBLISHABLE_KEY: 'pub', WALDO_ROUTER_HMAC_SECRET: 'router' };
    expect(await consoleAuth(env, fetcher as unknown as typeof fetch, () => 1_790_000_000_000)!.assertChannelPresence('do-a', 'telegram', 'tg-1')).toBe(true);
    const [, init] = fetcher.mock.calls[0]!;
    const body = JSON.parse(String(init?.body));
    expect(body.p_do_name).toBe('do-a');
    expect(body.p_provider).toBe('telegram');
    expect(body.p_subject).toBe('tg-1');
    expect(body.p_sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats a non-true RPC result as blocked', async () => {
    const call = vi.fn().mockResolvedValue({ message_id: 1 });
    const gated = gatedCaller(call, egressGate(() => false, async () => null as unknown as boolean));
    expect(await gated('sendMessage', { chat_id: 1, text: 'hello' })).toBeUndefined();
    expect(call).not.toHaveBeenCalled();
  });
});
