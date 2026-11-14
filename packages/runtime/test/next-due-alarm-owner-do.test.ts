import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import { traceBook } from '../src/channels/harness';
import { armHeartbeat, HEARTBEAT_EVERY_MS, HEARTBEAT_ID } from '../src/channels/heartbeat';
import { dayPlanBook } from '../src/channels/day-cards';
import { loopBook } from '../src/channels/loops';
import { reminderBook } from '../src/channels/reminders';
import { claimStore } from '../src/memory/claims';
import { ALARM_FAILED_LANE_KEY, ALARM_RETRY_DUE_KEY, TASK_JOBS_DUE_KEY } from '../src/scheduler/alarm-slot';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';

vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete(request: import('../src/llm/provider').LLMGatewayRequest) {
    return { ok: true as const, data: { model: request.request.model, text: JSON.stringify(request).includes('Reminder due now') ? 'Time to stretch.' : 'SKIP', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const AUTHORITY = new Set(['owner_runtime_authority', 'common_owner_authority', 'assert_channel_presence']);

// Every request the owner object makes: the directory's authority calls by name, anything else by host.
const wire = { asked: [] as string[], fetches: 0, revoked: false, blips: 0 };
beforeEach(() => {
  wire.asked = []; wire.fetches = 0; wire.revoked = false; wire.blips = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    wire.fetches += 1;
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    if (fn) wire.asked.push(fn);
    if (fn === 'owner_runtime_authority') {
      if (wire.blips > 0) { wire.blips -= 1; return new Response('unavailable', { status: 503 }); }
      if (wire.revoked) return Response.json(null);
      const asked = JSON.parse(String(init?.body)) as { p_do_name: string };
      return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    }
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (/^https:\/\/api\.telegram\.org\/bot[^/]+\/sendMessage$/.test(url)) {
      const sent = JSON.parse(String(init?.body)) as { chat_id: number };
      return Response.json({ ok: true, result: { message_id: 40 + wire.fetches, chat: { id: sent.chat_id } } });
    }
    return Response.json(null);
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

type Surface = 'app' | 'telegram';
const authorityCalls = () => wire.asked.filter(fn => AUTHORITY.has(fn));

// One owner object under a fixed clock. `alarm` stands in for the platform's invocation, which consumes the alarm that fired.
const withOwner = async <T>(name: string, surface: Surface, flag: '0' | '1', at: string,
  work: (h: Readonly<{ state: DurableObjectState; scheduler: Scheduler; alarm: () => Promise<number | null>; clock: (iso: string | number) => void; request: () => Promise<unknown>; restart: (flag: '0' | '1') => void }>) => Promise<T>) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse(at));
  return runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
    state.storage.kv.put('do_name', name);
    // An owner whose boot work already ran on this release.
    state.storage.kv.put('owner_alarm_full_release_v1', env.WALDO_RELEASE ?? 'unknown');
    if (surface === 'app') state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    else state.storage.kv.put('telegram_subject', '7');
    const make = (switched: '0' | '1') => new OwnerDO(state, { ...env, ...directory, NEXT_DUE_ALARM: switched, PROACTIVE_INTERVENTIONS: '0', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    let owner = make(flag);
    // A deploy that sets the switch the other way: the same storage under a new object.
    const restart = (switched: '0' | '1') => { owner = make(switched); };
    const alarm = async () => { await state.storage.deleteAlarm(); await owner.alarm(); return state.storage.getAlarm(); };
    const clock = (to: string | number) => vi.setSystemTime(typeof to === 'number' ? to : Date.parse(to));
    // Any request the object answers; the heartbeat's pull-forward runs after each one.
    const request = () => owner.fetch(new Request('https://telegram-owner/app/v1/chat/main'));
    try { return await work({ state, scheduler: new Scheduler(state.storage.sql, state.storage, productionDeps()), alarm, clock, request, restart }); }
    finally { await state.storage.deleteAlarm(); }
  });
};

const runs = (state: DurableObjectState, id: string) =>
  state.storage.sql.exec<{ outcome: string }>('SELECT outcome FROM schedule_runs WHERE schedule_id = ? ORDER BY fired_at', id).toArray().map(row => row.outcome);
const dueOf = (state: DurableObjectState, id: string) =>
  state.storage.sql.exec<{ due_at: number }>('SELECT due_at FROM schedule WHERE id = ?', id).one().due_at;

describe('an owner wake with nothing due', () => {
  it.each(['app', 'telegram'] as const)('asks no authority, makes no request and re-arms at the next due item (%s owner)', async surface => {
    await withOwner(`next-due-empty-${surface}`, surface, '1', '2027-03-10T10:00:00Z', async ({ state, scheduler, alarm }) => {
      await armHeartbeat(scheduler, Date.now() - 10 * 60_000);
      await state.storage.put(TASK_JOBS_DUE_KEY, Date.now() + 5 * 60_000);
      const armed = await alarm();
      expect(authorityCalls()).toEqual([]);
      expect(wire.fetches).toBe(0);
      expect(armed).toBe(Date.now() + 5 * 60_000);
      expect(runs(state, HEARTBEAT_ID)).toEqual([]);
      // With the jobs wake spent, the next wake is the heartbeat's own due time.
      await state.storage.put(TASK_JOBS_DUE_KEY, null);
      expect(await alarm()).toBe(dueOf(state, HEARTBEAT_ID));
      expect(authorityCalls()).toEqual([]);
    });
  });

  it('with the switch off, the app owner still asks the directory on an empty wake', async () => {
    await withOwner('next-due-empty-off', 'app', '0', '2027-03-10T10:00:00Z', async ({ scheduler, alarm }) => {
      await armHeartbeat(scheduler, Date.now() - 10 * 60_000);
      await alarm();
      expect(authorityCalls()).toContain('owner_runtime_authority');
    });
  });

  it('still runs the pass that is a failed lane\'s retry, whose key the handler spent', async () => {
    await withOwner('next-due-retry', 'app', '1', '2027-03-10T10:00:00Z', async ({ state, scheduler, alarm }) => {
      await armHeartbeat(scheduler, Date.now() - 10 * 60_000);
      state.storage.kv.put('owner_alarm_failures_v1', 1);
      state.storage.kv.put(ALARM_FAILED_LANE_KEY, 'jobs');
      state.storage.kv.put(ALARM_RETRY_DUE_KEY, Date.now() - 1);
      await alarm();
      expect(authorityCalls()).toContain('owner_runtime_authority');
      expect(state.storage.kv.get(ALARM_FAILED_LANE_KEY)).toBeUndefined();
      expect(state.storage.kv.get('owner_alarm_failures_v1')).toBeUndefined();
    });
  });

  it('wakes for a schedule row set later, earlier than the armed wake', async () => {
    await withOwner('next-due-rearm-on-change', 'app', '1', '2027-03-10T10:00:00Z', async ({ state, scheduler, alarm }) => {
      await armHeartbeat(scheduler, Date.now() - 10 * 60_000);
      expect(await alarm()).toBe(dueOf(state, HEARTBEAT_ID));
      const book = reminderBook(state.storage.sql, scheduler, { timezone: 'UTC', now: () => new Date() }, () => 'rem-soon');
      await book.set({ note: 'stretch', at: '2027-03-10T10:05', repeat: 'none' });
      expect(await state.storage.getAlarm()).toBe(Date.parse('2027-03-10T10:05:00Z'));
    });
  });
});

describe('due work under the switch keeps its time', () => {
  it('fires a daily local reminder on time across the start of daylight saving time and a time zone change', async () => {
    await withOwner('next-due-dst', 'app', '1', '2027-03-13T12:00:00Z', async ({ state, scheduler, alarm, clock }) => {
      const book = reminderBook(state.storage.sql, scheduler, { timezone: 'America/New_York', now: () => new Date() }, () => 'rem-daily');
      await book.set({ note: 'stretch', at: '2027-03-13T09:00', repeat: 'daily' });
      // 09:00 EST is 14:00Z on 13 Mar; New York moves to daylight time on 14 Mar, so the next 09:00 is 13:00Z.
      clock('2027-03-13T12:10:00Z');
      expect(await alarm()).toBe(Date.parse('2027-03-13T14:00:00Z'));
      expect(authorityCalls()).toEqual([]);
      clock('2027-03-13T14:00:00Z');
      expect(await alarm()).toBe(Date.parse('2027-03-14T13:00:00Z'));
      expect(runs(state, 'reminder:rem-daily')).toEqual(['ok']);
      // The owner moves to India; the reminder keeps the zone it was set in, and so does its wake.
      state.storage.kv.put('timezone', 'Asia/Kolkata');
      clock('2027-03-14T03:00:00Z');
      expect(await alarm()).toBe(Date.parse('2027-03-14T13:00:00Z'));
      clock('2027-03-14T13:00:00Z');
      expect(await alarm()).toBe(Date.parse('2027-03-15T13:00:00Z'));
      expect(runs(state, 'reminder:rem-daily')).toEqual(['ok', 'ok']);
    });
  });

});

const Z = (iso: string) => Date.parse(iso);
const onGrid = (at: number) => at % HEARTBEAT_EVERY_MS === 0;
const loop = (state: DurableObjectState, id: string, due: string) =>
  state.storage.sql.exec("INSERT INTO loops (id, title, due, status, created_at) VALUES (?, 'send the deck', ?, 'open', ?)", id, due, Date.now());
const checks = (state: DurableObjectState) =>
  state.storage.sql.exec<{ note: string }>("SELECT note FROM trace_log WHERE hop = 'machine_check' ORDER BY id").toArray().map(row => row.note);
const confirmZone = (state: DurableObjectState, zone: string) => { loopBook(state.storage.sql, { newId: () => 'unused', now: Date.now }); state.storage.kv.put('timezone', zone); state.storage.kv.put('timezone_confirmed', true); };

describe('the heartbeat under the switch runs at its next tick worth running, on its own grid', () => {
  const DAYS = 3;
  // Drives every wake the owner object arms for three days. `idle` counts the wakes that found no schedule row due and still
  // asked the directory.
  const idle = (flag: '0' | '1') => withOwner(`next-due-idle-${flag}`, 'app', flag, '2027-03-10T00:05:00Z', async ({ state, scheduler, alarm, clock }) => {
    confirmZone(state, 'UTC');
    await armHeartbeat(scheduler, Date.now() - 5 * 60_000);
    const end = Date.now() + DAYS * 24 * 3_600_000;
    let armed = await alarm(), wakes = 0, idleAsked = 0;
    const boot = authorityCalls().length;
    while (armed !== null && armed < end && wakes < 500) {
      clock(armed); wakes++;
      const due = state.storage.sql.exec('SELECT 1 FROM schedule WHERE due_at <= ?', armed + 250).toArray().length > 0, before = authorityCalls().length;
      armed = await alarm();
      if (!due && authorityCalls().length > before) idleAsked++;
    }
    return { wakes, idleAsked, authority: authorityCalls().length - boot, ticks: runs(state, HEARTBEAT_ID).length, next: dueOf(state, HEARTBEAT_ID) };
  });

  it('an idle owner: the heartbeat ticks 48 times a day with the switch off and once a day with it on', async () => {
    const off = await idle('0'), on = await idle('1');
    expect(off.ticks).toBe(48 * DAYS);
    // The daily tick, a day after the first one; the day's cards and the nightly jobs still wake as they are due.
    expect(on.ticks).toBe(DAYS - 1);
    expect(on.idleAsked).toBe(0);
    expect(on.wakes * 5).toBeLessThan(off.wakes);
    expect(on.authority * 3).toBeLessThan(off.authority);
    expect(onGrid(on.next)).toBe(true);
  });

  it('arms for a loop due on the owner\'s wall clock across both daylight saving changes, gap and overlap included', async () => {
    const cases: readonly (readonly [string, string, string])[] = [
      ['2027-03-13T18:00:00Z', '2027-03-14T09:00', '2027-03-14T13:00:00Z'], // after the spring change: EDT
      ['2027-03-13T18:00:00Z', '2027-03-14T02:30', '2027-03-14T07:00:00Z'], // 02:30 never happens; 03:00 EDT is the first tick past it
      ['2027-11-06T18:00:00Z', '2027-11-07T09:00', '2027-11-07T14:00:00Z'], // after the autumn change: EST
      ['2027-11-06T18:00:00Z', '2027-11-07T01:30', '2027-11-07T05:30:00Z'], // 01:30 happens twice; the first one counts
    ];
    for (const [i, [at, due, wake]] of cases.entries()) {
      wire.asked = [];
      await withOwner(`next-due-dst-loop-${i}`, 'app', '1', at, async ({ state, scheduler, alarm, clock }) => {
        confirmZone(state, 'America/New_York');
        await armHeartbeat(scheduler, Date.now() - 5 * 60_000);
        loop(state, 'loop-1', due);
        expect(await alarm()).toBe(Z(wake));
        expect(authorityCalls()).toEqual([]);
        clock(Z(wake) - 60_000);
        expect(await alarm()).toBe(Z(wake));
        clock(Z(wake));
        await alarm();
        expect(checks(state)).toEqual(['enqueued']);
      });
    }
  });

  it('follows a time zone change while armed: earlier at once, later at the next wake, which asks nothing', async () => {
    await withOwner('next-due-zone-change', 'app', '1', '2027-03-20T00:00:00Z', async ({ state, scheduler, alarm, clock, request }) => {
      confirmZone(state, 'UTC');
      await armHeartbeat(scheduler, Date.now() - 5 * 60_000);
      loop(state, 'loop-1', '2027-03-20T09:00');
      expect(await alarm()).toBe(Z('2027-03-20T09:00:00Z'));
      state.storage.kv.put('timezone', 'Asia/Kolkata');
      await request();
      expect(dueOf(state, HEARTBEAT_ID)).toBe(Z('2027-03-20T03:30:00Z'));
      expect(await state.storage.getAlarm()).toBe(Z('2027-03-20T03:30:00Z'));
      state.storage.kv.put('timezone', 'America/Los_Angeles');
      await request();
      expect(dueOf(state, HEARTBEAT_ID)).toBe(Z('2027-03-20T03:30:00Z'));
      clock(Z('2027-03-20T03:30:00Z'));
      expect(await alarm()).toBe(Z('2027-03-20T16:00:00Z'));
      expect(authorityCalls()).toEqual([]);
      expect(runs(state, HEARTBEAT_ID)).toEqual([]);
    });
  });

  it('waits out quiet hours that span midnight, then checks back', async () => {
    await withOwner('next-due-quiet', 'app', '1', '2027-03-13T23:10:00Z', async ({ state, scheduler, alarm, clock }) => {
      confirmZone(state, 'UTC');
      loopBook(state.storage.sql, { newId: () => 'unused', now: Date.now }).setProactivity({ quiet_start: '22:00', quiet_end: '07:00', volume: 'normal' });
      await armHeartbeat(scheduler, Z('2027-03-13T22:30:00Z'));
      loop(state, 'loop-1', '2027-03-13T21:00');
      expect(await alarm()).toBe(Z('2027-03-14T07:00:00Z'));
      expect(authorityCalls()).toEqual([]);
      clock(Z('2027-03-14T07:00:00Z'));
      await alarm();
      expect(checks(state)).toEqual(['enqueued']);
    });
  });

  it('runs at the first tick after a cooldown that ends between ticks', async () => {
    await withOwner('next-due-cooldown', 'app', '1', '2027-03-13T11:00:00Z', async ({ state, scheduler, alarm, clock }) => {
      confirmZone(state, 'UTC');
      await armHeartbeat(scheduler, Z('2027-03-13T10:30:00Z'));
      loop(state, 'loop-1', '2027-03-13T08:00');
      state.storage.sql.exec("INSERT INTO heartbeat_notified (loop_id, due, notified_at) VALUES ('loop-1', '2027-03-13T08:00', ?)", Z('2027-03-13T10:10:00Z'));
      expect(await alarm()).toBe(Z('2027-03-13T14:30:00Z'));
      expect(authorityCalls()).toEqual([]);
      clock(Z('2027-03-13T14:30:00Z'));
      await alarm();
      expect(checks(state)).toEqual(['enqueued']);
    });
  });

  it('pulls the wake earlier for a loop added after it was armed, and for a card held for today', async () => {
    await withOwner('next-due-pull', 'app', '1', '2027-03-10T10:10:00Z', async ({ state, scheduler, alarm, request }) => {
      confirmZone(state, 'UTC');
      await armHeartbeat(scheduler, Date.now() - 5 * 60_000);
      expect(await alarm()).toBe(Z('2027-03-11T10:30:00Z'));
      loop(state, 'loop-1', '2027-03-10T12:15');
      await request();
      expect(await state.storage.getAlarm()).toBe(Z('2027-03-10T12:30:00Z'));
      dayPlanBook(state.storage.sql);
      state.storage.sql.exec("INSERT INTO day_plan (day, card, time, reason, sent) VALUES ('2027-03-10', 'midday', '11:00', 'default time', 2)");
      await request();
      expect(await state.storage.getAlarm()).toBe(Z('2027-03-10T10:30:00Z'));
      expect(authorityCalls()).toEqual([]);
    });
  });

  it('keeps the grid slot on a loop due time it cannot read', async () => {
    await withOwner('next-due-fallback-due', 'app', '1', '2027-03-10T10:10:00Z', async ({ state, scheduler, alarm }) => {
      confirmZone(state, 'UTC');
      await armHeartbeat(scheduler, Z('2027-03-10T09:30:00Z'));
      loop(state, 'loop-1', 'next week');
      expect(await alarm()).toBe(Z('2027-03-10T10:30:00Z'));
      expect(runs(state, HEARTBEAT_ID)).toEqual(['ok']);
      expect(authorityCalls()).toContain('owner_runtime_authority');
    });
  });

  it('keeps the grid slot with more open loops than its scan reads', async () => {
    await withOwner('next-due-fallback-many', 'app', '1', '2027-03-10T10:10:00Z', async ({ state, scheduler, alarm }) => {
      confirmZone(state, 'UTC');
      await armHeartbeat(scheduler, Z('2027-03-10T09:30:00Z'));
      for (let i = 0; i < 201; i++) loop(state, `loop-${i}`, '2027-04-01T09:00');
      expect(await alarm()).toBe(Z('2027-03-10T10:30:00Z'));
      expect(dueOf(state, HEARTBEAT_ID)).toBe(Z('2027-03-10T10:30:00Z'));
    });
  });

  it('keeps the grid slot on a time zone it cannot read', async () => {
    await withOwner('next-due-fallback-zone', 'app', '1', '2027-03-10T10:10:00Z', async ({ state, scheduler, alarm }) => {
      confirmZone(state, 'Not/AZone');
      await armHeartbeat(scheduler, Z('2027-03-10T09:30:00Z'));
      await alarm();
      // The row is left due on its slot and the pass runs, exactly as with the switch off.
      expect(dueOf(state, HEARTBEAT_ID)).toBe(Z('2027-03-10T10:00:00Z'));
      expect(authorityCalls()).toContain('owner_runtime_authority');
    });
  });

  it('moves the heartbeat for a loop a lane writes inside the pass', async () => {
    const drain = vi.spyOn(OwnerDO.prototype as unknown as { drainApp: () => Promise<void> }, 'drainApp').mockImplementation(async function (this: { ctx: DurableObjectState }) {
      if (!this.ctx.storage.sql.exec("SELECT 1 FROM loops WHERE id = 'loop-lane'").toArray().length) loop(this.ctx, 'loop-lane', '2027-03-10T12:15');
    });
    try {
      await withOwner('next-due-lane-loop', 'app', '1', '2027-03-10T10:10:00Z', async ({ state, scheduler, alarm }) => {
        confirmZone(state, 'UTC');
        await armHeartbeat(scheduler, Z('2027-03-10T09:30:00Z') + 24 * 3_600_000 - 30 * 60_000);
        expect(await alarm()).toBe(Z('2027-03-10T12:30:00Z'));
        expect(dueOf(state, HEARTBEAT_ID)).toBe(Z('2027-03-10T12:30:00Z'));
        expect(authorityCalls()).toEqual([]);
      });
    } finally { drain.mockRestore(); }
  });
});

describe('turning the switch back off', () => {
  it('puts a heartbeat the switch moved back on its grid, so a card held through quiet hours goes out at their end', async () => {
    await withOwner('next-due-rollback', 'app', '1', '2027-03-12T05:10:00Z', async ({ state, scheduler, alarm, clock, restart }) => {
      confirmZone(state, 'UTC');
      loopBook(state.storage.sql, { newId: () => 'unused', now: Date.now }).setProactivity({ quiet_start: '22:00', quiet_end: '07:00', volume: 'normal' });
      await armHeartbeat(scheduler, Z('2027-03-12T05:30:00Z'));
      await alarm();
      expect(dueOf(state, HEARTBEAT_ID)).toBe(Z('2027-03-13T05:30:00Z'));
      restart('0');
      clock(Z('2027-03-12T05:20:00Z'));
      dayPlanBook(state.storage.sql);
      state.storage.sql.exec("INSERT INTO day_plan (day, card, time, reason, sent) VALUES ('2027-03-12', 'brief', '06:30', 'default time', 2)");
      let armed = await alarm();
      expect(armed).toBeLessThanOrEqual(Z('2027-03-12T05:30:00Z'));
      expect(dueOf(state, HEARTBEAT_ID)).toBe(Z('2027-03-12T05:30:00Z'));
      expect(state.storage.kv.get('owner_heartbeat_moved_v1')).toBeUndefined();
      // The ticks through quiet hours hold the card; the one at their end releases it to fire at once.
      for (let wakes = 0; armed !== null && armed <= Z('2027-03-12T07:00:00Z') && wakes < 20; wakes++) { clock(armed); armed = await alarm(); }
      expect(state.storage.sql.exec<{ occurrence_at: number }>("SELECT occurrence_at FROM schedule WHERE id = 'brief'").one().occurrence_at).toBe(Z('2027-03-12T07:00:00Z'));
    });
  });

  // With the switch on, a pass that cannot compute the bound leaves the heartbeat where it is. A row an earlier pass moved
  // goes back to its grid slot, or the fallback would wait out that move.
  const parked = (name: string, fallback: (state: DurableObjectState) => void) =>
    withOwner(name, 'app', '1', '2027-03-12T05:10:00Z', async ({ state, scheduler, alarm, clock, request }) => {
      confirmZone(state, 'UTC');
      await armHeartbeat(scheduler, Z('2027-03-12T05:30:00Z'));
      await alarm();
      expect(dueOf(state, HEARTBEAT_ID)).toBe(Z('2027-03-13T05:30:00Z'));
      clock(Z('2027-03-12T05:20:00Z'));
      fallback(state);
      await request();
      expect(dueOf(state, HEARTBEAT_ID)).toBe(Z('2027-03-12T05:30:00Z'));
      expect(await state.storage.getAlarm()).toBeLessThanOrEqual(Z('2027-03-12T05:30:00Z'));
    });
  it('puts a moved heartbeat back on its grid when a delivery record opens', () => parked('next-due-parked-record', state => {
    const held = Date.now() + 30 * 24 * 3_600_000;
    state.storage.kv.put('telegram_final_outbox_v1', [{ id: 'reminder:held', trace: 'held', status: 'pending', reason: 'window_refused', dueAt: held, createdAt: Date.now(), attempts: 1, payload: { chat_id: 7, text: 'Time to stretch.' } }]);
    state.storage.kv.put('telegram_final_outbox_due_v1', held);
  }));
  it('puts a moved heartbeat back on its grid for a loop due time it cannot read', () => parked('next-due-parked-unreadable', state => loop(state, 'loop-1', 'next week')));
  it('puts a moved heartbeat back on its grid with more open loops than its scan reads', () => parked('next-due-parked-many', state => {
    for (let i = 0; i < 201; i++) loop(state, `loop-${i}`, '2027-04-01T09:00');
  }));
  it('puts a moved heartbeat back on its grid when the zone stops being valid', () => parked('next-due-parked-zone', state => state.storage.kv.put('timezone', 'Not/AZone')));

  it('leaves a heartbeat on its grid alone, and with the switch off reads nothing when the switch never moved it', async () => {
    await withOwner('next-due-off-untouched', 'app', '0', '2027-03-12T05:10:00Z', async ({ state, scheduler, alarm }) => {
      confirmZone(state, 'UTC');
      await armHeartbeat(scheduler, Z('2027-03-12T05:30:00Z'));
      const armed = dueOf(state, HEARTBEAT_ID);
      await alarm();
      expect(dueOf(state, HEARTBEAT_ID)).toBe(armed);
      expect(state.storage.kv.get('owner_heartbeat_moved_v1')).toBeUndefined();
    });
  });
});

describe('a directory that cannot answer on the first wake after a release', () => {
  it('runs the retry wake in full, and marks the release only once boot work ran', async () => {
    await withOwner('next-due-release-retry', 'app', '1', '2027-03-10T10:00:00Z', async ({ state, scheduler, alarm, clock }) => {
      await armHeartbeat(scheduler, Date.now() - 10 * 60_000);
      state.storage.kv.put('owner_alarm_full_release_v1', 'an-earlier-release');
      wire.blips = 1;
      const retry = await alarm();
      expect(authorityCalls()).toEqual(['owner_runtime_authority']);
      expect(state.storage.kv.get('owner_alarm_full_release_v1')).toBe('an-earlier-release');
      expect(retry).toBeLessThanOrEqual(Date.now() + 60_000);
      clock(retry!);
      wire.asked = [];
      await alarm();
      expect(authorityCalls()).toContain('owner_runtime_authority');
      expect(state.storage.kv.get('owner_alarm_full_release_v1')).toBe(env.WALDO_RELEASE ?? 'unknown');
    });
  });

  it('keeps a cut-off pass open across a directory retry, so the retry wake still runs in full', async () => {
    await withOwner('next-due-resumed-retry', 'app', '1', '2027-03-10T10:00:00Z', async ({ state, scheduler, alarm, clock }) => {
      await armHeartbeat(scheduler, Date.now() - 10 * 60_000);
      state.storage.kv.put('owner_alarm_pass_open_v1', true);
      wire.blips = 1;
      const retry = await alarm();
      expect(state.storage.kv.get('owner_alarm_pass_open_v1')).toBe(true);
      clock(retry!);
      wire.asked = [];
      await alarm();
      expect(authorityCalls()).toContain('owner_runtime_authority');
      expect(state.storage.kv.get('owner_alarm_pass_open_v1')).toBeUndefined();
    });
  });
});

describe('a pass the platform cut off, and an owner the directory no longer admits', () => {
  it('runs the pass after an unfinished one in full, then marks it finished', async () => {
    await withOwner('next-due-resumed', 'app', '1', '2027-03-10T10:00:00Z', async ({ state, scheduler, alarm }) => {
      await armHeartbeat(scheduler, Date.now() - 10 * 60_000);
      state.storage.kv.put('owner_alarm_pass_open_v1', true);
      await alarm();
      expect(authorityCalls()).toContain('owner_runtime_authority');
      expect(state.storage.kv.get('owner_alarm_pass_open_v1')).toBeUndefined();
      wire.asked = [];
      await alarm();
      expect(authorityCalls()).toEqual([]);
    });
  });

  it('runs the first wake on a new release in full, so its boot work reaches the owner, then stops again', async () => {
    await withOwner('next-due-release', 'app', '1', '2027-03-10T10:00:00Z', async ({ state, scheduler, alarm }) => {
      await armHeartbeat(scheduler, Date.now() - 10 * 60_000);
      state.storage.kv.put('owner_alarm_full_release_v1', 'an-earlier-release');
      await alarm();
      expect(authorityCalls()).toContain('owner_runtime_authority');
      expect(state.storage.kv.get('owner_alarm_full_release_v1')).toBe(env.WALDO_RELEASE ?? 'unknown');
      wire.asked = [];
      await alarm();
      expect(authorityCalls()).toEqual([]);
    });
  });

  it('while a delivery record is open (a message held for WhatsApp\'s window), every wake runs in full and the heartbeat keeps its grid', async () => {
    await withOwner('next-due-held-record', 'app', '1', '2027-03-10T10:10:00Z', async ({ state, scheduler, alarm }) => {
      confirmZone(state, 'UTC');
      await armHeartbeat(scheduler, Z('2027-03-10T09:30:00Z') + 30 * 60_000);
      const held = Date.now() + 30 * 24 * 3_600_000;
      state.storage.kv.put('telegram_final_outbox_v1', [{ id: 'reminder:held', trace: 'held', status: 'pending', reason: 'window_refused', dueAt: held, createdAt: Date.now(), attempts: 1, payload: { chat_id: 7, text: 'Time to stretch.' } }]);
      state.storage.kv.put('telegram_final_outbox_due_v1', held);
      await alarm();
      expect(authorityCalls()).toContain('owner_runtime_authority');
      expect(dueOf(state, HEARTBEAT_ID)).toBe(Z('2027-03-10T10:30:00Z'));
    });
  });

  it('a revoked owner\'s daily tick holds the schedule, and no later wake is armed for it', async () => {
    await withOwner('next-due-revoked', 'app', '1', '2027-03-10T10:10:00Z', async ({ state, scheduler, alarm, clock }) => {
      confirmZone(state, 'UTC');
      await armHeartbeat(scheduler, Z('2027-03-10T09:30:00Z'));
      wire.revoked = true;
      const daily = await alarm();
      expect(daily).toBe(Z('2027-03-11T10:30:00Z'));
      expect(authorityCalls()).toEqual([]);
      clock(daily!);
      expect(await alarm()).toBeNull();
      expect(authorityCalls()).toEqual(['owner_runtime_authority']);
      clock(Z('2027-03-13T00:00:00Z'));
      expect(await alarm()).toBeNull();
    });
  });
});
