import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calendarDayV1Schema } from '../../contracts/src/app/calendar-day';
import { GoogleError, type CalendarItem } from '../src/connectors/google';
import { appSubjectFor } from '../src/channels/app-api';
import { traceBook } from '../src/channels/harness';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// GET /app/v1/calendar/day through the owner's real Durable Object: the session check, the owner's own Google accounts
// and zone, and the owner's own health answer. Google and the database are fixtures with synthetic content.
const fixture = vi.hoisted(() => ({ events: [] as unknown[], pages: null as unknown[][] | null, failure: null as Error | null, onRead: null as (() => void) | null, reads: [] as Array<{ from: string; to: string; account: unknown; token?: string }> }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (_app: unknown, _tokens: unknown, _fetch: unknown, _health: unknown, account: unknown) => ({
    account,
    events: async () => fixture.events,
    // The real connector refuses a page larger than 50.
    calendarPage: async (_calendar: string, from: string, to: string, limit: number, _declined: boolean, token?: string) => {
      fixture.reads.push({ from, to, account, ...(token ? { token } : {}) });
      fixture.onRead?.();
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('invalid Calendar page request');
      if (fixture.failure) throw fixture.failure;
      const pages = fixture.pages ?? [fixture.events], at = token ? Number(token) : 0;
      return { events: pages[at], next_page_token: at + 1 < pages.length ? String(at + 1) : null, fetched_count: pages[at]!.length, account, observed_at: new Date().toISOString() };
    },
  }) };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '6c4d5e6f-7081-4b9c-8d1e-2f3a4b5c6d7e';
const AT = Date.parse('2026-10-03T09:00:00Z');
const HASH = 'b'.repeat(64);
const CALENDAR = 'https://www.googleapis.com/auth/calendar.events';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const wire = { session: true, scores: {} as unknown, asked: [] as Array<{ fn: string; body: Record<string, string> }> };
const SCORES = { scores: { day: '2026-10-03', timezone: 'UTC', compiled_at: '2026-10-03T08:00:00Z', form: { score: 71, zone: 'good', algorithm_version: 'form.v9', activation: 'accepted', confidence: 0.8 } } };

beforeEach(() => {
  fixture.events = []; fixture.pages = null; fixture.failure = null; fixture.onRead = null; fixture.reads = [];
  wire.session = true; wire.scores = SCORES; wire.asked = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1] ?? url;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    wire.asked.push({ fn, body });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: body.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json(wire.session ? { owner_id: OWNER_ID, do_name: body.p_do_name, session_hash: body.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 } : null);
    if (fn === 'health_scores_read') { if (wire.scores === 'throw') throw new Error('synthetic health store outage'); return Response.json(wire.scores); }
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'assert_channel_presence') return Response.json(false);
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown> }; fetch(request: Request): Promise<Response> }>;
type Account = Readonly<{ id: string; email: string; refresh_token: string; scopes: readonly string[] }>;
const account = (email: string, scopes: readonly string[] = [CALENDAR]): Account => ({ id: `local:${email}`, email, refresh_token: 'synthetic-offline-only', scopes });

const withOwner = async (name: string, accounts: readonly Account[], run: (owner: Owner) => Promise<void>, failing: Record<string, string> = {}, timezone = 'UTC') => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const originalNow = Date.now;
    Date.now = () => AT;
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      state.storage.kv.put('do_name', name);
      state.storage.kv.put('app_subject', String(appSubjectFor(name)));
      state.storage.kv.put('timezone', timezone);
      state.storage.kv.put('timezone_confirmed', true);
      await state.storage.put('origin', 'https://fixture.invalid');
      await state.storage.put('google:accounts', accounts);
      await state.storage.put('google:health', failing);
      const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC',
        WALDO_OWNER_TELEGRAM_ID: undefined, GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret' }) as unknown as Owner;
      await owner.setup('app').ready;
      await run(owner);
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
};
type Reply = Omit<Response, 'json'> & { json(): Promise<any> };
const ask = (owner: Owner, name: string, query = '', method = 'GET') => owner.fetch(new Request(`https://telegram-owner/app/v1/calendar/day${query}`, {
  method, headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': HASH },
})) as Promise<Reply>;

const item = (over: Partial<CalendarItem> & Pick<CalendarItem, 'id' | 'title' | 'start' | 'end'>): CalendarItem => ({ all_day: false, status: 'confirmed', ...over });
const DESIGN = item({ id: 'provider-event-design', title: 'Synthetic design review', start: '2026-10-03T14:00:00+05:30', end: '2026-10-03T15:00:00+05:30', location: 'Room 4',
  attendees: 7, attendee_names: ['Asha Fixture', 'Ravi Fixture', 'Mina Fixture', 'Tom Fixture'],
  attendee_emails: ['asha@example.test', 'ravi@example.test', 'mina@example.test', 'tom@example.test', 'lee@example.test'] });
// Google lists the owner and a guest who declined; the connector's guest list holds neither.
const ONE_ON_ONE = item({ id: 'provider-event-one-on-one', title: 'Synthetic one to one', start: '2026-10-03T11:00:00Z', end: '2026-10-03T11:30:00Z',
  attendees: 3, attendee_names: ['Pat Fixture'], attendee_emails: ['pat@example.test'] });
const DECLINED_ONLY = item({ id: 'provider-event-declined', title: 'Synthetic declined sync', start: '2026-10-03T12:00:00Z', end: '2026-10-03T12:30:00Z', attendees: 2 });
const FOCUS = item({ id: 'provider-event-focus', title: 'Synthetic writing block', start: '2026-10-03T07:00:00Z', end: '2026-10-03T08:30:00Z' });
const HOLIDAY = item({ id: 'provider-event-holiday', title: 'Synthetic holiday', start: '2026-10-03', end: '2026-10-04', all_day: true });
const CANCELLED = item({ id: 'provider-event-cancelled', title: 'Synthetic cancelled sync', start: '2026-10-03T10:00:00Z', end: '2026-10-03T10:30:00Z', status: 'cancelled' });

describe('GET /app/v1/calendar/day', () => {
  it('populated day: timed events in start order, all-day and cancelled left out, server ids, guests named, no invented pills', async () => {
    fixture.events = [DESIGN, HOLIDAY, CANCELLED, FOCUS, ONE_ON_ONE, DECLINED_ONLY];
    const logs: string[] = [];
    for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    await withOwner('owner-calendar-populated', [account('owner@example.test')], async owner => {
      const response = await ask(owner, 'owner-calendar-populated');
      expect(response.status).toBe(200);
      const body = calendarDayV1Schema.parse(await response.json());
      expect(body).toMatchObject({ day: '2026-10-03', timezone: 'UTC', compiled_at: new Date(AT).toISOString(), freshness: 'fresh',
        calendar: { state: 'available', read_at: new Date(AT).toISOString() }, form: { state: 'unavailable', reason: 'intraday_inputs_unavailable' } });
      expect(body.events.map(event => event.title)).toEqual(['Synthetic writing block', 'Synthetic design review', 'Synthetic one to one', 'Synthetic declined sync']);
      expect(body.events.slice(2).map(event => [event.category, event.attendees])).toEqual([['meeting', { names: ['Pat Fixture'], more: 0 }], ['other', null]]);
      expect(body.events[0]).toMatchObject({ start: '2026-10-03T07:00:00.000Z', end: '2026-10-03T08:30:00.000Z', category: 'other', attendees: null, detail: null, badges: [] });
      expect(body.events[1]).toMatchObject({ start: '2026-10-03T08:30:00.000Z', end: '2026-10-03T09:30:00.000Z', category: 'meeting', detail: 'Room 4',
        attendees: { names: ['Asha Fixture', 'Ravi Fixture', 'Mina Fixture'], more: 2 }, badges: [] });
      for (const event of body.events) expect(event.id).toMatch(/^evt_[0-9a-f]{32}$/);
      expect(JSON.stringify(body)).not.toContain('provider-event');
      // The same day reads to the same ids.
      expect((await (await ask(owner, 'owner-calendar-populated')).json()).events.map((event: { id: string }) => event.id)).toEqual(body.events.map(event => event.id));
      // The owner's own local day, read once from the owner's account.
      expect(fixture.reads[0]).toMatchObject({ from: '2026-10-03T00:00:00.000Z', to: '2026-10-04T00:00:00.000Z', account: { email: 'owner@example.test' } });
    });
    expect(logs.join('\n')).not.toMatch(/Synthetic|Fixture|Room 4|provider-event|owner@example/);
    expect(logs.some(line => line.includes('"hop":"app_calendar_day"') && line.includes('"ok":true'))).toBe(true);
  });

  it('reads every page of the day, keeps an event seen on two pages once, and refuses a day past the page cap', async () => {
    const moved = { ...FOCUS, start: '2026-10-03T07:30:00Z', end: '2026-10-03T08:45:00Z' };
    fixture.pages = [[FOCUS, DESIGN], [moved, ONE_ON_ONE]];
    await withOwner('owner-calendar-pages', [account('owner@example.test')], async owner => {
      const body = calendarDayV1Schema.parse(await (await ask(owner, 'owner-calendar-pages')).json());
      expect(body.events.map(event => [event.title, event.start])).toEqual([
        ['Synthetic writing block', '2026-10-03T07:00:00.000Z'], ['Synthetic design review', '2026-10-03T08:30:00.000Z'], ['Synthetic one to one', '2026-10-03T11:00:00.000Z']]);
      expect(fixture.reads.map(read => read.token ?? null)).toEqual([null, '1']);
    });
    fixture.reads = [];
    fixture.pages = Array.from({ length: 5 }, (_, page) => [{ ...FOCUS, id: `provider-event-${page}` }]);
    await withOwner('owner-calendar-cap', [account('owner@example.test')], async owner => {
      expect((await ask(owner, 'owner-calendar-cap')).status).toBe(503);
      expect(fixture.reads).toHaveLength(4);
    });
  });

  it('empty day: an available calendar with no events', async () => {
    await withOwner('owner-calendar-empty', [account('owner@example.test')], async owner => {
      const body = calendarDayV1Schema.parse(await (await ask(owner, 'owner-calendar-empty', '?day=2026-10-05')).json());
      expect(body).toMatchObject({ day: '2026-10-05', calendar: { state: 'available' }, events: [] });
      expect(fixture.reads[0]).toMatchObject({ from: '2026-10-05T00:00:00.000Z', to: '2026-10-06T00:00:00.000Z' });
    });
  });

  it('reads the day in the owner\'s own zone', async () => {
    await withOwner('owner-calendar-zone', [account('owner@example.test')], async owner => {
      const body = calendarDayV1Schema.parse(await (await ask(owner, 'owner-calendar-zone')).json());
      // 09:00 UTC is 14:30 in Kolkata, still 3 October.
      expect(body).toMatchObject({ day: '2026-10-03', timezone: 'Asia/Kolkata' });
      expect(fixture.reads[0]).toMatchObject({ from: '2026-10-02T18:30:00.000Z', to: '2026-10-03T18:30:00.000Z' });
    }, {}, 'Asia/Kolkata');
  });

  it('not connected: no Google account, no events, and no calendar read', async () => {
    await withOwner('owner-calendar-none', [], async owner => {
      const body = calendarDayV1Schema.parse(await (await ask(owner, 'owner-calendar-none')).json());
      expect(body).toMatchObject({ calendar: { state: 'not_connected' }, events: [] });
      expect(fixture.reads).toEqual([]);
    });
  });

  it('needs reconnect: a failing grant, a grant without the calendar, or a grant Google refuses mid-read', async () => {
    fixture.events = [FOCUS];
    await withOwner('owner-calendar-dead', [account('owner@example.test')], async owner => {
      expect(calendarDayV1Schema.parse(await (await ask(owner, 'owner-calendar-dead')).json())).toMatchObject({ calendar: { state: 'needs_reconnect' }, events: [] });
      expect(fixture.reads).toEqual([]);
    }, { 'local:owner@example.test': 'invalid_grant' });
    await withOwner('owner-calendar-mail-only', [account('owner@example.test', ['https://www.googleapis.com/auth/gmail.readonly'])], async owner => {
      expect(calendarDayV1Schema.parse(await (await ask(owner, 'owner-calendar-mail-only')).json())).toMatchObject({ calendar: { state: 'needs_reconnect' }, events: [] });
    });
    fixture.failure = new GoogleError(401, 'synthetic expired grant');
    await withOwner('owner-calendar-revoked', [account('owner@example.test')], async owner => {
      expect(calendarDayV1Schema.parse(await (await ask(owner, 'owner-calendar-revoked')).json())).toMatchObject({ calendar: { state: 'needs_reconnect' }, events: [] });
    });
  });

  it('a second account that cannot be read leaves the whole day unknown, never a partial day', async () => {
    fixture.events = [FOCUS];
    await withOwner('owner-calendar-two', [account('owner@example.test'), account('work@example.test')], async owner => {
      expect(calendarDayV1Schema.parse(await (await ask(owner, 'owner-calendar-two')).json())).toMatchObject({ calendar: { state: 'needs_reconnect' }, events: [] });
    }, { 'local:work@example.test': 'invalid_grant' });
  });

  it('a failed calendar read is an error, not a free day', async () => {
    fixture.failure = new GoogleError(500, 'synthetic outage');
    await withOwner('owner-calendar-outage', [account('owner@example.test')], async owner => {
      const response = await ask(owner, 'owner-calendar-outage');
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'unavailable' });
    });
  });

  it('only a missing calendar scope is a reconnect: any other 403 is a failed read, never a reason to reconnect', async () => {
    fixture.events = [FOCUS];
    for (const [failure, name] of [[new GoogleError(403, 'synthetic quota exceeded'), 'quota'], [new GoogleError(403, 'synthetic api off', 'SERVICE_DISABLED'), 'disabled']] as const) {
      fixture.failure = failure;
      await withOwner(`owner-calendar-403-${name}`, [account('owner@example.test')], async owner => {
        const response = await ask(owner, `owner-calendar-403-${name}`);
        expect([response.status, await response.json()], name).toEqual([503, { error: 'unavailable' }]);
      });
    }
    fixture.failure = new GoogleError(403, 'synthetic scope', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT');
    await withOwner('owner-calendar-403-scope', [account('owner@example.test')], async owner => {
      expect(calendarDayV1Schema.parse(await (await ask(owner, 'owner-calendar-403-scope')).json())).toMatchObject({ calendar: { state: 'needs_reconnect' }, events: [] });
    });
  });

  it('a health store that cannot be asked leaves Form unavailable, and the calendar still answers', async () => {
    fixture.events = [FOCUS];
    wire.scores = 'throw';
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    await withOwner('owner-calendar-health-down', [account('owner@example.test')], async owner => {
      const response = await ask(owner, 'owner-calendar-health-down');
      expect(response.status).toBe(200);
      expect(calendarDayV1Schema.parse(await response.json())).toMatchObject({ calendar: { state: 'available' }, events: [{ title: 'Synthetic writing block' }], form: { state: 'unavailable', reason: 'intraday_inputs_unavailable' } });
      expect(logs.filter(line => line.includes('"hop":"app_calendar_day"')).map(line => JSON.parse(line).code)).toEqual(['scores_read_failed', 'calendar_available']);
    });
  });

  it('consent withdrawn: Form fails closed with the reason, and the calendar still answers', async () => {
    fixture.events = [FOCUS];
    for (const [answer, reason] of [[{ error: 'consent_withdrawn' }, 'consent_withdrawn'], [{ error: 'consent_required' }, 'consent_required'], [{ error: 'not_linked' }, 'not_linked'],
      [{ unavailable: 'no_readings' }, 'no_readings'], [{ error: 'unavailable' }, 'intraday_inputs_unavailable'], [null, 'intraday_inputs_unavailable']] as const) {
      wire.scores = answer; wire.asked = [];
      await withOwner(`owner-calendar-consent-${reason}`, [account('owner@example.test')], async owner => {
        const body = calendarDayV1Schema.parse(await (await ask(owner, `owner-calendar-consent-${reason}`)).json());
        expect(body.form, JSON.stringify(answer)).toEqual({ state: 'unavailable', reason });
        expect(body).toMatchObject({ calendar: { state: 'available' }, events: [{ title: 'Synthetic writing block' }] });
        // The health read is the session owner's, for the day shown.
        const read = wire.asked.find(call => call.fn === 'health_scores_read');
        expect(read?.body).toMatchObject({ p_do_name: `owner-calendar-consent-${reason}`, p_payload: JSON.stringify({ day: '2026-10-03' }) });
      });
    }
  });

  it('refuses a session the directory does not hold, before reading anything', async () => {
    wire.session = false;
    fixture.events = [FOCUS];
    await withOwner('owner-calendar-signed-out', [account('owner@example.test')], async owner => {
      const response = await ask(owner, 'owner-calendar-signed-out');
      expect(response.status).toBe(403);
      expect(fixture.reads).toEqual([]);
      expect(wire.asked.some(call => call.fn === 'health_scores_read')).toBe(false);
    });
  });

  it('a session signed out while Google is read gets the generic 503 its sibling reads give, with no events', async () => {
    fixture.events = [FOCUS, ONE_ON_ONE];
    fixture.onRead = () => { wire.session = false; };
    const logs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    await withOwner('owner-calendar-revoked-mid-read', [account('owner@example.test')], async owner => {
      const response = await ask(owner, 'owner-calendar-revoked-mid-read');
      expect(fixture.reads).toHaveLength(1);
      expect([response.status, await response.json()]).toEqual([503, { error: 'unavailable' }]);
      expect(logs.map(line => JSON.parse(line))).toContainEqual({ hop: 'app_calendar_day', ok: false, code: 'session' });
    });
  });

  it('refuses a malformed query and anything but GET', async () => {
    await withOwner('owner-calendar-query', [account('owner@example.test')], async owner => {
      for (const query of ['?day=today', '?day=2026-02-30', '?day=2026-10-03&owner=someone-else', '?days=7', '?day=2026-10-03&day=2026-10-04']) {
        const response = await ask(owner, 'owner-calendar-query', query);
        expect(response.status, query).toBe(400);
        expect(await response.json()).toEqual({ error: 'invalid_request' });
      }
      expect((await ask(owner, 'owner-calendar-query', '', 'POST')).status).toBe(405);
      expect(fixture.reads).toEqual([]);
    });
  });
});
