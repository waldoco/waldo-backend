import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarItem } from '../src/connectors/google';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { HEALTH_RECOMPUTE_WINDOW_MS } from '../src/health/recompute';
import { HEALTH_TRIGGER_ID } from '../src/health/trigger';
import { notifyOwnerHealthSamples } from '../src/health/zone-change-route';
import { armAlarm } from '../src/scheduler/alarm-slot';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';

// An upload on the real owner object: the recompute writes the rows, the wake check reads them back, and the one trigger
// path decides with the model whether a card goes up. The database, Google and the model are fakes. The plane keeps what
// the writer was given, with the day's sleep debt and drivers set by the test, so each case names what the rows say.
const SECRET = 'router-secret-fixture-0000000000';
const OWNER_ID = '5b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
const NOW = Date.parse('2026-10-21T08:00:00Z'); // 13:30 in Kolkata
const TODAY = '2026-10-21';
const LEAKS = ['183.5', '91.5', '41.5', '63.5'];
const REVIEW: CalendarItem = { id: 'gcal-review-1', title: 'Quarterly board review', status: 'confirmed', start: '2026-10-21T17:00:00+05:30', end: '2026-10-21T18:30:00+05:30', all_day: false, etag: 'r1' };
const SENTENCE = 'Sleep debt has been building over the last few days.';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const plane = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(), debt: new Map<string, number>(), drivers: new Map<string, string[]>(), consent: true,
  event: null as unknown, requests: [] as LLMGatewayRequest[], decision: '' as string,
}));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (_app: unknown, _tokens: unknown, _fetch: unknown, _health: unknown, account: unknown) => ({
    account, events: async () => (plane.event ? [plane.event] : []),
    calendarPage: async () => ({ events: plane.event ? [plane.event] : [], next_page_token: null, fetched_count: 1, account, observed_at: new Date().toISOString() }),
    event: async () => plane.event, changedEvents: async () => [], newMail: async () => [],
  }) };
});
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async () => true }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    plane.requests.push(request);
    const format = request.request.response_format?.name;
    const text = format === 'health_proposal' ? plane.decision : format === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : 'SKIP';
    return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const CONFIG = { ...env, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'Asia/Kolkata', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture',
  GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret', WALDO_ROUTER_HMAC_SECRET: SECRET, SUPABASE_PROJECT_URL: 'https://edge.test', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable' };
const move = JSON.stringify({ kind: 'propose', action: 'move', item: 'e1', start: '2026-10-21T19:00', end: '2026-10-21T20:30', title: null, block: null, notify_guests: false, reason: 'A later slot gives you a slower afternoon.' });

const series = (to: string) => ({
  access: 'granted', read_at: new Date().toISOString(),
  sources: [{ source: 'apple', consent_epoch: 1, truncated: false, samples: Array.from({ length: 25 }, (_, i) => {
    const day = addDays(to, -i), start_at = `${addDays(day, -1)}T17:30:00.000Z`, end_at = `${day}T01:30:00.000Z`;
    return [
      { signal: 'sleep_duration', day, start_at, end_at, timezone: 'Asia/Kolkata', value: 440 + (i % 5) * 6, method: 'asleep_duration' },
      { signal: 'sleep_midpoint', day, start_at, end_at, timezone: 'Asia/Kolkata', value: 180 + (i % 3) * 7 },
      { signal: 'overnight_hrv', day, start_at, end_at, timezone: 'Asia/Kolkata', value: 52 + (i % 4) * 3, method: 'rmssd' },
      { signal: 'resting_heart_rate', day, start_at: `${day}T03:00:00.000Z`, end_at: `${day}T04:00:00.000Z`, timezone: 'Asia/Kolkata', value: 55 + (i % 2) },
    ];
  }).flat() }],
});
const pillar = { score: 60, zone: 'good', algorithm_version: 'recovery.candidate.v1', activation: 'candidate_unaccepted' };
const debtOf = (minutes: number) => ({ state: 'available', debt_minutes: minutes, need_basis: 'own_average', algorithm_version: 'sleep-debt.v1', activation: 'candidate_unaccepted' });
// Four days of stored debt, newest first: building today, and not already building the day before.
const building = (today: number, ...earlier: number[]) => { [today, ...earlier].forEach((minutes, i) => plane.debt.set(addDays(TODAY, -i), minutes)); };

let sequence = 0;
const printed: string[] = [];
beforeEach(() => {
  plane.rows.clear(); plane.debt.clear(); plane.drivers.clear(); plane.consent = true; plane.event = REVIEW; plane.requests = []; printed.length = 0;
  plane.decision = move;
  for (const day of [-3, -2]) plane.rows.set(addDays(TODAY, day), { recovery: pillar, form: pillar, weight: { reason: 'calendar_demand_unavailable' } });
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  for (const method of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { printed.push(args.map(String).join(' ')); });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, string | number> : {};
    const payload = typeof body.p_payload === 'string' ? JSON.parse(body.p_payload) as Record<string, unknown> : {};
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: body.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'health_series_read') return Response.json(series(String(payload.to)));
    if (fn === 'health_context_write') {
      const day = String(payload.day);
      plane.rows.set(day, { recovery: payload.recovery, form: payload.form, weight: payload.weight });
      return Response.json({ written: true, changed: [] });
    }
    if (fn === 'health_scores_read') {
      const day = String(payload.day), row = plane.rows.get(day), debt = plane.debt.get(day);
      return Response.json(row ? { scores: { day, timezone: 'Asia/Kolkata', compiled_at: new Date().toISOString(), freshness: 'fresh', ...row, ...(debt === undefined ? {} : { sleep_debt: debtOf(debt) }) } } : { unavailable: 'no_readings' });
    }
    if (fn === 'health_context_read') {
      const day = [...plane.rows.keys()].sort().at(-1), row = day ? plane.rows.get(day) : undefined;
      return Response.json(plane.consent && day && row ? { context: { id: day, day, ...row, drivers: plane.drivers.get(day) ?? [], confidence: 0.8, freshness: 'fresh', tags: [], compiled_at: new Date().toISOString(), basis: [{ source: 'apple', consent_epoch: 1 }] }, previous: null } : null);
    }
    if (fn === 'assert_channel_presence' || fn === 'set_owner_settings') return Response.json(true);
    return fn ? Response.json(null) : new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

const dump = (state: DurableObjectState) => JSON.stringify([
  state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray().map(({ name }) => [name, state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray()]),
  [...state.storage.kv.list()],
]);
type Owner = { fetch(request: Request): Promise<Response>; alarm(): Promise<void> };
const withOwner = (work: (o: { state: DurableObjectState; upload(): Promise<void>; pass(): Promise<void>; recompute(): Promise<void> }) => Promise<void>) => {
  const doName = `health-wakes-do-${sequence++}`;
  return runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(doName)), async (_i, state) => {
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', doName); state.storage.kv.put('telegram_subject', '7');
    await state.storage.put('origin', 'https://fixture.invalid');
    await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only', scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
    const owner = new OwnerDO(state, CONFIG as never) as unknown as Owner;
    const upload = () => notifyOwnerHealthSamples({ idFromName: (name: string) => name as never, get: () => ({ fetch: (request: Request) => owner.fetch(request) }) }, SECRET, doName);
    const pass = async () => { await armAlarm(state.storage, Date.now()); await state.storage.deleteAlarm(); state.storage.kv.put('owner_alarm_last_v1', 0); await owner.alarm(); };
    // One upload and the recompute window it arms, run through the real scheduler.
    const recompute = async () => { await upload(); vi.setSystemTime(Date.now() + HEALTH_RECOMPUTE_WINDOW_MS); await pass(); };
    try { await work({ state, upload, pass, recompute }); } finally { await state.storage.deleteAlarm(); }
  });
};
const evaluations = () => plane.requests.filter(r => r.request.response_format?.name === 'health_proposal');
const runs = (state: DurableObjectState) => state.storage.sql.exec<{ local_day: string; outcome: string; approval_id: string | null }>('SELECT local_day, outcome, approval_id FROM health_trigger_runs').toArray();
const wakes = (state: DurableObjectState) => state.storage.sql.exec<{ day: string; reason: string; taken: number }>('SELECT day, reason, taken FROM health_trigger_wakes ORDER BY reason').toArray();
const triggerEntry = (state: DurableObjectState) => state.storage.sql.exec('SELECT kind FROM schedule WHERE id = ?', HEALTH_TRIGGER_ID).toArray();

describe('a wake beyond a zone change, on the owner object', () => {
  it('turns sleep debt building into one evaluation and one approval card, in words with no figure', async () => {
    building(183.5, 91.5, 41.5, 63.5);
    await withOwner(async ({ state, pass, recompute }) => {
      await recompute();
      expect(wakes(state)).toEqual([{ day: TODAY, reason: 'sleep_debt_building', taken: 0 }]);
      expect(triggerEntry(state)).toHaveLength(1);
      await pass();
      expect(evaluations()).toHaveLength(1);
      const sent = JSON.stringify(evaluations()[0]!.request);
      expect(sent).toContain(SENTENCE);
      expect(sent).toContain('Quarterly board review');
      expect(runs(state)).toMatchObject([{ local_day: TODAY, outcome: 'proposed' }]);
      expect(runs(state)[0]!.approval_id).toBeTruthy();
      for (const leak of LEAKS) for (const [where, text] of [['the model request', sent], ['tables and storage', dump(state)], ['printed lines', printed.join('\n')]] as const) expect(text, `${leak} in ${where}`).not.toContain(leak);
    });
  });

  it('wakes once for a day however many uploads find the same debt', async () => {
    building(183.5, 91.5, 41.5, 63.5);
    await withOwner(async ({ state, pass, recompute }) => {
      await recompute();
      await pass();
      expect(evaluations()).toHaveLength(1);
      await recompute();
      await recompute();
      expect(triggerEntry(state)).toEqual([]);
      await pass();
      expect(evaluations()).toHaveLength(1);
      expect(wakes(state)).toEqual([{ day: TODAY, reason: 'sleep_debt_building', taken: 1 }]);
    });
  });

  it('wakes nothing when the stored rows show no change', async () => {
    building(91.5, 91.5, 91.5, 91.5);
    await withOwner(async ({ state, pass, recompute }) => {
      await recompute();
      await pass();
      expect([wakes(state), triggerEntry(state), evaluations()]).toEqual([[], [], []]);
    });
  });

  it('wakes nothing once model-use consent is withdrawn, though the rows still say the debt is building', async () => {
    building(183.5, 91.5, 41.5, 63.5);
    plane.consent = false;
    await withOwner(async ({ state, pass, recompute }) => {
      await recompute();
      await pass();
      expect([wakes(state), triggerEntry(state), evaluations()]).toEqual([[], [], []]);
    });
  });

  it('wakes on a driver that appeared since the last row, and shows the model the signals in words', async () => {
    plane.rows.set(addDays(TODAY, -1), { recovery: pillar, form: pillar, weight: { reason: 'calendar_demand_unavailable' } });
    plane.drivers.set(TODAY, ['wrist temperature above usual']);
    await withOwner(async ({ state, pass, recompute }) => {
      await recompute();
      expect(wakes(state)).toEqual([{ day: TODAY, reason: 'driver_appeared', taken: 0 }]);
      await pass();
      expect(JSON.stringify(evaluations()[0]!.request)).toContain('Signals outside the owner\'s usual range now: wrist temperature above usual.');
    });
  });

  it('keeps the owner\'s own off switch: no check and no wake while health proposals are off', async () => {
    building(183.5, 91.5, 41.5, 63.5);
    await withOwner(async ({ state, recompute }) => {
      state.storage.sql.exec('CREATE TABLE IF NOT EXISTS schedule_preferences (kind TEXT PRIMARY KEY, enabled INTEGER NOT NULL)');
      state.storage.sql.exec("INSERT INTO schedule_preferences (kind, enabled) VALUES ('health_proposals', 0)");
      await recompute();
      expect([wakes(state), triggerEntry(state)]).toEqual([[], []]);
      expect(printed.join('\n')).not.toContain(SENTENCE);
    });
  });
});
