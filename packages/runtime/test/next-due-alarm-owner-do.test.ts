import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import { traceBook } from '../src/channels/harness';
import { armHeartbeat, HEARTBEAT_EVERY_MS, HEARTBEAT_ID } from '../src/channels/heartbeat';
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
const wire = { asked: [] as string[], fetches: 0 };
beforeEach(() => {
  wire.asked = []; wire.fetches = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    wire.fetches += 1;
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    if (fn) wire.asked.push(fn);
    if (fn === 'owner_runtime_authority') {
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
  work: (h: Readonly<{ state: DurableObjectState; scheduler: Scheduler; alarm: () => Promise<number | null>; clock: (iso: string | number) => void }>) => Promise<T>) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse(at));
  return runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
    state.storage.kv.put('do_name', name);
    if (surface === 'app') state.storage.kv.put('app_subject', String(appSubjectFor(name)));
    else state.storage.kv.put('telegram_subject', '7');
    const owner = new OwnerDO(state, { ...env, ...directory, NEXT_DUE_ALARM: flag, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
    const alarm = async () => { await state.storage.deleteAlarm(); await owner.alarm(); return state.storage.getAlarm(); };
    const clock = (to: string | number) => vi.setSystemTime(typeof to === 'number' ? to : Date.parse(to));
    try { return await work({ state, scheduler: new Scheduler(state.storage.sql, state.storage, productionDeps()), alarm, clock }); }
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

  it('keeps the heartbeat on its interval phase, and holds it in quiet hours and inside a loop\'s cooldown', async () => {
    await withOwner('next-due-heartbeat', 'app', '1', '2027-03-13T21:50:00Z', async ({ state, scheduler, alarm, clock }) => {
      state.storage.kv.put('timezone', 'UTC'); state.storage.kv.put('timezone_confirmed', true);
      await armHeartbeat(scheduler, Date.parse('2027-03-13T21:30:00Z'));
      const first = dueOf(state, HEARTBEAT_ID);
      expect(first).toBe(Date.parse('2027-03-13T22:00:00Z'));
      const checks = () => state.storage.sql.exec<{ note: string }>("SELECT note FROM trace_log WHERE hop = 'machine_check' ORDER BY id").toArray().map(row => row.note);
      const loops = loopBook(state.storage.sql, { newId: () => 'loop-1', now: Date.now });
      loops.setProactivity({ quiet_start: '22:00', quiet_end: '07:00', volume: 'normal' });
      expect(await alarm()).toBe(first);
      expect(authorityCalls()).toEqual([]);
      // Due in quiet hours: the tick runs, holds, and the next one stays on the grid.
      clock(first);
      expect(await alarm()).toBe(first + HEARTBEAT_EVERY_MS);
      expect(state.storage.sql.exec<{ heartbeat_result: string }>('SELECT heartbeat_result FROM schedule_runs WHERE schedule_id = ?', HEARTBEAT_ID).one().heartbeat_result).toBe('quiet');
      expect(checks()).toEqual(['held_quiet']);
      expect((dueOf(state, HEARTBEAT_ID) - first) % HEARTBEAT_EVERY_MS).toBe(0);
      // Out of quiet hours, a past-due loop told about within its cooldown writes no check-back.
      loops.setProactivity({ quiet_start: null, quiet_end: null, volume: 'normal' });
      state.storage.sql.exec("INSERT INTO loops (id, title, due, status, created_at) VALUES ('loop-1', 'send the deck', '2027-03-13T20:00', 'open', ?)", Date.now());
      state.storage.sql.exec("INSERT INTO heartbeat_notified (loop_id, due, notified_at) VALUES ('loop-1', '2027-03-13T20:00', ?)", Date.now());
      clock(dueOf(state, HEARTBEAT_ID));
      const after = await alarm();
      expect(after).toBe(first + 2 * HEARTBEAT_EVERY_MS);
      expect(state.storage.sql.exec<{ heartbeat_result: string }>('SELECT heartbeat_result FROM schedule_runs WHERE schedule_id = ? ORDER BY fired_at DESC LIMIT 1', HEARTBEAT_ID).one().heartbeat_result).toBe('quiet');
      expect(checks()).toEqual(['held_quiet', 'unchanged']);
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM task_jobs").one().n).toBe(0);
    });
  });
});
