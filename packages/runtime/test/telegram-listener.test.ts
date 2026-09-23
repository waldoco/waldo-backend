import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramOwnerListener, type TelegramOwnerApi } from '../src/channels/telegram-listener';
import { TelegramPollingAdapter } from '../src/channels/telegram-polling';

const OWNER = 5458446350;
const update = (id: number, from = OWNER, chat = from, text = 'hi') => ({
  update_id: id,
  message: { message_id: id * 10, date: 1, from: { id: from, is_bot: false, first_name: 'A' }, chat: { id: chat, type: 'private' }, text },
});
const recorder = () => {
  const calls: Array<[string, unknown]> = [];
  const api: TelegramOwnerApi = {
    setMessageReaction: async (r) => { calls.push(['react', r]); },
    sendChatAction: async (r) => { calls.push(['typing', r]); },
    sendMessage: async (r) => { calls.push(['send', r]); },
  };
  return { calls, api };
};

afterEach(() => vi.useRealTimers());

describe('TelegramOwnerListener', () => {
  it('acks with a reaction and typing before answering the owner', async () => {
    const { calls, api } = recorder();
    const listener = new TelegramOwnerListener({ ownerTelegramId: OWNER, api, respond: async (turn) => `echo ${turn.text}`, saveOffset: async () => undefined });
    const adapter = new TelegramPollingAdapter({ getUpdates: async () => [update(5)] });
    await expect(listener.pollOnce(adapter, 0)).resolves.toEqual(['answered']);
    expect(calls.map(([kind]) => kind)).toEqual(['react', 'typing', 'send', 'react']);
    expect(calls[0]?.[1]).toEqual({ chat_id: OWNER, message_id: 50, reaction: [{ type: 'emoji', emoji: '👀' }] });
    expect(calls[3]?.[1]).toEqual({ chat_id: OWNER, message_id: 50, reaction: [{ type: 'emoji', emoji: '👌' }] });
    expect(calls[2]?.[1]).toEqual({ chat_id: OWNER, text: 'echo hi' });
  });

  it('ignores every non-owner sender or chat without calling the model or replying', async () => {
    const { calls, api } = recorder();
    const respond = vi.fn(async () => 'never');
    const saved: number[] = [];
    const listener = new TelegramOwnerListener({ ownerTelegramId: OWNER, api, respond, saveOffset: async (o) => { saved.push(o); } });
    const adapter = new TelegramPollingAdapter({ getUpdates: async () => [update(6, 42), update(7, 42, OWNER), update(8, OWNER, 42)] });
    await expect(listener.pollOnce(adapter, 0)).resolves.toEqual(['ignored', 'ignored', 'ignored']);
    expect(respond).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(saved).toEqual([9]);
  });

  it('sends a progress beat on slow turns and an honest failure message on errors', async () => {
    vi.useFakeTimers();
    const { calls, api } = recorder();
    let finish!: (text: string) => void;
    const listener = new TelegramOwnerListener({ ownerTelegramId: OWNER, api, respond: () => new Promise((resolve) => { finish = resolve; }), saveOffset: async () => undefined, progressAfterMs: 100, typingEveryMs: 1_000 });
    const pending = listener.handle({ updateId: 1, messageId: 3, senderId: OWNER, chatId: OWNER, text: 'slow' });
    await vi.advanceTimersByTimeAsync(150);
    finish('done');
    await expect(pending).resolves.toBe('answered');
    expect(calls.filter(([kind]) => kind === 'send').map(([, r]) => (r as { text: string }).text)).toEqual(['On it - still working on this, reply coming shortly.', 'done']);

    const failing = new TelegramOwnerListener({ ownerTelegramId: OWNER, api, respond: async () => { throw new Error('model down'); }, saveOffset: async () => undefined });
    await expect(failing.handle({ updateId: 2, messageId: null, senderId: OWNER, chatId: OWNER, text: 'x' })).resolves.toBe('failed');
    expect(calls.at(-1)?.[1]).toEqual({ chat_id: OWNER, text: 'Sorry - I hit a problem answering that. Please try again in a moment.' });
  });

  it('moves the receipt to a final reaction from the Telegram allowlist when the turn resolves', async () => {
    const reactions = async (choice: string | null | Error, reply: () => Promise<string> = async () => 'ok') => {
      const { calls, api } = recorder();
      const listener = new TelegramOwnerListener({
        ownerTelegramId: OWNER, api, respond: reply, saveOffset: async () => undefined,
        chooseReaction: async () => { if (choice instanceof Error) throw choice; return choice; },
      });
      await listener.handle({ updateId: 1, messageId: 9, senderId: OWNER, chatId: OWNER, text: 'thanks!' });
      return calls.filter(([kind]) => kind === 'react').map(([, r]) => (r as { reaction: [{ emoji: string }] }).reaction[0].emoji);
    };
    await expect(reactions('🙏')).resolves.toEqual(['👀', '🙏']);
    await expect(reactions('❤️')).resolves.toEqual(['👀', '❤']);
    await expect(reactions('✅')).resolves.toEqual(['👀', '👌']);
    await expect(reactions('none')).resolves.toEqual(['👀', '👌']);
    await expect(reactions('👀')).resolves.toEqual(['👀', '👌']);
    await expect(reactions(new Error('model down'))).resolves.toEqual(['👀', '👌']);
    await expect(reactions('🎉', async () => { throw new Error('model down'); })).resolves.toEqual(['👀', '😢']);
  });

  it('never delays the reply on the reaction choice', async () => {
    const { calls, api } = recorder();
    let pick!: (emoji: string) => void;
    const listener = new TelegramOwnerListener({
      ownerTelegramId: OWNER, api, respond: async () => 'fast', saveOffset: async () => undefined,
      chooseReaction: () => new Promise((resolve) => { pick = resolve; }),
    });
    const pending = listener.handle({ updateId: 1, messageId: 9, senderId: OWNER, chatId: OWNER, text: 'hey' });
    await vi.waitFor(() => expect(calls.some(([kind]) => kind === 'send')).toBe(true));
    pick('🔥');
    await expect(pending).resolves.toBe('answered');
    expect(calls.map(([kind]) => kind)).toEqual(['react', 'typing', 'send', 'react']);
  });

  it('rejects an invalid owner id', () => {
    const { api } = recorder();
    expect(() => new TelegramOwnerListener({ ownerTelegramId: 0, api, respond: async () => '', saveOffset: async () => undefined })).toThrow('owner id');
  });
});
