import { describe, expect, it } from 'vitest';
import { draftEmailArgsSchema, getTasksArgsSchema, queryCalendarArgsSchema } from '@waldo/contracts';
import { b64url, GoogleError, googleClient } from '../src/connectors/google';
import { googleHandlers } from '../src/tools/live/google';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';

const app = { clientId: 'fixture', clientSecret: 'fixture', redirectUri: 'https://example.test/callback' };
const account = { connection_id: 'personal-connection', email: 'owner@example.test' };
const clock = { timezone: 'UTC', now: () => new Date('2026-10-10T00:00:00Z') };
const desk = { propose: async () => '', proposeSendEmail: async () => '', record: () => {} };
const effectStorage = () => {
  const values = new Map<string, unknown>();
  return { kv: { get: (key: string) => structuredClone(values.get(key)), put: (key: string, value: unknown) => values.set(key, structuredClone(value)), list: ({ prefix }: { prefix: string }) => new Map([...values].filter(([key]) => key.startsWith(prefix))) }, transactionSync: <T>(work: () => T) => work() } as unknown as DurableObjectStorage;
};
const provider = (respond: (url: URL) => unknown, urls: URL[] = []): typeof fetch => (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture' });
  urls.push(url);
  return Response.json(respond(url));
}) as typeof fetch;

describe('Google Tasks collection coverage', () => {
  it('default serving read spans task lists and resumes a partially read list after rebuilding the client', async () => {
    const urls: URL[] = [];
    const fetcher = provider(url => {
      if (url.pathname.endsWith('/users/@me/lists')) return url.searchParams.has('pageToken')
        ? { kind: 'tasks#taskLists', items: [{ id: 'work', title: 'Work' }] }
        : { kind: 'tasks#taskLists', items: [{ id: 'home', title: 'Home' }], nextPageToken: 'lists-next' };
      if (url.pathname.endsWith('/home/tasks')) return url.searchParams.has('pageToken')
        ? { kind: 'tasks#tasks', items: [{ id: 'h2', title: 'Rent', status: 'needsAction' }] }
        : { kind: 'tasks#tasks', items: [{ id: 'h1', title: 'Groceries', status: 'needsAction' }], nextPageToken: 'home-next' };
      if (url.pathname.endsWith('/work/tasks')) return { kind: 'tasks#tasks', items: [{ id: 'w1', title: 'Proposal', status: 'needsAction' }] };
      throw new Error('Unexpected provider path');
    }, urls);
    const read = (cursor?: string) => {
      const client = googleClient(app, { refresh_token: 'grant', email: account.email }, fetcher, undefined, account);
      const handler = googleHandlers({ client: async () => client }, desk, clock).find(h => h.name === 'get_tasks')!;
      return handler.handle(getTasksArgsSchema.parse({ limit: 1, ...(cursor ? { page_token: cursor } : {}) }));
    };
    const first = await read() as any;
    expect(first).toMatchObject({ ok: true, data: { tasks: [{ id: 'h1', task_list_id: 'home' }], coverage: { scope: 'all_task_lists', complete: false } } });
    const second = await read(first.data.next_page_token) as any;
    expect(second.data.tasks).toMatchObject([{ id: 'h2', task_list_id: 'home' }]);
    const third = await read(second.data.next_page_token) as any;
    expect(third.data.tasks).toMatchObject([{ id: 'w1', task_list_id: 'work' }]);
    expect(third.data.coverage).toMatchObject({ complete: false, page_exhausted: true });
    expect(third.data.next_page_token).toBeNull();
    expect(urls.some(url => url.pathname.includes('@default'))).toBe(false);
  });
  it('discovers list names and reads a selected list including completed, hidden and assigned tasks', async () => {
    const urls: URL[] = [];
    const client = googleClient(app, { refresh_token: 'grant' }, provider(url => url.pathname.endsWith('/users/@me/lists')
      ? { kind: 'tasks#taskLists', items: [{ id: 'work/team', title: 'Team', updated: '2026-10-10T00:00:00Z' }] }
      : { kind: 'tasks#tasks', items: [{ id: 'done', title: 'Sent proposal', status: 'completed', completed: '2026-10-09T00:00:00Z', notes: 'Receipt in Drive' }] }, urls), undefined, account);
    const handler = googleHandlers({ client: async () => client }, desk, clock).find(h => h.name === 'get_tasks')!;
    const lists = await handler.handle(getTasksArgsSchema.parse({ operation: 'list_task_lists' })) as any;
    expect(lists.data).toMatchObject({ task_lists: [{ id: 'work/team', title: 'Team' }], coverage: { complete: true } });
    const tasks = await handler.handle(getTasksArgsSchema.parse({ task_list_id: 'work/team', status: 'done' })) as any;
    expect(tasks.data).toMatchObject({ tasks: [{ task_list_id: 'work/team', status: 'done', notes: 'Receipt in Drive' }], coverage: { scope: 'selected_task_list', complete: true } });
    const request = urls.at(-1)!;
    expect(request.pathname).toContain('work%2Fteam/tasks');
    expect(Object.fromEntries(request.searchParams)).toMatchObject({ showHidden: 'true', showCompleted: 'true', showAssigned: 'true' });
  });
  it('rejects moved or forged continuations before reading any provider resource', async () => {
    const urls: URL[] = [];
    const fetcher = provider(url => url.pathname.endsWith('/users/@me/lists')
      ? { kind: 'tasks#taskLists', items: [{ id: 'home', title: 'Home' }] }
      : { kind: 'tasks#tasks', items: [{ id: 'task', title: 'Task', status: 'needsAction' }], nextPageToken: 'next-task' }, urls);
    const client = googleClient(app, { refresh_token: 'grant' }, fetcher, undefined, account);
    const token = (await client.allTasksPage('todo', 1)).next_page_token!;
    const reads = urls.length;
    const requests = [
      () => client.allTasksPage('done', 1, token), () => client.allTasksPage('todo', 2, token), () => client.allTasksPage('todo', 1, token + 'x'),
      () => client.tasksPage('home', 'todo', 1, token),
      () => googleClient(app, { refresh_token: 'other-grant' }, fetcher, undefined, account).allTasksPage('todo', 1, token),
      () => googleClient(app, { refresh_token: 'grant' }, fetcher, undefined, { ...account, connection_id: 'other' }).allTasksPage('todo', 1, token),
    ];
    for (const request of requests) await expect(request()).rejects.toThrow('cursor');
    expect(urls.length).toBe(reads);
  });
  it('retains a bounded continuation across empty lists rather than silently finishing discovery', async () => {
    let listReads = 0;
    const client = googleClient(app, { refresh_token: 'grant' }, provider(url => url.pathname.endsWith('/users/@me/lists')
      ? { kind: 'tasks#taskLists', items: [{ id: `list-${++listReads}`, title: 'Empty' }], nextPageToken: `next-${listReads}` }
      : { kind: 'tasks#tasks', items: [] }), undefined, account);
    const first = await client.allTasksPage('todo', 20);
    expect(first.tasks).toEqual([]);
    expect(first.next_page_token).toEqual(expect.any(String));
    expect(listReads).toBe(10);
    const second = await client.allTasksPage('todo', 20, first.next_page_token!);
    expect(second.task_list_ids[0]).toBe('list-11');
  });
  it('reports a stalled provider cursor rather than returning the same task page indefinitely', async () => {
    const client = googleClient(app, { refresh_token: 'grant' }, provider(() => ({ kind: 'tasks#tasks', items: [], nextPageToken: 'same' })), undefined, account);
    const first = await client.tasksPage('home', 'todo', 20);
    await expect(client.tasksPage('home', 'todo', 20, first.next_page_token!)).rejects.toThrow('made no progress');
  });
  it.each([
    { kind: 'tasks#tasks', error: { message: 'failed' } },
    { kind: 'tasks#tasks', items: [{ id: '', status: 'needsAction' }] },
    { kind: 'tasks#tasks', items: [{ id: 'task', status: 'completed', due: '2026-02-30T00:00:00Z' }] },
    { kind: 'tasks#tasks', items: [], nextPageToken: '' },
    { items: [] },
  ])('does not turn malformed Tasks responses into an empty complete page %j', async response => {
    const client = googleClient(app, { refresh_token: 'grant' }, provider(() => response), undefined, account);
    const handler = googleHandlers({ client: async () => client }, desk, clock).find(h => h.name === 'get_tasks')!;
    expect(await handler.handle(getTasksArgsSchema.parse({ task_list_id: 'home' }))).toMatchObject({ ok: false });
  });
  it('preserves selected-account custody and current source checks on continuation', async () => {
    let reads = 0;
    let checks = 0;
    const client = googleClient(app, { refresh_token: 'grant' }, provider(() => { reads++; return { kind: 'tasks#tasks', items: [] }; }), undefined, account);
    const selected: unknown[] = [];
    const handler = googleHandlers({ client: async (...args) => { selected.push(args[3]); return client; } }, desk, clock).find(h => h.name === 'get_tasks')!;
    const stale = await handler.handle(getTasksArgsSchema.parse({ task_list_id: 'home', account: account.email }), { assertTaskSourceCurrent: async () => { checks++; throw new Error('revoked source'); } } as never);
    expect(stale).toMatchObject({ ok: false });
    expect(checks).toBe(1);
    expect(reads).toBe(0);
    expect(selected).toEqual([account.email]);
    expect(await handler.handle(getTasksArgsSchema.parse({ task_list_id: 'home', account: 'work@example.test' }))).toMatchObject({ ok: false });
    expect(reads).toBe(0);
  });
});

describe('Google Calendar discovery', () => {
  it('reads the authoritative exact event in an explicit calendar without a primary fallback', async () => {
    const urls: URL[] = [];
    const client = googleClient(app, { refresh_token: 'grant' }, provider(() => ({ id: 'event/id', summary: 'Shared event', start: { dateTime: '2026-10-11T10:00:00Z' }, end: { dateTime: '2026-10-11T11:00:00Z' }, etag: 'v1' }), urls), undefined, account);
    expect(await client.eventInCalendar!('team@example.test', 'event/id')).toMatchObject({ id: 'event/id', title: 'Shared event' });
    expect(urls[0]!.pathname).toBe('/calendar/v3/calendars/team%40example.test/events/event%2Fid');
    await expect(client.eventInCalendar!('team@example.test', 'different')).rejects.toThrow('event response');
    expect(urls.some(u => u.pathname.includes('/primary/'))).toBe(false);
  });
  it('reads authoritative events from their selected calendar without a primary fallback', async () => {
    const urls: URL[] = [];
    const client = googleClient(app, { refresh_token: 'grant' }, provider(url => ({ id: 'event/id', status: 'cancelled', etag: 'cancelled-v2' }), urls), undefined, account);
    expect(await client.eventInCalendar!('shared/team@example.test', 'event/id')).toMatchObject({ id: 'event/id', status: 'cancelled', etag: 'cancelled-v2' });
    expect(urls.map(url => url.pathname)).toEqual(['/calendar/v3/calendars/shared%2Fteam%40example.test/events/event%2Fid']);
    const wrong = googleClient(app, { refresh_token: 'grant' }, provider(() => ({ id: 'different', status: 'cancelled' })), undefined, account);
    await expect(wrong.eventInCalendar!('shared@example.test', 'event')).rejects.toThrow('response');
  });
  it('returns permission, calendar identity and timezone with bound pagination', async () => {
    const urls: URL[] = [];
    const fetcher = provider(() => ({ kind: 'calendar#calendarList', items: [{ id: 'shared@example.test', summary: 'Team', timeZone: 'Asia/Kolkata', accessRole: 'reader' }], nextPageToken: 'next' }), urls);
    const client = googleClient(app, { refresh_token: 'grant' }, fetcher, undefined, account);
    const handler = googleHandlers({ client: async () => client }, desk, clock).find(h => h.name === 'query_calendar')!;
    const result = await handler.handle(queryCalendarArgsSchema.parse({ operation: 'list_calendars', account: account.email, include_hidden: true })) as any;
    expect(result.data).toMatchObject({ calendars: [{ id: 'shared@example.test', timezone: 'Asia/Kolkata', access_role: 'reader' }], coverage: { complete: false, include_hidden: true } });
    const reads = urls.length;
    await expect(client.calendarListsPage(20, false, result.data.next_page_token)).rejects.toThrow('cursor');
    expect(urls.length).toBe(reads);
    expect(urls[0]!.pathname).toBe('/calendar/v3/users/me/calendarList');
  });
  it('reports a missing Calendar-list grant without inventing permitted calendars', async () => {
    const handler = googleHandlers({ client: async () => ({ account, calendarListsPage: async () => { throw new GoogleError(403, 'scope missing', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'); } } as never) }, desk, clock).find(h => h.name === 'query_calendar')!;
    expect(await handler.handle(queryCalendarArgsSchema.parse({ operation: 'list_calendars' }))).toMatchObject({ ok: false, code: 'auth_failed', connect: { reason: 'scope_missing', feature: 'calendar_list' } });
  });
  it('does not silently degrade discovery to primary-calendar events on an older proxy', async () => {
    let events = 0;
    const handler = googleHandlers({ client: async () => ({ account, calendarListsPage: async () => { throw new GoogleError(404, 'unknown operation'); }, events: async () => { events++; return []; } } as never) }, desk, clock).find(h => h.name === 'query_calendar')!;
    expect(await handler.handle(queryCalendarArgsSchema.parse({ operation: 'list_calendars' }))).toMatchObject({ ok: false });
    expect(events).toBe(0);
  });
});

describe('Calendar change continuation', () => {
  it.each([
    ['2026-10-11T10:00:00.000Z', '2026-10-11T10:00:00Z'],
    ['2026-10-11T10:00:00Z', '2026-10-11T10:00:00+00:00'],
    ['2026-10-11T10:00:00Z', '2026-10-11T15:30:00+05:30'],
  ])('verifies equivalent Calendar instants %s and %s', async (wanted, observed) => {
    const client = googleClient(app, { refresh_token: 'grant' }, (async (input: RequestInfo | URL) => {
      if (String(input).includes('oauth2.googleapis.com')) return Response.json({ access_token: 'fixture' });
      return Response.json({ id: 'event', summary: 'Meeting', start: { dateTime: observed }, end: { dateTime: '2026-10-11T11:00:00+00:00' }, etag: 'v2', extendedProperties: { private: { waldoOperation: 'marker' } } });
    }) as typeof fetch, undefined, account);
    await expect(client.createEvent({ id: 'event', title: 'Meeting', start: wanted, end: '2026-10-11T11:00:00.000Z', operationMarker: 'marker' })).resolves.toMatchObject({ id: 'event' });
  });
  it('does not equate Calendar all-day dates with timed events', async () => {
    const client = googleClient(app, { refresh_token: 'grant' }, provider(() => ({ id: 'event', summary: 'Meeting', start: { date: '2026-10-11' }, end: { date: '2026-10-12' }, etag: 'v2' })), undefined, account);
    await expect(client.createEvent({ id: 'event', title: 'Meeting', start: '2026-10-11T00:00:00Z', end: '2026-10-12T00:00:00Z' })).rejects.toThrow('readback');
  });
  it('legacy change collection processes more than fifty events and retains cancelled tombstones', async () => {
    const urls: URL[] = [];
    const client = googleClient(app, { refresh_token: 'grant' }, provider(url => url.searchParams.has('pageToken')
      ? { kind: 'calendar#events', items: [{ id: 'removed', status: 'cancelled' }] }
      : { kind: 'calendar#events', items: Array.from({ length: 50 }, (_, i) => ({ id: `e${i}`, start: { date: '2026-10-10' }, end: { date: '2026-10-11' }, updated: '2026-10-09T23:00:00Z' })), nextPageToken: 'more' }, urls), undefined, account);
    const changes = await client.changedEvents(Date.parse('2026-10-09T00:00:00Z'), Date.parse('2026-10-10T00:00:00Z'), Date.parse('2026-10-12T00:00:00Z'));
    expect(changes).toHaveLength(51);
    expect(changes.at(-1)).toMatchObject({ id: 'removed', status: 'cancelled' });
    expect(urls[1]!.searchParams.get('updatedMin')).toBe(urls[0]!.searchParams.get('updatedMin'));
  });
  it('does not report a Calendar mutation complete when independent final-state readback differs', async () => {
    let reads = 0;
    const start = '2026-10-11T10:00:00Z', end = '2026-10-11T11:00:00Z';
    const client = googleClient(app, { refresh_token: 'grant' }, (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('oauth2.googleapis.com')) return Response.json({ access_token: 'fixture' });
      if (!init?.method || init.method === 'GET') reads++;
      return Response.json({ id: 'event', summary: 'Meeting', start: { dateTime: init?.method === 'POST' ? start : '2026-10-11T12:00:00Z' }, end: { dateTime: init?.method === 'POST' ? end : '2026-10-11T13:00:00Z' }, etag: 'v2', extendedProperties: { private: { waldoOperation: 'marker' } } });
    }) as typeof fetch, undefined, account);
    await expect(client.createEvent({ id: 'event', title: 'Meeting', start, end, operationMarker: 'marker' })).rejects.toThrow('readback');
    expect(reads).toBe(1);
  });
});

describe('Gmail draft readback', () => {
  it('reopens a newly created draft before reporting its exact payload verified', async () => {
    let raw = '';
    const reads: string[] = [];
    const client = googleClient(app, { refresh_token: 'grant' }, (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture' });
      if (init?.method === 'POST') { raw = (JSON.parse(String(init.body)) as any).message.raw; return Response.json({ id: 'draft', message: { id: 'message', threadId: 'thread' } }); }
      reads.push(url.pathname);
      return Response.json({ id: 'draft', message: { id: 'message', threadId: 'thread', raw } });
    }) as typeof fetch, undefined, account);
    const handler = googleHandlers({ client: async () => client }, desk, clock).find(h => h.name === 'draft_email')!;
    const result = await handler.handle(draftEmailArgsSchema.parse({ to: ['a@example.test'], subject: 'Hello', body_markdown: 'Exact body' }), { authenticatedUserId: 'owner', turnId: 'turn', toolCallId: 'tool' } as never) as any;
    expect(result).toMatchObject({ ok: true, data: { draft_id: 'draft', sent: false, readback_verified: true } });
    expect(reads).toEqual(['/gmail/v1/users/me/drafts/draft']);
  });
  it('does not claim a draft complete when provider readback has different recipients or body', async () => {
    const client = googleClient(app, { refresh_token: 'grant' }, (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture' });
      if (init?.method === 'POST') return Response.json({ id: 'draft', message: { id: 'message', threadId: 'thread' } });
      return Response.json({ id: 'draft', message: { id: 'message', threadId: 'thread', raw: b64url(new TextEncoder().encode('To: wrong@example.test\r\nSubject: Hello\r\n\r\nChanged body')) } });
    }) as typeof fetch, undefined, account);
    const handler = googleHandlers({ client: async () => client }, desk, clock).find(h => h.name === 'draft_email')!;
    expect(await handler.handle(draftEmailArgsSchema.parse({ to: ['a@example.test'], subject: 'Hello', body_markdown: 'Exact body' }), { authenticatedUserId: 'owner', turnId: 'turn', toolCallId: 'tool' } as never)).toMatchObject({ ok: false });
  });
  it('reconciles an interrupted draft after reopening the ledger without a second provider write', async () => {
    const storage = effectStorage();
    let raw = '';
    let writes = 0;
    let readable = false;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture' });
      if (init?.method === 'POST') { writes++; raw = (JSON.parse(String(init.body)) as any).message.raw; throw new Error('lost response after provider accepted'); }
      if (!readable) throw new Error('readback unavailable');
      return Response.json(url.pathname.endsWith('/drafts')
        ? { drafts: [{ id: 'draft', message: { id: 'message' } }] }
        : { id: 'draft', message: { id: 'message', threadId: 'thread', raw } });
    }) as typeof fetch;
    const invoke = () => {
      const client = googleClient(app, { refresh_token: 'grant' }, fetcher, undefined, account);
      const handler = googleHandlers({ client: async () => client }, desk, clock, undefined, ownerEffectLedger(storage, () => clock.now().getTime())).find(h => h.name === 'draft_email')!;
      return handler.handle(draftEmailArgsSchema.parse({ to: ['a@example.test'], subject: 'Hello', body_markdown: 'Exact body' }), { authenticatedUserId: 'owner', turnId: 'turn', toolCallId: 'tool' } as never);
    };
    expect(await invoke()).toMatchObject({ ok: false, error: expect.stringContaining('unknown') });
    readable = true;
    expect(await invoke()).toMatchObject({ ok: true, data: { draft_id: 'draft', readback_verified: true, sent: false } });
    expect(writes).toBe(1);
  });
  it('cannot replay a verified draft receipt from another selected account', async () => {
    const storage = effectStorage();
    let selected = account;
    let raw = '';
    let writes = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture' });
      if (init?.method === 'POST') { writes++; raw = (JSON.parse(String(init.body)) as any).message.raw; }
      return Response.json({ id: 'draft', message: { id: 'message', threadId: 'thread', raw } });
    }) as typeof fetch;
    const handler = googleHandlers({ client: async () => googleClient(app, { refresh_token: 'grant' }, fetcher, undefined, selected) }, desk, clock, undefined, ownerEffectLedger(storage, () => clock.now().getTime())).find(h => h.name === 'draft_email')!;
    const invoke = () => handler.handle(draftEmailArgsSchema.parse({ account: selected.email, to: ['a@example.test'], subject: 'Hello', body_markdown: 'Exact body' }), { authenticatedUserId: 'owner', turnId: 'turn', toolCallId: 'tool' } as never);
    expect(await invoke()).toMatchObject({ ok: true });
    selected = { connection_id: 'work-connection', email: 'work@example.test' };
    expect(await invoke()).toMatchObject({ ok: false, error: 'effect identity conflict' });
    expect(writes).toBe(1);
  });
});
