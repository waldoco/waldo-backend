import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { applyDayPlan, dayPlanBook, MOVED_EARLIER } from '../src/channels/day-cards';
import { HEALTH_RECOMPUTE_WINDOW_MS } from '../src/health/recompute';
import { armAlarm } from '../src/scheduler/alarm-slot';
import { notifyOwnerHealthSamples } from '../src/health/zone-change-route';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';

// The wake Brief on the real owner object (WAKE_BRIEF): the Worker or a WHOOP sync says only that a night just ended, and a
// Brief still to come gets one model turn on its own queue: now, earlier, or keep. Never later. The night's own times never
// reach the owner object or the model, and nothing the owner object keeps or logs is labelled a wake: the wake turn's rows read as
// a day re-plan, so their times say nothing of when the owner woke. Google, the health plane and the model are fakes; nothing
// here is a real reading.
const SECRET = 'router-secret-fixture-0000000000';
const OWNER_ID = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
const TODAY = '2026-10-20';
const at = (hhmm: string) => Date.parse(`${TODAY}T${hhmm}:00Z`);

// rows: the owner's stored derived rows by day. night: the series read holds a night with sleep and an overnight signal, so the
// recompute can score today's Recovery. contextFails: the model-use read errors. recoveryAtWake: whether today's stored row held
// a Recovery when each wake turn was asked.
const world = vi.hoisted(() => ({ consent: true, wakes: [] as string[], replans: [] as string[], wakeReply: '', wakeFails: false,
  rows: new Map<string, Record<string, unknown>>(), requests: [] as string[], night: true, contextFails: false, seriesFails: false, recoveryAtWake: [] as boolean[] }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (_app: unknown, _tokens: unknown, _fetch: unknown, _health: unknown, account: unknown) => ({
    account, events: async () => [], event: async () => null, newMail: async () => [], changedEvents: async () => [],
    calendarPage: async () => ({ events: [], next_page_token: null, fetched_count: 0, account, observed_at: new Date().toISOString() }),
  }) };
});
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async () => true }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    const content = String(request.request.messages.at(-1)?.content ?? '');
    world.requests.push(JSON.stringify(request.request));
    const wake = content.includes('a night that just ended');
    if (wake) { world.wakes.push(content); world.recoveryAtWake.push(typeof (world.rows.get('2026-10-20')?.recovery as { zone?: unknown } | undefined)?.zone === 'string'); }
    if (wake && world.wakeFails) return { ok: false as const, code: 'rejected' as const, error: 'synthetic refusal' };
    const text = wake ? world.wakeReply : content.includes('calendar just changed') ? (world.replans.push(content), JSON.stringify({ cards: [] })) : 'SKIP';
    return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const CONFIG = { ...env, WALDO_OWNER_TELEGRAM_ID: undefined, WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture',
  GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret', WALDO_ROUTER_HMAC_SECRET: SECRET, SUPABASE_PROJECT_URL: 'https://edge.test',
  SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WAKE_BRIEF: '1', CALENDAR_GROUNDED_PREP: '0' };
const reply = (time: string) => JSON.stringify({ cards: [{ id: 'card:brief', time, reason: 'model reason' }] });

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
// Twenty-five nights ending today, as the series read returns them for an owner who wears a watch; synthetic values.
const nights = (to: string) => ({
  access: 'granted', read_at: new Date().toISOString(),
  sources: [{ source: 'apple', consent_epoch: 1, truncated: false, samples: Array.from({ length: 25 }, (_, i) => {
    const day = addDays(to, -i), start_at = `${addDays(day, -1)}T22:00:00.000Z`, end_at = `${day}T06:00:00.000Z`;
    return [
      { signal: 'sleep_duration', day, start_at, end_at, timezone: 'UTC', value: 440 + (i % 5) * 6, method: 'asleep_duration' },
      { signal: 'sleep_midpoint', day, start_at, end_at, timezone: 'UTC', value: 180 + (i % 3) * 7 },
      { signal: 'overnight_hrv', day, start_at, end_at, timezone: 'UTC', value: 52 + (i % 4) * 3, method: 'rmssd' },
      { signal: 'resting_heart_rate', day, start_at: `${day}T03:00:00.000Z`, end_at: `${day}T04:00:00.000Z`, timezone: 'UTC', value: 55 + (i % 2) },
    ];
  }).flat() }],
});
// What the owner's store held at 07:05, before the night's upload was computed: today's row from the calendar alone.
const unscoredToday = () => ({ recovery: { reason: 'missing_sleep' }, form: { reason: 'missing_sleep' }, weight: { score: 40, zone: 'moderate', algorithm_version: 'weight.v1' } });

let sequence = 0;
beforeEach(() => {
  world.consent = true; world.wakes = []; world.replans = []; world.wakeReply = reply('now'); world.wakeFails = false;
  world.rows = new Map([[TODAY, unscoredToday()]]); world.night = true; world.contextFails = false; world.seriesFails = false; world.recoveryAtWake = []; world.requests = [];
  vi.useFakeTimers({ toFake: ['Date'], now: at('07:05') });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, string | number> : {};
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: body.p_do_name, state_version: 1, admission_revision: '5' });
    const payload = typeof body.p_payload === 'string' ? JSON.parse(body.p_payload) as Record<string, unknown> : {};
    if (fn === 'health_series_read') {
      if (world.seriesFails) return new Response('synthetic outage', { status: 500 });
      return Response.json(world.night ? nights(String(payload.to)) : { access: 'granted', read_at: new Date().toISOString(), sources: [] });
    }
    if (fn === 'health_context_write') { world.rows.set(String(payload.day), { recovery: payload.recovery, form: payload.form, weight: payload.weight }); return Response.json({ written: true, changed: [] }); }
    if (fn === 'health_scores_read') {
      const row = world.rows.get(String(payload.day));
      return Response.json(row ? { scores: { day: String(payload.day), timezone: 'UTC', compiled_at: new Date().toISOString(), freshness: 'fresh', ...row } } : { unavailable: 'no_readings' });
    }
    if (fn === 'health_scores_history') return Response.json({ unavailable: 'no_readings' });
    if (fn === 'health_settings_read') return Response.json({ sleep_need_minutes: null, updated_at: null });
    // The model-use consented read: with that consent withdrawn it returns nothing.
    if (fn === 'health_context_read') {
      if (world.contextFails) return new Response('synthetic outage', { status: 500 });
      const day = [...world.rows.keys()].sort().at(-1), row = day ? world.rows.get(day) : undefined;
      return Response.json(world.consent && day && row ? { context: { id: `ctx-${day}`, day, ...row, drivers: [], confidence: 0.8, freshness: 'fresh', tags: [], compiled_at: new Date().toISOString(), basis: [{ source: 'apple', consent_epoch: 1 }] }, previous: null } : null);
    }
    if (fn === 'assert_channel_presence') return Response.json(false);
    return fn ? Response.json(true) : new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

type Owner = { fetch(request: Request): Promise<Response>; alarm(): Promise<void>; setup(channel: string): { ready: Promise<unknown> }; serial(work: () => Promise<void>): Promise<void> };
type Desk = Readonly<{ state: DurableObjectState; due(): number | undefined; notice(hhmm: string, woke?: boolean): Promise<void>; upload(hhmm: string, woke?: boolean): Promise<void>; recompute(): Promise<void> }>;
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
    // The Worker's signed notice at `hhmm`, as an app upload or a WHOOP sync sends it; it returns once the wake turn it queued ran.
    const upload = async (hhmm: string, woke = true) => {
      vi.setSystemTime(at(hhmm));
      await notifyOwnerHealthSamples({ idFromName: (name: string) => name as never, get: () => ({ fetch: (request: Request) => owner.fetch(request) }) }, SECRET, doName, 'readings', woke);
      await owner.serial(async () => undefined);
    };
    // The recompute window the upload armed, run through the real scheduler, and the wake turn it may queue.
    const recompute = async () => {
      vi.setSystemTime(Date.now() + HEALTH_RECOMPUTE_WINDOW_MS);
      await armAlarm(state.storage, Date.now()); await state.storage.deleteAlarm(); state.storage.kv.put('owner_alarm_last_v1', 0);
      await owner.alarm();
      await owner.serial(async () => undefined);
    };
    // The upload and the recompute it arms: the night's readings reach the owner, are scored, and the wake may follow.
    const notice = async (hhmm: string, woke = true) => { await upload(hhmm, woke); await recompute(); };
    try {
      await work({ state, due: () => scheduler.read('card:brief')?.due_at, notice, upload, recompute });
      // Every path, a failure included: no row the owner object keeps or logs says wake.
      expect(state.storage.sql.exec<{ trace: string; hop: string }>('SELECT trace, hop FROM trace_log').toArray().filter(row => /wake|woke/i.test(`${row.trace} ${row.hop}`))).toEqual([]);
      expect(dump(state)).not.toMatch(/"woke":true|the owner is up/);
    } finally { await state.storage.deleteAlarm(); }
  });
};
// The plan's row for today's Brief: its time and why it moved, whether or not the Brief has already been sent from it.
const brief = (state: DurableObjectState) => dayPlanBook(state.storage.sql).read(TODAY).find(row => row.card === 'card:brief');
const dump = (state: DurableObjectState) => JSON.stringify([
  state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray().map(({ name }) => [name, state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray()]),
  [...state.storage.kv.list()],
]);

describe('the wake Brief', () => {
  it('golden: a night just ended at 07:05, the model sends the Brief now, and the owner\'s day opens with it', async () => {
    await withOwner(async ({ state, notice }) => {
      await notice('07:05');
      expect(world.wakes).toHaveLength(1);
      expect(world.wakes[0]).toContain('planned 08:00');
      expect(world.wakes[0]).toContain('Tuesday');
      // The plan row says the Brief moved earlier, never why. The wake came after the recompute that scored the night.
      expect(brief(state)).toMatchObject({ time: '07:06', reason: MOVED_EARLIER });
      expect(world.recoveryAtWake).toEqual([true]);
    });
  });

  it('a wake the model keeps, or would move later, leaves the planned time; one already moved is not asked about again', async () => {
    await withOwner(async ({ state, notice }) => {
      world.wakeReply = reply('08:00');
      await notice('03:10');
      expect([world.wakes.length, brief(state)?.time]).toEqual([1, '08:00']);
      world.wakeReply = reply('09:30');
      await notice('05:00');
      expect([world.wakes.length, brief(state)?.time]).toEqual([2, '08:00']);
      world.wakeReply = reply('07:30');
      await notice('07:05');
      expect([world.wakes.length, brief(state)?.time]).toEqual([3, '07:30']);
      world.wakeReply = reply('now');
      await notice('07:40');
      expect([world.wakes.length, brief(state)?.time]).toEqual([3, '07:30']);
    });
  });

  it('stops asking the model past the deployment\'s turns a day', async () => {
    await withOwner(async ({ state, notice }) => {
      world.wakeReply = reply('08:00');
      await notice('03:10');
      await notice('04:10');
      expect(world.wakes).toHaveLength(1);
      expect(brief(state)?.time).toBe('08:00');
    }, { ...CONFIG, WAKE_BRIEF_TURNS_PER_DAY: '1' });
  });
});

// A wake that comes before the recompute that reads the night's upload would send the Brief on the row from before it: the
// phone's calendar-only row today, or yesterday's. The wake waits for the recompute that started after the upload.
describe('the wake Brief waits for the night to be scored', () => {
  it('an upload alone asks no model turn and moves nothing; the recompute that scores the night does', async () => {
    await withOwner(async ({ state, upload, recompute }) => {
      await upload('07:05');
      expect(world.wakes).toEqual([]);
      expect(brief(state)).toMatchObject({ time: '08:00', state: 'pending' });
      expect(brief(state)?.reason).not.toBe(MOVED_EARLIER);
      await recompute();
      expect(world.wakes).toHaveLength(1);
      expect(world.recoveryAtWake).toEqual([true]);
      expect(brief(state)).toMatchObject({ time: '07:06', reason: MOVED_EARLIER });
      // The Brief that goes out at that time is written from the scored row, not the one from before the upload.
      await recompute();
      const written = world.requests.at(-1)!;
      expect(world.requests).toHaveLength(2);
      expect(written).toMatch(/Form zone|Recovery zone/);
      expect(written).not.toMatch(/Partial health context|No derived health context/);
    });
  });

  it('a recompute that leaves today without a Recovery asks nothing and leaves the Brief at its time', async () => {
    await withOwner(async ({ state, notice }) => {
      world.night = false;
      await notice('07:05');
      expect(world.wakes).toEqual([]);
      expect(brief(state)).toMatchObject({ time: '08:00', state: 'pending' });
    });
  });

  it('one wake per upload: a later recompute with no new upload asks nothing more', async () => {
    await withOwner(async ({ state, notice, recompute }) => {
      world.wakeReply = reply('08:00');
      await notice('07:05');
      expect(world.wakes).toHaveLength(1);
      await recompute();
      await recompute();
      expect(world.wakes).toHaveLength(1);
      expect(brief(state)?.time).toBe('08:00');
    });
  });

  it('an upload with no night in it, a note too old, or none at all: the recompute wakes nothing', async () => {
    await withOwner(async ({ notice, upload, recompute }) => {
      await notice('07:05', false);
      expect(world.wakes).toEqual([]);
      await upload('07:07');
      await recompute();
      expect(world.wakes).toHaveLength(1);
    });
    world.wakes = [];
    await withOwner(async ({ state, upload, recompute }) => {
      // A Brief planned for the evening is still to come when the recompute finally runs.
      await applyDayPlan(new Scheduler(state.storage.sql, state.storage, productionDeps()), dayPlanBook(state.storage.sql), 'UTC', at('06:00'), [{ card: 'card:brief', time: '20:00', reason: 'model plan' }], false);
      await upload('07:05');
      // The recompute is not run until the note is older than a night's end can be.
      vi.setSystemTime(at('07:05') + 4 * 3_600_000);
      await recompute();
      expect(world.wakes).toEqual([]);
      expect(brief(state)).toMatchObject({ time: '20:00', state: 'pending' });
    });
  });

  it('a recompute that fails keeps the wake for the next one, which asks once', async () => {
    await withOwner(async ({ state, upload, recompute }) => {
      await upload('07:05');
      world.seriesFails = true;
      await recompute().catch(() => undefined);
      expect(world.wakes).toEqual([]);
      world.seriesFails = false;
      await recompute();
      await recompute();
      expect(world.wakes).toHaveLength(1);
      expect(brief(state)?.reason).toBe(MOVED_EARLIER);
    });
  });
});

describe('the wake Brief falls back to the planned time', () => {
  const preference = (state: DurableObjectState, kind: string, enabled: boolean) =>
    state.storage.sql.exec('INSERT INTO schedule_preferences (kind, enabled) VALUES (?, ?) ON CONFLICT (kind) DO UPDATE SET enabled = excluded.enabled', kind, enabled ? 1 : 0);

  it('with model-use health consent withdrawn after the upload', async () => {
    await withOwner(async ({ state, notice }) => {
      world.consent = false;
      await notice('07:05');
      expect(brief(state)?.time).toBe('08:00');
    });
    expect(world.wakes).toEqual([]);
  });

  it('with no row for the model to read (nothing shared): the recompute ends and nothing is asked', async () => {
    await withOwner(async ({ state, notice }) => {
      world.rows.clear();
      world.consent = false;
      await notice('07:05');
      expect(brief(state)?.time).toBe('08:00');
    });
    expect(world.wakes).toEqual([]);
  });

  it('with the health read failing after the recompute: the Brief keeps its time, nothing is asked, and the recompute does not fail', async () => {
    await withOwner(async ({ state, upload, recompute }) => {
      await upload('07:05');
      world.contextFails = true;
      await recompute();
      expect(brief(state)?.time).toBe('08:00');
      expect(state.storage.sql.exec<{ ok: number }>("SELECT ok FROM trace_log WHERE hop = 'health_recompute'").toArray().map(row => row.ok)).toEqual([1]);
    });
    expect(world.wakes).toEqual([]);
  });

  it('with no night in the readings (no wearable, nothing shared): the notice carries no wake', async () => {
    await withOwner(async ({ due, notice }) => {
      await notice('07:05', false);
      expect(due()).toBe(at('08:00'));
    });
    expect(world.wakes).toEqual([]);
  });

  it('with the daily Brief off', async () => {
    await withOwner(async ({ state, notice }) => {
      preference(state, 'daily_brief', false);
      await notice('07:05');
    });
    expect(world.wakes).toEqual([]);
  });

  it('with WAKE_BRIEF off, a wake notice changes nothing', async () => {
    await withOwner(async ({ due, notice }) => {
      await notice('07:05');
      expect(due()).toBe(at('08:00'));
    }, { ...CONFIG, WAKE_BRIEF: '0' });
    expect(world.wakes).toEqual([]);
  });

  it('with a Brief already due when the night comes in: it runs as planned, asking nothing', async () => {
    await withOwner(async ({ state, notice }) => {
      await applyDayPlan(new Scheduler(state.storage.sql, state.storage, productionDeps()), dayPlanBook(state.storage.sql), 'UTC', at('06:00'), [{ card: 'card:brief', time: '07:00', reason: 'model plan' }], false);
      await notice('07:05');
      expect(brief(state)?.time).toBe('07:00');
    });
    expect(world.wakes).toEqual([]);
  });

  it('when the model call fails: the Brief keeps its time, and the failure is logged as a day re-plan\'s, with no wake in it', async () => {
    await withOwner(async ({ state, due, notice }) => {
      world.wakeFails = true;
      await notice('07:05');
      expect([world.wakes.length, due()]).toEqual([1, at('08:00')]);
      const failed = state.storage.sql.exec<{ trace: string; ok: number }>("SELECT trace, ok FROM trace_log WHERE hop = 'day_plan'").toArray();
      expect(failed).toEqual([{ trace: expect.stringMatching(/^day-plan:[0-9a-f-]{36}$/), ok: 0 }]);
    });
  });
});
