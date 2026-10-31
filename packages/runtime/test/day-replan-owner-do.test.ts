import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CalendarChange, CalendarItem } from '../src/connectors/google';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { applyDayPlan, dayPlanBook } from '../src/channels/day-cards';
import { BRIEF_SWEEP_ID } from '../src/channels/event-briefs';
import { traceBook } from '../src/channels/harness';
import { claimStore } from '../src/memory/claims';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

// In the owner object with the day state on: a meeting added before the Brief makes the sweep ask for a re-plan of the cards
// still to come, and the Brief moves ahead of the meeting. The re-plan sees each card's current time; a card the reply leaves
// out keeps its own; a burst of changes in one pass costs one re-plan; a failed re-plan keeps the plan; with the day state off
// nothing is re-planned. The trace carries counts, never the times.
const OWNER_ID = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const LISTED: CalendarItem = { id: 'e-call', title: 'Call with Asha', status: 'confirmed', start: '2026-10-20T07:30:00Z', end: '2026-10-20T08:00:00Z', all_day: false };
const CALL: CalendarChange = { ...LISTED, status: 'confirmed', created: '2026-10-20T06:05:00Z' };
const fixture = vi.hoisted(() => ({ listed: [] as CalendarItem[], changed: [] as CalendarChange[], replans: [] as string[], reply: '' }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (_app: unknown, _tokens: unknown, _fetch: unknown, _health: unknown, account: unknown) => ({
    account, events: async () => [...fixture.listed],
    calendarPage: async () => ({ events: [...fixture.listed], next_page_token: null, fetched_count: fixture.listed.length, account, observed_at: new Date().toISOString() }),
    event: async () => fixture.listed[0] ?? null, changedEvents: async () => [...fixture.changed], newMail: async () => [],
  }) };
});
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const content = String(request.request.messages.at(-1)?.content ?? '');
    const text = content.includes('Today\'s calendar just changed') ? (fixture.replans.push(content), fixture.reply) : 'SKIP';
    return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

let clock = 0;
beforeEach(() => {
  fixture.listed = []; fixture.changed = []; fixture.replans = []; fixture.reply = '';
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'assert_channel_presence') return Response.json(false);
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown> }; alarm(): Promise<void> }>;
const withOwner = (name: string, dayState: '0' | '1', work: (h: Readonly<{ sweep(): Promise<void>; due(card: string): number | undefined; sql: SqlStorage }>) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const originalNow = Date.now;
    clock = Date.parse('2026-10-20T06:00:00Z');
    Date.now = () => clock;
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      state.storage.kv.put('do_name', name);
      state.storage.kv.put('app_subject', String(appSubjectFor(name)));
      state.storage.kv.put('timezone', 'UTC');
      state.storage.kv.put('timezone_confirmed', true);
      await state.storage.put('origin', 'https://fixture.invalid');
      await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only', scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
      const owner = new OwnerDO(state, { ...env, ...directory, WALDO_DAY_STATE: dayState, CALENDAR_GROUNDED_PREP: '0', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture',
        OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined,
        GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret' }) as unknown as Owner;
      await owner.setup('app').ready;
      const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
      await applyDayPlan(scheduler, dayPlanBook(state.storage.sql), 'UTC', clock, [{ card: 'card:brief', time: '08:00', reason: 'model plan' },
        { card: 'card:midday', time: '15:00', reason: 'model plan' }, { card: 'card:close', time: '21:30', reason: 'model plan' }], false);
      const sweep = async () => {
        await scheduler.schedule({ id: BRIEF_SWEEP_ID, kind: 'pre_activity_spot', payloadRefs: { id: BRIEF_SWEEP_ID }, occurrenceAt: clock - 1000, dueAt: clock - 1000, recurrence: null });
        state.storage.kv.put('owner_alarm_last_v1', 0);
        await owner.alarm();
      };
      await sweep();
      clock += 10 * 60_000;
      await work({ sweep, due: card => scheduler.read(card)?.due_at, sql: state.storage.sql });
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
const replanNotes = (sql: SqlStorage) => sql.exec<{ ok: number; note: string | null }>("SELECT ok, note FROM trace_log WHERE hop = 'day_plan' AND trace LIKE '%:replan'").toArray();

it('golden: a call added before the Brief moves the Brief ahead of it; the cards the reply leaves out keep their times', async () => {
  await withOwner('day-replan-golden', '1', async ({ sweep, due, sql }) => {
    fixture.reply = JSON.stringify({ cards: [{ id: 'card:brief', time: '07:15', reason: 'before the 07:30 call' }] });
    fixture.listed = [LISTED];
    fixture.changed = [CALL];
    await sweep();
    await vi.waitFor(() => expect(due('card:brief')).toBe(Date.parse('2026-10-20T07:15:00Z')));
    expect(fixture.replans).toHaveLength(1);
    expect(fixture.replans[0]).toContain('- card:brief (The Brief), default 08:00, planned 08:00');
    expect(fixture.replans[0]).toContain('Call with Asha');
    expect(due('card:midday')).toBe(Date.parse('2026-10-20T15:00:00Z'));
    expect(dayPlanBook(sql).read('2026-10-20').find(row => row.card === 'card:brief')).toMatchObject({ time: '07:15', reason: 'before the 07:30 call' });
    expect(replanNotes(sql)).toEqual([{ ok: 1, note: '1 planned' }]);
    expect(JSON.stringify(sql.exec("SELECT * FROM trace_log WHERE hop = 'day_plan'").toArray())).not.toMatch(/07:15|07:30|Asha/);
  });
});

it('a burst of changes in one pass costs one re-plan', async () => {
  await withOwner('day-replan-burst', '1', async ({ sweep }) => {
    fixture.reply = JSON.stringify({ cards: [] });
    fixture.listed = Array.from({ length: 5 }, (_, i) => ({ ...LISTED, id: `e-${i}`, start: `2026-10-20T1${i}:00:00Z`, end: `2026-10-20T1${i}:30:00Z` }));
    fixture.changed = fixture.listed.map(item => ({ ...item, status: 'confirmed', created: CALL.created }));
    await sweep();
    await vi.waitFor(() => expect(fixture.replans).toHaveLength(1));
  });
});

it('a re-plan the model could not give keeps the plan', async () => {
  await withOwner('day-replan-failed', '1', async ({ sweep, due, sql }) => {
    fixture.reply = 'SKIP';
    fixture.listed = [LISTED];
    fixture.changed = [CALL];
    await sweep();
    await vi.waitFor(() => expect(replanNotes(sql)).toEqual([{ ok: 0, note: expect.anything() }]));
    expect(due('card:brief')).toBe(Date.parse('2026-10-20T08:00:00Z'));
  });
});

it('with the day state off, a change touching today re-plans nothing', async () => {
  await withOwner('day-replan-off', '0', async ({ sweep, due, sql }) => {
    fixture.reply = JSON.stringify({ cards: [{ id: 'card:brief', time: '07:15', reason: 'x' }] });
    fixture.listed = [LISTED];
    fixture.changed = [CALL];
    await sweep();
    await sweep();
    expect(fixture.replans).toEqual([]);
    expect(replanNotes(sql)).toEqual([]);
    expect(due('card:brief')).toBe(Date.parse('2026-10-20T08:00:00Z'));
  });
});
