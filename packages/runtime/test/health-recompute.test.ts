import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { loopBook } from '../src/channels/loops';
import { HEALTH_RECOMPUTE_ID, HEALTH_RECOMPUTE_WINDOW_MS, healthRecompute } from '../src/health/recompute';
import { HEALTH_TRIGGER_ID } from '../src/health/trigger';
import { HEALTH_SAMPLES_PATH, notifyOwnerHealthSamples, verifiedHealthSamples } from '../src/health/zone-change-route';
import { armAlarm } from '../src/scheduler/alarm-slot';
import { ensureSchema } from '../src/tracer/schema';
import type { ScheduleEntry } from '@waldo/contracts';
import { presenceAuthority } from './helpers/directory-presence';

// The owner's derived health rows, recomputed in the owner's own object: the Worker's signed notice after each upload, a
// real scheduler entry and real alarm passes, against a fake health plane that answers like the database functions. Every
// reading is synthetic, and none may be found anywhere in the object's storage or printed lines.
const SECRET = 'router-secret-fixture-0000000000';
const OWNER_ID = '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const NOW = Date.parse('2026-10-21T08:00:00Z'); // 13:30 in Kolkata
const LEAKS = ['452.25', '61.37', '54.75'];
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// What the database functions hold and answer for this owner: the derived rows by day, and every call made.
const plane = vi.hoisted(() => ({
  rows: new Map<string, Record<string, Record<string, unknown>>>(), calls: [] as { fn: string; payload: Record<string, unknown> }[],
  seriesFails: false, during: null as null | (() => Promise<void>),
}));
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async () => true }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete() { throw new Error('a recompute never calls the model'); } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const CONFIG = { ...env, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'Asia/Kolkata', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture',
  WALDO_ROUTER_HMAC_SECRET: SECRET, SUPABASE_PROJECT_URL: 'https://edge.test', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable' };

// Twenty-five nights from the phone, ending on the last day the read asks for, so the zone the recompute runs in decides
// which days it writes.
const series = (to: string) => ({
  access: 'granted', read_at: new Date().toISOString(),
  sources: [{ source: 'apple', consent_epoch: 1, truncated: false, samples: Array.from({ length: 25 }, (_, i) => {
    const day = addDays(to, -i), start_at = `${addDays(day, -1)}T17:30:00.000Z`, end_at = `${day}T01:30:00.000Z`;
    return [
      { signal: 'sleep_duration', day, start_at, end_at, timezone: 'Asia/Kolkata', value: i === 0 ? 452.25 : 440 + (i % 5) * 6, method: 'asleep_duration' },
      { signal: 'sleep_midpoint', day, start_at, end_at, timezone: 'Asia/Kolkata', value: 180 + (i % 3) * 7 },
      { signal: 'overnight_hrv', day, start_at, end_at, timezone: 'Asia/Kolkata', value: i === 0 ? 61.37 : 52 + (i % 4) * 3, method: 'rmssd' },
      { signal: 'resting_heart_rate', day, start_at: `${day}T03:00:00.000Z`, end_at: `${day}T04:00:00.000Z`, timezone: 'Asia/Kolkata', value: i === 0 ? 54.75 : 55 + (i % 2) },
    ];
  }).flat() }],
});
const newestBefore = (day: string) => [...plane.rows.keys()].filter(d => d < day).sort().at(-1);

let sequence = 0;
const printed: string[] = [];
beforeEach(() => {
  plane.rows.clear(); plane.calls = []; plane.seriesFails = false; plane.during = null; printed.length = 0;
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  for (const method of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { printed.push(args.map(String).join(' ')); });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, string | number> : {};
    const payload = typeof body.p_payload === 'string' ? JSON.parse(body.p_payload) as Record<string, unknown> : {};
    if (fn?.startsWith('health_')) plane.calls.push({ fn, payload });
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: body.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'health_series_read') {
      await plane.during?.();
      return plane.seriesFails ? new Response('unavailable', { status: 503 }) : Response.json(series(String(payload.to)));
    }
    if (fn === 'health_scores_read') {
      const day = typeof payload.day === 'string' ? payload.day : [...plane.rows.keys()].sort().at(-1);
      const row = day === undefined ? undefined : plane.rows.get(day);
      return Response.json(row ? { scores: { day, timezone: 'Asia/Kolkata', compiled_at: new Date().toISOString(), freshness: 'fresh', ...row } } : { unavailable: 'no_readings' });
    }
    if (fn === 'health_context_write') {
      const row = payload as Record<string, Record<string, unknown>> & { day: string };
      const old = plane.rows.get(row.day) ?? plane.rows.get(newestBefore(row.day) ?? '');
      const changed = old ? ['recovery', 'form', 'weight'].filter(p => typeof old[p]?.zone === 'string' && typeof row[p]?.zone === 'string' && old[p]!.zone !== row[p]!.zone) : [];
      plane.rows.set(row.day, { recovery: row.recovery!, form: row.form!, weight: row.weight! });
      return Response.json({ written: true, changed });
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
const withOwner = (work: (o: { owner: Owner; state: DurableObjectState; upload(timezone?: string): Promise<void>; pass(): Promise<void> }) => Promise<void>) => {
  const doName = `health-recompute-do-${sequence++}`;
  return runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(doName)), async (_i, state) => {
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', doName); state.storage.kv.put('telegram_subject', '7');
    const owner = new OwnerDO(state, CONFIG as never) as unknown as Owner;
    const upload = (timezone = 'Asia/Kolkata') => notifyOwnerHealthSamples({ idFromName: (name: string) => name as never, get: () => ({ fetch: (request: Request) => owner.fetch(request) }) }, SECRET, doName, timezone);
    const pass = async () => { await armAlarm(state.storage, Date.now()); await state.storage.deleteAlarm(); state.storage.kv.put('owner_alarm_last_v1', 0); await owner.alarm(); };
    try { await work({ owner, state, upload, pass }); } finally { await state.storage.deleteAlarm(); }
  });
};
const entry = (state: DurableObjectState, id = HEALTH_RECOMPUTE_ID) => state.storage.sql.exec<{ kind: string; due_at: number; status: string; attempts: number }>('SELECT kind, due_at, status, attempts FROM schedule WHERE id = ?', id).toArray()[0] ?? null;
const reads = () => plane.calls.filter(call => call.fn === 'health_series_read');
const writtenDays = () => plane.calls.filter(call => call.fn === 'health_context_write').map(call => call.payload.day);
const pending = (state: DurableObjectState) => state.storage.sql.exec<{ day: string }>("SELECT day FROM health_trigger_pending").toArray().map(row => row.day);
const tableExists = (state: DurableObjectState, name: string) => state.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;
// Today's row as an earlier upload left it, in another Recovery zone than the readings now give.
const earlierToday = (day = '2026-10-21') => plane.rows.set(day, { recovery: { score: 20, zone: 'low', algorithm_version: 'recovery.candidate.v1' }, form: { reason: 'intraday_inputs_unavailable' }, weight: { reason: 'calendar_demand_unavailable' } });

describe('the readings-changed notice', () => {
  const capture = async (doName = 'owner-a', timezone = 'Asia/Kolkata') => {
    let sent!: Request;
    await notifyOwnerHealthSamples({ idFromName: (name: string) => name as never, get: () => ({ fetch: async (request: Request) => { sent = request; return Response.json({ ok: true }); } }) }, SECRET, doName, timezone);
    return sent;
  };
  const resend = async (request: Request, over: { headers?: Record<string, string>; body?: unknown; method?: string } = {}) =>
    new Request(request.url, { method: over.method ?? request.method, headers: { ...Object.fromEntries(request.headers), ...over.headers }, ...((over.method ?? request.method) === 'POST' ? { body: over.body === undefined ? await request.text() : JSON.stringify(over.body) } : {}) });
  const isOwnerA = (name: string) => name === 'owner-a';

  it('carries the zone the batch was read in and nothing else', async () => {
    const request = await capture();
    expect(new URL(request.url).pathname).toBe(HEALTH_SAMPLES_PATH);
    expect(await request.clone().json()).toEqual({ timezone: 'Asia/Kolkata' });
    expect(await verifiedHealthSamples(request, SECRET, isOwnerA)).toBe('Asia/Kolkata');
  });

  it('refuses a forged, re-addressed, re-zoned, padded, unknown-zone or unsigned request', async () => {
    const cases = {
      forged: await resend(await capture(), { headers: { 'x-waldo-samples-sig': '0'.repeat(64) } }),
      otherOwner: await capture('owner-b'),
      reAddressed: await resend(await capture('owner-b'), { headers: { 'x-waldo-do-name': 'owner-a' } }),
      reZoned: await resend(await capture(), { body: { timezone: 'Europe/London' } }),
      padded: await resend(await capture(), { body: { timezone: 'Asia/Kolkata', accepted: 3 } }),
      unknownZone: await capture('owner-a', 'Mars/Olympus'),
      wrongMethod: await resend(await capture(), { method: 'GET' }),
    };
    for (const [label, request] of Object.entries(cases)) expect([label, await verifiedHealthSamples(request, SECRET, isOwnerA)]).toEqual([label, null]);
    expect(await verifiedHealthSamples(await capture(), undefined, isOwnerA)).toBeNull();
  });
});

describe('when a recompute is armed', () => {
  // The scheduler as the recompute sees it: one row, or none.
  const fake = (row: ScheduleEntry | 'unreadable' | null, now = NOW) => {
    const scheduled: number[] = [], kv = new Map<string, unknown>();
    const recompute = healthRecompute({
      scheduler: {
        lookup: () => (row === null ? { state: 'absent' } : row === 'unreadable' ? { state: 'unreadable' } : { state: 'entry', entry: row }),
        schedule: async input => { scheduled.push(input.dueAt); return null as never; },
      },
      kv: { get: <T,>(key: string) => kv.get(key) as T | undefined, put: (key: string, value: unknown) => { kv.set(key, value); } },
      now: () => now, ownerZone: () => 'UTC', producer: null as never,
    });
    return { recompute, scheduled, kv };
  };
  const row = (over: Partial<ScheduleEntry>): ScheduleEntry => ({ id: HEALTH_RECOMPUTE_ID, kind: 'provider_sync', occurrence_at: NOW, due_at: NOW, recurrence: null, payload_refs: { id: HEALTH_RECOMPUTE_ID },
    status: 'armed', attempts: 0, last_fired_at: null, quarantined_until: null, created_at: NOW, updated_at: NOW, ...over });

  it('arms one a window out when none waits, and lets one already waiting take the upload', async () => {
    const none = fake(null);
    await none.recompute.ask('Asia/Kolkata');
    expect(none.scheduled).toEqual([NOW + HEALTH_RECOMPUTE_WINDOW_MS]);
    const waiting = fake(row({ due_at: NOW + 1_000 }));
    await waiting.recompute.ask('Asia/Kolkata');
    expect(waiting.scheduled).toEqual([]);
  });

  it('arms a fresh one when the one there is due or running, retrying, or paused', async () => {
    for (const there of [row({ due_at: NOW }), row({ due_at: NOW - 5_000, attempts: 1 }), row({ status: 'quarantined', quarantined_until: NOW + 86_400_000 })]) {
      const f = fake(there);
      await f.recompute.ask('Asia/Kolkata');
      expect(f.scheduled).toEqual([NOW + HEALTH_RECOMPUTE_WINDOW_MS]);
    }
    const unreadable = fake('unreadable');
    await unreadable.recompute.ask('Asia/Kolkata');
    expect(unreadable.scheduled).toEqual([]);
  });

  it('keeps the zone the last upload named when a wearable sync names none', async () => {
    const f = fake(null);
    await f.recompute.ask('Asia/Kolkata');
    await f.recompute.ask(null);
    expect([...f.kv.values()]).toEqual(['Asia/Kolkata']);
  });
});

describe('the owner object recomputes the derived rows', () => {
  it('turns a burst of uploads into one recompute, one read of the month and at most one zone change', async () => {
    earlierToday();
    await withOwner(async ({ state, upload, pass }) => {
      for (let i = 0; i < 5; i += 1) { vi.setSystemTime(NOW + i * 10_000); await upload(); }
      expect(entry(state)).toMatchObject({ kind: 'provider_sync', due_at: NOW + HEALTH_RECOMPUTE_WINDOW_MS, status: 'armed' });
      await pass();
      expect(reads()).toEqual([]);
      vi.setSystemTime(NOW + HEALTH_RECOMPUTE_WINDOW_MS);
      await pass();
      expect(reads()).toHaveLength(1);
      expect(writtenDays()).toEqual(['2026-10-20', '2026-10-21']);
      expect(pending(state)).toEqual(['2026-10-21']);
      expect(entry(state, HEALTH_TRIGGER_ID)).toMatchObject({ kind: 'patrol' });
      expect(entry(state)).toBeNull();
      for (const leak of LEAKS) for (const [where, text] of [['tables and storage', dump(state)], ['printed lines', printed.join('\n')]] as const) expect(text, `${leak} in ${where}`).not.toContain(leak);
      expect(printed.join('\n')).toContain('"hop":"health_recompute"');
    });
  });

  it('recomputes again after a run that an upload landed in, since that run may have read before the batch committed', async () => {
    await withOwner(async ({ state, upload, pass }) => {
      await upload();
      vi.setSystemTime(NOW + HEALTH_RECOMPUTE_WINDOW_MS);
      plane.during = async () => { plane.during = null; await upload(); };
      await pass();
      expect(reads()).toHaveLength(1);
      expect(entry(state)).toMatchObject({ status: 'armed', due_at: NOW + 2 * HEALTH_RECOMPUTE_WINDOW_MS });
      vi.setSystemTime(NOW + 2 * HEALTH_RECOMPUTE_WINDOW_MS);
      await pass();
      expect(reads()).toHaveLength(2);
      expect(entry(state)).toBeNull();
    });
  });

  it('recomputes in the owner\'s quiet hours, while the health trigger it arms still waits for them to end', async () => {
    earlierToday('2026-10-22');
    vi.setSystemTime(Date.parse('2026-10-21T20:00:00Z')); // 01:30 in Kolkata
    await withOwner(async ({ state, upload, pass }) => {
      loopBook(state.storage.sql, { newId: () => 'fixture', now: () => Date.now() }).setProactivity({ quiet_start: '22:00', quiet_end: '07:00', volume: 'normal' });
      await upload();
      vi.setSystemTime(Date.parse('2026-10-21T20:01:00Z'));
      await pass();
      expect(writtenDays()).toEqual(['2026-10-21', '2026-10-22']);
      expect(pending(state)).toEqual(['2026-10-22']);
      await pass();
      expect(entry(state, HEALTH_TRIGGER_ID)!.due_at).toBe(Date.parse('2026-10-22T01:30:00Z')); // 07:00 in Kolkata
      expect(tableExists(state, 'health_trigger_runs') ? state.storage.sql.exec('SELECT 1 FROM health_trigger_runs').toArray() : []).toEqual([]);
    });
  });

  it('names the owner\'s today by the zone the newest upload was read in, so a change of zone moves the day', async () => {
    vi.setSystemTime(Date.parse('2026-10-21T20:00:00Z')); // 01:30 on the 22nd in Kolkata, 16:00 on the 21st in New York
    await withOwner(async ({ upload, pass }) => {
      await upload('Asia/Kolkata');
      vi.setSystemTime(Date.parse('2026-10-21T20:01:00Z'));
      await pass();
      expect(writtenDays()).toEqual(['2026-10-21', '2026-10-22']);
      plane.calls = [];
      await upload('America/New_York');
      vi.setSystemTime(Date.parse('2026-10-21T20:02:00Z'));
      await pass();
      expect(writtenDays()).toEqual(['2026-10-20', '2026-10-21']);
    });
  });

  it('writes the finished day and the new one when a burst runs past the owner\'s midnight', async () => {
    vi.setSystemTime(Date.parse('2026-10-21T18:29:30Z')); // 23:59:30 in Kolkata
    await withOwner(async ({ upload, pass }) => {
      await upload();
      vi.setSystemTime(Date.parse('2026-10-21T18:29:50Z'));
      await upload();
      vi.setSystemTime(Date.parse('2026-10-21T18:30:30Z')); // 00:00:30 on the 22nd
      await pass();
      expect(reads()).toHaveLength(1);
      expect(writtenDays()).toEqual(['2026-10-21', '2026-10-22']);
    });
  });

  it('leaves a failed recompute to the scheduler\'s retry, then pause, and a new upload asks again', async () => {
    plane.seriesFails = true;
    await withOwner(async ({ state, upload, pass }) => {
      await upload();
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        vi.setSystemTime(entry(state)!.due_at);
        await pass();
        expect(entry(state)).toMatchObject(attempt < 3 ? { status: 'armed', attempts: attempt } : { status: 'quarantined' });
      }
      expect(writtenDays()).toEqual([]);
      expect(printed.join('\n')).toContain('"hop":"health_recompute","ms":0,"ok":false,"code":"failed"');
      plane.seriesFails = false;
      await upload();
      expect(entry(state)).toMatchObject({ status: 'armed', attempts: 0, due_at: Date.now() + HEALTH_RECOMPUTE_WINDOW_MS });
      vi.setSystemTime(Date.now() + HEALTH_RECOMPUTE_WINDOW_MS);
      await pass();
      expect(writtenDays()).toEqual(['2026-10-20', '2026-10-21']);
    });
  });
});
