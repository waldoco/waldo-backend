import { describe, expect, it } from 'vitest';
import { getTasksArgsSchema, queryCalendarArgsSchema } from '@waldo/contracts';
import { GOOGLE_CONSENT_SCOPES, googleClient, googleConsentUrl, googleHas } from '../src/connectors/google';
import { googleHandlers } from '../src/tools/live/google';

const app = { clientId: 'fixture', clientSecret: 'fixture', redirectUri: 'https://example.test/callback' };
const account = { connection_id: 'personal-connection', email: 'owner@example.test' };
const clock = { timezone: 'UTC', now: () => new Date('2026-10-10T00:00:00Z') };
const desk = { propose: async () => '', proposeSendEmail: async () => '', record: () => {} };
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

describe('Calendar change continuation', () => {
  it('accepts a timed event whose start equals its end instead of rejecting the whole changes page', async () => {
    const zero = { id: 'zero', summary: 'Placeholder', start: { dateTime: '2026-10-10T09:00:00Z' }, end: { dateTime: '2026-10-10T09:00:00Z' } };
    const client = googleClient(app, { refresh_token: 'grant' }, provider(() => ({ kind: 'calendar#events', items: [zero, { id: 'normal', summary: 'Standup', start: { dateTime: '2026-10-10T10:00:00Z' }, end: { dateTime: '2026-10-10T10:30:00Z' } }] })), undefined, account);
    const changes = await client.changedEvents(Date.parse('2026-10-09T00:00:00Z'), Date.parse('2026-10-10T00:00:00Z'), Date.parse('2026-10-11T00:00:00Z'));
    expect(changes.map(change => change.id)).toEqual(['zero', 'normal']);
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
});

describe('Calendar discovery', () => {
  const listed = (items: unknown[], extra: Record<string, unknown> = {}) => ({ kind: 'calendar#calendarList', items, ...extra });
  const row = { id: 'team@group.calendar.google.com', summary: 'Team', timeZone: 'Asia/Kolkata', accessRole: 'reader', selected: true };
  const run = async (args: Record<string, unknown>, respond: (url: URL) => unknown, urls: URL[] = [], features: string[] = []) => {
    const client = googleClient(app, { refresh_token: 'grant' }, provider(respond, urls), undefined, account);
    const handler = googleHandlers({ client: async (feature?: string) => { features.push(String(feature)); return client; } } as never, desk, clock).find(h => h.name === 'query_calendar')!;
    return await handler.handle(queryCalendarArgsSchema.parse(args)) as any;
  };
  it('lists the calendars the owner can read, with role, zone and visibility, under the calendar-list feature', async () => {
    const urls: URL[] = []; const features: string[] = [];
    const result = await run({ operation: 'list_calendars' }, () => listed([{ ...row }, { id: 'owner@example.test', summary: 'Owner', accessRole: 'owner', primary: true, selected: true }]), urls, features);
    expect(features).toEqual(['calendar_list']);
    expect(result.data).toMatchObject({ calendars: [{ id: 'team@group.calendar.google.com', title: 'Team', timezone: 'Asia/Kolkata', access_role: 'reader', primary: false, selected: true, hidden: false }, { id: 'owner@example.test', primary: true, access_role: 'owner' }], coverage: { scope: 'account_calendars', complete: true, include_hidden: false } });
    expect(urls.at(-1)!.pathname).toBe('/calendar/v3/users/me/calendarList');
    expect(Object.fromEntries(urls.at(-1)!.searchParams)).toMatchObject({ showHidden: 'false', showDeleted: 'false', maxResults: '20' });
  });
  it('shows hidden calendars only when asked', async () => {
    const urls: URL[] = [];
    await run({ operation: 'list_calendars', include_hidden: true }, () => listed([{ ...row, hidden: true }]), urls);
    expect(urls.at(-1)!.searchParams.get('showHidden')).toBe('true');
  });
  it('continues a partial discovery with the returned token and never calls it complete', async () => {
    const urls: URL[] = [];
    const first = await run({ operation: 'list_calendars', limit: 1 }, () => listed([row], { nextPageToken: 'provider-next' }), urls);
    expect(first.data.next_page_token).toEqual(expect.any(String));
    expect(first.data.coverage).toMatchObject({ complete: false, page_exhausted: false });
    const second = await run({ operation: 'list_calendars', limit: 1, page_token: first.data.next_page_token }, url => { expect(url.searchParams.get('pageToken')).toBe('provider-next'); return listed([{ ...row, id: 'two@group.calendar.google.com' }]); }, urls);
    expect(second.data).toMatchObject({ calendars: [{ id: 'two@group.calendar.google.com' }], next_page_token: null, coverage: { page_exhausted: true, complete: false } });
  });
  it('refuses a continuation made for a different question', async () => {
    const first = await run({ operation: 'list_calendars', limit: 1 }, () => listed([row], { nextPageToken: 'provider-next' }));
    const urls: URL[] = [];
    const moved = await run({ operation: 'list_calendars', limit: 1, include_hidden: true, page_token: first.data.next_page_token }, () => listed([row]), urls);
    expect(moved.ok).toBe(false); expect(urls).toHaveLength(0);
  });
  it('rejects a malformed provider receipt instead of claiming coverage', async () => {
    for (const bad of [{ ...row, accessRole: 'admin' }, { ...row, id: '' }, { ...row, summary: 7 }, { ...row, primary: 'yes' }]) expect((await run({ operation: 'list_calendars' }, () => listed([bad]))).ok).toBe(false);
  });
  it('refuses a calendar list that names a different account than the one selected', async () => {
    const stranger = { connection_id: 'other-connection', email: 'other@example.test' };
    const fake = { account, calendarListsPage: async () => ({ items: [], next_page_token: null, fetched_count: 0, account: stranger, observed_at: '2026-10-10T00:00:00.000Z' }) };
    const handler = googleHandlers({ client: async () => fake } as never, desk, clock).find(h => h.name === 'query_calendar')!;
    expect(await handler.handle(queryCalendarArgsSchema.parse({ operation: 'list_calendars' }))).toMatchObject({ ok: false });
  });
  it('asks for the missing calendar-list grant as a typed connect intent', async () => {
    const handler = googleHandlers({ client: async () => null } as never, desk, clock).find(h => h.name === 'query_calendar')!;
    expect(await handler.handle(queryCalendarArgsSchema.parse({ operation: 'list_calendars' }))).toMatchObject({ ok: false, code: 'auth_failed', connect: { reason: 'not_connected', feature: 'calendar_list' } });
  });
  it('turns a provider scope refusal into a scope_missing intent', async () => {
    const client = googleClient(app, { refresh_token: 'grant' }, (async (input: RequestInfo | URL) => String(input).includes('oauth2') ? Response.json({ access_token: 'fixture' }) : Response.json({ error: { code: 403, message: 'Insufficient Permission', errors: [{ reason: 'insufficientPermissions' }], details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }, { status: 403 })) as typeof fetch, undefined, account);
    const handler = googleHandlers({ client: async () => client } as never, desk, clock).find(h => h.name === 'query_calendar')!;
    expect(await handler.handle(queryCalendarArgsSchema.parse({ operation: 'list_calendars' }))).toMatchObject({ ok: false, connect: { reason: 'scope_missing', feature: 'calendar_list' } });
  });
  it('treats the calendar-list scope as explicit, never implied by a legacy grant', () => {
    const auth = 'https://www.googleapis.com/auth/';
    expect(googleHas(null, 'calendar_list')).toBe(false);
    expect(googleHas([`${auth}calendar.events`, `${auth}calendar.events.freebusy`], 'calendar_list')).toBe(false);
    for (const scope of ['calendar.calendarlist.readonly', 'calendar.calendarlist', 'calendar.readonly', 'calendar']) expect(googleHas([`${auth}${scope}`], 'calendar_list')).toBe(true);
  });
  it('asks for the calendar-list scope in the one combined consent', () => {
    expect(GOOGLE_CONSENT_SCOPES).toContain('https://www.googleapis.com/auth/calendar.calendarlist.readonly');
    expect(new URL(googleConsentUrl(app, 'state', 'challenge')).searchParams.get('scope')).toContain('calendar.calendarlist.readonly');
  });
});
