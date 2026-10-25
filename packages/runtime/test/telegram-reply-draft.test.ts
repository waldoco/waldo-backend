import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramOwnerListener, type TelegramOwnerApi } from '../src/channels/telegram-listener';
import { TelegramRejection, telegramReplyDraft } from '../src/channels/telegram-api';
import type { ReplyCheck, ReplyStream } from '../src/conversation/reply-stream';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';
import { ownerTyped } from './helpers/owner-typed';

// Telegram shows the reply while it is written as a draft (sendMessageDraft): ephemeral, and cleared by the bot's next
// message. The final reply is still one sendMessage; drafts stop before it goes, so none can reappear after it.

const OWNER = 5458446350;
const passAll: ReplyCheck = async () => ({ ok: true, holdBack: 0 });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const recorder = () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const call = async (method: string, body: object) => { calls.push([method, body as Record<string, unknown>]); return method === 'sendMessageDraft' ? true : { message_id: 1 }; };
  const api: TelegramOwnerApi = {
    setMessageReaction: async () => undefined,
    sendChatAction: async () => undefined,
    sendMessage: (body) => call('sendMessage', body),
  };
  return { calls, call, api };
};
const turn = (updateId: number) => ownerTyped({ updateId, messageId: null, senderId: OWNER, chatId: OWNER, sentAt: null, text: 'plan my day' });
const words = (count: number, word = 'step') => Array.from({ length: count }, (_, i) => `${word}${i}`).join(' ');
const streamOf = (value: unknown) => (value as { replyStream?: ReplyStream }).replyStream;
// What the model step does with the turn's stream: begin a call, feed its final answer in pieces.
const feed = async (stream: ReplyStream, text: string) => {
  stream.begin(passAll);
  for (const piece of text.match(/.{1,8}/gs)!) { stream.deltas.delta(piece); await tick(); }
};
const fast = { minIntervalMs: 0 } as const;

afterEach(() => vi.useRealTimers());

describe('Telegram reply drafts', () => {
  it('streams prefixes of the reply as drafts, then sends the reply once, after the last draft', async () => {
    const { calls, call, api } = recorder();
    const logs: TurnLogEntry[] = [];
    const final = `Your day: ${words(40)}`;
    const listener = new TelegramOwnerListener({
      ownerTelegramId: OWNER, api, saveOffset: async () => undefined, log: (entry) => logs.push(entry),
      streamReply: (inbound) => ({ ...telegramReplyDraft(call, inbound.chatId, inbound.updateId), ...fast }),
      respond: async (inbound) => { await feed(streamOf(inbound)!, final); return final; },
    });
    await expect(listener.handle(turn(7))).resolves.toBe('answered');
    const drafts = calls.filter(([method]) => method === 'sendMessageDraft');
    const sends = calls.filter(([method]) => method === 'sendMessage');
    expect(drafts.length).toBeGreaterThan(1);
    for (const [, body] of drafts) {
      expect(body).toMatchObject({ chat_id: OWNER, draft_id: 7, parse_mode: 'HTML' });
      expect(final.startsWith(body.text as string)).toBe(true);
    }
    expect(sends).toHaveLength(1);
    expect(sends[0]![1].text).toBe(final);
    const methods = calls.map(([method]) => method);
    expect(methods.indexOf('sendMessage')).toBeGreaterThan(methods.lastIndexOf('sendMessageDraft'));
    expect(logs.find((entry) => entry.hop === 'reply_stream')).toMatchObject({ ok: true, code: 'matched' });
  });

  it('a provider that dies mid-answer: its draft is withdrawn, and only the fallback reply is sent', async () => {
    const { calls, call, api } = recorder();
    const listener = new TelegramOwnerListener({
      ownerTelegramId: OWNER, api, saveOffset: async () => undefined,
      streamReply: (inbound) => ({ ...telegramReplyDraft(call, inbound.chatId, inbound.updateId), ...fast }),
      respond: async (inbound) => {
        const stream = streamOf(inbound)!;
        await feed(stream, `The primary began ${words(30, 'half')}`);
        stream.withdraw();
        stream.begin(passAll);
        return 'The fallback answer.';
      },
    });
    await expect(listener.handle(turn(8))).resolves.toBe('answered');
    const drafts = calls.filter(([method]) => method === 'sendMessageDraft').map(([, body]) => body.text);
    expect(drafts.some((text) => String(text).startsWith('The primary began'))).toBe(true);
    expect(drafts.at(-1)).toBe('');
    expect(calls.filter(([method]) => method === 'sendMessage').map(([, body]) => body.text)).toEqual(['The fallback answer.']);
  });

  it('a turn that fails after drafting sends no draft after its failure message and logs the stream as failed', async () => {
    const { calls, call, api } = recorder();
    const logs: TurnLogEntry[] = [];
    const listener = new TelegramOwnerListener({
      ownerTelegramId: OWNER, api, saveOffset: async () => undefined, log: (entry) => logs.push(entry),
      streamReply: (inbound) => ({ ...telegramReplyDraft(call, inbound.chatId, inbound.updateId), ...fast }),
      respond: async (inbound) => { await feed(streamOf(inbound)!, words(30)); throw new Error('model down'); },
    });
    await expect(listener.handle(turn(9))).resolves.toBe('failed');
    expect(calls.at(-1)?.[0]).toBe('sendMessage');
    expect(logs.find((entry) => entry.hop === 'reply_stream')).toMatchObject({ code: 'failed' });
  });

  it('keeps to one draft a second and at most 90 per reply', async () => {
    vi.useFakeTimers();
    const { calls, call, api } = recorder();
    const surface = telegramReplyDraft(call, OWNER, 10);
    expect(surface).toMatchObject({ minIntervalMs: 1000, maxUpdates: 90, maxChars: 4096 });
    const listener = new TelegramOwnerListener({
      ownerTelegramId: OWNER, api, saveOffset: async () => undefined, streamReply: () => surface,
      respond: async (inbound) => {
        const stream = streamOf(inbound)!;
        stream.begin(passAll);
        for (let i = 0; i < 100; i += 1) { stream.deltas.delta(`word${i} `); await new Promise((resolve) => setTimeout(resolve, 100)); }
        return Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');
      },
    });
    const pending = listener.handle(turn(10));
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(pending).resolves.toBe('answered');
    // Ten seconds of text: at most one draft per second, plus the first.
    const drafts = calls.filter(([method]) => method === 'sendMessageDraft');
    expect(drafts.length).toBeGreaterThan(5);
    expect(drafts.length).toBeLessThanOrEqual(11);
  });

  it('without a draft surface the turn carries no stream and the calls are those of an unstreamed turn', async () => {
    const { calls, api } = recorder();
    let seen: unknown;
    const listener = new TelegramOwnerListener({ ownerTelegramId: OWNER, api, saveOffset: async () => undefined, respond: async (inbound) => { seen = inbound; return 'done'; } });
    await listener.handle(turn(11));
    expect(seen).not.toHaveProperty('replyStream');
    expect(calls).toEqual([['sendMessage', { chat_id: OWNER, text: 'done' }]]);
  });
});

describe('telegramReplyDraft', () => {
  it('sends the draft as Telegram HTML, plain when Telegram rejects the markup, and fails when the send is blocked', async () => {
    const sent: Record<string, unknown>[] = [];
    const rejecting = telegramReplyDraft(async (_method, body) => {
      sent.push(body as Record<string, unknown>);
      if ((body as { parse_mode?: string }).parse_mode) throw new TelegramRejection(400, "Bad Request: can't parse entities", undefined, 'sendMessageDraft');
      return true;
    }, OWNER, 3);
    await rejecting.show('**bold** start');
    expect(sent.map((body) => body.parse_mode ?? 'plain')).toEqual(['HTML', 'plain']);
    expect(sent[1]).toEqual({ chat_id: OWNER, draft_id: 3, text: '**bold** start' });
    await expect(telegramReplyDraft(async () => undefined, OWNER, 3).show('x')).rejects.toThrow();
  });
});
