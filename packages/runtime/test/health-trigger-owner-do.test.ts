import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarItem } from '../src/connectors/google';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { loopBook } from '../src/channels/loops';
import { HEALTH_TRIGGER_ID } from '../src/health/trigger';
import { notifyOwnerZoneChange } from '../src/health/zone-change-route';
import { armAlarm } from '../src/scheduler/alarm-slot';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';

// The health trigger end to end on the real owner object: a zone-change notice from the Worker, a real alarm pass, the
// consented read of the derived row, one scripted model call, and the one approval card it ends in. The database, Google
// and the model are fakes; every reading is synthetic and none may be found anywhere the trigger is not allowed to put it.
const SECRET = 'router-secret-fixture-0000000000';
const OWNER_ID = '4a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const NOW = Date.parse('2026-10-21T03:30:00Z'); // 09:00 in Kolkata
const LEAKS = ['47.3', '37.9', '61.4', '52.6'];
const REVIEW: CalendarItem = { id: 'gcal-review-1', title: 'Quarterly board review', status: 'confirmed', start: '2026-10-21T14:00:00+05:30', end: '2026-10-21T15:30:00+05:30', all_day: false, description: null, etag: 'r1' };
const ROW = {
  context: {
    id: 'ctx-1', day: '2026-10-21', compiled_at: '2026-10-21T03:00:00Z', basis: [{ source: 'whoop', consent_epoch: 1 }], confidence: 0.8, freshness: 'fresh', drivers: [], tags: [],
    recovery: { score: 47.3, zone: 'low', algorithm_version: 'recovery.candidate.v1', activation: 'candidate_unaccepted' },
    form: { score: 37.9, zone: 'low', algorithm_version: 'form.candidate.v3', activation: 'candidate_unaccepted' },
    weight: { score: 61.4, zone: 'high', algorithm_version: 'weight.candidate.v3', activation: 'candidate_unaccepted' },
  },
  previous: { day: '2026-10-20', form_score: 52.6, recovery_zone: 'good', weight_zone: 'moderate', basis: [{ source: 'whoop', consent_epoch: 1 }] },
};

const fixture = vi.hoisted(() => ({
  event: null as CalendarItem | null, health: null as unknown, requests: [] as LLMGatewayRequest[], decision: '' as string, writes: 0,
}));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (_app: unknown, _tokens: unknown, _fetch: unknown, _health: unknown, account: unknown) => ({
    account, events: async () => (fixture.event ? [fixture.event] : []),
    calendarPage: async () => ({ events: fixture.event ? [fixture.event] : [], next_page_token: null, fetched_count: 1, account, observed_at: new Date().toISOString() }),
    event: async () => fixture.event, changedEvents: async () => [], newMail: async () => [],
    updateEvent: async () => { fixture.writes += 1; throw new Error('the trigger must not write to Google'); },
  }) };
});
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async () => true }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway: LLMGatewayAdapter = { async complete(request) {
    fixture.requests.push(request);
    const format = request.request.response_format?.name;
    const text = format === 'health_proposal' ? fixture.decision : format === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : 'SKIP';
    return { ok: true, data: { model: request.request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const CONFIG = { ...env, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'Asia/Kolkata', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture',
  GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret', WALDO_ROUTER_HMAC_SECRET: SECRET, SUPABASE_PROJECT_URL: 'https://edge.test', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable' };
const move = (start: string, end: string) => JSON.stringify({ kind: 'propose', action: 'move', item: 'e1', start, end, title: null, notify_guests: true, reason: 'Recovery is compromised; a later slot gives you a slower morning.' });

let sequence = 0;
const printed: string[] = [];
beforeEach(() => {
  fixture.event = REVIEW; fixture.health = ROW; fixture.requests = []; fixture.writes = 0; printed.length = 0;
  fixture.decision = move('2026-10-21T16:00', '2026-10-21T17:30');
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  for (const method of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { printed.push(args.map(String).join(' ')); });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, string | number> : {};
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, init?.body);
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: body.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'health_context_read') return Response.json(fixture.health);
    if (fn === 'assert_channel_presence' || fn === 'set_owner_settings') return Response.json(true);
    return fn ? Response.json(null) : new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

const dump = (state: DurableObjectState) => JSON.stringify([
  state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray().map(({ name }) => [name, state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray()]),
  [...state.storage.kv.list()],
]);

const withOwner = (work: (o: { owner: { fetch(request: Request): Promise<Response>; alarm(): Promise<void> }; state: DurableObjectState; doName: string; pass(): Promise<void>; notify(day?: string): Promise<void> }) => Promise<void>) => {
  const doName = `health-trigger-do-${sequence++}`;
  return runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(doName)), async (_i, state) => {
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', doName); state.storage.kv.put('telegram_subject', '7');
    await state.storage.put('origin', 'https://fixture.invalid');
    await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only', scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
    const owner = new OwnerDO(state, CONFIG as never) as unknown as { fetch(request: Request): Promise<Response>; alarm(): Promise<void> };
    const notify = async (day = '2026-10-21') => notifyOwnerZoneChange({ idFromName: (name: string) => name as never, get: () => ({ fetch: (request: Request) => owner.fetch(request) }) }, SECRET, doName, day);
    const pass = async () => { await armAlarm(state.storage, Date.now()); await state.storage.deleteAlarm(); state.storage.kv.put('owner_alarm_last_v1', 0); await owner.alarm(); };
    try { await work({ owner, state, doName, pass, notify }); } finally { await state.storage.deleteAlarm(); }
  });
};
const runs = (state: DurableObjectState) => state.storage.sql.exec<{ local_day: string; mode: string; outcome: string; approval_id: string | null }>('SELECT local_day, mode, outcome, approval_id FROM health_trigger_runs').toArray();
const evaluations = () => fixture.requests.filter(r => r.request.response_format?.name === 'health_proposal');

describe('the health trigger on the owner object', () => {
  it('turns a zone change and a coming meeting into one approval card, in zone words only, with nothing written to Google', async () => {
    await withOwner(async ({ state, pass, notify }) => {
      await notify();
      expect(state.storage.sql.exec('SELECT day FROM health_trigger_pending').toArray()).toEqual([{ day: '2026-10-21' }]);
      expect(state.storage.sql.exec<{ kind: string }>('SELECT kind FROM schedule WHERE id = ?', HEALTH_TRIGGER_ID).toArray()).toEqual([{ kind: 'patrol' }]);
      await pass();
      expect(evaluations()).toHaveLength(1);
      const sent = JSON.stringify(evaluations()[0]!.request);
      expect(sent).toContain('recovery compromised');
      expect(sent).toContain('Quarterly board review');
      const [run] = runs(state);
      expect(run).toMatchObject({ local_day: '2026-10-21', mode: 'live', outcome: 'proposed' });
      expect(run!.approval_id).toBeTruthy();
      expect(fixture.writes).toBe(0);
      expect(state.storage.sql.exec('SELECT day FROM health_trigger_pending').toArray()).toEqual([]);
      for (const leak of LEAKS) for (const [where, text] of [['the model request', sent], ['tables and storage', dump(state)], ['printed lines', printed.join('\n')]] as const) expect(text, `${leak} in ${where}`).not.toContain(leak);
    });
  });

  it('asks nothing of the model when health sharing is off: no readable row, no evaluation, the mark cleared', async () => {
    fixture.health = null;
    await withOwner(async ({ state, pass, notify }) => {
      await notify();
      await pass();
      expect(evaluations()).toHaveLength(0);
      expect(runs(state)).toEqual([]);
      expect(state.storage.sql.exec('SELECT day FROM health_trigger_pending').toArray()).toEqual([]);
    });
  });

  it('proposes nothing when the model judges the change does not matter', async () => {
    fixture.decision = JSON.stringify({ kind: 'no_op', action: null, item: null, start: null, end: null, title: null, notify_guests: null, reason: '' });
    await withOwner(async ({ state, pass, notify }) => {
      await notify();
      await pass();
      expect(evaluations()).toHaveLength(1);
      expect(runs(state)).toMatchObject([{ outcome: 'no_op', approval_id: null }]);
    });
  });

  it('holds a change that arrives in quiet hours and still evaluates it when they end, through the real scheduler', async () => {
    await withOwner(async ({ state, pass, notify }) => {
      vi.setSystemTime(Date.parse('2026-10-20T17:30:00Z')); // 23:00 in Kolkata
      loopBook(state.storage.sql, { newId: () => 'fixture', now: () => Date.now() }).setProactivity({ quiet_start: '22:00', quiet_end: '07:00', volume: 'normal' });
      await notify('2026-10-20');
      await pass();
      expect(evaluations()).toHaveLength(0);
      const held = state.storage.sql.exec<{ due_at: number }>('SELECT due_at FROM schedule WHERE id = ?', HEALTH_TRIGGER_ID).toArray();
      expect(held).toHaveLength(1);
      expect(held[0]!.due_at).toBe(Date.parse('2026-10-21T01:30:00Z')); // 07:00 in Kolkata
      vi.setSystemTime(Date.parse('2026-10-21T03:30:00Z'));
      await pass();
      expect(evaluations()).toHaveLength(1);
    });
  });
});
