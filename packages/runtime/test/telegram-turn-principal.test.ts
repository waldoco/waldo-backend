import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TelegramOwnerInbox } from '../src/channels/telegram-owner-inbox';
import { claimStore } from '../src/memory/claims';
import { persistInboxWake } from '../src/scheduler/alarm-slot';
import { ensureSchema } from '../src/tracer/schema';
import type { LLMGatewayRequest } from '../src/llm/provider';

// On a directory-backed deploy a Telegram turn runs under the directory owner's principal, exactly as an app turn
// does: the composed context names that owner and the fixture principal never reaches the model.
const model = vi.hoisted(() => ({ requests: [] as string[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const text = request.response_format ? '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : 'Noted.';
    if (!request.response_format) model.requests.push(JSON.stringify(request));
    return { ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async (method: string) => method === 'getMe' ? { username: 'fixture_bot' } : method === 'sendMessage' ? { message_id: 1 } : true }));
const { TelegramOwnerDO } = await import('../src/channels/telegram-owner-do');

const OWNER_ID = '7c2e9a14-3b5d-4f60-8a71-92b3c4d5e6f7';
const PRESENCE_ID = '0d6b1f22-9c4e-4a7b-8e21-5f3a9c7d1b44';
const PRINCIPAL = `prn_${OWNER_ID.replaceAll('-', '')}`;
const FIXTURE_PRINCIPAL = 'prn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const rpcs: string[] = [];

beforeEach(() => {
  model.requests = []; rpcs.length = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn) rpcs.push(fn);
    if (fn === 'common_owner_authority') return Response.json({ admission_revision: '5', auth_user_id: OWNER_ID, do_name: asked.p_do_name, owner_id: OWNER_ID, presence_id: PRESENCE_ID, provider: asked.p_provider, state_version: 1, subject: asked.p_subject });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const telegramTurn = async (name: string, withDirectory: boolean, text: string) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    await state.storage.put({ telegram_subject: '42', do_name: name });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new TelegramOwnerDO(state, { ...env, ...(withDirectory ? directory : {}), TELEGRAM_BOT_TOKEN: '7.fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC' });
    const inbox = new TelegramOwnerInbox(state.storage, persistInboxWake);
    const update = 920001;
    try {
      await inbox.admit({ bot: '7.fixture', subject: '42', doName: name }, update, JSON.stringify({ update_id: update, message: { message_id: update, from: { id: 42, is_bot: false }, chat: { id: 42, type: 'private' }, text } }));
      await (owner as unknown as { drainInbox(): Promise<void> }).drainInbox();
      return (await inbox.records()).find(row => row.updateId === update)?.state;
    } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });

it('a directory-backed Telegram turn runs under the directory owner principal', async () => {
  expect(await telegramTurn('telegram-principal-directory', true, 'What does my day look like?')).toBe('awaiting_delivery');
  expect(rpcs).toContain('common_owner_authority');
  expect(model.requests.length).toBeGreaterThan(0);
  expect(model.requests[0]).toContain(`Authenticated owner ${PRINCIPAL}`);
  for (const request of model.requests) expect(request).not.toContain(FIXTURE_PRINCIPAL);
});

it('without a directory the fixture admission still answers, and names no owner', async () => {
  expect(await telegramTurn('telegram-principal-local', false, 'What does my day look like?')).toBe('awaiting_delivery');
  expect(rpcs).not.toContain('common_owner_authority');
  expect(model.requests.length).toBeGreaterThan(0);
  expect(model.requests[0]).not.toContain('Authenticated owner prn_');
});

// The Telegram chain as staging holds it: rows written before turns ran under the directory owner carry the fixture
// principal, and a reminder lands on the same chain as the owner's own messages.
const legacyRow = (index: number, id: string, role: 'user' | 'assistant', text: string, parentId: string | null, inputOrigin?: 'owner' | 'machine') => [`conv:${String(index).padStart(10, '0')}`, {
  id, ownerId: FIXTURE_PRINCIPAL, chatId: 'telegram-42', parentId, threadAnchorId: null, surface: 'telegram', modelPayload: text, appPayload: text,
  modelProjection: { mode: 'include' }, role, ...(inputOrigin ? { inputOrigin } : {}) }] as const;
it('a directory-backed Telegram turn continues the Telegram chain: it sees the earlier turns and a reminder, and the next turn sees it', async () => {
  const name = 'telegram-principal-chain';
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    await state.storage.put({ telegram_subject: '42', do_name: name });
    await state.storage.put(Object.fromEntries([
      legacyRow(0, 'tg-41', 'user', 'Is the dentist booked for Friday?', null, 'owner'),
      legacyRow(1, 'tg-41-reply', 'assistant', 'Booked for Friday at 3.', 'tg-41'),
      legacyRow(2, 'reminder-1', 'user', 'Reminder due now: call Sam.', 'tg-41-reply', 'machine'),
      legacyRow(3, 'reminder-1-reply', 'assistant', 'Time to call Sam.', 'reminder-1'),
    ]));
    await state.storage.put({ 'conv-count': 4, 'conv-leaf': 'reminder-1-reply' });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new TelegramOwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7.fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC' });
    const inbox = new TelegramOwnerInbox(state.storage, persistInboxWake);
    const turn = async (update: number, text: string, host = owner) => {
      await inbox.admit({ bot: '7.fixture', subject: '42', doName: name }, update, JSON.stringify({ update_id: update, message: { message_id: update, from: { id: 42, is_bot: false }, chat: { id: 42, type: 'private' }, text } }));
      await (host as unknown as { drainInbox(): Promise<void> }).drainInbox();
      return (await inbox.records()).find(row => row.updateId === update)?.state;
    };
    try {
      expect(await turn(930001, 'Did I call Sam yet?')).toBe('awaiting_delivery');
      const first = model.requests.at(-1)!;
      expect(first).toContain(`Authenticated owner ${PRINCIPAL}`);
      for (const earlier of ['Booked for Friday at 3.', 'Time to call Sam.']) expect(first).toContain(earlier);
      const rows = [...(await state.storage.list<{ id: string; chatId: string; ownerId: string; parentId: string | null }>({ prefix: 'conv:' })).values()];
      const asked = rows.find(row => row.id === 'tg-930001')!;
      expect(asked).toMatchObject({ chatId: 'telegram-42', ownerId: PRINCIPAL, parentId: 'reminder-1-reply' });
      expect(await turn(930002, 'And the dentist?')).toBe('awaiting_delivery');
      expect(model.requests.at(-1)).toContain('Did I call Sam yet?');
      // A turn that still runs under the fixture principal, as a media-only turn does, continues the same chain.
      const local = new TelegramOwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: '7.fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC' });
      expect(await turn(930003, 'Anything else today?', local)).toBe('awaiting_delivery');
      expect(model.requests.at(-1)).toContain('And the dentist?');
    } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
});
