import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { appSubjectFor } from '../src/channels/app-api';
import { applyDayPlan, dayPlanBook } from '../src/channels/day-cards';
import { reopensAt } from '../src/channels/interruptions';
import { notifyOwnerHealthSamples } from '../src/health/zone-change-route';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';

// The wake Brief on the real owner object (WAKE_BRIEF): the Worker or a WHOOP sync says only that a night just ended, and a
// Brief still to come gets one model turn on its own queue: now, earlier, or keep. Never later. The night's own times never
// reach the owner object or the model. Google, the health plane and the model are fakes; nothing here is a real reading.
const SECRET = 'router-secret-fixture-0000000000';
const OWNER_ID = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
const TODAY = '2026-10-20';
const at = (hhmm: string) => Date.parse(`${TODAY}T${hhmm}:00Z`);

const world = vi.hoisted(() => ({ consent: true, wakes: [] as string[], replans: [] as string[], wakeReply: '' }));
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
    const text = content.includes('a night that just ended') ? (world.wakes.push(content), world.wakeReply)
      : content.includes('calendar just changed') ? (world.replans.push(content), JSON.stringify({ cards: [] })) : 'SKIP';
    return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const CONFIG = { ...env, WALDO_OWNER_TELEGRAM_ID: undefined, WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture',
  GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret', WALDO_ROUTER_HMAC_SECRET: SECRET, SUPABASE_PROJECT_URL: 'https://edge.test',
  SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WAKE_BRIEF: '1', CALENDAR_GROUNDED_PREP: '0' };
const reply = (time: string) => JSON.stringify({ cards: [{ id: 'card:brief', time, reason: 'model reason' }] });

let sequence = 0;
beforeEach(() => {
  world.consent = true; world.wakes = []; world.replans = []; world.wakeReply = reply('now');
  vi.useFakeTimers({ toFake: ['Date'], now: at('07:05') });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, string | number> : {};
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: body.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'health_series_read') return Response.json({ access: 'granted', read_at: new Date().toISOString(), sources: [] });
    if (fn === 'health_scores_read' || fn === 'health_scores_history') return Response.json({ unavailable: 'no_readings' });
    // The model-use consented read: with that consent withdrawn it returns nothing.
    if (fn === 'health_context_read') return Response.json(world.consent ? { context: { id: 'ctx', day: TODAY, basis: [{ source: 'apple', consent_epoch: 1 }], drivers: [] }, previous: null } : null);
    if (fn === 'assert_channel_presence') return Response.json(false);
    return fn ? Response.json(true) : new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

type Owner = { fetch(request: Request): Promise<Response>; setup(channel: string): { ready: Promise<unknown> } };
type Desk = Readonly<{ state: DurableObjectState; due(): number | undefined; notice(hhmm: string, woke?: boolean): Promise<void>; codes(): string[] }>;
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
    // The Worker's signed notice at `hhmm`, as an app upload or a WHOOP sync sends it.
    const notice = async (hhmm: string, woke = true) => {
      vi.setSystemTime(at(hhmm));
      await notifyOwnerHealthSamples({ idFromName: (name: string) => name as never, get: () => ({ fetch: (request: Request) => owner.fetch(request) }) }, SECRET, doName, 'readings', woke);
    };
    const codes = () => state.storage.sql.exec<{ note: string | null }>("SELECT note FROM trace_log WHERE hop = 'brief_wake' ORDER BY rowid").toArray().map(row => String(row.note));
    try { await work({ state, due: () => scheduler.read('card:brief')?.due_at, notice, codes }); } finally { await state.storage.deleteAlarm(); }
  });
};
const dump = (state: DurableObjectState) => JSON.stringify([
  state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray().map(({ name }) => [name, state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray()]),
  [...state.storage.kv.list()],
]);

describe('the wake Brief', () => {
  it('golden: a night just ended at 07:05, the model sends the Brief now, and the owner\'s day opens with it', async () => {
    await withOwner(async ({ state, due, notice, codes }) => {
      await notice('07:05');
      await vi.waitFor(() => expect(codes()).toEqual(['woke', 'now']));
      expect(due()! - at('07:05')).toBeGreaterThanOrEqual(0);
      expect(due()! - at('07:05')).toBeLessThan(60_000);
      expect(world.wakes).toHaveLength(1);
      expect(world.wakes[0]).toContain('planned 08:00');
      expect(world.wakes[0]).toContain('Tuesday');
      const book = dayPlanBook(state.storage.sql);
      expect(book.read(TODAY).find(row => row.card === 'card:brief')).toMatchObject({ time: '07:05', state: 'pending' });
      expect(reopensAt(at('07:06'), 'UTC', day => book.window(day, 'UTC'))).toBeNull();
      // The trace's ids and codes say nothing of when: no clock time in any wake row.
      const traces = state.storage.sql.exec<{ trace: string; note: string | null }>("SELECT trace, note FROM trace_log WHERE hop = 'brief_wake'").toArray();
      for (const row of traces) expect(`${row.trace} ${row.note}`).not.toMatch(/\d{2}:\d{2}|\d{13}/);
      expect(dump(state)).not.toContain('"woke":true');
    });
  });

  it('a wake the model keeps, or would move later, leaves the planned time; one already moved is not asked about again', async () => {
    await withOwner(async ({ due, notice, codes }) => {
      world.wakeReply = reply('08:00');
      await notice('03:10');
      await vi.waitFor(() => expect(codes()).toEqual(['woke', 'kept']));
      world.wakeReply = reply('09:30');
      await notice('05:00');
      await vi.waitFor(() => expect(codes()).toEqual(['woke', 'kept', 'woke', 'kept']));
      expect(due()).toBe(at('08:00'));
      world.wakeReply = reply('07:30');
      await notice('07:05');
      await vi.waitFor(() => expect(codes().at(-1)).toBe('earlier'));
      expect(due()).toBe(at('07:30'));
      world.wakeReply = reply('now');
      await notice('07:40');
      await vi.waitFor(() => expect(codes().at(-1)).toBe('nothing_to_move'));
      expect(world.wakes).toHaveLength(3);
    });
  });

  it('stops asking the model past the deployment\'s turns a day', async () => {
    await withOwner(async ({ due, notice, codes }) => {
      world.wakeReply = reply('08:00');
      await notice('03:10');
      await vi.waitFor(() => expect(codes()).toEqual(['woke', 'kept']));
      await notice('04:10');
      await vi.waitFor(() => expect(codes()).toEqual(['woke', 'kept', 'woke', 'turn_limit']));
      expect(world.wakes).toHaveLength(1);
      expect(due()).toBe(at('08:00'));
    }, { ...CONFIG, WAKE_BRIEF_TURNS_PER_DAY: '1' });
  });
});

describe('the wake Brief falls back to the planned time', () => {
  const preference = (state: DurableObjectState, kind: string, enabled: boolean) =>
    state.storage.sql.exec('INSERT INTO schedule_preferences (kind, enabled) VALUES (?, ?) ON CONFLICT (kind) DO UPDATE SET enabled = excluded.enabled', kind, enabled ? 1 : 0);

  it('with model-use health consent withdrawn after the upload', async () => {
    await withOwner(async ({ due, notice, codes }) => {
      world.consent = false;
      await notice('07:05');
      expect(codes()).toEqual(['no_consent']);
      expect(due()).toBe(at('08:00'));
    });
    expect(world.wakes).toEqual([]);
  });

  it('with no night in the readings (no wearable, nothing shared): the notice carries no wake', async () => {
    await withOwner(async ({ due, notice, codes }) => {
      await notice('07:05', false);
      expect(codes()).toEqual([]);
      expect(due()).toBe(at('08:00'));
    });
    expect(world.wakes).toEqual([]);
  });

  it('with the daily Brief off', async () => {
    await withOwner(async ({ state, notice, codes }) => {
      preference(state, 'daily_brief', false);
      await notice('07:05');
      expect(codes()).toEqual(['brief_off']);
    });
    expect(world.wakes).toEqual([]);
  });

  it('with WAKE_BRIEF off, a wake notice changes nothing', async () => {
    await withOwner(async ({ due, notice, codes }) => {
      await notice('07:05');
      expect(codes()).toEqual([]);
      expect(due()).toBe(at('08:00'));
    }, { ...CONFIG, WAKE_BRIEF: '0' });
    expect(world.wakes).toEqual([]);
  });

  it('with a Brief already due when the night comes in: it runs as planned, asking nothing', async () => {
    await withOwner(async ({ state, due, notice, codes }) => {
      await applyDayPlan(new Scheduler(state.storage.sql, state.storage, productionDeps()), dayPlanBook(state.storage.sql), 'UTC', at('06:00'), [{ card: 'card:brief', time: '07:00', reason: 'model plan' }], false);
      await notice('07:05');
      await vi.waitFor(() => expect(codes()).toEqual(['woke', 'nothing_to_move']));
      expect(due()).toBe(at('07:00'));
    });
    expect(world.wakes).toEqual([]);
  });
});
