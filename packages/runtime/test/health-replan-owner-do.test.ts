import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarChange, CalendarItem, CalendarListItem, FreeBusyResult } from '../src/connectors/google';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { HEALTH_RECOMPUTE_ID, HEALTH_RECOMPUTE_WINDOW_MS } from '../src/health/recompute';
import { HEALTH_TRIGGER_ID } from '../src/health/trigger';
import { notifyOwnerHealthSamples } from '../src/health/zone-change-route';
import { armAlarm } from '../src/scheduler/alarm-slot';
import { jobBook } from '../src/tasks/jobs';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';

// Weight follows the day, end to end on the real owner object: a meeting added to today shows up in the ten-minute
// sweep, which asks for one recompute; the recompute reads today's busy minutes again, Weight moves band, the producer
// reports the zone change, and the health trigger evaluates it once and puts up at most one approval card. Google, the
// health plane and the model are fakes; every reading is synthetic and none may be found where it is not allowed.
const SECRET = 'router-secret-fixture-0000000000';
const OWNER_ID = '7d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a';
const TZ = 'Asia/Kolkata';
const NOW = Date.parse('2026-10-21T04:30:00Z'); // 10:00 in Kolkata
const TODAY = '2026-10-21';
const LEAKS = ['452.25', '61.37', '54.75'];
const AUTH = 'https://www.googleapis.com/auth/';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
// A busy block on a local day, from local hour `at` for `hours`.
const block = (day: string, at: number, hours: number) => ({ start: new Date(Date.parse(`${day}T00:00:00+05:30`) + at * 3_600_000).toISOString(), end: new Date(Date.parse(`${day}T00:00:00+05:30`) + (at + hours) * 3_600_000).toISOString() });
const OFFSITE: CalendarItem = { id: 'gcal-offsite-1', title: 'Partner offsite', start: '2026-10-21T13:00:00+05:30', end: '2026-10-21T19:00:00+05:30', all_day: false, attendees: 4, etag: 'o1' };

const world = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(), trace: [] as string[], requests: [] as LLMGatewayRequest[],
  busy: [] as { start: string; end: string }[], changed: [] as CalendarChange[], events: [] as CalendarItem[],
  access: 'granted', scoresAccess: true, decision: '' as string, latencyMs: 0,
  // How many update records the sweep had saved each time the health row was read.
  recorded: null as null | (() => number), recordedAtRead: [] as number[],
  // The kind of each event Waldo created, as the approval handed it to Google.
  created: [] as string[],
}));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (_app: unknown, _tokens: unknown, _fetch: unknown, _health: unknown, account: unknown) => ({
    account,
    events: async () => world.events,
    calendarPage: async () => ({ events: world.events, next_page_token: null, fetched_count: world.events.length, account, observed_at: new Date().toISOString() }),
    event: async (id: string) => world.events.find(event => event.id === id) ?? null,
    // Waldo's rest blocks as the connector finds them by their private kind, with what else falls inside them.
    restBlocks: async (_calendarId: string, from: string, to: string) => {
      const within = (e: { start: string; end: string }, s: string, t: string) => Date.parse(e.end) > Date.parse(s) && Date.parse(e.start) < Date.parse(t);
      const tagged = world.events as (CalendarItem & { block?: string })[];
      const blocks = tagged.filter(e => e.block === 'rest' && within(e, from, to));
      return { blocks: blocks.map(({ start, end }) => ({ start, end })), others: tagged.filter(e => !blocks.includes(e) && blocks.some(b => within(e, b.start, b.end))).map(({ start, end, all_day }) => ({ start, end, all_day })) };
    },
    // Google as Waldo's own writes leave it: the new event is busy, carries the kind it was tagged with, and is seen as a change.
    createEvent: async (input: { id?: string; title: string; start: string; end: string; block?: 'rest' | 'deep_work' }) => {
      world.created.push(input.block ?? 'none');
      const item = { id: input.id ?? `gcal-new-${world.created.length}`, title: input.title, start: input.start, end: input.end, all_day: false, etag: 'n1', ...(input.block ? { block: input.block } : {}) } as CalendarItem;
      world.events.push(item);
      world.busy.push({ start: new Date(Date.parse(input.start)).toISOString(), end: new Date(Date.parse(input.end)).toISOString() });
      world.changed.push({ ...item, status: 'confirmed', created: new Date().toISOString() });
      return item;
    },
    // Google answers with what changed since the last look, so each change is seen once.
    changedEvents: async () => { world.trace.push('calendar_changes'); const seen = world.changed; world.changed = []; return seen; },
    newMail: async () => [],
    calendarListsPage: async () => ({ items: [{ id: 'primary', title: 'primary', access_role: 'owner', primary: true, selected: true, hidden: false } as CalendarListItem], next_page_token: null, fetched_count: 1, account, observed_at: new Date().toISOString() }),
    freeBusy: async (from: string, to: string, ids: readonly string[]) => {
      world.trace.push('free_busy');
      return { from, to, calendars: Object.fromEntries(ids.map(id => [id, { busy: world.busy.filter(b => Date.parse(b.end) > Date.parse(from) && Date.parse(b.start) < Date.parse(to)) }])) } as FreeBusyResult;
    },
  }) };
});
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async () => true }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    world.requests.push(request);
    const format = request.request.response_format?.name;
    if (format === 'health_proposal') { world.trace.push('health_evaluation'); vi.setSystemTime(Date.now() + world.latencyMs); }
    const text = format === 'health_proposal' ? world.decision : format === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : 'SKIP';
    return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const CONFIG = { ...env, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: TZ, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture',
  GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret', WALDO_ROUTER_HMAC_SECRET: SECRET, SUPABASE_PROJECT_URL: 'https://edge.test', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable' };

// Twenty-five nights from the phone, ending on the last day the read asks for.
const series = (to: string) => ({
  access: world.access, read_at: new Date().toISOString(),
  sources: [{ source: 'apple', consent_epoch: 1, truncated: false, samples: Array.from({ length: 25 }, (_, i) => {
    const day = addDays(to, -i), start_at = `${addDays(day, -1)}T17:30:00.000Z`, end_at = `${day}T01:30:00.000Z`;
    return [
      { signal: 'sleep_duration', day, start_at, end_at, timezone: TZ, value: i === 0 ? 452.25 : 440 + (i % 5) * 6, method: 'asleep_duration' },
      { signal: 'sleep_midpoint', day, start_at, end_at, timezone: TZ, value: 180 + (i % 3) * 7 },
      { signal: 'overnight_hrv', day, start_at, end_at, timezone: TZ, value: i === 0 ? 61.37 : 52 + (i % 4) * 3, method: 'rmssd' },
      { signal: 'resting_heart_rate', day, start_at: `${day}T03:00:00.000Z`, end_at: `${day}T04:00:00.000Z`, timezone: TZ, value: i === 0 ? 54.75 : 55 + (i % 2) },
    ];
  }).flat() }],
});
const newestBefore = (day: string) => [...world.rows.keys()].filter(d => d < day).sort().at(-1);
const pillars = ['recovery', 'form', 'weight'] as const;

let sequence = 0;
const printed: string[] = [];
beforeEach(() => {
  world.rows.clear(); world.trace = []; world.requests = []; world.changed = []; world.events = []; world.access = 'granted'; world.scoresAccess = true; world.latencyMs = 0; world.recorded = null; world.recordedAtRead = []; world.created = []; printed.length = 0;
  // A month of one to two hours of meetings a day, and today's hour at 10:00 so far.
  world.busy = Array.from({ length: 31 }, (_, i) => block(addDays(TODAY, -i), 10, i === 0 ? 1 : 1 + (i % 3) * 0.5));
  world.decision = JSON.stringify({ kind: 'propose', action: 'create', item: null, start: '2026-10-21T11:30', end: '2026-10-21T12:30', title: 'Focus block', notify_guests: null, reason: 'Load is peaking with the offsite; an hour clear before it keeps the day steady.' });
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  for (const method of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { printed.push(args.map(String).join(' ')); });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, string | number> : {};
    const payload = typeof body.p_payload === 'string' ? JSON.parse(body.p_payload) as Record<string, unknown> : {};
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: body.p_do_name, state_version: 1, admission_revision: '5' });
    // A recompute reads the scores' readings and, beside them, the night's vital signals for the drivers.
    if (fn === 'health_series_read') { world.trace.push((payload.signals as string[] | undefined)?.includes('respiratory_rate') ? 'vitals_read' : 'series_read'); return Response.json(series(String(payload.to))); }
    if (fn === 'health_scores_read') {
      const day = String(payload.day), row = world.rows.get(day);
      world.trace.push(`scores_read:${day}`);
      if (world.recorded) world.recordedAtRead.push(world.recorded());
      if (!world.scoresAccess) return Response.json({ unavailable: 'consent_withdrawn' });
      return Response.json(row ? { scores: { day, timezone: TZ, compiled_at: new Date().toISOString(), freshness: 'fresh', ...row } } : { unavailable: 'no_readings' });
    }
    if (fn === 'health_context_write') {
      const row = payload as Record<string, Record<string, unknown>> & { day: string };
      const old = world.rows.get(row.day) ?? world.rows.get(newestBefore(row.day) ?? '');
      const changed = old ? pillars.filter(p => typeof (old[p] as Record<string, unknown> | undefined)?.zone === 'string' && typeof row[p]?.zone === 'string' && (old[p] as Record<string, unknown>).zone !== row[p]!.zone) : [];
      world.rows.set(row.day, { recovery: row.recovery, form: row.form, weight: row.weight, basis: row.basis });
      world.trace.push(`context_write:${row.day}:${changed.join('+') || 'none'}`);
      return Response.json({ written: true, changed });
    }
    if (fn === 'health_context_read') {
      world.trace.push('context_read');
      const today = world.rows.get(TODAY), before = world.rows.get(newestBefore(TODAY) ?? '');
      if (!today) return Response.json({ context: null, previous: null });
      const zone = (pillar: unknown) => (pillar as Record<string, unknown> | undefined)?.zone ?? null;
      return Response.json({
        context: { id: 'ctx-today', day: TODAY, compiled_at: new Date(Date.now() - 60_000).toISOString(), confidence: 0.8, freshness: 'fresh', drivers: [], tags: [], ...today },
        previous: before ? { day: newestBefore(TODAY), form_score: (before.form as Record<string, unknown> | undefined)?.score ?? null, recovery_zone: zone(before.recovery), weight_zone: zone(before.weight), basis: before.basis } : null,
      });
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
type Desk = { propose(args: Record<string, unknown>, turnKey?: string): Promise<string>; decide(id: string, action: 'a', trace: string, via?: { surface: string }): Promise<{ toast: string }> };
type Runtime = { ready: Promise<unknown>; updateCheck(trace: string): Promise<void>; desk: Desk };
type Owner = { fetch(request: Request): Promise<Response>; alarm(): Promise<void>; setup(channel: string): Runtime };
const withOwner = (work: (o: { state: DurableObjectState; sweep(): Promise<void>; pass(): Promise<void>; upload(): Promise<void>; desk(): Desk }) => Promise<void>, google = true) => {
  const doName = `health-replan-do-${sequence++}`;
  let sweeps = 0;
  world.trace = [];
  return runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(doName)), async (_i, state) => {
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', doName); state.storage.kv.put('telegram_subject', '7');
    await state.storage.put('origin', 'https://fixture.invalid');
    if (google) await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only',
      scopes: [`${AUTH}calendar.events`, `${AUTH}calendar.events.freebusy`, `${AUTH}calendar.calendarlist.readonly`] }]);
    const owner = new OwnerDO(state, CONFIG as never) as unknown as Owner;
    world.recorded = () => state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'update_cards'").toArray().length
      ? state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM update_cards').one().n : 0;
    const upload = () => notifyOwnerHealthSamples({ idFromName: (name: string) => name as never, get: () => ({ fetch: (request: Request) => owner.fetch(request) }) }, SECRET, doName);
    const pass = async () => { await armAlarm(state.storage, Date.now()); await state.storage.deleteAlarm(); state.storage.kv.put('owner_alarm_last_v1', 0); await owner.alarm(); };
    // The ten-minute sweep's update check, as the schedule runs it. A sweep's reader job holds the window until it settles,
    // and its worker has reported by the next sweep: the one still open from the last sweep is settled here first.
    const sweep = async () => {
      const jobs = jobBook(state.storage.sql, { now: Date.now, newId: () => crypto.randomUUID(), newToken: () => crypto.randomUUID() });
      const open = jobs.openMachine('update_sweep', 'owner');
      if (open) jobs.cancel(open.id, 'owner');
      const runtime = owner.setup('telegram'); await runtime.ready; await runtime.updateCheck(`update:${sweeps++}:${Date.now()}`);
    };
    try { await work({ state, sweep, pass, upload, desk: () => owner.setup('app').desk }); } finally { await state.storage.deleteAlarm(); }
  });
};
const entry = (state: DurableObjectState, id: string) => state.storage.sql.exec<{ due_at: number }>('SELECT due_at FROM schedule WHERE id = ?', id).toArray()[0] ?? null;
const cards = (state: DurableObjectState) => state.storage.sql.exec<{ kind: string }>("SELECT kind FROM ledger WHERE kind = 'calendar_change'").toArray();
const runs = (state: DurableObjectState) => state.storage.sql.exec<{ mode: string; outcome: string }>('SELECT mode, outcome FROM health_trigger_runs').toArray();
const calendarLogs = () => printed.flatMap(line => { try { const e = JSON.parse(line) as Record<string, unknown>; return e.hop === 'health_calendar_change' ? [{ ok: e.ok, code: e.code }] : []; } catch { return []; } });

// The morning as the phone left it: today's rows from an upload and a light calendar, then the sweep's first look, which
// only notes the time. The trigger state that upload left is cleared, so what follows is the calendar's doing alone.
const morning = async (o: { state: DurableObjectState; sweep(): Promise<void>; pass(): Promise<void>; upload(): Promise<void> }) => {
  await o.upload();
  vi.setSystemTime(NOW + HEALTH_RECOMPUTE_WINDOW_MS);
  await o.pass();
  expect(world.rows.has(TODAY)).toBe(true);
  o.state.storage.sql.exec('DELETE FROM health_trigger_pending');
  o.state.storage.sql.exec('DELETE FROM schedule WHERE id = ?', HEALTH_TRIGGER_ID);
  await o.sweep();
  world.trace = []; world.requests = [];
};
// At 10:10 the owner accepts a six-hour offsite this afternoon, while the morning's read of today's busy minutes is still
// inside its half hour in the cache.
const offsiteAdded = () => {
  vi.setSystemTime(NOW + 10 * 60_000);
  world.events = [OFFSITE];
  world.changed = [{ ...OFFSITE, status: 'confirmed', created: new Date(Date.now() - 60_000).toISOString() }];
  world.busy.push(block(TODAY, 13, 6));
};

describe('Weight follows the day', () => {
  it('turns a meeting added to today into one recompute, a Weight band change, one evaluation and at most one approval card', async () => {
    await withOwner(async o => {
      await morning(o);
      const weightBefore = (world.rows.get(TODAY)!.weight as Record<string, unknown>).zone;
      offsiteAdded();
      world.recordedAtRead = [];
      await o.sweep();
      expect(calendarLogs()).toEqual([{ ok: true, code: 'asked' }]);
      // The sweep saved what changed before it read the health row, so a slow or failed read cannot lose the change.
      expect(world.recordedAtRead).toEqual([1]);
      expect(entry(o.state, HEALTH_RECOMPUTE_ID)).toEqual({ due_at: Date.now() + HEALTH_RECOMPUTE_WINDOW_MS });
      // A second change inside the window is the same recompute.
      vi.setSystemTime(Date.now() + 20_000);
      world.changed = [{ ...OFFSITE, end: '2026-10-21T19:30:00+05:30', status: 'confirmed', created: new Date(NOW - 86_400_000).toISOString() }];
      await o.sweep();
      expect(calendarLogs()).toEqual([{ ok: true, code: 'asked' }, { ok: true, code: 'asked' }]);
      expect(entry(o.state, HEALTH_RECOMPUTE_ID)).toEqual({ due_at: NOW + 10 * 60_000 + HEALTH_RECOMPUTE_WINDOW_MS });
      vi.setSystemTime(entry(o.state, HEALTH_RECOMPUTE_ID)!.due_at);
      await o.pass();
      expect(entry(o.state, HEALTH_TRIGGER_ID)).not.toBeNull();
      await o.pass();
      expect((world.rows.get(TODAY)!.weight as Record<string, unknown>).zone).not.toBe(weightBefore);
      // The trace: one recompute (one read of the readings and one of the vitals, one fresh read of today's busy minutes beside it), Weight the
      // only pillar that moved, then one evaluation of that change.
      const count = (step: string) => world.trace.filter(seen => seen === step).length;
      expect([count('series_read'), count('vitals_read'), count('free_busy'), count('health_evaluation')]).toEqual([1, 1, 1, 1]);
      expect(world.trace.filter(step => step.startsWith('context_write'))).toEqual([`context_write:${addDays(TODAY, -1)}:none`, `context_write:${TODAY}:weight`]);
      expect(world.trace.indexOf(`context_write:${TODAY}:weight`)).toBeLessThan(world.trace.indexOf('health_evaluation'));
      expect(runs(o.state)).toEqual([{ mode: 'live', outcome: 'proposed' }]);
      expect(cards(o.state)).toHaveLength(1);
      const sent = JSON.stringify(world.requests.find(r => r.request.response_format?.name === 'health_proposal')!.request);
      expect(sent).toContain('Partner offsite');
      for (const leak of LEAKS) for (const [where, text] of [['the model request', sent], ['tables and storage', dump(o.state)], ['printed lines', printed.join('\n')]] as const) expect(text, `${leak} in ${where}`).not.toContain(leak);
    });
  });

  // Two evaluations on one day: the offsite added at 10:10 gives the first card, its cancellation at 10:40 moves Weight
  // back, and the floor's run lands five seconds inside the cooldown of the first card and waits for it. The model takes
  // five seconds, so each card is booked after its run started. `second` is what the model answers the second time.
  const twoEvaluations = async (o: { state: DurableObjectState; sweep(): Promise<void>; pass(): Promise<void>; upload(): Promise<void> }, second: string) => {
    const REVIEW: CalendarItem = { id: 'gcal-review-2', title: 'Quarterly board review', start: '2026-10-21T16:00:00+05:30', end: '2026-10-21T16:30:00+05:30', all_day: false, attendees: 6, etag: 'r2' };
    await morning(o);
    offsiteAdded();
    world.events = [OFFSITE, REVIEW];
    await o.sweep();
    vi.setSystemTime(entry(o.state, HEALTH_RECOMPUTE_ID)!.due_at);
    await o.pass();
    const firstRun = Date.now();
    await o.pass();
    expect(cards(o.state)).toHaveLength(1);
    // Google returns the cancellation without times.
    vi.setSystemTime(NOW + 40 * 60_000);
    world.events = [REVIEW];
    world.busy = world.busy.filter(b => b.start !== block(TODAY, 13, 6).start);
    world.changed = [{ id: OFFSITE.id, title: '(no title)', start: '', end: '', all_day: true, status: 'cancelled', created: '' }];
    world.decision = second;
    await o.sweep();
    expect(calendarLogs().at(-1)).toEqual({ ok: true, code: 'asked' });
    vi.setSystemTime(entry(o.state, HEALTH_RECOMPUTE_ID)!.due_at);
    await o.pass();
    expect(world.trace.filter(step => step.startsWith(`context_write:${TODAY}`)).at(-1)).toBe(`context_write:${TODAY}:weight`);
    expect(entry(o.state, HEALTH_TRIGGER_ID)).toEqual({ due_at: firstRun + 60 * 60_000 });
    vi.setSystemTime(firstRun + 60 * 60_000);
    await o.pass();
    expect(runs(o.state).map(run => run.outcome)).toEqual(['proposed']);
    expect(entry(o.state, HEALTH_TRIGGER_ID)).toEqual({ due_at: firstRun + 5_000 + 60 * 60_000 });
    vi.setSystemTime(firstRun + 5_000 + 60 * 60_000);
    await o.pass();
    return world.requests.filter(r => r.request.response_format?.name === 'health_proposal').map(r => JSON.stringify(r.request));
  };
  const sameDay = (run: () => Promise<void>) => async () => {
    // Today still holds an hour of meetings before the offsite: half an hour at 10:00 and the review.
    world.busy[0] = block(TODAY, 10, 0.5);
    world.busy.push(block(TODAY, 16, 0.5));
    world.latencyMs = 5_000;
    await run();
  };

  it('puts up a second card the same day once the gate\'s cooldown ends, showing the model the first and that it is still waiting', sameDay(async () => {
    await withOwner(async o => {
      const evaluations = await twoEvaluations(o, JSON.stringify({ kind: 'propose', action: 'create', item: null, start: '2026-10-21T15:00', end: '2026-10-21T15:30', title: 'Buffer', notify_guests: null, reason: 'The afternoon opened up; a short buffer before the review keeps it steady.' }));
      expect(runs(o.state)).toEqual([{ mode: 'live', outcome: 'proposed' }, { mode: 'live', outcome: 'proposed' }]);
      expect(cards(o.state)).toHaveLength(2);
      expect(evaluations).toHaveLength(2);
      expect(evaluations[0]).toContain('Nothing proposed earlier on 2026-10-21.');
      expect(evaluations[1]).toContain('Earlier on 2026-10-21 you proposed:');
      expect(evaluations[1]).toContain('\\"title\\":\\"Focus block\\",\\"start\\":\\"2026-10-21T11:30\\",\\"end\\":\\"2026-10-21T12:30\\",\\"answer\\":\\"waiting for the owner\\"');
      for (const leak of LEAKS) for (const [where, text] of [['the model requests', evaluations.join('\n')], ['tables and storage', dump(o.state)], ['printed lines', printed.join('\n')]] as const) expect(text, `${leak} in ${where}`).not.toContain(leak);
    });
  }));

  it('puts no second card up for the same change the owner is still deciding on, whatever the model says this time', sameDay(async () => {
    await withOwner(async o => {
      const again = JSON.stringify({ ...JSON.parse(world.decision), reason: 'Still a heavy afternoon; an hour clear before it keeps the day steady.' });
      expect(await twoEvaluations(o, again)).toHaveLength(2);
      expect(runs(o.state)).toEqual([{ mode: 'live', outcome: 'proposed' }, { mode: 'live', outcome: 'duplicate' }]);
      expect(cards(o.state)).toHaveLength(1);
    });
  }));

  it('asks nothing when the owner has not shared health, or withdrew it: no recompute and no read of their readings', async () => {
    await withOwner(async o => {
      await morning(o);
      world.scoresAccess = false;
      offsiteAdded();
      await o.sweep();
      expect(calendarLogs()).toEqual([{ ok: true, code: 'no_row' }]);
      expect(entry(o.state, HEALTH_RECOMPUTE_ID)).toBeNull();
      vi.setSystemTime(Date.now() + HEALTH_RECOMPUTE_WINDOW_MS);
      await o.pass();
      expect(world.trace.filter(step => step === 'series_read' || step === 'vitals_read' || step === 'free_busy' || step.startsWith('context_write'))).toEqual([]);
      expect(world.requests.filter(r => r.request.response_format?.name === 'health_proposal')).toEqual([]);
    });
  });

  it('begins nothing from the calendar alone when today has no health row yet, as when the wearable has not synced', async () => {
    await withOwner(async o => {
      await o.sweep();
      offsiteAdded();
      await o.sweep();
      expect(calendarLogs()).toEqual([{ ok: true, code: 'no_row' }]);
      expect(entry(o.state, HEALTH_RECOMPUTE_ID)).toBeNull();
      expect(world.rows.size).toBe(0);
    });
  });

  it('writes nothing when sharing is withdrawn between the ask and the recompute', async () => {
    await withOwner(async o => {
      await morning(o);
      offsiteAdded();
      await o.sweep();
      world.access = 'withdrawn';
      vi.setSystemTime(Date.now() + HEALTH_RECOMPUTE_WINDOW_MS);
      await o.pass();
      expect(world.trace.filter(step => step.startsWith('context_write'))).toEqual([]);
      expect(entry(o.state, HEALTH_TRIGGER_ID)).toBeNull();
    });
  });

  it('leaves Weight alone for a change on another day, and for an owner with no Google calendar', async () => {
    await withOwner(async o => {
      await morning(o);
      vi.setSystemTime(NOW + 10 * 60_000);
      const tomorrow = { ...OFFSITE, start: '2026-10-22T13:00:00+05:30', end: '2026-10-22T19:00:00+05:30' };
      world.changed = [{ ...tomorrow, status: 'confirmed', created: new Date(Date.now() - 60_000).toISOString() }];
      await o.sweep();
      expect(calendarLogs()).toEqual([]);
      expect(entry(o.state, HEALTH_RECOMPUTE_ID)).toBeNull();
    });
    await withOwner(async o => {
      offsiteAdded();
      await o.sweep();
      await o.sweep();
      expect(world.trace).toEqual([]);
      expect(calendarLogs()).toEqual([]);
    }, false);
  });

  // The owner's ruling: a rest block Waldo put in leaves Weight where it was; a deep-work block counts like any meeting.
  // One fixture and one approved three-hour block, with only its kind different.
  const approvedBlock = (kind: 'rest' | 'deep_work') => withOwner(async o => {
    await morning(o);
    const weight = () => (world.rows.get(TODAY)!.weight as Record<string, unknown>).zone;
    const before = weight();
    vi.setSystemTime(NOW + 10 * 60_000);
    const desk = o.desk();
    const id = await desk.propose({ action: 'create', title: 'Protected time', start: '2026-10-21T14:00:00+05:30', end: '2026-10-21T17:00:00+05:30', reason: 'Keep the afternoon clear.', block: kind }, 'turn-block');
    expect((await desk.decide(id, 'a', 'approve-block', { surface: 'app' })).toast).toBe('Done');
    expect(world.created).toEqual([kind]);
    await o.sweep();
    expect(calendarLogs()).toEqual([{ ok: true, code: 'asked' }]);
    vi.setSystemTime(entry(o.state, HEALTH_RECOMPUTE_ID)!.due_at);
    await o.pass();
    await o.pass();
    const writes = world.trace.filter(step => step.startsWith(`context_write:${TODAY}`));
    const evaluations = world.trace.filter(step => step === 'health_evaluation').length;
    if (kind === 'rest') {
      expect([writes, weight(), evaluations, entry(o.state, HEALTH_TRIGGER_ID)]).toEqual([[`context_write:${TODAY}:none`], before, 0, null]);
    } else {
      expect([writes, evaluations]).toEqual([[`context_write:${TODAY}:weight`], 1]);
      expect(weight()).not.toBe(before);
    }
    for (const leak of LEAKS) for (const [where, text] of [['tables and storage', dump(o.state)], ['printed lines', printed.join('\n')]] as const) expect(text, `${leak} in ${where}`).not.toContain(leak);
  });

  it('leaves Weight where it was for an approved rest block, so nothing is evaluated again', () => approvedBlock('rest'));
  it('raises Weight for an approved deep-work block and evaluates that change once', () => approvedBlock('deep_work'));
});
