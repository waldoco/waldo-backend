// What Waldo sends and when, from the app's settings: the day view's schedule_controls and its schedule.set action (controls
// revision 16), through the Worker and the owner's Durable Object, on the receipt-bearing path proactivity.set uses (auth, owner
// check, revision, request_id). Each schedule turns on and off where the scheduler reads it; the Brief and the Close take the
// owner's time, which today's card follows at once. The clock is mocked: the owner's zone is UTC.
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { APP_CONTROLS_CLAIM_CONTROLS_REVISION, APP_CONTROLS_SCHEDULE_REVISION, APP_SCHEDULE_RECEIPTS_V1, appControlProjectionV1Schema, appControlResultV1Schema } from '../../contracts/src/app/controls';
import { APP_CONTRACT_HEADER } from '../../contracts/src/app/core';
import { OwnerDO } from '../src/channels/owner-do';
import { handleApp } from '../src/channels/app-api';
import { dayPlanBook } from '../src/channels/day-cards';
import { schedulePreferences } from '../src/channels/schedule-preferences';
import { loopBook } from '../src/channels/loops';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { jobBook } from '../src/tasks/jobs';
import { enqueueMachine } from '../src/tasks/machine';

vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async () => { throw Error('No Telegram binding exists'); } }));

const SECRET = 'fictional-schedule-router-secret-00000000000000', DIRECTORY = 'https://schedule-app.fixture.invalid', ORIGIN = 'https://app.fixture.invalid';
const OWNER = '10000000-0000-0000-0000-000000000016', AUTH = '20000000-0000-0000-0000-000000000016', EMAIL = 'schedule-owner@example.test', WHATSAPP = '15550001111';

type Directory = { whatsapp: 'linked' | 'not_linked' | 'down' };
type App = (path: string, body?: unknown) => Promise<Response>;
type World = { app: App; storage: DurableObjectStorage; directory: Directory };

const fixture = async (run: (world: World) => Promise<void>, options: { revision?: number; bound?: boolean; wake?: boolean; confirmed?: boolean } = {}) => {
  const name = `app-schedule-owner-${crypto.randomUUID()}`, stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_unused, state) => {
    let hash: string | undefined, live = false;
    const created = new Date().toISOString(), expires = Date.now() + 3_600_000, directory: Directory = { whatsapp: 'linked' };
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input)); expect(url.origin).toBe(DIRECTORY); const a = JSON.parse(String(init?.body ?? '{}'));
      if (url.pathname === '/auth/v1/otp') return Response.json({});
      if (url.pathname === '/auth/v1/verify') return Response.json({ user: { id: AUTH, email: EMAIL } });
      const fn = url.pathname.split('/').at(-1)!;
      if (fn === 'presence_hint') {
        if (a.p_provider !== 'whatsapp') return Response.json(null);
        if (directory.whatsapp === 'down') return new Response('down', { status: 503 });
        return Response.json(directory.whatsapp === 'linked' ? '1111' : null);
      }
      if (fn === 'console_auth_throttle') return Response.json(true);
      if (fn === 'signin_allowed') return Response.json(a.p_email === EMAIL);
      if (fn === 'owner_for_auth') return Response.json(a.p_auth_user === AUTH && a.p_email === EMAIL ? name : null);
      if (fn === 'console_session_open') { hash = a.p_session_hash; live = true; return Response.json(true); }
      if (fn === 'console_session_touch') return Response.json(live && a.p_session_hash === hash);
      if (fn === 'console_session_inventory') return Response.json(live && a.p_do_name === name ? [{ session: hash, created_at: created, last_seen_at: created, expires_at: new Date(Date.parse(created) + 12 * 60 * 60_000).toISOString(), rotated_to: null, signed_in_at: created }] : []);
      if (fn === 'owner_runtime_authority') return Response.json(a.p_do_name === name ? { owner_id: OWNER, auth_user_id: AUTH, do_name: name, state_version: 0, admission_revision: '1' } : null);
      if (fn === 'app_session_authority') return Response.json(live && a.p_do_name === name && a.p_session_hash === hash ? { owner_id: OWNER, do_name: name, session_hash: hash, state_version: 0, admission_revision: '1', expires_at: expires } : null);
      if (fn === 'workspace_owner_binding') return Response.json({ owner_id: OWNER, environment: 'staging', namespace: 'schedule-app-owner', do_name: name, do_id: state.id.toString(), state_version: 0, mapping_version: 1 });
      if (fn === 'health_plane' || fn === 'health_context_read') return Response.json(null);
      if (fn === 'google_connections' || fn === 'connections_list') return Response.json([]);
      throw Error(`Unlisted fixture RPC ${fn}`);
    });
    const settings = { ...env, TELEGRAM_BOT_TOKEN: undefined, WALDO_OWNER_TELEGRAM_ID: undefined, OPENAI_API_KEY: 'synthetic-model-key', COMMON_OWNER_TASKS: '0', COMMON_BROWSER_REGISTRATION: undefined, WALDO_ENVIRONMENT: 'staging',
      WALDO_OWNER_DO_NAMESPACE: 'schedule-app-owner', WALDO_OWNER_TIMEZONE: 'UTC', SUPABASE_PROJECT_URL: DIRECTORY, SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: SECRET,
      WHATSAPP_ACCESS_TOKEN: 'synthetic-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: '100000000000001', GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined, WAKE_BRIEF: options.wake ? '1' : undefined };
    // A set-up owner: the zone is confirmed, so the app's runtime arms the day's own jobs.
    state.storage.kv.put('timezone', 'UTC'); if (options.confirmed !== false) state.storage.kv.put('timezone_confirmed', true);
    const instance = new OwnerDO(state, settings as never);
    if (options.bound !== false) state.storage.kv.put('whatsapp_subject', WHATSAPP);
    const routed = { ...settings, OWNER_DO: { idFromName: (n: string) => env.OWNER_DO!.idFromName(n), get: () => ({ fetch: (r: Request) => instance.fetch(r) }) } } as never;
    let credential: string | undefined;
    const app: App = async (path, body) => {
      const response = await handleApp(new Request(`${ORIGIN}/app/v1${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', [APP_CONTRACT_HEADER]: `controls=${options.revision ?? APP_CONTROLS_SCHEDULE_REVISION}`, ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), routed);
      expect(response).not.toBeNull(); return response!;
    };
    try {
      expect((await app('/auth/code', { email: EMAIL })).status).toBe(200);
      credential = ((await (await app('/auth/verify', { email: EMAIL, code: '123456' })).json()) as { credential: string }).credential;
      await run({ app, storage: state.storage, directory });
    } finally { fetcher.mockRestore(); }
  });
};

type Row = { id: string; on: boolean; accepts: string; time: string | null; no_later_than: boolean };
const dayView = async (app: App) => {
  const response = await app('/controls?view=day');
  expect(response.status).toBe(200);
  return appControlProjectionV1Schema.parse(await response.json()) as { revision: string; data: { schedules: Record<string, boolean>; schedule_controls?: Row[]; cards: { id: string; time: string | null; pin: string | null }[] } };
};
let requests = 0;
const set = async (app: App, id: string, value: string, revision: string, request_id = `schedule-request-${++requests}`) => {
  const response = await app('/actions', { view: 'day', action: 'schedule.set', id, value, revision, request_id });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};
const receipt = (body: Record<string, unknown>) => appControlResultV1Schema.parse(body).receipt;
const due = (storage: DurableObjectStorage, id: string) => { const found = new Scheduler(storage.sql, storage, productionDeps()).lookup(id); return found.state === 'entry' ? found.entry.due_at : null; };
const NOW = Date.parse('2026-11-06T05:00:00Z');
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

it('lists the five schedules and the Brief and Close times; a build below 16 sees neither and is refused the action', async () => {
  await fixture(async ({ app }) => {
    expect((await dayView(app)).data.schedule_controls).toEqual([
      { id: 'daily_brief', on: true, accepts: 'on_off', time: null, no_later_than: false }, { id: 'followups', on: true, accepts: 'on_off', time: null, no_later_than: false },
      { id: 'event_briefs', on: true, accepts: 'on_off', time: null, no_later_than: false }, { id: 'nightly', on: true, accepts: 'on_off', time: null, no_later_than: false },
      { id: 'heartbeat', on: true, accepts: 'on_off', time: null, no_later_than: false },
      { id: 'card:brief', on: true, accepts: 'time', time: '08:00', no_later_than: false }, { id: 'card:close', on: true, accepts: 'time', time: '21:30', no_later_than: false },
    ]);
  });
  await fixture(async ({ app, storage }) => {
    const day = await dayView(app);
    expect(day.data.schedule_controls).toBeUndefined();
    const refused = await set(app, 'daily_brief', 'off', day.revision);
    expect([refused.status, refused.body]).toEqual([400, { error: 'invalid_action' }]);
    expect(schedulePreferences(storage.sql, loopBook(storage.sql, { newId: () => 'x', now: Date.now })).enabled('daily_brief')).toBe(true);
  }, { revision: APP_CONTROLS_CLAIM_CONTROLS_REVISION });
});

it('turns each schedule off and back on where the scheduler reads it, with a receipt for each, and says when nothing changed', async () => {
  await fixture(async ({ app, storage }) => {
    for (const id of ['daily_brief', 'followups', 'event_briefs', 'nightly', 'heartbeat']) {
      let day = await dayView(app);
      expect([id, receipt((await set(app, id, 'off', day.revision)).body)]).toEqual([id, APP_SCHEDULE_RECEIPTS_V1.off]);
      day = await dayView(app);
      expect([id, day.data.schedules[id], day.data.schedule_controls!.find(row => row.id === id)!.on]).toEqual([id, false, false]);
      expect([id, receipt((await set(app, id, 'off', day.revision)).body)]).toEqual([id, APP_SCHEDULE_RECEIPTS_V1.already_off]);
      if (id === 'daily_brief') {
        // Off stops the day cards: no entry is left to wake, and the times say they follow it.
        expect([due(storage, 'card:brief'), due(storage, 'card:close')]).toEqual([null, null]);
        expect(day.data.schedule_controls!.filter(row => row.accepts === 'time').map(row => row.on)).toEqual([false, false]);
      }
      day = await dayView(app);
      expect([id, receipt((await set(app, id, 'on', day.revision)).body)]).toEqual([id, APP_SCHEDULE_RECEIPTS_V1.on]);
      expect([id, (await dayView(app)).data.schedules[id]]).toEqual([id, true]);
      expect([id, receipt((await set(app, id, 'on', (await dayView(app)).revision)).body)]).toEqual([id, APP_SCHEDULE_RECEIPTS_V1.already_on]);
    }
    // On again, today's cards still to come are armed again.
    expect([due(storage, 'card:brief'), due(storage, 'card:close')]).toEqual([Date.parse('2026-11-06T08:00:00Z'), Date.parse('2026-11-06T21:30:00Z')]);
  });
});

it('turning the check-in off from the app cancels its open background job, as the agent tool does', async () => {
  await fixture(async ({ app, storage }) => {
    let n = 0;
    const book = jobBook(storage.sql, { now: Date.now, newId: () => `job${(n += 1).toString().padStart(9, '0')}`, newToken: () => `tok-${n}` });
    const made = enqueueMachine(book, { job: 'heartbeat', scope: 'owner', key: 'machine:heartbeat:heartbeat-tick:1', surface: 'app',
      text: { title: 'Loop check-back', goal: 'Check these loops.', done_when: 'Return no findings when nothing is worth telling.' },
      items: [{ ref: 'l1', detail: 'Chase the quote (due 2026-11-07 09:00)' }], timezone: 'UTC', now: NOW, deadlineAt: NOW + 30 * 60_000 }, []);
    const id = (made as { job: { id: string } }).job.id;
    expect(receipt((await set(app, 'heartbeat', 'off', (await dayView(app)).revision)).body)).toEqual(APP_SCHEDULE_RECEIPTS_V1.off);
    expect(book.get(id)).toMatchObject({ status: 'cancelled', cancel_reason: 'owner' });
  });
});

it('a new Brief time moves today\'s Brief once, keeps it for every day, and a replay is the same receipt with no second change', async () => {
  await fixture(async ({ app, storage }) => {
    const day = await dayView(app);
    const saved = await set(app, 'card:brief', '07:10', day.revision, 'schedule-brief-0001');
    expect([saved.status, receipt(saved.body), saved.body.duplicate]).toEqual([200, { state: 'recorded', message: 'Saved. Your Brief comes at 7:10am.' }, false]);
    expect(due(storage, 'card:brief')).toBe(Date.parse('2026-11-06T07:10:00Z'));
    expect(dayPlanBook(storage.sql).pins()).toEqual({ 'card:brief': '07:10' });
    const replayed = await set(app, 'card:brief', '07:10', day.revision, 'schedule-brief-0001');
    expect([replayed.status, receipt(replayed.body), replayed.body.duplicate]).toEqual([200, receipt(saved.body), true]);
    const after = await dayView(app);
    expect(after.data.schedule_controls!.find(row => row.id === 'card:brief')).toEqual({ id: 'card:brief', on: true, accepts: 'time', time: '07:10', no_later_than: false });
    expect(after.data.cards.find(card => card.id === 'card:brief')).toMatchObject({ time: '07:10', pin: '07:10' });
    // The old read is stale now: a change made since cannot be overwritten blind.
    expect((await set(app, 'card:close', '22:00', day.revision)).status).toBe(409);
    expect(receipt((await set(app, 'card:brief', '07:10', after.revision)).body).message).toBe('Your Brief already comes at 7:10am.');
  });
});

it('a time set just past now sends today\'s card now, once; the Close reads 9:30pm', async () => {
  await fixture(async ({ app, storage }) => {
    expect(receipt((await set(app, 'card:brief', '04:30', (await dayView(app)).revision)).body).message).toBe("Saved. Your Brief comes at 4:30am. Today's is on its way now.");
    expect(due(storage, 'card:brief')).toBe(NOW);
    expect(receipt((await set(app, 'card:close', '21:30', (await dayView(app)).revision)).body).message).toBe('Saved. Your Close comes at 9:30pm.');
  });
});

it('a new time inside quiet hours says it waits for them to end', async () => {
  await fixture(async ({ app, storage }) => {
    loopBook(storage.sql, { newId: () => 'x', now: Date.now }).setProactivity({ quiet_start: '22:00', quiet_end: '07:00', volume: 'normal' });
    expect(receipt((await set(app, 'card:close', '23:15', (await dayView(app)).revision)).body).message).toBe('Saved. Your Close comes at 11:15pm. That is inside your quiet hours, so it waits until they end.');
  });
});

it('before the owner confirms their zone, a new time is kept and the receipt says the cards start once they do, not that they are off', async () => {
  await fixture(async ({ app, storage }) => {
    const day = await dayView(app);
    expect(day.data.schedule_controls!.find(row => row.id === 'card:brief')?.on).toBe(true);
    expect(receipt((await set(app, 'card:brief', '07:10', day.revision)).body).message).toBe('Saved. Your Brief comes at 7:10am. Your day cards start once you confirm your time zone.');
    expect(dayPlanBook(storage.sql).pins()).toEqual({ 'card:brief': '07:10' });
  }, { confirmed: false });
});

it('with WAKE_BRIEF, the Brief time is the latest it comes, in the receipt and the projection', async () => {
  await fixture(async ({ app }) => {
    expect(receipt((await set(app, 'card:brief', '07:10', (await dayView(app)).revision)).body).message).toBe('Saved. Your Brief comes by 7:10am, earlier when you wake before then.');
    expect((await dayView(app)).data.schedule_controls!.find(row => row.id === 'card:brief')?.no_later_than).toBe(true);
  }, { wake: true });
});

it('refuses an unknown schedule, a time for an on/off schedule and a malformed time with the fixed refusal, changing nothing', async () => {
  await fixture(async ({ app, storage }) => {
    const day = await dayView(app);
    for (const [id, value] of [['health_proposals', 'off'], ['card:midday', '13:00'], ['nightly', '03:00'], ['card:brief', '7:10'], ['card:brief', '25:00'], ['card:close', 'off'], ['heartbeat', 'maybe']] as const) {
      const refused = await set(app, id, value, day.revision);
      expect([id, value, refused.status, refused.body]).toEqual([id, value, 400, { error: 'invalid_action' }]);
    }
    expect([dayPlanBook(storage.sql).pins(), due(storage, 'card:brief')]).toEqual([{}, Date.parse('2026-11-06T08:00:00Z')]);
  });
});
