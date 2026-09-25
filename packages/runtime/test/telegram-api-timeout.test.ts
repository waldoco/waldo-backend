import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTelegramCaller } from '../src/channels/telegram-api';
import { TelegramOwnerListener, type TelegramOwnerApi } from '../src/channels/telegram-listener';

afterEach(() => vi.useRealTimers());

const OWNER = 5458446350;
const turn = { updateId: 1, messageId: 3, senderId: OWNER, chatId: OWNER, sentAt: null as number | null, text: 'hi' };

describe('telegram api egress timeout', () => {
  it('a hung Bot API call rejects after the per-call timeout instead of wedging forever', async () => {
    vi.useFakeTimers();
    // Faithful to real fetch: rejects when the abort signal fires, never settles on its own.
    const hanging = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
    }));
    const call = createTelegramCaller('token', hanging as unknown as typeof fetch, 50);
    const pending = call('setMessageReaction', { chat_id: 1 });
    const assertion = expect(pending).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
  });

  it('a fast call resolves with the result', async () => {
    const fast = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: true })));
    const call = createTelegramCaller('token', fast as unknown as typeof fetch, 5_000);
    await expect(call('sendMessage', { chat_id: 1, text: 'hi' })).resolves.toBe(true);
  });

  it('telegram error classification survives the timeout wiring', async () => {
    const failing = vi.fn(async () => new Response(JSON.stringify({ ok: false, error_code: 400, description: 'message not found' })));
    const call = createTelegramCaller('token', failing as unknown as typeof fetch, 5_000);
    await expect(call('setMessageReaction', {})).rejects.toThrow('telegram setMessageReaction failed: 400 message not found');
  });

  it('a hanging receipt reaction does not gate the turn: the reply still sends', async () => {
    vi.useFakeTimers();
    const calls: Array<[string, unknown]> = [];
    const api: TelegramOwnerApi = {
      setMessageReaction: async (r) => { calls.push(['react', r]); await new Promise(() => undefined); },
      sendChatAction: async (r) => { calls.push(['typing', r]); },
      sendMessage: async (r) => { calls.push(['send', r]); },
    };
    const listener = new TelegramOwnerListener({ ownerTelegramId: OWNER, api, respond: async (t) => `echo ${t.text}`, saveOffset: async () => undefined, reactionTimeoutMs: 50 });
    const pending = listener.handle(turn);
    const outcome = await Promise.race([
      pending,
      vi.advanceTimersByTimeAsync(5_000).then(() => 'wedged' as const),
    ]);
    expect(outcome).toBe('answered');
    expect(calls.some(([kind, r]) => kind === 'send' && (r as { text: string }).text === 'echo hi')).toBe(true);
  });
});
