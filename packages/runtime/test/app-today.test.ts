import { describe, expect, it } from 'vitest';
import { appApprovalListV1Schema } from '../../contracts/src/app/approvals';
import { calendarDayV1Schema } from '../../contracts/src/app/calendar-day';
import { appControlDayDataV1Schema } from '../../contracts/src/app/controls';
import { linkCodeHash } from '../src/identity/owner-directory';
import { handleApp } from '../src/channels/app-api';
import { appToday } from '../src/channels/app-today';
import type { ConsoleAuth } from '../src/identity/console-auth';

// Synthetic values: a made-up day, events and Brief.
const SESSION = 'a'.repeat(32);
const CREDENTIAL = `owner-1.${SESSION}.sig`;
const auth = { readAppCredential: async (credential: string) => (credential === CREDENTIAL ? 'owner-1' : null) } as unknown as ConsoleAuth;
const NOW = Date.parse('2026-11-06T05:00:00.000Z');
const event = (id: string, start: string, end: string, extra: object = {}) =>
  ({ id, title: `Event ${id}`, detail: null, start, end, category: 'meeting', attendees: { names: ['Someone'], more: 2 }, badges: ['priority'], ...extra });
const calendarDay = {
  day: '2026-11-06', timezone: 'Asia/Kolkata', compiled_at: '2026-11-06T05:00:00.000Z', freshness: 'fresh',
  calendar: { state: 'available', read_at: '2026-11-06T05:00:00.000Z' },
  events: [
    event('done', '2026-11-06T03:00:00Z', '2026-11-06T04:00:00Z'),
    event('long', '2026-11-06T04:00:00Z', '2026-11-06T07:00:00Z'),
    event('now', '2026-11-06T04:30:00Z', '2026-11-06T05:30:00Z'),
    event('next', '2026-11-06T06:00:00Z', '2026-11-06T06:30:00Z'),
  ],
  form: { state: 'unavailable', reason: 'consent_required' },
};
const card = (approval_id: string, state: string) => ({
  approval_id, kind: 'email_send', state, review: 'From: me@example.com\nTo: sam@example.com\nSubject: Friday\n\nSee you at 4.',
  exact: { recipients: { to: ['sam@example.com'], cc: [], bcc: [] }, scope: 'me@example.com' },
  payload_digest: `sha256:${'a'.repeat(64)}`, expires_at: Date.UTC(2026, 10, 7), actions: state === 'open' ? ['approve', 'edit', 'skip'] : [],
});
const approvals = { approvals: [card('p0001', 'open'), card('p0002', 'open'), card('p0003', 'done')] };
const dayCard = (id: string, name: string, latest: unknown) => ({ id, name, defaultTime: '07:30', time: null, reason: 'Planned for the morning', sent: latest !== null && latest !== undefined, pin: null, ...(latest === undefined ? {} : { latest }) });
const controls = (latest: unknown) => ({ view: 'day', revision: 'r1', data: { timezone: 'Asia/Kolkata', cards: [dayCard('card:brief', 'Brief', latest), dayCard('card:close', 'Close', null)] } });
const brief = { message_id: 'row-1', delivered_at: 1_762_400_000_000, excerpt: 'A light morning, then the review at ten.' };

const reader = (answers: Record<string, unknown>) => {
  const asked: string[] = [];
  const read = async (path: string) => {
    asked.push(path);
    const value = answers[path];
    return value instanceof Error ? Promise.reject(value) : value === undefined ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json(value);
  };
  return { asked, read };
};
const all = (over: Record<string, unknown> = {}) => ({
  '/app/v1/calendar/day': calendarDay, '/app/v1/approvals': approvals, '/app/v1/controls?view=day': controls(brief), ...over,
});

describe('today', () => {
  it('reads from fixtures the real calendar day, approvals and day card contracts accept', () => {
    expect(calendarDayV1Schema.safeParse(calendarDay).error?.issues).toBeUndefined();
    expect(appApprovalListV1Schema.safeParse(approvals).error?.issues).toBeUndefined();
    for (const latest of [brief, null, undefined]) expect(appControlDayDataV1Schema.shape.cards.element.safeParse(dayCard('card:brief', 'Brief', latest)).error?.issues).toBeUndefined();
  });

  it('reads the owner\'s own calendar day, approvals and day view, and keeps only a glance of each', async () => {
    const { asked, read } = reader(all());
    const response = await appToday(read, NOW);
    expect([response.status, response.headers.get('cache-control')]).toEqual([200, 'no-store']);
    expect(asked.sort()).toEqual(['/app/v1/approvals', '/app/v1/calendar/day', '/app/v1/controls?view=day']);
    expect(await response.json()).toEqual({
      compiled_at: '2026-11-06T05:00:00.000Z', day: '2026-11-06', timezone: 'Asia/Kolkata',
      calendar: { state: 'available', left: 3,
        now: { id: 'now', title: 'Event now', start: '2026-11-06T04:30:00Z', end: '2026-11-06T05:30:00Z', category: 'meeting' },
        next: { id: 'next', title: 'Event next', start: '2026-11-06T06:00:00Z', end: '2026-11-06T06:30:00Z', category: 'meeting' } },
      approvals: { state: 'available', waiting: 2 },
      brief: { state: 'delivered', excerpt: brief.excerpt, delivered_at: brief.delivered_at },
    });
  });

  it('reads past fields a later revision adds, and a calendar kind it does not know reads as other', async () => {
    const { read } = reader(all({
      '/app/v1/approvals': { approvals: [{ ...card('p0001', 'open'), why_from_a_later_revision: {} }] },
      '/app/v1/calendar/day': { ...calendarDay, events: [event('next', '2026-11-06T06:00:00Z', '2026-11-06T06:30:00Z', { category: 'travel' })] },
    }));
    expect(await (await appToday(read, NOW)).json()).toMatchObject({ approvals: { state: 'available', waiting: 1 }, calendar: { state: 'available', next: { category: 'other' } } });
  });

  it('answers each part on its own when another cannot be read', async () => {
    const { read } = reader(all({ '/app/v1/calendar/day': undefined, '/app/v1/approvals': new Error('network'), '/app/v1/controls?view=day': { view: 'day', data: 'garbled' } }));
    expect(await (await appToday(read, NOW)).json()).toMatchObject({
      day: null, timezone: null, calendar: { state: 'unavailable' }, approvals: { state: 'unavailable' }, brief: { state: 'unavailable' },
    });
    const { read: partial } = reader(all({ '/app/v1/approvals': undefined }));
    expect(await (await appToday(partial, NOW)).json()).toMatchObject({ calendar: { state: 'available' }, approvals: { state: 'unavailable' }, brief: { state: 'delivered' } });
  });

  it('says what the calendar and the Brief say when there is nothing to show', async () => {
    const { read } = reader(all({ '/app/v1/calendar/day': { ...calendarDay, calendar: { state: 'needs_reconnect' }, events: [] }, '/app/v1/controls?view=day': controls(null) }));
    expect(await (await appToday(read, NOW)).json()).toMatchObject({ day: '2026-11-06', calendar: { state: 'needs_reconnect' }, brief: { state: 'not_delivered' } });
    const late = reader(all({ '/app/v1/controls?view=day': controls(undefined) }));
    expect((await (await appToday(late.read, NOW)).json() as { brief: unknown }).brief).toEqual({ state: 'unavailable' });
    const evening = reader(all());
    expect((await (await appToday(evening.read, Date.parse('2026-11-06T08:00:00Z'))).json() as { calendar: unknown }).calendar).toEqual({ state: 'available', now: null, next: null, left: 0 });
  });

  it('never answers a shape outside its contract', async () => {
    const { read } = reader(all({ '/app/v1/calendar/day': { ...calendarDay, day: 'tomorrow' } }));
    expect((await appToday(read, NOW)).status).toBe(503);
  });
});

describe('the today route', () => {
  const forwards: Request[] = [];
  const keys: string[] = [];
  const env = (limited = false) => ({
    OWNER_DO: { idFromName: (n: string) => n, get: () => ({ fetch: async (request: Request) => {
      forwards.push(request);
      const path = new URL(request.url).pathname + new URL(request.url).search;
      return Response.json(all()[path as keyof ReturnType<typeof all>]);
    } }) },
    RESPONSIBILITY_RATE_LIMITER: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: !limited }; } },
    SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: 'fictional-router-secret-00000000000000000',
  }) as never;
  const get = (path: string, headers: Record<string, string> = { authorization: `Bearer ${CREDENTIAL}` }, method = 'GET') =>
    handleApp(new Request(`https://w.test${path}`, { method, headers }), env(), auth) as Promise<Response>;

  it('asks the session owner\'s Durable Object as this session and build, on one read charge', async () => {
    forwards.length = 0; keys.length = 0;
    const response = await get('/app/v1/today', { authorization: `Bearer ${CREDENTIAL}`, 'x-waldo-app-contract': 'approvals=3,controls=9' });
    expect([response.status, (await response.json() as { approvals: unknown }).approvals]).toEqual([200, { state: 'available', waiting: 2 }]);
    expect(keys).toEqual(['app-read:owner-1']);
    const hash = await linkCodeHash(SESSION);
    expect(forwards.map(r => [r.method, new URL(r.url).pathname + new URL(r.url).search, r.headers.get('x-waldo-do-name'), r.headers.get('x-waldo-app-session-hash'), r.headers.get('x-waldo-app-contract')]).sort())
      .toEqual([
        ['GET', '/app/v1/approvals', 'owner-1', hash, 'approvals=3,controls=9'],
        ['GET', '/app/v1/calendar/day', 'owner-1', hash, 'approvals=3,controls=9'],
        ['GET', '/app/v1/controls?view=day', 'owner-1', hash, 'approvals=3,controls=9'],
      ]);
  });

  it('needs a credential, takes no query and answers only a read', async () => {
    forwards.length = 0;
    expect((await get('/app/v1/today', {})).status).toBe(401);
    expect((await get('/app/v1/today?day=2026-11-07')).status).toBe(400);
    expect((await get('/app/v1/today', { authorization: `Bearer ${CREDENTIAL}` }, 'POST')).status).toBe(405);
    expect((await handleApp(new Request('https://w.test/app/v1/today', { headers: { authorization: `Bearer ${CREDENTIAL}` } }), env(true), auth))!.status).toBe(429);
    expect(forwards).toEqual([]);
  });
});
