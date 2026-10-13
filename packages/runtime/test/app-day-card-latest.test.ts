import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appControlProjectionV1Schema } from '../../contracts/src/app/controls';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { redactConversationEntries } from '../src/channels/conversation-store';
import { dayPlanBook } from '../src/channels/day-cards';
import { traceBook } from '../src/channels/harness';
import { FORGOTTEN, claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

// The app's day view names the Main chat row each of today's cards went to, with an excerpt of what the chat shows.
const card = vi.hoisted(() => ({ text: 'Your morning is clear until noon.' }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const content = request.request.messages.at(-1)?.content ?? '';
    const text = String(content).includes('[Scheduled card') ? card.text : 'SKIP';
    return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { TelegramOwnerDO } = await import('../src/channels/telegram-owner-do');

const OWNER_ID = '4b5c6d7e-8f90-4a1b-9c2d-3e4f5a6b7c8d';
const AT = Date.parse('2026-10-03T09:00:00Z');
const DAY_MS = 24 * 60 * 60_000;
const HASH = 'a'.repeat(64);
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const wire = { revoked: false };

beforeEach(() => {
  card.text = 'Your morning is clear until noon.';
  wire.revoked = false;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json(wire.revoked ? null : { owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'console_session_list') return Response.json([{ session: HASH, created_at: new Date(AT - 60_000).toISOString(), last_seen_at: new Date(AT).toISOString() }]);
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'assert_channel_presence') return Response.json(false);
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown> }; fetch(request: Request): Promise<Response>; alarm(): Promise<void> }>;
type Ctx = { owner: Owner; state: DurableObjectState; name: string; clock: { now: number } };

// An app-only owner with nothing scheduled; `deliver` fires one day card now through the real alarm.
const appOwner = async (name: string, check: (ctx: Ctx) => Promise<void>) => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const originalNow = Date.now, clock = { now: AT };
    Date.now = () => clock.now;
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      state.storage.kv.put('do_name', name);
      state.storage.kv.put('app_subject', String(appSubjectFor(name)));
      state.storage.kv.put('timezone', 'UTC');
      state.storage.kv.put('timezone_confirmed', true);
      const owner = new TelegramOwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC',
        WALDO_OWNER_TELEGRAM_ID: undefined }) as unknown as Owner;
      await owner.setup('app').ready;
      state.storage.sql.exec('DELETE FROM schedule');
      await check({ owner, state, name, clock });
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
};
const deliver = async ({ owner, state, clock }: Ctx, cardId: string) => {
  dayPlanBook(state.storage.sql).save(new Date(clock.now).toISOString().slice(0, 10), { card: cardId as never, time: '00:00', reason: 'planned' });
  await new Scheduler(state.storage.sql, state.storage, productionDeps())
    .schedule({ id: cardId, kind: 'brief', payloadRefs: { id: cardId }, occurrenceAt: clock.now - 1000, dueAt: clock.now - 1000, recurrence: null });
  state.storage.kv.put('owner_alarm_last_v1', 1);
  await owner.alarm();
};
const headers = (name: string) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': HASH });
const dayRead = async ({ owner, name }: Ctx) => {
  const response = await owner.fetch(new Request('https://telegram-owner/app/v1/controls?view=day', { headers: headers(name) }));
  const body = response.status === 200 ? appControlProjectionV1Schema.parse(await response.json()) : null;
  if (body && body.view !== 'day') throw Error(`unexpected view ${body.view}`);
  return { status: response.status, revision: body?.revision, cards: Object.fromEntries((body?.view === 'day' ? body.data.cards : []).map(row => [row.id, row])) };
};
const chatRows = async ({ owner, name }: Ctx) => {
  const response = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: headers(name) }));
  return (await response.json() as { messages: { id: string; text: string }[] }).messages;
};
const witnessKey = async (state: DurableObjectState, rowId: string) =>
  [...(await state.storage.list({ prefix: 'canonical-owner-v1:' })).keys()].find(key => key.endsWith(`:witness:${rowId}`))!;

it('a delivered Brief names its Main chat row, when it was delivered and what the chat shows; the other cards name none', async () => {
  await appOwner('card-latest-brief', async ctx => {
    await deliver(ctx, 'card:brief');
    const [row] = await chatRows(ctx);
    expect(row?.text).toBe(card.text);
    const { cards } = await dayRead(ctx);
    expect(cards['card:brief']?.latest).toEqual({ message_id: row!.id, delivered_at: AT, excerpt: card.text });
    expect(Object.values(cards).filter(entry => entry.id !== 'card:brief').every(entry => entry.latest === null)).toBe(true);
  });
});

it('a long card is cut to 280 units, and a cut never splits a character in two', async () => {
  card.text = `${'a'.repeat(279)}\u{1F305} and the rest of a long morning.`;
  await appOwner('card-latest-long', async ctx => {
    await deliver(ctx, 'card:brief');
    expect((await dayRead(ctx)).cards['card:brief']?.latest?.excerpt).toBe('a'.repeat(279));
  });
  card.text = 'b'.repeat(400);
  await appOwner('card-latest-long-plain', async ctx => {
    await deliver(ctx, 'card:brief');
    expect((await dayRead(ctx)).cards['card:brief']?.latest?.excerpt).toBe('b'.repeat(280));
  });
});

it('a day with nothing delivered names none, and the next day forgets yesterday\'s cards when the first card is delivered', async () => {
  await appOwner('card-latest-none', async ctx => {
    expect(Object.values((await dayRead(ctx)).cards).every(entry => entry.latest === null)).toBe(true);
  });
  await appOwner('card-latest-rollover', async ctx => {
    await deliver(ctx, 'card:close');
    ctx.clock.now = AT + DAY_MS;
    expect(Object.values((await dayRead(ctx)).cards).every(entry => entry.latest === null)).toBe(true);
    await deliver(ctx, 'card:brief');
    const rows = await chatRows(ctx);
    const { cards } = await dayRead(ctx);
    expect(cards['card:close']?.latest).toBeNull();
    expect(cards['card:brief']?.latest?.message_id).toBe(rows[0]!.id);
    expect(cards['card:brief']?.latest?.delivered_at).toBe(AT + DAY_MS);
  });
});

it('the excerpt is read from the row each time: a forgotten card shows the forgotten text, and a row that is gone names none', async () => {
  await appOwner('card-latest-forgotten', async ctx => {
    await deliver(ctx, 'card:brief');
    await redactConversationEntries(ctx.state.storage, ['clear until noon'], FORGOTTEN);
    const excerpt = (await dayRead(ctx)).cards['card:brief']?.latest?.excerpt;
    expect(excerpt).toContain(FORGOTTEN);
    expect(excerpt).not.toContain('clear until noon');
  });
  await appOwner('card-latest-gone', async ctx => {
    await deliver(ctx, 'card:brief');
    const kept = ctx.state.storage.kv.get<{ day: string; cards: Record<string, { message_id: string; delivered_at: number }> }>('day_card_delivery_v1')!;
    ctx.state.storage.kv.put('day_card_delivery_v1', { ...kept, cards: { ...kept.cards, 'card:brief': { ...kept.cards['card:brief']!, message_id: 'scheduled-gone' } } });
    expect((await dayRead(ctx)).cards['card:brief']?.latest).toBeNull();
  });
});

it('when the chat cannot be read, the day view still answers: the delivered card leaves latest out, the others say null, and one fixed code is logged', async () => {
  await appOwner('card-latest-unreadable', async ctx => {
    await deliver(ctx, 'card:brief');
    const [row] = await chatRows(ctx);
    const key = await witnessKey(ctx.state, row!.id);
    const witness = (await ctx.state.storage.get<{ entry: { appPayload: string } }>(key))!;
    await ctx.state.storage.put(key, { ...witness, entry: { ...witness.entry, appPayload: 'not what the row says' } });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const read = await dayRead(ctx);
    expect(read.status).toBe(200);
    expect('latest' in read.cards['card:brief']!).toBe(false);
    expect(Object.values(read.cards).filter(entry => entry.id !== 'card:brief').every(entry => entry.latest === null)).toBe(true);
    const lines = logged.mock.calls.map(call => String(call[0])).filter(line => line.includes('app_cards_latest'));
    expect(lines.map(line => JSON.parse(line))).toEqual([{ hop: 'app_cards_latest', ok: false, code: 'history_witness' }]);
    expect(lines.join('')).not.toContain(card.text);
  });
});

it('a day action carries the revision of the day read, and the chat read never changes it', async () => {
  await appOwner('card-latest-action', async ctx => {
    await deliver(ctx, 'card:brief');
    const { revision } = await dayRead(ctx);
    const [row] = await chatRows(ctx);
    const key = await witnessKey(ctx.state, row!.id);
    const witness = (await ctx.state.storage.get<{ entry: { appPayload: string } }>(key))!;
    await ctx.state.storage.put(key, { ...witness, entry: { ...witness.entry, appPayload: 'not what the row says' } });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await dayRead(ctx)).revision).toBe(revision);
    const action = await ctx.owner.fetch(new Request('https://telegram-owner/app/v1/actions', { method: 'POST', headers: { ...headers(ctx.name), 'content-type': 'application/json' },
      body: JSON.stringify({ view: 'day', action: 'proactivity.set', quiet_start: '22:00', quiet_end: '07:00', volume: 'normal', revision, request_id: 'card-latest-action-0001' }) }));
    expect(action.status).toBe(200);
    expect(await action.json()).toMatchObject({ receipt: { state: 'recorded' } });
  });
});

it('a session revoked while the chat is read fails the day read closed', async () => {
  await appOwner('card-latest-revoked', async ctx => {
    await deliver(ctx, 'card:brief');
    const host = ctx.owner as unknown as { appCardsLatest(...args: unknown[]): Promise<unknown> };
    const original = host.appCardsLatest.bind(host);
    vi.spyOn(host, 'appCardsLatest').mockImplementation(async (...args) => { wire.revoked = true; return original(...args); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await dayRead(ctx)).status).toBe(503);
  });
});
