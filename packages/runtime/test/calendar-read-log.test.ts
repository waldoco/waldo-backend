import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryCalendarArgsSchema } from '@waldo/contracts';
import { googleClient } from '../src/connectors/google';
import { googleHandlers } from '../src/tools/live/google';

const app = { clientId: 'fixture', clientSecret: 'fixture', redirectUri: 'https://example.test/callback' };
const account = { connection_id: 'personal-connection', email: 'owner@example.test' };
const clock = { timezone: 'UTC', now: () => new Date('2026-10-10T00:00:00Z') };
const desk = { propose: async () => '', proposeSendEmail: async () => '', record: () => {} };
const TEAM = 'team@group.calendar.google.com';
const event = (id: string, hour: number) => ({ id, summary: `Board review ${id}`, start: { dateTime: `2026-10-10T${String(hour).padStart(2, '0')}:00:00Z` }, end: { dateTime: `2026-10-10T${String(hour).padStart(2, '0')}:30:00Z` } });

type Account = Readonly<{ connection_id: string | null; email: string | null }>;
const read = async (args: Record<string, unknown>, respond: (url: URL) => unknown, owner: Account = account) => {
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    return Response.json(url.hostname === 'oauth2.googleapis.com' ? { access_token: 'fixture' } : respond(url));
  }) as typeof fetch;
  const client = googleClient(app, { refresh_token: 'grant' }, fetcher, undefined, owner);
  const handler = googleHandlers({ client: async () => client } as never, desk, clock).find(h => h.name === 'query_calendar')!;
  return await handler.handle(queryCalendarArgsSchema.parse(args)) as { ok: boolean; data?: { next_page_token: string | null } };
};

let log: ReturnType<typeof vi.spyOn>;
const lines = () => (log.mock.calls as unknown[][]).map(([line]) => String(line));
const readLines = () => lines().flatMap(line => { try { const parsed = JSON.parse(line); return parsed.hop === 'calendar_read' ? [parsed] : []; } catch { return []; } });
afterEach(() => vi.restoreAllMocks());

describe('the calendar read log line', () => {
  it('says which window, which kind of calendar and which page were read, and how many events came back', async () => {
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect((await read({}, () => ({ kind: 'calendar#events', items: [event('a', 9), event('b', 10), event('f', 12)] }))).ok).toBe(true);
    expect((await read({ calendar_id: TEAM, date_range: { from: '2026-10-11T00:00:00Z', to: '2026-10-12T00:00:00Z' } }, () => ({ kind: 'calendar#events', items: [event('c', 11)] }))).ok).toBe(true);
    // The primary calendar read by its id, which is the account address.
    expect((await read({ calendar_id: 'Owner@Example.test' }, () => ({ kind: 'calendar#events', items: [event('h', 13), event('i', 14)] }))).ok).toBe(true);
    // A continuation repeats its explicit window.
    const window = { date_range: { from: '2026-10-10T00:00:00Z', to: '2026-10-11T00:00:00Z' }, limit: 1 };
    const first = await read(window, () => ({ kind: 'calendar#events', items: [event('d', 9)], nextPageToken: 'provider-next' }));
    const next = await read({ ...window, page_token: first.data!.next_page_token }, () => ({ kind: 'calendar#events', items: [] }));
    expect(next.ok).toBe(true);
    expect(readLines()).toEqual([
      { hop: 'calendar_read', ok: true, code: 'window_default:calendar_primary:page_first', count: 3 },
      { hop: 'calendar_read', ok: true, code: 'window_date_range:calendar_other:page_first', count: 1 },
      { hop: 'calendar_read', ok: true, code: 'window_default:calendar_primary:page_first', count: 2 },
      { hop: 'calendar_read', ok: true, code: 'window_date_range:calendar_primary:page_first', count: 1 },
      { hop: 'calendar_read', ok: true, code: 'window_date_range:calendar_primary:page_next', count: 0 },
    ]);
  });

  it('keeps every code the handler can log within the hop-code charset', async () => {
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const range = { from: '2026-10-10T00:00:00Z', to: '2026-10-11T00:00:00Z' };
    for (const date_range of [undefined, range]) for (const calendar_id of ['primary', TEAM]) {
      const window = { ...(date_range ? { date_range } : {}), calendar_id, limit: 1 };
      const first = await read(window, () => ({ kind: 'calendar#events', items: [event('j', 9)], nextPageToken: 'provider-next' }));
      if (date_range) await read({ ...window, page_token: first.data!.next_page_token }, () => ({ kind: 'calendar#events', items: [] }));
    }
    const codes = readLines().map(line => line.code as string);
    expect(new Set(codes).size).toBe(6);
    for (const code of codes) expect(code).toMatch(/^[a-z0-9_:]{1,64}$/);
    // The other two combinations cannot be logged: a continuation must repeat an explicit window.
    expect(queryCalendarArgsSchema.safeParse({ page_token: 'next' }).success).toBe(false);
  });

  it('reads with an account that has no known address, and calls only the literal primary id primary', async () => {
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const anonymous = { connection_id: null, email: null };
    for (const calendar_id of ['primary', TEAM, account.email]) expect((await read({ calendar_id }, () => ({ kind: 'calendar#events', items: [] }), anonymous)).ok).toBe(true);
    expect(readLines().map(line => line.code)).toEqual(['window_default:calendar_primary:page_first', 'window_default:calendar_other:page_first', 'window_default:calendar_other:page_first']);
  });

  it('never logs the calendar id, the account, the window or any event text, and logs nothing for a calendar listing', async () => {
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const window = { from: '2026-10-13T07:17:00Z', to: '2026-10-14T07:17:00Z' };
    await read({ calendar_id: TEAM, date_range: window }, () => ({ kind: 'calendar#events', items: [event('e', 9)] }));
    await read({}, () => ({ kind: 'calendar#events', items: [event('g', 9)] }));
    await read({ operation: 'list_calendars' }, () => ({ kind: 'calendar#calendarList', items: [{ id: TEAM, summary: 'Team', accessRole: 'reader', selected: true }] }));
    expect(readLines()).toHaveLength(2);
    // The default window starts at the clock's now.
    for (const line of lines()) for (const secret of [TEAM, account.email, account.connection_id, 'Board review', '2026-10-13T07:17', '2026-10-14T07:17', '2026-10-10T00:00']) expect([secret, line.toLowerCase().includes(secret.toLowerCase())]).toEqual([secret, false]);
  });
});
