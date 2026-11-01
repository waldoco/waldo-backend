import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { applyDayPlan, dayPlanBook } from '../src/channels/day-cards';
import { HEALTH_RECOMPUTE_WINDOW_MS } from '../src/health/recompute';
import { notifyOwnerHealthSamples } from '../src/health/zone-change-route';
import { armAlarm } from '../src/scheduler/alarm-slot';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { jobBook } from '../src/tasks/jobs';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';

// The wake Brief on the real owner object: the phone's upload brings last night's sleep in, the health plane says today's
// night changed, and the owner object, told only the day, gives a Brief still to come one wake turn on its own queue. The
// model sends it now, earlier, or keeps its latest-by. The night's own times never reach the owner object. Google, the health
// plane and the model are fakes; every reading is synthetic.
const SECRET = 'router-secret-fixture-0000000000';
const OWNER_ID = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
const TODAY = '2026-10-20';
const NIGHT_END = '06:52';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const world = vi.hoisted(() => ({
  listed: [] as unknown[], changed: [] as unknown[], nightEnd: '', refs: new Map<string, string>(), writes: [] as Record<string, unknown>[], consent: true,
  wakes: [] as string[], planModes: [] as (boolean | undefined)[], replans: [] as string[], wakeReply: '', replanReply: '',
}));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (_app: unknown, _tokens: unknown, _fetch: unknown, _health: unknown, account: unknown) => ({
    account, events: async () => [...world.listed], event: async () => world.listed[0] ?? null, newMail: async () => [],
    changedEvents: async () => { const seen = world.changed; world.changed = []; return seen; },
    calendarPage: async () => ({ events: [...world.listed], next_page_token: null, fetched_count: world.listed.length, account, observed_at: new Date().toISOString() }),
  }) };
});
// What the owner object asks the day plan for: whether the plan is in wake mode.
vi.mock('../src/prompt/day-cards', async load => {
  const original = await load<typeof import('../src/prompt/day-cards')>();
  return { ...original, dayPlanInput: (context: Parameters<typeof original.dayPlanInput>[0]) => {
    if (!context.wake && !context.replan) world.planModes.push(context.wakeMode);
    return original.dayPlanInput(context);
  } };
});
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async () => true }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const content = String(request.request.messages.at(-1)?.content ?? '');
    const text = content.includes('wearable shows their night is in') ? (world.wakes.push(content), world.wakeReply)
      : content.includes('calendar just changed') ? (world.replans.push(content), world.replanReply) : 'SKIP';
    return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const CONFIG = { ...env, WALDO_OWNER_TELEGRAM_ID: undefined, WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture',
  GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret', WALDO_ROUTER_HMAC_SECRET: SECRET, SUPABASE_PROJECT_URL: 'https://edge.test',
  SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_DAY_STATE: '1', WAKE_BRIEF: '1', CALENDAR_GROUNDED_PREP: '0' };

// Twenty nights from the phone; today's ends at the night's end the test sets.
const series = () => ({
  access: 'granted', read_at: new Date().toISOString(),
  sources: [{ source: 'apple', consent_epoch: 1, truncated: false, samples: Array.from({ length: 20 }, (_, i) => {
    const day = addDays(TODAY, -i), start_at = `${addDays(day, -1)}T23:00:00.000Z`, end_at = i === 0 ? `${day}T${world.nightEnd}:00.000Z` : `${day}T07:00:00.000Z`;
    if (i === 0 && !world.nightEnd) return [];
    return [
      { signal: 'sleep_duration', day, start_at, end_at, utc_offset_minutes: 0, timezone: 'UTC', value: 440 + (i % 5) * 6, method: 'asleep_duration' },
      { signal: 'sleep_midpoint', day, start_at, end_at, utc_offset_minutes: 0, timezone: 'UTC', value: 180 + (i % 3) * 7, method: 'sleep_midpoint' },
      { signal: 'overnight_hrv', day, start_at, end_at, utc_offset_minutes: 0, timezone: 'UTC', value: 52 + (i % 4) * 3, method: 'rmssd' },
    ];
  }).flat() }],
});

let sequence = 0;
beforeEach(() => {
  world.listed = []; world.changed = []; world.nightEnd = NIGHT_END; world.refs.clear(); world.writes = []; world.consent = true;
  world.wakes = []; world.planModes = []; world.replans = []; world.wakeReply = JSON.stringify({ cards: [{ id: 'card:brief', time: 'now', reason: 'up for the day' }] }); world.replanReply = JSON.stringify({ cards: [] });
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(`${TODAY}T07:05:00Z`) });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, string | number> : {};
    const payload = typeof body.p_payload === 'string' ? JSON.parse(body.p_payload) as Record<string, unknown> : {};
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: body.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'health_series_read') return Response.json(series());
    if (fn === 'health_scores_read') return Response.json({ unavailable: 'no_readings' });
    if (fn === 'health_scores_history') return Response.json({ unavailable: 'no_readings' });
    // As the writer does: a row with a digest says whether it differs from the day's; one without leaves it as it was.
    if (fn === 'health_context_write') {
      world.writes.push(payload);
      const day = String(payload.day), ref = payload.night_ref;
      if (typeof ref !== 'string') return Response.json({ written: true, changed: [] });
      const changed = world.refs.get(day) !== ref;
      world.refs.set(day, ref);
      return Response.json({ written: true, changed: [], night_changed: changed });
    }
    // The model-use consented read: with that consent withdrawn it returns nothing.
    if (fn === 'health_context_read') return Response.json(world.consent ? { context: { id: 'ctx', day: TODAY, basis: [{ source: 'apple', consent_epoch: 1 }], drivers: [] }, previous: null } : null);
    if (fn === 'assert_channel_presence') return Response.json(false);
    return fn ? Response.json(true) : new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

const dump = (state: DurableObjectState) => JSON.stringify([
  state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray().map(({ name }) => [name, state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray()]),
  [...state.storage.kv.list()],
]);
type Owner = { fetch(request: Request): Promise<Response>; alarm(): Promise<void>; setup(channel: string): { ready: Promise<unknown>; updateCheck(trace: string): Promise<void> } };
type Desk = Readonly<{ state: DurableObjectState; due(): number | undefined; night(at: string): Promise<void>; sweep(): Promise<void>; wakeNotes(): string[] }>;
const withOwner = (work: (o: Desk) => Promise<void>, config: Record<string, unknown> = CONFIG) => {
  const doName = `wake-brief-do-${sequence++}`;
  return runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(doName)), async (_i, state) => {
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', doName);
    state.storage.kv.put('app_subject', String(appSubjectFor(doName)));
    state.storage.kv.put('timezone', 'UTC');
    state.storage.kv.put('timezone_confirmed', true);
    await state.storage.put('origin', 'https://fixture.invalid');
    await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only', scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
    const owner = new OwnerDO(state, config as never) as unknown as Owner;
    await owner.setup('app').ready;
    const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
    await applyDayPlan(scheduler, dayPlanBook(state.storage.sql), 'UTC', Date.now(), [{ card: 'card:brief', time: '08:00', reason: 'model plan' }], false);
    // An upload at `at` (UTC), then the recompute it asked for, as the alarm runs it a window later.
    const night = async (at: string) => {
      vi.setSystemTime(Date.parse(`${TODAY}T${at}:00Z`));
      await notifyOwnerHealthSamples({ idFromName: (name: string) => name as never, get: () => ({ fetch: (request: Request) => owner.fetch(request) }) }, SECRET, doName);
      vi.setSystemTime(Date.now() + HEALTH_RECOMPUTE_WINDOW_MS);
      await armAlarm(state.storage, Date.now()); await state.storage.deleteAlarm(); state.storage.kv.put('owner_alarm_last_v1', 0);
      await owner.alarm();
    };
    const wakeNotes = () => state.storage.sql.exec<{ note: string | null }>("SELECT note FROM trace_log WHERE hop = 'day_plan' AND trace LIKE 'night-recorded:%'").toArray().map(row => String(row.note));
    let sweeps = 0;
    // The ten-minute sweep's update check, as the schedule runs it; the reader job a sweep leaves open is settled first.
    const sweep = async () => {
      const jobs = jobBook(state.storage.sql, { now: Date.now, newId: () => crypto.randomUUID(), newToken: () => crypto.randomUUID() });
      const open = jobs.openMachine('update_sweep', 'owner');
      if (open) jobs.cancel(open.id, 'owner');
      await owner.setup('app').updateCheck(`update:${sweeps++}:${Date.now()}`);
    };
    try { await work({ state, due: () => scheduler.read('card:brief')?.due_at, night, sweep, wakeNotes }); } finally { await state.storage.deleteAlarm(); }
  });
};

describe('the wake Brief', () => {
  it('golden: the night is in at 07:05, the wake turn sends the Brief now, and 06:52 is nowhere in the owner object', async () => {
    await withOwner(async ({ state, due, night, wakeNotes }) => {
      await night('07:05');
      const woke = Date.now();
      await vi.waitFor(() => expect(due()).toBeLessThan(Date.parse(`${TODAY}T08:00:00Z`)));
      expect(due()! - woke).toBeGreaterThanOrEqual(0);
      expect(due()! - woke).toBeLessThan(60_000);
      expect(world.wakes).toHaveLength(1);
      expect(world.wakes[0]).toContain('planned for 08:00 at the latest');
      expect(world.wakes[0]).toContain('Tuesday');
      expect(world.wakes[0]).not.toContain(NIGHT_END);
      expect(world.writes.find(row => row.day === TODAY)?.night_ref).toMatch(/^[0-9a-f]{64}$/);
      expect(dayPlanBook(state.storage.sql).read(TODAY).find(row => row.card === 'card:brief')).toMatchObject({ reason: 'up for the day', state: 'pending' });
      expect(wakeNotes()).toEqual(['1 planned']);
      const stored = dump(state);
      expect(stored).not.toContain(NIGHT_END);
      expect(stored).not.toContain(`${TODAY}T06:52`);
      expect(stored).not.toContain(String(world.writes.find(row => row.day === TODAY)?.night_ref));
    });
  });

  it('a wake the model keeps leaves the latest-by; a later night that changed asks again; one sent is not asked about again', async () => {
    await withOwner(async ({ due, night, wakeNotes }) => {
      world.nightEnd = '03:00';
      world.wakeReply = JSON.stringify({ cards: [{ id: 'card:brief', time: '08:00', reason: 'awake in the night' }] });
      await night('03:10');
      await vi.waitFor(() => expect(world.wakes).toHaveLength(1));
      await vi.waitFor(() => expect(wakeNotes()).toHaveLength(1));
      expect(due()).toBe(Date.parse(`${TODAY}T08:00:00Z`));
      // The same night again is no change, so no turn.
      await night('03:40');
      expect(world.wakes).toHaveLength(1);
      world.nightEnd = '07:00';
      world.wakeReply = JSON.stringify({ cards: [{ id: 'card:brief', time: 'now', reason: 'up for the day' }] });
      await night('07:10');
      await vi.waitFor(() => expect(due()).toBeLessThan(Date.parse(`${TODAY}T07:12:00Z`)));
      expect(world.wakes).toHaveLength(2);
      world.nightEnd = '07:20';
      await night('07:30');
      await vi.waitFor(() => expect(wakeNotes()).toContain('nothing_to_move'));
      expect(world.wakes).toHaveLength(2);
    });
  });

  it('never moves the Brief later than its latest-by', async () => {
    await withOwner(async ({ due, night, wakeNotes }) => {
      world.wakeReply = JSON.stringify({ cards: [{ id: 'card:brief', time: '09:30', reason: 'let them settle' }] });
      await night('07:05');
      await vi.waitFor(() => expect(wakeNotes()).toEqual(['kept']));
      expect(due()).toBe(Date.parse(`${TODAY}T08:00:00Z`));
    });
  });

  it('a calendar re-plan and a wake in one morning each get their own turn; only the wake\'s prompt says the night is in', async () => {
    await withOwner(async ({ due, night, sweep }) => {
      vi.setSystemTime(Date.parse(`${TODAY}T06:50:00Z`));
      await sweep();
      const call = { id: 'e-call', title: 'Call with Asha', status: 'confirmed', start: `${TODAY}T09:30:00Z`, end: `${TODAY}T10:00:00Z`, all_day: false };
      world.listed = [call];
      world.changed = [{ ...call, created: `${TODAY}T06:55:00Z` }];
      vi.setSystemTime(Date.parse(`${TODAY}T07:00:00Z`));
      await sweep();
      await night('07:05');
      await vi.waitFor(() => expect(due()).toBeLessThan(Date.parse(`${TODAY}T08:00:00Z`)));
      await vi.waitFor(() => expect(world.replans).toHaveLength(1));
      expect(world.wakes).toHaveLength(1);
      expect(world.replans[0]).not.toContain('night is in');
    });
  });
});

describe('the wake Brief\'s gates', () => {
  // A night the producer reports leaves one code on the owner's trace saying which gate it met; it never carries a time.
  const gateNotes = (state: DurableObjectState) => state.storage.sql.exec<{ note: string | null }>("SELECT note FROM trace_log WHERE hop = 'night_recorded'").toArray().map(row => String(row.note));
  const preference = (state: DurableObjectState, kind: string, enabled: boolean) =>
    state.storage.sql.exec('INSERT INTO schedule_preferences (kind, enabled) VALUES (?, ?) ON CONFLICT (kind) DO UPDATE SET enabled = excluded.enabled', kind, enabled ? 1 : 0);

  it('with WAKE_BRIEF off, or without the day state, no row carries the digest and no night is reported', async () => {
    for (const config of [{ ...CONFIG, WAKE_BRIEF: '0' }, { ...CONFIG, WALDO_DAY_STATE: '0' }]) {
      world.writes = [];
      await withOwner(async ({ state, due, night }) => {
        await night('07:05');
        expect(world.writes.some(row => row.day === TODAY)).toBe(true);
        expect(world.writes.some(row => 'night_ref' in row)).toBe(false);
        expect(gateNotes(state)).toEqual([]);
        expect(due()).toBe(Date.parse(`${TODAY}T08:00:00Z`));
      }, config);
    }
    expect(world.wakes).toEqual([]);
  });

  it('with model-use consent withdrawn the night wakes nothing', async () => {
    await withOwner(async ({ state, due, night }) => {
      world.consent = false;
      await night('07:05');
      expect(gateNotes(state)).toEqual(['no_consent']);
      expect(due()).toBe(Date.parse(`${TODAY}T08:00:00Z`));
    });
    expect(world.wakes).toEqual([]);
  });

  it('with the daily Brief off the night wakes nothing', async () => {
    await withOwner(async ({ state, night }) => {
      preference(state, 'daily_brief', false);
      await night('07:05');
      expect(gateNotes(state)).toEqual(['brief_off']);
    });
    expect(world.wakes).toEqual([]);
  });

  it('with health proposals off and the Brief on the wake still works', async () => {
    await withOwner(async ({ state, due, night }) => {
      preference(state, 'health_proposals', false);
      await night('07:05');
      expect(gateNotes(state)).toEqual(['woke']);
      await vi.waitFor(() => expect(due()).toBeLessThan(Date.parse(`${TODAY}T08:00:00Z`)));
    });
  });

  it('a night that comes in past local midday wakes nothing', async () => {
    await withOwner(async ({ night, wakeNotes, state }) => {
      await applyDayPlan(new Scheduler(state.storage.sql, state.storage, productionDeps()), dayPlanBook(state.storage.sql), 'UTC', Date.parse(`${TODAY}T07:00:00Z`),
        [{ card: 'card:brief', time: '13:00', reason: 'model plan' }], false);
      await night('12:10');
      await vi.waitFor(() => expect(wakeNotes()).toEqual(['past_fresh']));
    });
    expect(world.wakes).toEqual([]);
  });
});

describe('the nightly plan in wake mode', () => {
  // The boot plan, as an owner whose surface runs their scheduled work sees it.
  const boot = (config: Record<string, unknown>) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`wake-brief-plan-${sequence++}`)), async (_i, state) => {
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', 'wake-brief-plan'); state.storage.kv.put('telegram_subject', '7');
    await state.storage.put('origin', 'https://fixture.invalid');
    await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only', scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
    const owner = new OwnerDO(state, { ...config, WALDO_OWNER_TELEGRAM_ID: '7' } as never) as unknown as Owner;
    await owner.setup('telegram').ready;
    try { await vi.waitFor(() => expect(world.planModes.length).toBeGreaterThan(0)); } finally { await state.storage.deleteAlarm(); }
  });

  it('plans the Brief as its latest-by with WAKE_BRIEF on, and as before with it off or without the day state', async () => {
    await boot(CONFIG);
    expect(world.planModes).toEqual([true]);
    world.planModes = [];
    await boot({ ...CONFIG, WAKE_BRIEF: '0' });
    expect(world.planModes).toEqual([false]);
    world.planModes = [];
    await boot({ ...CONFIG, WALDO_DAY_STATE: '0' });
    expect(world.planModes).toEqual([false]);
  });
});
