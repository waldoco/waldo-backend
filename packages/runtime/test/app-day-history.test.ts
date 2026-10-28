import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appControlProjectionV1Schema } from '../../contracts/src/app/controls';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { redactConversationEntries } from '../src/channels/conversation-store';
import { dayPlanBook } from '../src/channels/day-cards';
import { traceBook } from '../src/channels/harness';
import { NIGHTLY_ID } from '../src/channels/episodes';
import { HEALTH_TRIGGER_ID } from '../src/health/trigger';
import { FORGOTTEN, claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

// The days view through the real Owner DO: the app's day history with the card words cut from the Main chat.
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
const { OwnerDO } = await import('../src/channels/owner-do');

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
    if (fn === 'console_session_inventory') return Response.json([{ session: HASH, created_at: new Date(AT - 60_000).toISOString(), last_seen_at: new Date(AT).toISOString(), expires_at: new Date(AT - 60_000 + 12 * 60 * 60_000).toISOString(), rotated_to: null, signed_in_at: new Date(AT - 60_000).toISOString() }]);
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
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const originalNow = Date.now, clock = { now: AT };
    Date.now = () => clock.now;
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      state.storage.kv.put('do_name', name);
      state.storage.kv.put('app_subject', String(appSubjectFor(name)));
      state.storage.kv.put('timezone', 'UTC');
      state.storage.kv.put('timezone_confirmed', true);
      const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC',
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

const daysRead = async ({ owner, name }: Ctx, query: string, contract: string | null = 'controls=6') => {
  const response = await owner.fetch(new Request(`https://telegram-owner/app/v1/controls?${query}`, { headers: { ...headers(name), ...(contract ? { 'x-waldo-app-contract': contract } : {}) } }));
  const body: unknown = await response.json();
  return { status: response.status, body: response.status === 200 ? appControlProjectionV1Schema.parse(body) : body };
};
const today = new Date(AT).toISOString().slice(0, 10);

it('lists the last fourteen days for controls=6, with today\'s delivered Brief and the words the chat shows', async () => {
  await appOwner('days-list', async ctx => {
    await deliver(ctx, 'card:brief');
    const [row] = await chatRows(ctx);
    const { status, body } = await daysRead(ctx, 'view=days');
    expect(status).toBe(200);
    if (!(body as { view?: string }).view || (body as { view: string }).view !== 'days') throw Error('not the days view');
    const data = (body as { data: { today: string; history_since: string; days: { date: string; complete: boolean; cards: { id: string; state: string; latest?: unknown }[] }[] } }).data;
    expect([data.today, data.history_since, data.days.length]).toEqual([today, today, 14]);
    expect(data.days[0]!.cards).toEqual([
      { id: 'card:brief', name: 'The Brief', state: 'sent', latest: { message_id: row!.id, delivered_at: AT, excerpt: card.text } },
      { id: 'card:midday', name: 'Check-in', state: 'pending', latest: null }, { id: 'card:close', name: 'The Close', state: 'pending', latest: null },
    ]);
    expect(data.days[1]).toEqual({ date: new Date(AT - DAY_MS).toISOString().slice(0, 10), complete: false, cards: [], updates_total: 0 });
  });
});

it('reads one day, says 404 for a date outside the fourteen, and 400 below controls=6 or with date on another view', async () => {
  await appOwner('days-one', async ctx => {
    await deliver(ctx, 'card:brief');
    const one = await daysRead(ctx, `view=days&date=${today}`);
    expect(one.status).toBe(200);
    const data = (one.body as { data: { date: string; cards: { state: string }[]; updates: unknown; night: { to: number } } }).data;
    expect([data.date, data.cards[0]!.state, data.night.to]).toEqual([today, 'sent', AT]);
    expect(data.updates).toEqual({ items: [], total: 0 });
    expect(Object.keys(data.cards[0]!)).not.toContain('text');
    expect((await daysRead(ctx, 'view=days&date=2026-09-01')).status).toBe(404);
    for (const contract of [null, 'controls=5']) expect(await daysRead(ctx, 'view=days', contract)).toEqual({ status: 400, body: { error: 'invalid_query' } });
    expect((await daysRead(ctx, `view=day&date=${today}`)).status).toBe(400);
  });
});

it('records the nightly memory pass as a run, so the next day\'s night shows it', async () => {
  await appOwner('days-nightly-run', async ctx => {
    ctx.clock.now = AT + 18 * 60 * 60_000;
    await new Scheduler(ctx.state.storage.sql, ctx.state.storage, productionDeps())
      .schedule({ id: NIGHTLY_ID, kind: 'dreaming', payloadRefs: { id: NIGHTLY_ID }, occurrenceAt: ctx.clock.now - 1000, dueAt: ctx.clock.now - 1000, recurrence: null });
    ctx.state.storage.kv.put('owner_alarm_last_v1', 1);
    await ctx.owner.alarm();
    const runs = ctx.state.storage.sql.exec<{ kind: string; status: string; summary: string | null }>("SELECT kind, status, summary FROM background_runs WHERE kind = 'nightly'").toArray();
    expect(runs).toEqual([{ kind: 'nightly', status: 'completed', summary: 'memory pass finished' }]);
    ctx.clock.now = AT + DAY_MS;
    const next = await daysRead(ctx, `view=days&date=${new Date(AT + DAY_MS).toISOString().slice(0, 10)}`);
    const night = (next.body as { data: { night: { runs: { kind: string }[] } } }).data.night;
    expect(night.runs.map(run => run.kind)).toContain('nightly');
  });
});

it('records the health trigger as a run that names how it ended, with nothing marked to check', async () => {
  await appOwner('days-health-run', async ctx => {
    await new Scheduler(ctx.state.storage.sql, ctx.state.storage, productionDeps())
      .schedule({ id: HEALTH_TRIGGER_ID, kind: 'patrol', payloadRefs: { id: HEALTH_TRIGGER_ID }, occurrenceAt: ctx.clock.now - 1000, dueAt: ctx.clock.now - 1000, recurrence: null });
    ctx.state.storage.kv.put('owner_alarm_last_v1', 1);
    await ctx.owner.alarm();
    expect(ctx.state.storage.sql.exec<{ status: string; summary: string | null }>("SELECT status, summary FROM background_runs WHERE kind = 'health_trigger'").toArray())
      .toEqual([{ status: 'completed', summary: 'nothing to check; stayed quiet' }]);
  });
});
