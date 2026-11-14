import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appApprovalV1Schema, type AppApprovalV1 } from '../../contracts/src/app/approvals';
import { calendarProposalApiErrorV1Schema, calendarProposalResponseV1Schema } from '../../contracts/src/app/calendar-proposal';
import { GoogleError, type CalendarItem } from '../src/connectors/google';
import { appSubjectFor } from '../src/channels/app-api';
import { appApprovalStepUp } from '../src/channels/approval-step-up';
import { traceBook } from '../src/channels/harness';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

// POST /app/v1/calendar/proposals through the owner's real Durable Object and its real approval desk: the session check,
// the day's read that resolves an event id, and the calendar_change card. Google and the directory are fixtures with
// synthetic content; every calendar write the fixture sees is recorded, and the route must cause none.
const fixture = vi.hoisted(() => ({ events: [] as unknown[], writes: [] as unknown[][], gone: false }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original, googleClient: (_app: unknown, _tokens: unknown, _fetch: unknown, _health: unknown, account: unknown) => ({
    account,
    events: async () => fixture.events,
    calendarPage: async () => ({ events: fixture.events, next_page_token: null, fetched_count: fixture.events.length, account, observed_at: new Date().toISOString() }),
    event: async (id: string) => {
      const found = (fixture.events as Array<{ id: string }>).find(event => event.id === id);
      if (!found || fixture.gone) throw new original.GoogleError(404, 'synthetic not found');
      return { ...found, etag: 'synthetic-etag-1' };
    },
    createEvent: async (...args: unknown[]) => { fixture.writes.push(['create', ...args]); return { id: 'provider-event-created', title: '', start: '', end: '', all_day: false, etag: 'synthetic-etag-2' }; },
    moveEvent: async (...args: unknown[]) => { fixture.writes.push(['move', ...args]); return { id: String(args[0]), title: '', start: '', end: '', all_day: false, etag: 'synthetic-etag-2' }; },
    cancelEvent: async (...args: unknown[]) => { fixture.writes.push(['cancel', ...args]); },
  }) };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '6c4d5e6f-7081-4b9c-8d1e-2f3a4b5c6d7e';
const AT = Date.parse('2026-10-03T09:00:00Z');
const HASH = 'b'.repeat(64);
const CALENDAR = 'https://www.googleapis.com/auth/calendar.events';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const wire = { session: true };

beforeEach(() => {
  fixture.events = []; fixture.writes = []; fixture.gone = false; wire.session = true;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1] ?? url;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: body.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'app_session_authority') return Response.json(wire.session ? { owner_id: OWNER_ID, do_name: body.p_do_name, session_hash: body.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 } : null);
    if (fn === 'health_scores_read') return Response.json({});
    if (fn === 'health_log_recent') return Response.json([]);
    if (fn === 'health_context_read') return Response.json(null);
    if (fn === 'assert_channel_presence') return Response.json(false);
    return Response.json(true);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Desk = Readonly<{ approvals(now: number, filter?: { id?: string }): Promise<readonly AppApprovalV1[]>; decide(id: string, action: string, trace: string, via?: { surface: string }): Promise<unknown> }>;
type Owner = Readonly<{ setup(channel: string): { ready: Promise<unknown>; desk: Desk }; fetch(request: Request): Promise<Response> }>;
type Account = Readonly<{ id: string; email: string; refresh_token: string; scopes: readonly string[] }>;
type Ledger = () => Array<{ id: string; kind: string; status: string }>;
const account = (email: string, scopes: readonly string[] = [CALENDAR]): Account => ({ id: `local:${email}`, email, refresh_token: 'synthetic-offline-only', scopes });

const withOwner = async (name: string, accounts: readonly Account[], run: (owner: Owner, ledger: Ledger) => Promise<void>, failing: Record<string, string> = {}) => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const originalNow = Date.now;
    Date.now = () => AT;
    try {
      claimStore(state.storage.sql); ensureSchema(state.storage); traceBook(state.storage.sql);
      state.storage.kv.put('do_name', name);
      state.storage.kv.put('app_subject', String(appSubjectFor(name)));
      state.storage.kv.put('timezone', 'UTC');
      state.storage.kv.put('timezone_confirmed', true);
      await state.storage.put('origin', 'https://fixture.invalid');
      await state.storage.put('google:accounts', accounts);
      await state.storage.put('google:health', failing);
      const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC',
        WALDO_OWNER_TELEGRAM_ID: undefined, GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret' }) as unknown as Owner;
      await owner.setup('app').ready;
      await run(owner, () => state.storage.sql.exec<{ id: string; kind: string; status: string }>('SELECT id, kind, status FROM ledger ORDER BY created_at, id').toArray());
    } finally { Date.now = originalNow; await state.storage.deleteAlarm(); }
  });
};
type Reply = Omit<Response, 'json'> & { json(): Promise<any> };
const headers = (name: string) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': HASH, 'content-type': 'application/json' });
const propose = (owner: Owner, name: string, body: unknown, method = 'POST') => owner.fetch(new Request('https://telegram-owner/app/v1/calendar/proposals', {
  method, headers: headers(name), ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
})) as Promise<Reply>;
// The ids the app holds are the ones the day read gave it.
const dayIds = async (owner: Owner, name: string, day = '2026-10-03'): Promise<Record<string, string>> => {
  const response = await owner.fetch(new Request(`https://telegram-owner/app/v1/calendar/day?day=${day}`, { headers: headers(name) }));
  return Object.fromEntries(((await response.json()) as { events: Array<{ id: string; title: string }> }).events.map(event => [event.title, event.id]));
};
const raised = async (response: Reply): Promise<string> => {
  expect(response.status).toBe(201);
  return calendarProposalResponseV1Schema.parse(await response.json()).approval_id;
};
const refused = async (response: Reply, status: number, error: string) => {
  expect([response.status, calendarProposalApiErrorV1Schema.parse(await response.json())]).toEqual([status, { error }]);
};
const card = async (owner: Owner, id: string): Promise<AppApprovalV1> => appApprovalV1Schema.parse((await owner.setup('app').desk.approvals(AT, { id }))[0]);

const item = (over: Partial<CalendarItem> & Pick<CalendarItem, 'id' | 'title' | 'start' | 'end'>): CalendarItem => ({ all_day: false, status: 'confirmed', ...over });
const MEETING = item({ id: 'provider-event-meeting', title: 'Synthetic design review', start: '2026-10-03T15:00:00Z', end: '2026-10-03T16:00:00Z', location: 'Room 4',
  attendees: 3, attendee_names: ['Asha Fixture', 'Ravi Fixture'], attendee_emails: ['asha@example.test', 'ravi@example.test'] });
const BLOCK = item({ id: 'provider-event-block', title: 'Synthetic writing block', start: '2026-10-03T17:00:00Z', end: '2026-10-03T18:00:00Z' });
const EARLIER = item({ id: 'provider-event-earlier', title: 'Synthetic standup', start: '2026-10-03T07:00:00Z', end: '2026-10-03T07:15:00Z' });
const CREATE = { action: 'create', title: 'Synthetic lunch', start: '2026-10-03T12:00:00Z', end: '2026-10-03T13:00:00Z' };
const REQUEST = 'request-0001';

describe('POST /app/v1/calendar/proposals', () => {
  it('create: raises a calendar_change card with the exact change, writes nothing, and the calendar is written only when the card is approved', async () => {
    await withOwner('owner-proposal-create', [account('owner@example.test')], async (owner, ledger) => {
      const id = await raised(await propose(owner, 'owner-proposal-create', { request_id: REQUEST, change: { ...CREATE, location: 'Cafe Fixture' } }));
      expect(fixture.writes).toEqual([]);
      expect(ledger()).toEqual([{ id, kind: 'calendar_change', status: 'open' }]);
      const approval = await card(owner, id);
      expect(approval).toMatchObject({ approval_id: id, kind: 'calendar_change', state: 'open', payload_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        exact: { changes: { action: 'create', title: 'Synthetic lunch', start: CREATE.start, end: CREATE.end, location: 'Cafe Fixture', account: 'owner@example.test', time_zone: 'UTC' } } });
      expect(approval.exact.changes).not.toHaveProperty('guests');
      expect(approval.exact.changes).not.toHaveProperty('emails_guests');
      expect(approval.actions).toContain('approve');
      expect(approval.review).toContain('You asked for this from your calendar.');

      await owner.setup('app').desk.decide(id, 'a', 'test', { surface: 'app' });
      expect(fixture.writes).toHaveLength(1);
      expect(fixture.writes[0]).toMatchObject(['create', { title: 'Synthetic lunch', start: CREATE.start, end: CREATE.end, location: 'Cafe Fixture' }]);
      expect((await card(owner, id)).state).toBe('done');
    });
  });

  it('create with guests: the card names every guest and says Google emails them, and reaches beyond the owner', async () => {
    await withOwner('owner-proposal-guests', [account('owner@example.test')], async (owner) => {
      const guests = ['asha@example.test', 'ravi@example.test'];
      const id = await raised(await propose(owner, 'owner-proposal-guests', { request_id: REQUEST, change: { ...CREATE, guests } }));
      const approval = await card(owner, id);
      expect(approval.exact.changes).toMatchObject({ action: 'create', title: 'Synthetic lunch', guests, emails_guests: true });
      for (const shown of [...guests, 'Google emails the 2 guests']) expect(approval.review).toContain(shown);
      expect(appApprovalStepUp(approval, 'approve')).toBe(true);
      expect(fixture.writes).toEqual([]);
    });
  });

  it('move: resolves the day\'s event id to the provider event, shows the old and new time, and says the guests are emailed', async () => {
    fixture.events = [MEETING, BLOCK];
    await withOwner('owner-proposal-move', [account('owner@example.test')], async (owner) => {
      const ids = await dayIds(owner, 'owner-proposal-move');
      const change = { action: 'move', event_id: ids['Synthetic design review'], day: '2026-10-03', start: '2026-10-03T19:00:00Z', end: '2026-10-03T20:00:00Z' };
      const id = await raised(await propose(owner, 'owner-proposal-move', { request_id: REQUEST, change }));
      expect(fixture.writes).toEqual([]);
      const approval = await card(owner, id);
      expect(approval.exact.changes).toEqual({ action: 'move', title: 'Synthetic design review', start: change.start, end: change.end, emails_guests: true,
        account: 'owner@example.test', previous: { start: MEETING.start, end: MEETING.end }, time_zone: 'UTC' });
      expect(approval.review).toContain('Google emails the 3 guests');

      await owner.setup('app').desk.decide(id, 'a', 'test', { surface: 'app' });
      expect(fixture.writes).toHaveLength(1);
      expect(fixture.writes[0]!.slice(0, 5)).toEqual(['move', 'provider-event-meeting', change.start, change.end, 'synthetic-etag-1']);
      expect(fixture.writes[0]!.at(-1)).toEqual({ sendUpdates: 'all' });

      // An event with no guests says nothing about emailing anyone.
      const solo = await raised(await propose(owner, 'owner-proposal-move', { request_id: 'request-0002', change: { ...change, event_id: ids['Synthetic writing block'] } }));
      const quiet = await card(owner, solo);
      expect(quiet.exact.changes).not.toHaveProperty('emails_guests');
      expect(appApprovalStepUp(quiet, 'approve')).toBe(false);
    });
  });

  it('cancel: raises the card for that event, and cancels it only on approval', async () => {
    fixture.events = [MEETING, BLOCK];
    await withOwner('owner-proposal-cancel', [account('owner@example.test')], async (owner) => {
      const ids = await dayIds(owner, 'owner-proposal-cancel');
      const id = await raised(await propose(owner, 'owner-proposal-cancel', { request_id: REQUEST, change: { action: 'cancel', event_id: ids['Synthetic writing block'], day: '2026-10-03' } }));
      expect(fixture.writes).toEqual([]);
      expect((await card(owner, id)).exact.changes).toEqual({ action: 'cancel', title: 'Synthetic writing block', start: null, end: null, account: 'owner@example.test', time_zone: 'UTC' });
      await owner.setup('app').desk.decide(id, 'a', 'test', { surface: 'app' });
      expect(fixture.writes.map(write => write.slice(0, 2))).toEqual([['cancel', 'provider-event-block']]);
    });
  });

  it('a repeated request_id answers the same approval and never a second card; reused for another change it is refused', async () => {
    fixture.events = [BLOCK];
    await withOwner('owner-proposal-repeat', [account('owner@example.test')], async (owner, ledger) => {
      const body = { request_id: REQUEST, change: CREATE };
      const first = await raised(await propose(owner, 'owner-proposal-repeat', body));
      expect(await raised(await propose(owner, 'owner-proposal-repeat', body))).toBe(first);
      // The same change with its keys in another order is the same request.
      expect(await raised(await propose(owner, 'owner-proposal-repeat', { change: { end: CREATE.end, start: CREATE.start, title: CREATE.title, action: 'create' }, request_id: REQUEST }))).toBe(first);
      expect(ledger()).toHaveLength(1);
      await refused(await propose(owner, 'owner-proposal-repeat', { request_id: REQUEST, change: { ...CREATE, title: 'Synthetic dinner' } }), 409, 'request_reused');
      expect(ledger()).toHaveLength(1);
      // Still the same answer once the card has been decided.
      await owner.setup('app').desk.decide(first, 's', 'test', { surface: 'app' });
      expect(await raised(await propose(owner, 'owner-proposal-repeat', body))).toBe(first);
      // A new request_id is a new card.
      expect(await raised(await propose(owner, 'owner-proposal-repeat', { ...body, request_id: 'request-0002' }))).not.toBe(first);
      expect(ledger()).toHaveLength(2);
      expect(fixture.writes).toEqual([]);
    });
  });

  it('an event id that is not on that day any more is 404, and raises nothing', async () => {
    fixture.events = [MEETING];
    await withOwner('owner-proposal-unknown', [account('owner@example.test')], async (owner, ledger) => {
      const ids = await dayIds(owner, 'owner-proposal-unknown');
      const known = ids['Synthetic design review']!;
      await refused(await propose(owner, 'owner-proposal-unknown', { request_id: REQUEST, change: { action: 'cancel', event_id: `evt_${'0'.repeat(32)}`, day: '2026-10-03' } }), 404, 'event_not_found');
      // The provider's own id is not the server's.
      await refused(await propose(owner, 'owner-proposal-unknown', { request_id: REQUEST, change: { action: 'cancel', event_id: MEETING.id, day: '2026-10-03' } }), 404, 'event_not_found');
      // The event left the day after the app read it.
      fixture.events = [];
      await refused(await propose(owner, 'owner-proposal-unknown', { request_id: REQUEST, change: { action: 'cancel', event_id: known, day: '2026-10-03' } }), 404, 'event_not_found');
      // It went between the day's read and the desk's own read of it.
      fixture.events = [MEETING]; fixture.gone = true;
      await refused(await propose(owner, 'owner-proposal-unknown', { request_id: REQUEST, change: { action: 'cancel', event_id: known, day: '2026-10-03' } }), 404, 'event_not_found');
      expect(ledger()).toEqual([]);
      expect(fixture.writes).toEqual([]);
    });
  });

  it('no calendar: not_connected without an account, needs_reconnect with a dead or calendar-less grant, and no card', async () => {
    fixture.events = [BLOCK];
    const cancel = { action: 'cancel', event_id: `evt_${'0'.repeat(32)}`, day: '2026-10-03' };
    await withOwner('owner-proposal-none', [], async (owner, ledger) => {
      await refused(await propose(owner, 'owner-proposal-none', { request_id: REQUEST, change: CREATE }), 409, 'not_connected');
      await refused(await propose(owner, 'owner-proposal-none', { request_id: 'request-0002', change: cancel }), 409, 'not_connected');
      expect(ledger()).toEqual([]);
    });
    await withOwner('owner-proposal-dead', [account('owner@example.test')], async (owner, ledger) => {
      await refused(await propose(owner, 'owner-proposal-dead', { request_id: REQUEST, change: CREATE }), 409, 'needs_reconnect');
      await refused(await propose(owner, 'owner-proposal-dead', { request_id: 'request-0002', change: cancel }), 409, 'needs_reconnect');
      expect(ledger()).toEqual([]);
    }, { 'local:owner@example.test': 'invalid_grant' });
    await withOwner('owner-proposal-mail-only', [account('owner@example.test', ['https://www.googleapis.com/auth/gmail.readonly'])], async (owner, ledger) => {
      await refused(await propose(owner, 'owner-proposal-mail-only', { request_id: REQUEST, change: CREATE }), 409, 'needs_reconnect');
      expect(ledger()).toEqual([]);
    });
    expect(fixture.writes).toEqual([]);
  });

  it('a time that has already started is too late: no card that could never be approved', async () => {
    fixture.events = [EARLIER, BLOCK];
    await withOwner('owner-proposal-late', [account('owner@example.test')], async (owner, ledger) => {
      const ids = await dayIds(owner, 'owner-proposal-late');
      await refused(await propose(owner, 'owner-proposal-late', { request_id: REQUEST, change: { ...CREATE, start: '2026-10-03T08:00:00Z', end: '2026-10-03T08:30:00Z' } }), 409, 'too_late');
      const later = { day: '2026-10-03', start: '2026-10-03T19:00:00Z', end: '2026-10-03T20:00:00Z' };
      await refused(await propose(owner, 'owner-proposal-late', { request_id: REQUEST, change: { action: 'move', event_id: ids['Synthetic standup'], ...later } }), 409, 'too_late');
      await refused(await propose(owner, 'owner-proposal-late', { request_id: REQUEST, change: { action: 'move', event_id: ids['Synthetic writing block'], day: '2026-10-03', start: '2026-10-03T08:00:00Z', end: '2026-10-03T08:30:00Z' } }), 409, 'too_late');
      expect(ledger()).toEqual([]);
    });
  });

  it('refuses a session the directory does not hold, a body that is not the contract, and anything but POST', async () => {
    fixture.events = [BLOCK];
    await withOwner('owner-proposal-refusals', [account('owner@example.test')], async (owner, ledger) => {
      for (const body of ['not json', {}, { request_id: 'short', change: CREATE }, { request_id: REQUEST, change: { ...CREATE, end: CREATE.start } },
        { request_id: REQUEST, change: { ...CREATE, owner: 'someone-else' } }, { request_id: REQUEST, change: { action: 'cancel', event_id: 'evt_1' } }])
        await refused(await propose(owner, 'owner-proposal-refusals', body), 400, 'invalid_request');
      expect((await propose(owner, 'owner-proposal-refusals', null, 'GET')).status).toBe(405);
      wire.session = false;
      expect((await propose(owner, 'owner-proposal-refusals', { request_id: REQUEST, change: CREATE })).status).toBe(403);
      expect(ledger()).toEqual([]);
      expect(fixture.writes).toEqual([]);
    });
  });

  it('logs the action and a reason code, never a title, a place, a guest or an event id', async () => {
    fixture.events = [MEETING];
    const logs: string[] = [];
    for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    await withOwner('owner-proposal-logs', [account('owner@example.test')], async (owner) => {
      const ids = await dayIds(owner, 'owner-proposal-logs');
      await raised(await propose(owner, 'owner-proposal-logs', { request_id: REQUEST, change: { ...CREATE, location: 'Cafe Fixture', guests: ['asha@example.test'] } }));
      await raised(await propose(owner, 'owner-proposal-logs', { request_id: 'request-0002', change: { action: 'cancel', event_id: ids['Synthetic design review'], day: '2026-10-03' } }));
      await refused(await propose(owner, 'owner-proposal-logs', { request_id: 'request-0003', change: { action: 'cancel', event_id: `evt_${'0'.repeat(32)}`, day: '2026-10-03' } }), 404, 'event_not_found');
    });
    const hops = logs.filter(line => line.includes('"hop":"app_calendar_proposal"')).map(line => JSON.parse(line));
    expect(hops.map(({ ok, code, action }) => [ok, code, action])).toEqual([[true, 'raised', 'create'], [true, 'raised', 'cancel'], [false, 'event_not_found', 'cancel']]);
    expect(logs.join('\n')).not.toMatch(/Synthetic|Fixture|Room 4|provider-event|example\.test|evt_/);
  });
});
