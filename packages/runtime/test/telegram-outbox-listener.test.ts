import { describe, expect, it, vi, afterEach } from 'vitest';
import { TelegramOwnerListener } from '../src/channels/telegram-listener';
import { TelegramFinalOutbox } from '../src/channels/telegram-final-outbox';
afterEach(() => vi.useRealTimers());
it.each([60_000, 120_000])('queues final after %sms response with old request budget exhausted', async delay => {
  vi.useFakeTimers(); const data = new Map<string, unknown>();
  const kv = { get: <T>(key: string) => structuredClone(data.get(key)) as T, put: (key: string, value: unknown) => data.set(key, structuredClone(value)) } as unknown as DurableObjectStorage['kv'];
  const outbox = new TelegramFinalOutbox(kv); let budget = 0;
  const requestSend = vi.fn(async () => { budget++; if (budget > 50) throw new Error('too many subrequests'); });
  const listener = new TelegramOwnerListener({ ownerTelegramId: 7,
    api: { sendMessage: requestSend, sendChatAction: async () => { budget++; }, setMessageReaction: async () => { budget++; } },
    respond: async () => { await new Promise(r => setTimeout(r, delay)); budget = 50; return 'final'; },
    saveOffset: async () => undefined,
    queueFinal: async (turn, payload) => outbox.enqueue({ id: `turn:${turn.updateId}`, trace: 'tg-1', payload, ownerSubject: '7', doName: 'owner-7' }),
  });
  const pending = listener.handle({ updateId: 1, senderId: 7, chatId: 7, messageId: 2, sentAt: null, text: 'slow' });
  await vi.advanceTimersByTimeAsync(delay + 1); expect(await pending).toBe('queued');
  expect(outbox.records()[0]?.status).toBe('pending'); expect(requestSend).toHaveBeenCalledTimes(1); // only progress
  await vi.advanceTimersByTimeAsync(300);
  const freshSend = vi.fn(async () => ({ message_id: 9 }));
  await outbox.drain({ allowed: async () => true, send: freshSend, settled: async () => undefined });
  expect(outbox.records()[0]?.status).toBe('delivered'); expect(freshSend).toHaveBeenCalledTimes(1);
});
it('180s responder deadline is not cancellation proof, and does not enqueue late final', async () => {
  vi.useFakeTimers(); const queueFinal = vi.fn(); let lateWork = false;
  const listener = new TelegramOwnerListener({ ownerTelegramId: 7,
    api: { sendMessage: async () => undefined, sendChatAction: async () => undefined, setMessageReaction: async () => undefined },
    respond: async () => { await new Promise(r => setTimeout(r, 180000)); lateWork = true; return 'late'; },
    queueFinal, saveOffset: async () => undefined,
  });
  const pending = listener.handle({ updateId: 1, senderId: 7, chatId: 7, messageId: null, sentAt: null, text: 'slow' });
  await vi.advanceTimersByTimeAsync(150001); expect(await pending).toBe('failed');
  await vi.advanceTimersByTimeAsync(30000); expect(lateWork).toBe(true); expect(queueFinal).not.toHaveBeenCalled();
});
