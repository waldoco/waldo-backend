import { env } from 'cloudflare:workers';
import { APP_SCHEDULE_RECEIPTS_V1 } from '../../contracts/src/app/controls';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import { calendarPushBook } from '../src/channels/calendar-push';
import { calendarChannelsBook } from '../src/channels/calendar-watches';
import { armBriefSweep, BRIEF_SWEEP_ID } from '../src/channels/event-briefs';
import { gmailPushBook } from '../src/channels/gmail-push';
import { gmailWatchesBook } from '../src/channels/gmail-watches';
import { GOOGLE_FINISH_PATH } from '../src/channels/google-oauth';
import { FINAL_OUTBOX_KEY } from '../src/channels/telegram-final-outbox';
import { WATCH_UPKEEP_ID } from '../src/channels/watch-upkeep';
import { startConsent, type ConsentFlow } from '../src/connectors/google-consent';
import { CALENDAR_WATCH_URL, verifyCalendarChannel } from '../src/connectors/google-push';
import { armAlarm } from '../src/scheduler/alarm-slot';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';
import { presenceAuthority } from './helpers/directory-presence';

// Gmail and Calendar watching is upkeep the scheduler runs whenever a mail or calendar grant exists, whatever the owner's
// schedule preferences and time-zone state. Every pass is a real alarm pass at the wake the runtime armed: the clock is far
// in the future so workerd never fires one on its own, and each pass reads the alarm slot, clears it and runs the handler,
// as runDurableObjectAlarm does, on an owner object that carries the connector-proxy fixture. No pass is driven by a command.
const MAIL = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose'];
const CALENDAR = 'https://www.googleapis.com/auth/calendar.events';
const EMAIL = 'owner@example.test';
const OWNER_ID = '4a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const HOUR = 3_600_000, DAY = 24 * HOUR;
const START = Date.parse('2030-11-04T09:00:00Z');
const ALL_OFF = ['daily_brief', 'event_briefs', 'nightly', 'heartbeat'];
const CONFIG = { TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC',
  GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret', WALDO_ROUTER_HMAC_SECRET: 'router-secret-fixture-0000000000',
  SUPABASE_PROJECT_URL: 'https://edge.test', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', GMAIL_PUSH_PROJECT: 'waldo-dev' };

const edge = vi.hoisted(() => ({ ops: [] as Record<string, unknown>[], exchange: { id: '', scopes: [] as string[], email: '' }, failing: new Set<string>(),
  sends: [] as string[], models: 0, throwing: null as 'calendar' | 'gmail' | null, googleWatches: [] as Record<string, string>[], calendars: [] as unknown[] }));
// A locally held refresh token resolves to a bearer route without reaching Google.
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original,
    googleAccessToken: async () => 'ya29.fixture',
    googleClient: (_app: unknown, _tokens: unknown, _fetch: unknown, _health: unknown, account: unknown) => ({
      account, events: async () => [], calendarPage: async () => ({ events: [], next_page_token: null, fetched_count: 0, account, observed_at: new Date().toISOString() }),
      event: async () => null, changedEvents: async () => [], newMail: async () => [],
      calendarListsPage: async () => ({ items: edge.calendars, next_page_token: null, fetched_count: edge.calendars.length, account, observed_at: new Date().toISOString() }),
    }) };
});
vi.mock('../src/connectors/google-push', async load => {
  const original = await load<typeof import('../src/connectors/google-push')>();
  return { ...original, gmailPush: (project?: string) => original.gmailPush(project) };
});
// A watch that throws once, before it can record anything, the way an unguarded call did.
vi.mock('../src/channels/calendar-push', async load => {
  const original = await load<typeof import('../src/channels/calendar-push')>();
  return { ...original, ensureCalendarWatch: async (deps: Parameters<typeof original.ensureCalendarWatch>[0]) => {
    if (edge.throwing === 'calendar') { edge.throwing = null; throw new Error('calendar watch threw'); }
    return original.ensureCalendarWatch(deps);
  } };
});
vi.mock('../src/channels/gmail-push', async load => {
  const original = await load<typeof import('../src/channels/gmail-push')>();
  return { ...original, ensureGmailWatch: async (deps: Parameters<typeof original.ensureGmailWatch>[0]) => {
    if (edge.throwing === 'gmail') { edge.throwing = null; throw new Error('gmail watch threw'); }
    return original.ensureGmailWatch(deps);
  } };
});
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(),
  createTelegramCaller: () => async (method: string, payload: { chat_id?: number; text?: string }) => {
    if (method !== 'sendMessage') return true;
    edge.sends.push(payload.text ?? '');
    return { message_id: edge.sends.length, chat: { id: payload.chat_id ?? 7 } };
  } }));
vi.mock('openai', () => ({ default: class { responses = { create: async () => { edge.models += 1; throw new Error('upkeep fixture forbids model calls'); } }; } }));
const { OwnerDO } = await import('../src/channels/owner-do');

// The connector-proxy edge: the exchange answers with the grant the test names, watches start unless the test fails them.
const answer = (body: Record<string, unknown>): unknown => {
  edge.ops.push(body);
  if (edge.failing.has(String(body.op))) return { error: { status: 503, message: 'backend unavailable' } };
  if (body.op === 'exchange') return { id: edge.exchange.id, email: edge.exchange.email, scopes: edge.exchange.scopes };
  if (body.op === 'gmail_watch') return { data: { historyId: '555', expiration: Date.now() + 7 * DAY } };
  if (body.op === 'calendar_watch' || body.op === 'events_watch') return { data: { channelId: body.channel_id, resourceId: 'res-1', expiration: Date.now() + 7 * DAY } };
  if (body.op === 'call' && body.method === 'calendarListsPage') return { data: { items: edge.calendars, next_page_token: null, fetched_count: edge.calendars.length, account: { connection_id: body.connection, email: null }, observed_at: new Date().toISOString() } };
  if (body.op === 'call') return { data: [] };
  return { error: { status: 404, message: 'unknown operation' } };
};

beforeEach(() => {
  edge.ops = []; edge.failing = new Set(); edge.sends = []; edge.models = 0; edge.throwing = null; edge.googleWatches = []; edge.calendars = [];
  vi.useFakeTimers({ toFake: ['Date'], now: START });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const raw = init?.body ? String(init.body) : '';
    if (url === 'https://edge.test/functions/v1/connector-proxy') return Response.json(answer(JSON.parse(raw) as Record<string, unknown>));
    // A locally held grant's Calendar watch goes to Google directly.
    if (url === CALENDAR_WATCH_URL) {
      const body = JSON.parse(raw) as Record<string, string>;
      edge.googleWatches.push(body);
      return Response.json({ id: body.id, resourceId: 'res-1', expiration: String(Date.now() + 7 * DAY) });
    }
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = raw ? JSON.parse(raw) as Record<string, string> : {};
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, raw);
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'connection_revoke' || fn === 'assert_channel_presence' || fn === 'set_owner_settings') return Response.json(true);
    if (fn === 'health_context_read' || fn === 'health_log_recent') return Response.json(fn === 'health_log_recent' ? [] : null);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

type Runtime = Readonly<{ act(action: { action: string; id?: string; value?: string }): Promise<boolean | string>; reminders: Readonly<{ list(): readonly unknown[] }> }>;
type Owner = Readonly<{ setup(channel?: string): Runtime; fetch(request: Request): Promise<Response>; alarm(): Promise<void> }>;
type Line = Readonly<{ raw: string; json: Record<string, unknown> }>;
type World = Readonly<{
  state: DurableObjectState; owner: Owner;
  connect(id: string, scopes: readonly string[], email?: string): Promise<void>;
  // One alarm pass at the wake the runtime armed; the wake it ran at, or null when nothing was armed.
  pass(): Promise<number | null>;
  watches(op: 'gmail_watch' | 'calendar_watch'): unknown[];
  lines(hop: string): Line[];
  row(id: string): Readonly<{ status: string; due_at: number; attempts: number }> | null;
  outbox(): readonly unknown[];
  // A verified Gmail push for this owner: 'wake' when it was admitted and pulled the sweep.
  push(connection: string, history: string): Promise<'wake' | 'ignore'>;
}>;
type Setup = Readonly<{ surface?: 'telegram' | 'app'; accounts?: readonly unknown[]; off?: readonly string[]; pushProject?: string; realtime?: boolean }>;

const world = async (name: string, setup: Setup, run: (world: World) => Promise<void>) => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    ensureSchema(state.storage);
    const kv = state.storage.kv;
    kv.put('do_name', name);
    if (setup.surface === 'app') kv.put('app_subject', String(appSubjectFor(name))); else kv.put('telegram_subject', '7');
    await state.storage.put('origin', 'https://fixture.invalid');
    if (setup.accounts) await state.storage.put('google:accounts', setup.accounts);
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS schedule_preferences (kind TEXT PRIMARY KEY, enabled INTEGER NOT NULL)');
    for (const kind of setup.off ?? []) state.storage.sql.exec('INSERT INTO schedule_preferences (kind, enabled) VALUES (?, 0)', kind);
    const owner = new OwnerDO(state, { ...env, ...CONFIG, WALDO_OWNER_TELEGRAM_ID: setup.surface === 'app' ? undefined : '7', ...(setup.pushProject === undefined ? {} : { GMAIL_PUSH_PROJECT: setup.pushProject }), ...(setup.realtime ? { WALDO_DAY_STATE: '1', GOOGLE_REALTIME_TRIAGE: '1' } : {}) }) as unknown as Owner;
    const logs: MockInstance = vi.spyOn(console, 'log');
    const connect = async (id: string, scopes: readonly string[], email = EMAIL) => {
      edge.exchange = { id, scopes: [...scopes], email };
      const store = { read: async () => (await state.storage.get<Record<string, ConsentFlow>>('google:consents')) ?? {}, write: (flows: Record<string, ConsentFlow>) => state.storage.put('google:consents', flows) };
      const { nonce } = await startConsent({ store, now: () => Date.now() }, { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', redirectUri: 'https://fixture.invalid/oauth/google/callback' }, 'state-secret-fixture', '7');
      const reply = await owner.fetch(new Request(`https://owner.invalid${GOOGLE_FINISH_PATH}`, { method: 'POST', body: JSON.stringify({ nonce, code: 'synthetic-code', error: null }) }));
      expect((await reply.json() as { outcome: { kind: string } }).outcome.kind).toBe('linked');
    };
    const pass = async () => {
      const due = await state.storage.getAlarm();
      if (due === null) return null;
      if (due > Date.now()) vi.setSystemTime(due);
      await state.storage.deleteAlarm();
      await owner.alarm();
      return due;
    };
    const lines = (hop: string) => logs.mock.calls.flatMap(([raw]): Line[] => {
      if (typeof raw !== 'string' || !raw.startsWith('{')) return [];
      try { const json = JSON.parse(raw) as Record<string, unknown>; return json.hop === hop ? [{ raw, json }] : []; } catch { return []; }
    });
    const watches = (op: 'gmail_watch' | 'calendar_watch') => edge.ops.filter(body => body.op === op && body.do_name === name).map(body => body.connection);
    const row = (id: string) => state.storage.sql.exec<{ status: string; due_at: number; attempts: number }>('SELECT status, due_at, attempts FROM schedule WHERE id = ?', id).toArray()[0] ?? null;
    const outbox = () => kv.get<readonly unknown[]>(FINAL_OUTBOX_KEY) ?? [];
    const push = async (connection: string, history: string) => {
      const before = lines('gmail_push').length;
      expect((await owner.fetch(new Request('https://owner.invalid/gmail-push', { method: 'POST', headers: { 'x-waldo-gmail-connection': connection, 'x-waldo-gmail-history': history } }))).status).toBe(200);
      return lines('gmail_push').length > before ? 'wake' as const : 'ignore' as const;
    };
    try { await run({ state, owner, connect, pass, watches, lines, row, outbox, push }); } finally { logs.mockRestore(); await state.storage.deleteAlarm(); }
  });
};
const codes = (world: World, hop: string) => world.lines(hop).map(({ json }) => json.code);

describe('Gmail and Calendar watch upkeep', () => {
  it('with event briefs off, a new grant starts both watches on the first scheduler pass, within a second of connecting', async () => {
    await world('upkeep-briefs-off', { off: ['event_briefs'] }, async w => {
      await w.connect('conn-1', [...MAIL, CALENDAR]);
      const connected = Date.now();
      expect(await w.state.storage.getAlarm(), 'upkeep is due at once, not at the next ten-minute sweep').toBeLessThanOrEqual(connected + 1_000);
      expect(await w.pass()).toBeLessThanOrEqual(connected + 1_000);
      expect(w.watches('gmail_watch')).toEqual(['conn-1']);
      expect(edge.ops.find(body => body.op === 'gmail_watch'), 'into the push topic').toMatchObject({ topic: 'projects/waldo-dev/topics/waldo-gmail-push' });
      expect(w.watches('calendar_watch')).toEqual(['conn-1']);
      expect(codes(w, 'gmail_watch')).toEqual(['gmail_watch_started']);
      expect(codes(w, 'calendar_watch')).toEqual(['calendar_watch_started']);
      // Logs carry the hop, outcome, code and time only.
      for (const { raw } of [...w.lines('gmail_watch'), ...w.lines('calendar_watch')]) expect(raw).not.toMatch(/@|conn-|example|history/);
      expect(w.row(BRIEF_SWEEP_ID), 'the owner\'s choice stands: no event-brief sweep').toBeNull();
      expect(w.row(WATCH_UPKEEP_ID)).toMatchObject({ status: 'armed', due_at: expect.any(Number) });
      expect(w.row(WATCH_UPKEEP_ID)!.due_at, 'the next check is an hour on').toBeGreaterThanOrEqual(connected + HOUR);
    });
  });

  it('an environment that names no Gmail push project starts no Gmail watch, and Calendar is unaffected', async () => {
    await world('upkeep-push-unconfigured', { off: ['event_briefs'], pushProject: '' }, async w => {
      await w.connect('conn-1', [...MAIL, CALENDAR]);
      await w.pass();
      expect(w.watches('gmail_watch'), 'no watch into any project').toEqual([]);
      expect(codes(w, 'gmail_watch')).toEqual(['gmail_watch_skipped:unconfigured']);
      expect(w.watches('calendar_watch')).toEqual(['conn-1']);
    });
  });

  it('for an app-only owner whose zone is unconfirmed, a new grant starts the watches and nothing reaches the owner', async () => {
    await world('upkeep-app-unconfirmed', { surface: 'app' }, async w => {
      await w.connect('conn-1', [...MAIL, CALENDAR]);
      const afterConnect = [...edge.sends];
      for (let n = 0; n < 6; n++) if (await w.pass() === null) break;
      expect(w.watches('gmail_watch')).toEqual(['conn-1']);
      expect(w.watches('calendar_watch')).toEqual(['conn-1']);
      // The proactive gates are unchanged: the sweep a Telegram build armed is dropped, nothing is queued or sent.
      expect(w.lines('brief_sweep')).toEqual([]);
      expect(w.lines('event_brief')).toEqual([]);
      expect(w.row(BRIEF_SWEEP_ID)).toBeNull();
      expect(w.outbox()).toEqual([]);
      expect(edge.sends, 'nothing after the connect notice').toEqual(afterConnect);
    });
  });

  it('an account connected before upkeep existed is watched on the next wake, with no reconnect', async () => {
    await world('upkeep-existing-account', { accounts: [{ id: 'conn-1', email: EMAIL, scopes: [...MAIL, CALENDAR] }], off: ALL_OFF }, async w => {
      expect(w.row(WATCH_UPKEEP_ID)).toBeNull();
      // A wake an older Worker left armed, as it does for any job it scheduled.
      await armAlarm(w.state.storage, Date.now());
      const woke = Date.now();
      for (let n = 0; n < 2 && w.watches('gmail_watch').length === 0; n++) await w.pass();
      expect(Date.now() - woke, 'within the first wake or the one it arms').toBeLessThan(1_000);
      expect(w.watches('gmail_watch')).toEqual(['conn-1']);
      expect(w.watches('calendar_watch')).toEqual(['conn-1']);
      expect(edge.models).toBe(0);
    });
  });

  it('on the app runtime, an existing account is watched with every routine off and the zone unconfirmed, with no reconnect', async () => {
    await world('upkeep-app-existing-unconfirmed', { surface: 'app', accounts: [{ id: 'conn-1', email: EMAIL, scopes: [...MAIL, CALENDAR] }], off: ALL_OFF }, async w => {
      expect(w.state.storage.kv.get('timezone_confirmed')).toBeUndefined();
      await armAlarm(w.state.storage, Date.now());
      for (let n = 0; n < 2 && w.watches('gmail_watch').length === 0; n++) await w.pass();
      expect(w.watches('gmail_watch')).toEqual(['conn-1']);
      expect(w.watches('calendar_watch')).toEqual(['conn-1']);
      expect(w.row(BRIEF_SWEEP_ID)).toBeNull();
      expect(w.outbox()).toEqual([]);
      expect(edge.models).toBe(0);
    });
  });

  it('a boot leaves an existing upkeep row as it is, so a paused upkeep stays paused', async () => {
    await world('upkeep-boot-keeps-row', { accounts: [{ id: 'conn-1', email: EMAIL, scopes: MAIL }], off: ALL_OFF }, async w => {
      await armAlarm(w.state.storage, Date.now());
      for (let n = 0; n < 2 && w.watches('gmail_watch').length === 0; n++) await w.pass();
      expect(w.watches('gmail_watch')).toEqual(['conn-1']);
      const sql = w.state.storage.sql;
      const paused = () => sql.exec<{ status: string; attempts: number; due_at: number; quarantined_until: number | null }>('SELECT status, attempts, due_at, quarantined_until FROM schedule WHERE id = ?', WATCH_UPKEEP_ID).toArray()[0];
      sql.exec("UPDATE schedule SET status = 'quarantined', attempts = 3, quarantined_until = ? WHERE id = ?", Date.now() + DAY, WATCH_UPKEEP_ID);
      const before = paused();
      // A new instance on the same storage is what an owner object's restart looks like.
      const booted = new OwnerDO(w.state, { ...env, ...CONFIG, WALDO_OWNER_TELEGRAM_ID: '7' }) as unknown as Owner;
      await w.state.storage.deleteAlarm();
      await booted.alarm();
      expect(paused()).toEqual(before);
      expect(w.watches('gmail_watch')).toEqual(['conn-1']);
    });
  });

  it('a failed start is retried by the scheduler after the backoff, not before, and a watch without its grant is not tried', async () => {
    await world('upkeep-retry', { accounts: [{ id: 'conn-1', email: EMAIL, scopes: MAIL }], off: ALL_OFF }, async w => {
      edge.failing.add('gmail_watch');
      await armAlarm(w.state.storage, Date.now());
      for (let n = 0; n < 2 && w.watches('gmail_watch').length === 0; n++) await w.pass();
      const failedAt = Date.now();
      expect(codes(w, 'gmail_watch')).toEqual(['gmail_watch_failed']);
      edge.failing.clear();
      const wakes: number[] = [];
      while (true) {
        const due = await w.state.storage.getAlarm();
        expect(due, 'upkeep keeps a wake armed').not.toBeNull();
        if (due! >= failedAt + 6 * HOUR) break;
        wakes.push((await w.pass())!);
      }
      expect(wakes.length, 'hourly checks inside the backoff').toBeGreaterThanOrEqual(5);
      expect(w.watches('gmail_watch'), 'nothing is retried inside the backoff').toEqual(['conn-1']);
      await w.pass();
      expect(w.watches('gmail_watch')).toEqual(['conn-1', 'conn-1']);
      expect(codes(w, 'gmail_watch')).toEqual(['gmail_watch_failed', 'gmail_watch_started']);
      expect(w.watches('calendar_watch'), 'a mail-only grant is never watched for calendar').toEqual([]);
      expect(w.lines('calendar_watch')).toEqual([]);
    });
  });

  for (const [throwing, other] of [['calendar', 'gmail_watch'], ['gmail', 'calendar_watch']] as const) {
    it(`a ${throwing} watch that throws doesn't keep the ${other.replace('_watch', '')} watch from starting, and waits out the backoff`, async () => {
      await world(`upkeep-${throwing}-throws`, { off: ALL_OFF }, async w => {
        edge.throwing = throwing;
        await w.connect('conn-1', [...MAIL, CALENDAR]);
        await w.pass();
        expect(w.watches(other)).toEqual(['conn-1']);
        expect(codes(w, `${throwing}_watch`)).toEqual([`${throwing}_watch_failed`]);
        const book = throwing === 'calendar' ? calendarPushBook(w.state.storage.kv) : gmailPushBook(w.state.storage.kv);
        expect(book.miss(), 'the throw is recorded as a failed start').toEqual({ at: expect.any(Number), reason: 'failed' });
        // The next hourly check leaves it alone: one line per backoff, not one per check.
        await w.pass();
        expect(codes(w, `${throwing}_watch`)).toEqual([`${throwing}_watch_failed`]);
      });
    });
  }

  it('a Calendar book this Worker cannot read is replaced by a failed start, and Gmail still starts', async () => {
    await world('upkeep-calendar-unreadable', { off: ALL_OFF }, async w => {
      await w.connect('conn-1', [...MAIL, CALENDAR]);
      w.state.storage.kv.put('calendar_push', 'not a watch');
      await w.pass();
      expect(w.watches('gmail_watch')).toEqual(['conn-1']);
      expect(codes(w, 'calendar_watch')).toEqual(['calendar_watch_failed']);
      expect(calendarPushBook(w.state.storage.kv).miss()).toEqual({ at: expect.any(Number), reason: 'failed' });
    });
  });

  it('a reconnect re-arms a Gmail watch that a locally held grant skipped, says why once, and retries a stored Calendar failure', async () => {
    await world('upkeep-rearm-local-rail', { accounts: [{ id: `local:${EMAIL}`, email: EMAIL, refresh_token: 'synthetic-offline-only', scopes: MAIL }], off: ALL_OFF }, async w => {
      const kv = w.state.storage.kv;
      await armAlarm(w.state.storage, Date.now());
      for (let n = 0; n < 2 && w.lines('gmail_watch').length === 0; n++) await w.pass();
      expect(w.watches('gmail_watch')).toEqual([]);
      expect(gmailPushBook(kv).miss()).toEqual({ at: expect.any(Number), reason: 'local_rail' });
      calendarPushBook(kv).fail(Date.now());
      await w.connect('conn-2', [...MAIL, CALENDAR]);
      const connected = Date.now();
      expect(calendarPushBook(kv).state(), 'the keep clears a Calendar failure').toBeNull();
      expect(await w.pass(), 'a reconnect runs the existing upkeep at once, not at its next hourly check').toBeLessThanOrEqual(connected + 1_000);
      expect(w.watches('gmail_watch'), 'upkeep watches with the new connection').toEqual(['conn-2']);
      expect(w.watches('calendar_watch'), 'and retries the Calendar watch with the new grant').toEqual(['conn-2']);
      await w.pass();
      expect(w.watches('gmail_watch'), 'a fresh watch is left alone').toEqual(['conn-2']);
      expect(codes(w, 'gmail_watch'), 'a skip is logged once with its reason; a fresh check is silent').toEqual(['gmail_watch_skipped:local_rail', 'gmail_watch_started']);
      for (const { raw } of w.lines('gmail_watch')) expect(raw).not.toMatch(/@|local:|conn-/);
      expect(await w.push('conn-2', '556'), 'a push for the new connection wakes the sweep').toBe('wake');
    });
  });

  it('an older account with another address keeps the mail route, and reconnecting that account moves the watch', async () => {
    const OLD = 'old@example.test';
    await world('upkeep-older-account-first', { accounts: [{ id: `local:${OLD}`, email: OLD, refresh_token: 'synthetic-offline-only', scopes: MAIL }], off: ALL_OFF }, async w => {
      await w.connect('conn-1', [...MAIL, CALENDAR]);
      await w.pass();
      expect(w.watches('gmail_watch'), 'mail still resolves to the older account, which cannot be watched').toEqual([]);
      expect(codes(w, 'gmail_watch')).toEqual(['gmail_watch_skipped:local_rail']);
      expect(w.watches('calendar_watch'), 'calendar resolves to the new grant').toEqual(['conn-1']);
      // The fact's advice: reconnect the older account. Its grant joins the vault, and mail moves to a watchable route.
      await w.connect('conn-old', MAIL, OLD);
      await w.pass();
      expect(w.watches('gmail_watch')).toEqual(['conn-1']);
      expect(codes(w, 'gmail_watch')).toEqual(['gmail_watch_skipped:local_rail', 'gmail_watch_started']);
    });
  });

  it('a reconnect that changes the connection moves the Gmail watch and its pushes to it, and leaves a live Calendar channel alone', async () => {
    await world('upkeep-new-connection', { accounts: [{ id: 'conn-1', email: EMAIL, scopes: [...MAIL, CALENDAR] }], off: ALL_OFF }, async w => {
      const kv = w.state.storage.kv;
      await armAlarm(w.state.storage, Date.now());
      for (let n = 0; n < 2 && w.watches('gmail_watch').length === 0; n++) await w.pass();
      expect(w.watches('gmail_watch')).toEqual(['conn-1']);
      const live = calendarPushBook(kv).state();
      expect(live).toMatchObject({ resourceId: 'res-1' });
      await w.connect('conn-2', [...MAIL, CALENDAR]);
      expect(calendarPushBook(kv).state(), 'a live Calendar channel survives the keep').toEqual(live);
      await w.pass();
      expect(w.watches('gmail_watch')).toEqual(['conn-1', 'conn-2']);
      expect(w.watches('calendar_watch'), 'no second Calendar channel is started').toEqual(['conn-1']);
      expect(await w.push('conn-1', '600'), 'a push for the old connection is ignored').toBe('ignore');
      expect(await w.push('conn-2', '601'), 'a push for the new connection wakes the sweep').toBe('wake');
    });
  });

  it('a Calendar watch on a locally held grant routes back to this owner, and a fresh one is left alone', async () => {
    const name = 'upkeep-calendar-local';
    await world(name, { accounts: [{ id: `local:${EMAIL}`, email: EMAIL, refresh_token: 'synthetic-offline-only', scopes: [CALENDAR] }], off: ALL_OFF }, async w => {
      await armAlarm(w.state.storage, Date.now());
      for (let n = 0; n < 2 && edge.googleWatches.length === 0; n++) await w.pass();
      expect(edge.googleWatches).toHaveLength(1);
      const [body] = edge.googleWatches;
      expect(body).toMatchObject({ type: 'web_hook', address: 'https://fixture.invalid/events/gcal' });
      expect(await verifyCalendarChannel(CONFIG.WALDO_ROUTER_HMAC_SECRET, body!.token!, body!.id!)).toBe(name);
      expect(calendarPushBook(w.state.storage.kv).state()).toMatchObject({ channelId: body!.id, resourceId: 'res-1' });
      await w.pass();
      expect(edge.googleWatches).toHaveLength(1);
      expect(w.lines('gmail_watch'), 'a calendar-only grant is never watched for mail').toEqual([]);
    });
  });

  it('after a disconnect leaves no mail or calendar grant, upkeep ends: no watch, no log, no wake', async () => {
    await world('upkeep-disconnect', { off: ALL_OFF }, async w => {
      await w.connect('conn-1', [...MAIL, CALENDAR]);
      await w.pass();
      expect(w.watches('gmail_watch')).toEqual(['conn-1']);
      expect(await w.owner.setup('telegram').act({ action: 'google.disconnect', id: 'conn-1' })).toBe(true);
      expect(w.row(WATCH_UPKEEP_ID)).toBeNull();
      const [ops, logged] = [edge.ops.length, w.lines('gmail_watch').length + w.lines('calendar_watch').length];
      for (let n = 0; n < 30; n++) if (await w.pass() === null) break;
      expect(edge.ops.slice(ops).filter(body => String(body.op).endsWith('watch'))).toEqual([]);
      expect(w.lines('gmail_watch').length + w.lines('calendar_watch').length).toBe(logged);
    });
  });

  it('ends itself, silently, when the grants are gone without a disconnect on this Worker', async () => {
    await world('upkeep-grants-gone', { off: ALL_OFF }, async w => {
      await w.connect('conn-1', [...MAIL, CALENDAR]);
      await w.pass();
      // An older Worker's disconnect removed the account and left the upkeep row.
      await w.state.storage.put('google:accounts', []);
      const [ops, logged] = [edge.ops.length, w.lines('gmail_watch').length + w.lines('calendar_watch').length];
      expect(await w.pass(), 'the next hourly check runs').not.toBeNull();
      expect(w.row(WATCH_UPKEEP_ID)).toBeNull();
      expect(edge.ops.length).toBe(ops);
      expect(w.lines('gmail_watch').length + w.lines('calendar_watch').length).toBe(logged);
    });
  });

  it('with event briefs off, a Gmail push still wakes nothing proactive', async () => {
    await world('upkeep-push-briefs-off', { off: ALL_OFF }, async w => {
      await w.connect('conn-1', [...MAIL, CALENDAR]);
      await w.pass();
      expect(w.watches('gmail_watch')).toEqual(['conn-1']);
      const pushed = await w.owner.fetch(new Request('https://owner.invalid/gmail-push', { method: 'POST', headers: { 'x-waldo-gmail-connection': 'conn-1', 'x-waldo-gmail-history': '556' } }));
      expect(pushed.status).toBe(200);
      expect(codes(w, 'gmail_push')).toEqual(['sweep_unchanged']);
      for (let n = 0; n < 3; n++) if (await w.pass() === null) break;
      expect(w.lines('brief_sweep')).toEqual([]);
      expect(w.lines('update_card')).toEqual([]);
      expect(w.outbox()).toEqual([]);
      expect(edge.models).toBe(0);
    });
  });

  it('the owner\'s schedule controls neither cancel upkeep nor list it', async () => {
    await world('upkeep-owner-controls', {}, async w => {
      await w.connect('conn-1', [...MAIL, CALENDAR]);
      const runtime = w.owner.setup('telegram');
      expect(await runtime.act({ action: 'schedule.set', id: 'event_briefs', value: 'off' })).toEqual(APP_SCHEDULE_RECEIPTS_V1.off);
      expect(w.row(WATCH_UPKEEP_ID)).toMatchObject({ status: 'armed' });
      expect(await runtime.act({ action: 'proactivity.set', value: '00:00|23:59|low' })).toBe(true);
      expect(await runtime.act({ action: 'schedule.reset' })).toBe(true);
      expect(w.row(WATCH_UPKEEP_ID)).toMatchObject({ status: 'armed' });
      expect(runtime.reminders.list()).toEqual([]);
      for (let n = 0; n < 2 && w.watches('gmail_watch').length === 0; n++) await w.pass();
      expect(w.watches('gmail_watch'), 'quiet hours and low volume don\'t stop it').toEqual(['conn-1']);
    });
  });
});

describe('GOOGLE_REALTIME_TRIAGE: every calendar the owner reads', () => {
  const listed = (id: string, primary = false) => ({ id, title: id, access_role: primary ? 'owner' : 'reader', primary, selected: true, hidden: false });
  it('upkeep watches each read calendar on its own channel, and a push on any of them wakes the owner\'s sweep', async () => {
    edge.calendars = [listed(EMAIL, true), listed('team@group.example.test')];
    await world('upkeep-realtime', { off: ['event_briefs'], realtime: true }, async w => {
      await w.connect('conn-1', [...MAIL, CALENDAR]);
      await w.pass();
      expect(w.watches('calendar_watch'), 'the primary calendar').toEqual(['conn-1']);
      const team = edge.ops.filter(body => body.op === 'events_watch');
      expect(team.map(body => body.calendar_id)).toEqual(['team@group.example.test']);
      expect(codes(w, 'calendar_watch')).toEqual(['calendar_watches:accounts=1:started=2:failed=0:stopped=0']);
      for (const { raw } of w.lines('calendar_watch')) expect(raw).not.toMatch(/@|conn-|example/);
      const push = (channel: string, number: number) => w.owner.fetch(new Request('https://owner.invalid/google-push', { method: 'POST',
        headers: { 'x-waldo-gcal-channel': channel, 'x-waldo-gcal-state': 'exists', 'x-waldo-gcal-number': String(number) } }));
      expect((await push(String(team[0]!.channel_id), 1)).status).toBe(200);
      expect(w.lines('calendar_push')).toHaveLength(1);
      expect((await push(String(team[0]!.channel_id), 1)).status).toBe(200);
      expect(w.lines('calendar_push'), 'a redelivery wakes nothing').toHaveLength(1);
    });
  });

  it('every connected account is watched on its own; a push marks only its account; a disconnect stops and forgets only that account', async () => {
    edge.calendars = [listed(EMAIL, true)];
    await world('upkeep-realtime-accounts', { off: ['event_briefs'], realtime: true }, async w => {
      await w.connect('conn-1', [...MAIL, CALENDAR]);
      await w.connect('conn-2', [...MAIL, CALENDAR], 'second@example.test');
      for (let n = 0; n < 2 && w.watches('gmail_watch').length < 2; n++) await w.pass();
      expect(w.watches('calendar_watch')).toEqual(['conn-1', 'conn-2']);
      expect(w.watches('gmail_watch')).toEqual(['conn-1', 'conn-2']);
      expect(codes(w, 'gmail_watch').at(-1)).toBe('gmail_watches:accounts=2:started=2:failed=0:skipped=0');
      for (const { raw } of [...w.lines('gmail_watch'), ...w.lines('calendar_watch')]) expect(raw).not.toMatch(/@|conn-|example/);
      const sql = w.state.storage.sql;
      const waiting = () => sql.exec<{ key: string }>("SELECT key FROM watch_state WHERE key LIKE 'pending:%' ORDER BY key").toArray().map(row => row.key);
      const second = edge.ops.find(body => body.op === 'calendar_watch' && body.connection === 'conn-2')!;
      expect((await w.owner.fetch(new Request('https://owner.invalid/google-push', { method: 'POST',
        headers: { 'x-waldo-gcal-channel': String(second.channel_id), 'x-waldo-gcal-state': 'exists', 'x-waldo-gcal-number': '1' } }))).status).toBe(200);
      expect(waiting()).toEqual(['pending:cal:conn-2:primary']);
      expect(await w.push('conn-2', '600')).toBe('wake');
      expect(waiting()).toEqual(['pending:cal:conn-2:primary', 'pending:mail:conn-2']);
      expect(await w.push('conn-2', '600'), 'a redelivery').toBe('ignore');
      await w.push('conn-9', '700');
      expect(codes(w, 'gmail_push').at(-1), 'a mailbox no connected account holds').toBe('unknown_account');
      for (const { raw } of w.lines('gmail_push')) expect(raw).not.toMatch(/@|conn-|example/);
      sql.exec("INSERT INTO watch_state (key, value) VALUES ('cursor:mail:conn-1', '5'), ('cursor:cal:conn-1:primary', 's1'), ('cursor:mail:conn-2', '9')");
      const first = edge.ops.find(body => body.op === 'calendar_watch' && body.connection === 'conn-1')!;
      expect(await w.owner.setup('telegram').act({ action: 'google.disconnect', id: 'conn-1' })).toBe(true);
      expect(edge.ops.filter(body => body.op === 'channel_stop').map(body => [body.connection, body.channel_id])).toEqual([['conn-1', first.channel_id]]);
      expect(sql.exec<{ key: string }>("SELECT key FROM watch_state WHERE key LIKE '%conn-%' ORDER BY key").toArray().map(row => row.key))
        .toEqual(['cursor:mail:conn-2', 'pending:cal:conn-2:primary', 'pending:mail:conn-2']);
      await w.push('conn-1', '800');
      expect(codes(w, 'gmail_push').at(-1), 'a disconnected mailbox wakes nothing').toBe('unknown_account');
      expect(waiting()).not.toContain('pending:mail:conn-1');
    });
  });

  it('a reconnect clears that account\'s failed watches at once; one under a new connection forgets the old one\'s cursors', async () => {
    edge.calendars = [listed(EMAIL, true)];
    await world('upkeep-realtime-reconnect', { off: ['event_briefs'], realtime: true }, async w => {
      edge.failing = new Set(['calendar_watch', 'gmail_watch']);
      await w.connect('conn-1', [...MAIL, CALENDAR]);
      await w.pass();
      const kv = w.state.storage.kv;
      expect(calendarChannelsBook(kv).failures().map(miss => miss.account)).toEqual(['conn-1']);
      expect(gmailWatchesBook(kv).misses().map(miss => miss.account)).toEqual(['conn-1']);
      edge.failing = new Set();
      await w.connect('conn-1', [...MAIL, CALENDAR]);
      expect(calendarChannelsBook(kv).failures()).toEqual([]);
      expect(gmailWatchesBook(kv).misses()).toEqual([]);
      w.state.storage.sql.exec("INSERT INTO watch_state (key, value) VALUES ('cursor:mail:conn-1', '5')");
      await w.connect('conn-7', [...MAIL, CALENDAR]);
      expect(w.state.storage.sql.exec("SELECT key FROM watch_state WHERE key LIKE '%conn-1%'").toArray()).toEqual([]);
    });
  });

  it('with the switch off, only the primary calendar is watched, as before', async () => {
    edge.calendars = [listed(EMAIL, true), listed('team@group.example.test')];
    await world('upkeep-realtime-off', { off: ['event_briefs'] }, async w => {
      await w.connect('conn-1', [...MAIL, CALENDAR]);
      await w.pass();
      expect(w.watches('calendar_watch')).toEqual(['conn-1']);
      expect(edge.ops.filter(body => body.op === 'events_watch')).toEqual([]);
      // A channel left from when the switch was on wakes nothing and marks nothing to read.
      calendarChannelsBook(w.state.storage.kv).record('conn-1', 'team@group.example.test', { channelId: 'left-on', resourceId: 'res-left', expiration: Date.now() + DAY }, 'conn-1');
      expect((await w.owner.fetch(new Request('https://owner.invalid/google-push', { method: 'POST',
        headers: { 'x-waldo-gcal-channel': 'left-on', 'x-waldo-gcal-state': 'exists', 'x-waldo-gcal-number': '1' } }))).status).toBe(200);
      expect(w.lines('calendar_push')).toEqual([]);
    });
  });
});

describe('the brief sweep follows the Google grant', () => {
  // The wakes a day the armed recurring schedule asks for, read from each entry's own recurrence.
  const wakesPerDay = (w: World) => w.state.storage.sql.exec<{ id: string; recurrence: string | null }>("SELECT id, recurrence_json AS recurrence FROM schedule WHERE status = 'armed'").toArray()
    .reduce((n, row) => { const r = row.recurrence ? JSON.parse(row.recurrence) as { type: string; every_ms?: number } : null; return n + (r === null ? 0 : r.type === 'interval' ? DAY / r.every_ms! : 1); }, 0);
  const boot = (w: World) => (w.owner.setup('telegram') as unknown as { ready: Promise<void> }).ready;

  it('an owner with no grant is not woken for it, an armed one is ended at boot, a connect arms it and a disconnect ends it again', async () => {
    let granted = 0;
    await world('sweep-with-grant', { accounts: [{ id: 'conn-1', email: EMAIL, scopes: MAIL }] }, async w => {
      await boot(w);
      expect(w.row(BRIEF_SWEEP_ID)?.status).toBe('armed');
      granted = wakesPerDay(w);
    });
    await world('sweep-follows-grant', {}, async w => {
      // A sweep an earlier Worker armed for this owner, who has no Google account.
      await armBriefSweep(new Scheduler(w.state.storage.sql, w.state.storage, productionDeps()), Date.now());
      await boot(w);
      expect(w.row(BRIEF_SWEEP_ID)?.status ?? 'none').not.toBe('armed');
      const bare = wakesPerDay(w);
      // The ten-minute sweep and the hourly watch upkeep are gone; the rest of the owner's own jobs stay.
      expect(granted - bare).toBe(144 + 24);
      expect(w.row('heartbeat-tick')?.status).toBe('armed');
      await w.connect('conn-1', MAIL);
      expect(w.row(BRIEF_SWEEP_ID)?.status).toBe('armed');
      expect(wakesPerDay(w)).toBe(granted);
      expect(await w.owner.setup('telegram').act({ action: 'google.disconnect', id: 'conn-1' })).toBe(true);
      expect(w.row(BRIEF_SWEEP_ID)?.status ?? 'none').not.toBe('armed');
      expect(wakesPerDay(w)).toBe(bare);
    });
  });

  it('a connect with event briefs turned off, or turning them on with no grant, arms no sweep', async () => {
    await world('sweep-briefs-off', { off: ['event_briefs'] }, async w => {
      await w.connect('conn-1', MAIL);
      expect(w.row(BRIEF_SWEEP_ID)).toBeNull();
    });
    await world('sweep-on-without-grant', { off: ['event_briefs'] }, async w => {
      await boot(w);
      expect(await w.owner.setup('telegram').act({ action: 'schedule.set', id: 'event_briefs', value: 'on' })).toEqual(APP_SCHEDULE_RECEIPTS_V1.on);
      expect(w.row(BRIEF_SWEEP_ID)).toBeNull();
      await w.connect('conn-1', MAIL);
      expect(w.row(BRIEF_SWEEP_ID)?.status).toBe('armed');
    });
  });
});
