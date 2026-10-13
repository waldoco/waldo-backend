import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ownerTurnTrace, type OwnerTurnEnvelope } from '../src/channels/owner-turn-envelope';
import { reminderBook } from '../src/channels/reminders';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import { TelegramOwnerInbox } from '../src/channels/telegram-owner-inbox';
import { ownerChainRef } from '../src/context-composer/owner-turn';
import { claimStore } from '../src/memory/claims';
import { persistInboxWake } from '../src/scheduler/alarm-slot';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';
import type { LLMGatewayRequest } from '../src/llm/provider';

// On a directory-backed deploy a Telegram turn runs under the directory owner's principal, exactly as an app turn
// does: the composed context names that owner and the fixture principal never reaches the model.
const model = vi.hoisted(() => ({ requests: [] as string[] }));
// Before the context host prepares a turn it is offered near-miss copies of it; the outcomes say which it admitted.
type NearMiss = readonly [label: string, turn: OwnerTurnEnvelope, scope: RunEffectScope];
const nearMiss = vi.hoisted(() => ({ variants: null as null | ((turn: OwnerTurnEnvelope, scope: RunEffectScope) => readonly NearMiss[]), outcomes: [] as (readonly [string, string])[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const { ClosedRunError } = await import('../src/channels/run-effect-scope');
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const text = request.response_format ? '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : 'Noted.';
    if (!request.response_format) model.requests.push(JSON.stringify(request));
    return { ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => {
    args[11] = gateway;
    const host = args[22]?.contextHost;
    if (host) args[22] = { ...args[22], contextHost: { prepare: async (turn, scope) => {
      for (const [label, variant, variantScope] of nearMiss.variants?.(turn, scope) ?? []) {
        nearMiss.outcomes.push([label, await host.prepare(variant, variantScope).then(() => 'admitted', (error: unknown) => error instanceof ClosedRunError ? 'closed' : 'failed')]);
      }
      return host.prepare(turn, scope);
    } } };
    return original.createTelegramResponder(...args);
  } };
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
  model.requests = []; rpcs.length = 0; nearMiss.variants = null; nearMiss.outcomes = [];
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

const OTHER_PRINCIPAL = `prn_${'c'.repeat(32)}`;
const telegramTurn = async (name: string, withDirectory: boolean, text: string, seed: Record<string, unknown> = {}) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    await state.storage.put({ telegram_subject: '42', do_name: name, ...seed });
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

it('a directory-backed Telegram turn answers only for the owner principal the object is pinned to', async () => {
  expect(await telegramTurn('telegram-principal-pinned', true, 'What does my day look like?', { owner_principal_ref: PRINCIPAL })).toBe('awaiting_delivery');
  model.requests = [];
  expect(await telegramTurn('telegram-principal-pinned-other', true, 'What does my day look like?', { owner_principal_ref: OTHER_PRINCIPAL })).toBe('quarantined');
  expect(model.requests).toEqual([]);
});

it('a Telegram chain holding a second owner principal is refused, admitted or not, before the model reads it', async () => {
  const chain = Object.fromEntries([
    legacyRow(0, 'tg-41', 'user', 'Is the dentist booked for Friday?', null, 'owner'),
    legacyRow(1, 'tg-41-reply', 'assistant', 'Booked for Friday at 3.', 'tg-41', undefined, PRINCIPAL),
    legacyRow(2, 'tg-50', 'user', 'Pick up the parcel from locker 12.', 'tg-41-reply', 'owner', OTHER_PRINCIPAL),
  ]);
  const seed = { ...chain, 'conv-count': 3, 'conv-leaf': 'tg-50' };
  expect(await telegramTurn('telegram-principal-two-owners', true, 'What did I ask you?', seed)).toBe('quarantined');
  expect(await telegramTurn('telegram-principal-two-owners-local', false, 'What did I ask you?', seed)).toBe('quarantined');
  for (const request of model.requests) expect(request).not.toContain('locker 12');
});

it('without a directory the fixture admission still answers, and names no owner', async () => {
  expect(await telegramTurn('telegram-principal-local', false, 'What does my day look like?')).toBe('awaiting_delivery');
  expect(rpcs).not.toContain('common_owner_authority');
  expect(model.requests.length).toBeGreaterThan(0);
  expect(model.requests[0]).not.toContain('Authenticated owner prn_');
});

// The Telegram chain as staging holds it: rows written before turns ran under the directory owner carry the fixture
// principal, and a reminder lands on the same chain as the owner's own messages.
const legacyRow = (index: number, id: string, role: 'user' | 'assistant', text: string, parentId: string | null, inputOrigin?: 'owner' | 'machine', ownerId = FIXTURE_PRINCIPAL) => [`conv:${String(index).padStart(10, '0')}`, {
  id, ownerId, chatId: 'telegram-42', parentId, threadAnchorId: null, surface: 'telegram', modelPayload: text, appPayload: text,
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
      expect(state.storage.kv.get('owner_principal_ref')).toBeUndefined();
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

// One directory-backed owner object for a whole scenario: owner messages through its inbox, reminders through its alarm.
type ChainRow = { id: string; chatId: string; ownerId: string; parentId: string | null; modelPayload: string };
const directoryOwner = (name: string, run: (owner: Readonly<{
  send(update: number, message: Readonly<Record<string, unknown>>): Promise<string | undefined>;
  remind(note: string): Promise<void>;
  chain(): Promise<ReadonlyMap<string, ChainRow>>;
}>) => Promise<void>) => runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
  claimStore(state.storage.sql);
  ensureSchema(state.storage);
  await state.storage.put({ telegram_subject: '42', do_name: name });
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const owner = new TelegramOwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7.fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC' });
  const inbox = new TelegramOwnerInbox(state.storage, persistInboxWake);
  const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
  let reminders = 0;
  try {
    await run({
      send: async (update, message) => {
        await inbox.admit({ bot: '7.fixture', subject: '42', doName: name }, update, JSON.stringify({ update_id: update, message: { message_id: update, from: { id: 42, is_bot: false }, chat: { id: 42, type: 'private' }, ...message } }));
        await (owner as unknown as { drainInbox(): Promise<void> }).drainInbox();
        return (await inbox.records()).find(row => row.updateId === update)?.state;
      },
      // Set an hour ago for half an hour ago, so the next alarm finds it due.
      remind: async note => {
        const { id } = await reminderBook(state.storage.sql, scheduler, { timezone: 'UTC', now: () => new Date(Date.now() - 3_600_000) }, () => `due-${++reminders}`)
          .set({ note, at: new Date(Date.now() - 1_800_000).toISOString().slice(0, 16), repeat: 'none' });
        for (let pass = 0; pass < 4 && scheduler.read(id) !== null; pass++) await owner.alarm();
        expect(scheduler.read(id)).toBeNull();
      },
      chain: async () => new Map([...(await state.storage.list<ChainRow>({ prefix: 'conv:' })).values()].map(row => [row.id, row])),
    });
  } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
});

it('the Telegram context host admits only the occurrence it is running: another chain, surface, update or scope is refused', async () => {
  nearMiss.variants = (turn, scope) => [
    ['another chat', { ...turn, conversationRef: 'telegram-43' }, scope],
    ['the same chat on another surface', { ...turn, conversationRef: 'whatsapp-42' }, scope],
    ['the app chain', { ...turn, conversationRef: ownerChainRef('app', PRINCIPAL) }, scope],
    ['another surface', { ...turn, surface: 'whatsapp' }, scope],
    ['another update', { ...turn, traceId: ownerTurnTrace('telegram', 960002) }, scope],
    ['a copy of the run scope', turn, { ...scope }],
    ['the turn itself', turn, scope],
  ];
  await directoryOwner('telegram-principal-guard', async ({ send }) => {
    expect(await send(960001, { text: 'What does my day look like?' })).toBe('awaiting_delivery');
  });
  expect(nearMiss.outcomes).toEqual([
    ['another chat', 'closed'], ['the same chat on another surface', 'closed'], ['the app chain', 'closed'],
    ['another surface', 'closed'], ['another update', 'closed'], ['a copy of the run scope', 'closed'], ['the turn itself', 'admitted'],
  ]);
  expect(model.requests.at(-1)).toContain(`Authenticated owner ${PRINCIPAL}`);
});

it('a reminder the alarm fires lands on the Telegram chain, and the next directory-backed turn continues from it', async () => {
  await directoryOwner('telegram-principal-reminder', async ({ send, remind, chain }) => {
    expect(await send(970001, { text: 'Is the dentist booked for Friday?' })).toBe('awaiting_delivery');
    await remind('call the plumber');
    expect(await send(970002, { text: 'What did you just remind me about?' })).toBe('awaiting_delivery');
    for (const seen of ['Is the dentist booked for Friday?', 'call the plumber']) expect(model.requests.at(-1)).toContain(seen);
    const rows = await chain();
    const reminder = [...rows.values()].find(row => row.modelPayload.includes('call the plumber'))!;
    expect(reminder).toMatchObject({ chatId: 'telegram-42', parentId: 'tg-970001-reply' });
    expect(rows.get('tg-970002')).toMatchObject({ chatId: 'telegram-42', ownerId: PRINCIPAL, parentId: `${reminder.id}-reply` });
  });
});

it('a media-only message on a directory-backed deploy continues the Telegram chain both ways', async () => {
  await directoryOwner('telegram-principal-media', async ({ send, chain }) => {
    expect(await send(980001, { text: 'Is the dentist booked for Friday?' })).toBe('awaiting_delivery');
    expect(await send(980002, { document: { file_id: 'fixture-file', file_name: 'notes.zip' } })).toBe('awaiting_delivery');
    for (const seen of ['Is the dentist booked for Friday?', 'notes.zip']) expect(model.requests.at(-1)).toContain(seen);
    expect(await send(980003, { text: 'Did the file come through?' })).toBe('awaiting_delivery');
    expect(model.requests.at(-1)).toContain(`Authenticated owner ${PRINCIPAL}`);
    expect(model.requests.at(-1)).toContain('notes.zip');
    const rows = await chain();
    expect(rows.get('tg-980002')).toMatchObject({ chatId: 'telegram-42', parentId: 'tg-980001-reply' });
    expect(rows.get('tg-980003')).toMatchObject({ chatId: 'telegram-42', ownerId: PRINCIPAL, parentId: 'tg-980002-reply' });
  });
});

// Only inbox text turns run as the owner today; the other paths that write the Telegram chain still use the fixture stand-in.
it('turns outside the inbox text path still write under the fixture principal, on the same chain', async () => {
  const name = 'telegram-principal-paths';
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql);
    ensureSchema(state.storage);
    await state.storage.put({ telegram_subject: '42', do_name: name });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = new TelegramOwnerDO(state, { ...env, ...directory, WALDO_ENVIRONMENT: 'staging', TELEGRAM_BOT_TOKEN: '7.fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC' });
    const host = owner as unknown as { drainInbox(): Promise<void>; probeTurn(body: string): Promise<Response>; turn(update: unknown): Promise<void>;
      setup(channel: 'telegram'): { reminders: { set(args: { note: string; at: string; repeat: 'none' }): Promise<{ id: string }> }; scheduler: { read(id: string): unknown }; fire(entry: unknown): Promise<void> } };
    const inbox = new TelegramOwnerInbox(state.storage, persistInboxWake);
    const update = (id: number, body: object) => ({ update_id: id, message: { message_id: id, from: { id: 42, is_bot: false }, chat: { id: 42, type: 'private' }, ...body } });
    const admitted = async (id: number, body: object) => {
      await inbox.admit({ bot: '7.fixture', subject: '42', doName: name }, id, JSON.stringify(update(id, body)));
      await host.drainInbox();
      return (await inbox.records()).find(row => row.updateId === id)?.state;
    };
    try {
      expect(await admitted(960001, { text: 'Is the dentist booked?' })).toBe('awaiting_delivery');
      expect(await admitted(960002, { voice: { file_id: 'voice-1', file_unique_id: 'voice-u1', duration: 1, mime_type: 'audio/ogg', file_size: 10 } })).toBe('awaiting_delivery');
      const runtime = host.setup('telegram');
      await runtime.fire(runtime.scheduler.read((await runtime.reminders.set({ note: 'Call Sam.', at: '2099-01-01T09:00', repeat: 'none' })).id));
      expect((await host.probeTurn(JSON.stringify({ text: 'Probe: anything due?' }))).status).toBe(200);
      await host.turn(update(960003, { text: 'Root route: and tomorrow?' }));
      expect(await admitted(960004, { text: 'What did we cover?' })).toBe('awaiting_delivery');
      const rows = [...(await state.storage.list<{ id: string; ownerId: string; chatId: string; parentId: string | null; role: string }>({ prefix: 'conv:' })).values()];
      rows.forEach((row, index) => expect(row).toMatchObject({ chatId: 'telegram-42', parentId: index === 0 ? null : rows[index - 1]!.id }));
      expect(rows.filter(row => row.role === 'user').map(row => [row.id.startsWith('reminder:') ? 'reminder' : row.id, row.ownerId])).toEqual([
        ['tg-960001', PRINCIPAL], ['tg-960002', FIXTURE_PRINCIPAL], ['reminder', FIXTURE_PRINCIPAL], ['tg--1', FIXTURE_PRINCIPAL], ['tg-960003', FIXTURE_PRINCIPAL], ['tg-960004', PRINCIPAL],
      ]);
      const last = model.requests.at(-1)!;
      expect(last).toContain(`Authenticated owner ${PRINCIPAL}`);
      for (const earlier of ['Is the dentist booked?', 'Probe: anything due?', 'Root route: and tomorrow?']) expect(last).toContain(earlier);
    } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
  });
});
