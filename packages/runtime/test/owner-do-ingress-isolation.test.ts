// This integration test reaches the real webhook router, per-owner Durable Objects,
// listener, and model responder. All external model and Telegram effects are intercepted.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { OwnerDirectory, OwnerRoute } from '../src/identity/owner-directory';
import type { TelegramOwnerDO } from '../src/channels/telegram-owner-do';

const outbox: { method: string; body: Record<string, unknown> }[] = [];
const modelInputs: unknown[] = [];
vi.mock('../src/channels/telegram-api', async (load) => {
  const original = await load<typeof import('../src/channels/telegram-api')>();
  return {
    ...original,
    createTelegramCaller: () => async (method: string, body: object) => {
      outbox.push({ method, body: body as Record<string, unknown> });
      return method === 'getMe' ? { username: 'fixture_bot' } : true;
    },
  };
});
vi.mock('openai', () => ({
  default: class {
    responses = { create: async (body: unknown) => {
      modelInputs.push(body);
      const name = (body as { text?: { format?: { name?: string } } }).text?.format?.name;
      const text = name === 'claim_ops'
        ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}'
        : 'Synthetic answer from the model adapter.';
      return { id: `fixture-${modelInputs.length}`, output_text: text, output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
    } };
  },
}));

const { handleTelegramWebhook } = await import('../src/channels/telegram-webhook');
let sequence = 0;
const route = (subject: number): OwnerRoute => ({ doName: `hermetic-owner-${subject}`, subject: String(subject), timezone: 'Asia/Kolkata' });
const directory: OwnerDirectory = { byPresence: async (provider, subject) => provider === 'telegram' && ['81101', '81102'].includes(subject) ? route(Number(subject)) : null, redeem: async () => null };
const send = async (subject: number, text: string, updateId: number) => {
  const pending: Promise<unknown>[] = [];
  const response = await handleTelegramWebhook(new Request('https://fixture.invalid/telegram/webhook', {
    method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'hermetic-test-webhook-secret' },
    body: JSON.stringify({ update_id: updateId, message: { message_id: updateId, from: { id: subject, is_bot: false }, chat: { id: subject, type: 'private' }, text } }),
  }), env, (work) => pending.push(work), directory);
  await Promise.all(pending);
  return response;
};
const doStub = (subject: number) => env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(route(subject).doName)) as DurableObjectStub<TelegramOwnerDO>;

describe('real owner-DO ingress in a sealed test world', () => {
  it('routes two fictional owners through separate durable state and intercepts model and channel effects', async () => {
    outbox.length = 0;
    modelInputs.length = 0;
    const update = 100000 + ++sequence * 10;
    expect((await send(81101, 'My private fixture is cedar.', update)).status).toBe(200);
    expect((await send(81102, 'My private fixture is birch.', update + 1)).status).toBe(200);
    const answers = outbox.filter((item) => item.method === 'sendMessage');
    expect(answers).toEqual(expect.arrayContaining([
      expect.objectContaining({ body: expect.objectContaining({ chat_id: 81101, text: 'Synthetic answer from the model adapter.' }) }),
      expect.objectContaining({ body: expect.objectContaining({ chat_id: 81102, text: 'Synthetic answer from the model adapter.' }) }),
    ]));
    const replyInputs = modelInputs.filter((input) => JSON.stringify(input).includes('My private fixture is'))
      .map((input) => JSON.stringify(input));
    expect(replyInputs).toEqual(expect.arrayContaining([expect.stringContaining('cedar'), expect.stringContaining('birch')]));
    expect(replyInputs.filter((input) => input.includes('cedar')).every((input) => !input.includes('birch'))).toBe(true);
    expect(replyInputs.filter((input) => input.includes('birch')).every((input) => !input.includes('cedar'))).toBe(true);
    expect(outbox.every((item) => item.method === 'setWebhook' || [81101, 81102].includes(Number(item.body.chat_id)))).toBe(true);
    const before = outbox.length;
    expect((await send(81101, 'My private fixture is cedar.', update)).status).toBe(200);
    expect(outbox.length).toBe(before); // duplicate ingress cannot re-send effects
    await runInDurableObject(doStub(81101), async (_instance, state) => {
      expect(state.storage.kv.get('telegram_subject')).toBe('81101');
    });
    await runInDurableObject(doStub(81102), async (_instance, state) => {
      expect(state.storage.kv.get('telegram_subject')).toBe('81102');
    });
  });
});
