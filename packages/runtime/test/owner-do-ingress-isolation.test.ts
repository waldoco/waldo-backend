// This integration test reaches the real webhook router, per-owner Durable Objects,
// listener, and model responder. All external model and Telegram effects are intercepted.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OwnerDirectory, OwnerRoute } from '../src/identity/owner-directory';
import type { TelegramOwnerDO } from '../src/channels/telegram-owner-do';
import { IsolatedSourceWorld } from '../scenarios/isolated-source-world';
import { isolatedGoogleClient } from '../scenarios/isolated-google-client';

const outbox: { method: string; body: Record<string, unknown> }[] = [];
const modelInputs: unknown[] = [];
let sourceWorld: IsolatedSourceWorld | null = null;
vi.mock('../src/connectors/google', async (load) => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (_app: unknown, tokens: { email?: string }) => {
    if (!sourceWorld || !tokens.email) throw new Error('fixture Google account is unavailable');
    return isolatedGoogleClient(sourceWorld, tokens.email);
  } };
});
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
      const input = JSON.stringify(body);
      const wantsMail = input.includes('Read the fixture inbox');
      const hasToolOutput = input.includes('function_call_output');
      const output = wantsMail && !hasToolOutput && name !== 'claim_ops'
        ? [{ type: 'function_call', call_id: 'fixture-mail-read', name: 'get_communication', arguments: '{}' }] : [];
      return { id: `fixture-${modelInputs.length}`, output_text: output.length ? '' : text, output, usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
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
  afterEach(() => { sourceWorld = null; });
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
  it('routes fictional Google reads through owner-scoped source rows inside the real DO tool loop', async () => {
    sourceWorld = new IsolatedSourceWorld({ clock: '2026-09-29T11:00:00Z', owners: [{ id: 'a@example.invalid' }, { id: 'b@example.invalid' }], sources: { mail: [
      { owner_id: 'a@example.invalid', id: 'mail', thread_id: 'thread', from: 'sender@example.invalid', subject: 'Cedar report', snippet: 'cedar only', at: '2026-09-29T10:30:00Z' },
      { owner_id: 'b@example.invalid', id: 'mail', thread_id: 'thread', from: 'sender@example.invalid', subject: 'Birch report', snippet: 'birch only', at: '2026-09-29T10:30:00Z' },
    ] } });
    outbox.length = 0; modelInputs.length = 0;
    for (const [subject, email] of [[81101, 'a@example.invalid'], [81102, 'b@example.invalid']] as const) {
      await runInDurableObject(doStub(subject), async (_instance, state) => {
        await state.storage.put('google:accounts', [{ id: `local:${email}`, email, scopes: null, refresh_token: 'fictional-not-a-token' }]);
      });
    }
    const update = 200000 + ++sequence * 10;
    expect((await send(81101, 'Read the fixture inbox for owner A.', update)).status).toBe(200);
    expect((await send(81102, 'Read the fixture inbox for owner B.', update + 1)).status).toBe(200);
    const sent = outbox.filter((item) => item.method === 'sendMessage');
    expect(sent.map((item) => item.body.chat_id)).toEqual([81101, 81102]);
    const toolInputs = modelInputs.filter((body) => JSON.stringify(body).includes('function_call_output')).map((body) => JSON.stringify(body));
    expect(toolInputs).toEqual(expect.arrayContaining([expect.stringContaining('cedar only'), expect.stringContaining('birch only')]));
    expect(toolInputs.filter((input) => input.includes('cedar only')).every((input) => !input.includes('birch only'))).toBe(true);
    expect(toolInputs.filter((input) => input.includes('birch only')).every((input) => !input.includes('cedar only'))).toBe(true);
  });
});
