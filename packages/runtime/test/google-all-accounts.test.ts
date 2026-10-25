import { describe, expect, it, vi } from 'vitest';
import { getCommunicationArgsSchema, getTasksArgsSchema, queryCalendarArgsSchema, readDriveArgsSchema, readThreadArgsSchema, searchCommunicationArgsSchema, searchContactsArgsSchema } from '@waldo/contracts';
import { googleClient, type FreeBusyResult, type GoogleClient, type GoogleFeature } from '../src/connectors/google';
import { readDriveHandler } from '../src/tools/live/drive';
import { googleHandlers, type GoogleAccess } from '../src/tools/live/google';

// An owner with two Google accounts asks one question; the read covers both accounts in that one call, each result
// labelled by its account, and an account that cannot be read is named with its fix instead of read as empty.
const clock = { timezone: 'UTC', now: () => new Date('2026-10-25T08:00:00Z') };
const desk = { propose: async () => 'p', proposeSendEmail: async () => 'p', record: () => undefined };
type Known = { id: string; email: string; error: string | null; calendar: boolean; mail: boolean; tasks: boolean };
const WORK: Known = { id: 'conn-work', email: 'work@example.test', error: null, calendar: true, mail: true, tasks: true };
const HOME: Known = { id: 'conn-home', email: 'home@example.test', error: null, calendar: true, mail: true, tasks: true };
const receipt = (known: Known) => ({ connection_id: known.id, email: known.email });

// The owner DO's selection: the first healthy account whose grant covers the feature, or the named one.
const accessFor = (accounts: readonly Known[], clients: Record<string, Partial<GoogleClient>>, calls: Array<readonly [GoogleFeature | undefined, string | undefined]> = []): GoogleAccess => ({
  client: async (feature, _intent, _guard, account) => {
    calls.push([feature, account]);
    const flagged = feature === 'calendar' || feature === 'mail' || feature === 'tasks';
    const known = accounts.find((k) => k.error === null && (!flagged || k[feature]) && (!account || k.email === account.toLowerCase()));
    return known ? ({ ...clients[known.email], account: receipt(known) } as GoogleClient) : null;
  },
  state: async () => accounts,
});
const handler = (access: GoogleAccess, name: string) => googleHandlers(access, desk, clock).find((h) => h.name === name)! as unknown as { handle(args: unknown): Promise<unknown> };

const mail = (known: Known, subject: string) => ({
  mailPage: async (_q: string, limit: number) => ({ messages: [{ id: `${known.id}-m`, thread_id: `${known.id}-t`, from: 'sender@example.test', subject, snippet: 'hello', at: '2026-10-25T07:00:00Z' }].slice(0, limit), next_page_token: null, result_size_estimate: 1 }),
});
const calendar = (known: Known, title: string) => ({
  calendarPage: async () => ({ events: [{ id: `${known.id}-e`, title, start: '2026-10-25T10:00:00Z', end: '2026-10-25T11:00:00Z', all_day: false }], next_page_token: null, fetched_count: 1, account: receipt(known), observed_at: '2026-10-25T08:00:00Z' }),
});
const contacts = (name: string, email: string) => ({ searchContacts: async () => [{ name, emails: [email], source: 'contacts' as const }] });
const tasks = (known: Known, title: string) => ({
  allTasksPage: async () => ({ tasks: [{ id: `${known.id}-task`, title, status: 'todo' as const, task_list_id: `${known.id}-list` }], next_page_token: null, fetched_count: 1, task_list_ids: [`${known.id}-list`], account: receipt(known), observed_at: '2026-10-25T08:00:00Z' }),
});
const both = {
  [WORK.email]: { ...mail(WORK, 'Board deck'), ...calendar(WORK, 'Board call'), ...contacts('Priya Work', 'priya@work.example.test'), ...tasks(WORK, 'Send deck') },
  [HOME.email]: { ...mail(HOME, 'School trip'), ...calendar(HOME, 'Dentist'), ...contacts('Priya Home', 'priya@home.example.test'), ...tasks(HOME, 'Buy milk') },
};
type Section = { account: { email: string }; [key: string]: unknown };
const sections = (result: unknown) => ((result as { data: { by_account: Section[] } }).data.by_account);

describe('a two-account owner gets every account in the first read', () => {
  const READS = [
    ['get_communication', getCommunicationArgsSchema.parse({}), 'messages', ['Board deck', 'School trip']],
    ['query_calendar', queryCalendarArgsSchema.parse({}), 'events', ['Board call', 'Dentist']],
    ['search_contacts', searchContactsArgsSchema.parse({ query: 'Priya' }), 'contacts', ['Priya Work', 'Priya Home']],
    ['get_tasks', getTasksArgsSchema.parse({}), 'tasks', ['Send deck', 'Buy milk']],
  ] as const;
  for (const [name, args, list, titles] of READS) {
    it(`${name} reads both accounts in one call, each item under its account`, async () => {
      const calls: Array<readonly [GoogleFeature | undefined, string | undefined]> = [];
      const result = await handler(accessFor([WORK, HOME], both, calls), name).handle(args);
      expect(result).toMatchObject({ ok: true, source_taint: 'external', data: { accounts: [{ email: WORK.email, read: 'ok' }, { email: HOME.email, read: 'ok' }] } });
      const [work, home] = sections(result);
      expect(work!.account.email).toBe(WORK.email);
      expect(home!.account.email).toBe(HOME.email);
      const label = (section: Section) => JSON.stringify(section[list]);
      expect(label(work!)).toContain(titles[0]);
      expect(label(work!)).not.toContain(titles[1]);
      expect(label(home!)).toContain(titles[1]);
      expect(calls.map(([, account]) => account).sort()).toEqual([HOME.email, WORK.email]);
    });
  }

  it('the google_read_accounts log line counts accounts and failures and carries no address', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const refused = { ...both[HOME.email], allTasksPage: async () => { throw new TypeError('fetch failed'); } };
      await handler(accessFor([WORK, HOME], { ...both, [HOME.email]: refused }), 'get_tasks').handle(getTasksArgsSchema.parse({}));
      const lines = log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('google_read_accounts'));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ hop: 'google_read_accounts', ok: false, code: expect.stringMatching(/^get_tasks:read_1_of_2:transient/) });
      expect(lines[0]).not.toContain('@');
      expect(lines[0]).not.toContain('example.test');
    } finally {
      log.mockRestore();
    }
  });

  it('reads the accounts concurrently, not one after the other', async () => {
    let started = 0;
    let release!: () => void;
    const together = new Promise<void>((resolve) => { release = resolve; });
    const gated = (known: Known) => ({ allTasksPage: async () => {
      if (++started === 2) release();
      await together;
      return tasks(known, 'x').allTasksPage();
    } });
    const read = handler(accessFor([WORK, HOME], { [WORK.email]: gated(WORK), [HOME.email]: gated(HOME) }), 'get_tasks').handle(getTasksArgsSchema.parse({}));
    const timeout = new Promise((resolve) => setTimeout(() => resolve('serial'), 500));
    expect(await Promise.race([read.then(() => 'concurrent'), timeout])).toBe('concurrent');
  });

  it('bounds each account to its share of the page, so two accounts never double the result', async () => {
    const limits: number[] = [];
    const counting = (known: Known) => ({ mailPage: async (q: string, limit: number) => { limits.push(limit); return mail(known, 's').mailPage(q, limit); } });
    await handler(accessFor([WORK, HOME], { [WORK.email]: counting(WORK), [HOME.email]: counting(HOME) }), 'get_communication').handle(getCommunicationArgsSchema.parse({ limit: 30 }));
    expect(limits).toEqual([15, 15]);
  });

  it('an explicitly named account reads that account alone', async () => {
    const calls: Array<readonly [GoogleFeature | undefined, string | undefined]> = [];
    const result = await handler(accessFor([WORK, HOME], both, calls), 'get_tasks').handle(getTasksArgsSchema.parse({ account: HOME.email }));
    expect(result).toMatchObject({ ok: true, data: { account: receipt(HOME), tasks: [{ title: 'Buy milk' }] } });
    expect((result as { data: object }).data).not.toHaveProperty('by_account');
    expect(calls).toEqual([['tasks', HOME.email]]);
  });

  it('one connected account keeps the single-account read', async () => {
    const result = await handler(accessFor([WORK], both), 'get_tasks').handle(getTasksArgsSchema.parse({}));
    expect(result).toMatchObject({ ok: true, data: { account: receipt(WORK), tasks: [{ title: 'Send deck' }] } });
  });

  it('no connected account asks to connect, and reads nothing', async () => {
    const result = await handler(accessFor([], both), 'get_tasks').handle(getTasksArgsSchema.parse({}));
    expect(result).toMatchObject({ ok: false, code: 'auth_failed', connect: { reason: 'not_connected', feature: 'tasks' } });
  });

  it.each([
    ['get_communication', getCommunicationArgsSchema.parse({ page_token: 'p', date_range: { from: '2026-10-24T00:00:00Z', to: '2026-10-25T00:00:00Z' } })],
    ['search_communication', searchCommunicationArgsSchema.parse({ query: 'deck', cursor: 'c' })],
    ['get_tasks', getTasksArgsSchema.parse({ page_token: 'p' })],
    ['get_tasks', getTasksArgsSchema.parse({ task_list_id: 'list' })],
    ['query_calendar', queryCalendarArgsSchema.parse({ calendar_id: 'team@group.example.test' })],
    ['read_thread', readThreadArgsSchema.parse({ thread_id: 't' })],
  ])('%s with an id from one account asks which account instead of guessing', async (name, args) => {
    const calls: Array<readonly [GoogleFeature | undefined, string | undefined]> = [];
    const result = await handler(accessFor([WORK, HOME], both, calls), name).handle(args);
    expect(result).toMatchObject({ ok: false, code: 'rejected' });
    expect((result as { error: string }).error).toContain(WORK.email);
    expect((result as { error: string }).error).toContain(HOME.email);
    expect(calls).toEqual([]);
  });
});

// Google's answer when a grant does not hold the Tasks scope: 403 with ErrorInfo ACCESS_TOKEN_SCOPE_INSUFFICIENT and the
// legacy insufficientPermissions reason. A grant stored before scopes were recorded (scopes null) is served for Tasks by
// the owner DO, so this is the answer the read meets on that account.
const SCOPE_INSUFFICIENT = { error: { code: 403, message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED',
  errors: [{ message: 'Insufficient Permission', domain: 'global', reason: 'insufficientPermissions' }],
  details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', domain: 'googleapis.com', metadata: { service: 'tasks.googleapis.com', method: 'google.tasks.v1.TasksListService.ListTasklists' } }] } };
const app = { clientId: 'fixture', clientSecret: 'fixture', redirectUri: 'https://example.test/callback' };
const provider = (answer: (url: URL) => Response | Promise<Response>): typeof fetch => (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture-access' });
  return answer(url);
}) as typeof fetch;
const tasksProvider = provider((url) => url.pathname.endsWith('/users/@me/lists')
  ? Response.json({ kind: 'tasks#taskLists', items: [{ id: 'home-list', title: 'Home' }] })
  : Response.json({ kind: 'tasks#tasks', items: [{ id: 'h1', title: 'Buy milk', status: 'needsAction' }] }));
const realClients = (work: typeof fetch, home: typeof fetch) => ({
  [WORK.email]: googleClient(app, { refresh_token: 'fixture-work', email: WORK.email }, work, undefined, receipt(WORK)),
  [HOME.email]: googleClient(app, { refresh_token: 'fixture-home', email: HOME.email }, home, undefined, receipt(HOME)),
});
type Entry = { email: string; read: string; code?: string; reason?: string; error?: string; fix?: string };
const entries = (result: unknown) => (result as { data: { accounts: Entry[] } }).data.accounts;

describe('a Tasks read that fails on one account still returns the other, and names the failure', () => {
  it("one account's Tasks scope is refused by Google: the other account's tasks come back and the refused one is named with its fix", async () => {
    const refused = provider(() => Response.json(SCOPE_INSUFFICIENT, { status: 403 }));
    const result = await handler(accessFor([WORK, HOME], realClients(refused, tasksProvider)), 'get_tasks').handle(getTasksArgsSchema.parse({}));
    expect(result).toMatchObject({ ok: true });
    const [work, home] = entries(result);
    expect(work).toMatchObject({ email: WORK.email, read: 'failed', code: 'auth_failed', reason: 'scope_missing' });
    expect(work!.fix).toMatch(/reconnect/i);
    expect(work!.fix).toContain('Google Tasks');
    expect(work!.fix).toContain(WORK.email);
    expect(home).toMatchObject({ email: HOME.email, read: 'ok' });
    expect(sections(result)).toHaveLength(1);
    expect(sections(result)[0]).toMatchObject({ account: receipt(HOME), tasks: [{ title: 'Buy milk' }] });
    expect(JSON.stringify(result)).toMatch(/not read.*unknown, not empty/i);
  });

  it('an account whose grant lacks Tasks is not one of the accounts read: the other is read alone, without a Google call to the first', async () => {
    let called = false;
    const never = provider(() => { called = true; return Response.json({}); });
    const result = await handler(accessFor([{ ...WORK, tasks: false }, HOME], realClients(never, tasksProvider)), 'get_tasks').handle(getTasksArgsSchema.parse({}));
    expect(result).toMatchObject({ ok: true, data: { account: receipt(HOME), tasks: [{ title: 'Buy milk' }] } });
    expect((result as { data: object }).data).not.toHaveProperty('by_account');
    expect(called).toBe(false);
  });

  it('a revoked or expired account is named for reconnect while the other is read', async () => {
    const result = await handler(accessFor([{ ...WORK, error: 'google token failed: invalid_grant' }, HOME], realClients(tasksProvider, tasksProvider)), 'get_tasks').handle(getTasksArgsSchema.parse({}));
    expect(entries(result)[0]).toMatchObject({ email: WORK.email, read: 'failed', reason: 'reauth_needed' });
    expect(entries(result)[0]!.fix).toMatch(/reconnect/i);
    expect(entries(result)[1]).toMatchObject({ email: HOME.email, read: 'ok' });
  });

  it('a network failure mid-read on one account is named as temporary, and the other account is kept', async () => {
    const dropped = provider(() => { throw new TypeError('fetch failed'); });
    const result = await handler(accessFor([WORK, HOME], realClients(tasksProvider, dropped)), 'get_tasks').handle(getTasksArgsSchema.parse({}));
    expect(entries(result)[0]).toMatchObject({ email: WORK.email, read: 'ok' });
    expect(entries(result)[1]).toMatchObject({ email: HOME.email, read: 'failed', code: 'transient' });
    expect(sections(result)).toHaveLength(1);
  });

  it('both accounts failing is a failed read that names each account, never an empty list', async () => {
    const refused = provider(() => Response.json(SCOPE_INSUFFICIENT, { status: 403 }));
    const result = await handler(accessFor([WORK, { ...HOME, error: 'google token failed: invalid_grant' }], realClients(refused, tasksProvider)), 'get_tasks').handle(getTasksArgsSchema.parse({}));
    expect(result).toMatchObject({ ok: false, code: 'auth_failed', source_taint: 'external', connect: { service: 'google', feature: 'tasks' } });
    const { error } = result as { error: string };
    expect(error).toContain(WORK.email);
    expect(error).toContain(HOME.email);
    expect(error).toMatch(/not authorized/);
    expect(error).toMatch(/expired/);
    expect(error).toMatch(/not read.*unknown, not empty/i);
  });

  it('a named account whose grant lacks Tasks is reported as not authorized, not as unconnected', async () => {
    const result = await handler(accessFor([WORK, { ...HOME, tasks: false }], both), 'get_tasks').handle(getTasksArgsSchema.parse({ account: HOME.email }));
    expect(result).toMatchObject({ ok: false, code: 'auth_failed', connect: { reason: 'scope_missing', feature: 'tasks' } });
  });
});

describe('only accounts whose grant holds the feature count as accounts to read', () => {
  const ONE_GMAIL = [WORK, { ...HOME, mail: false }];
  it('read_thread without account reads the one Gmail account instead of asking which account', async () => {
    const calls: Array<readonly [GoogleFeature | undefined, string | undefined]> = [];
    const thread = { threadPage: async () => ({ messages: [], cursor: null }) };
    const result = await handler(accessFor(ONE_GMAIL, { [WORK.email]: thread }, calls), 'read_thread').handle(readThreadArgsSchema.parse({ thread_id: 't' }));
    expect(result).toMatchObject({ ok: true, data: { thread_id: 't', account: receipt(WORK) } });
    expect(calls).toEqual([['mail', undefined]]);
  });
  it('get_communication without account reads the one Gmail account alone, with its whole page', async () => {
    const calls: Array<readonly [GoogleFeature | undefined, string | undefined]> = [];
    const limits: number[] = [];
    const counting = { mailPage: async (q: string, limit: number) => { limits.push(limit); return mail(WORK, 'Board deck').mailPage(q, limit); } };
    const result = await handler(accessFor(ONE_GMAIL, { [WORK.email]: counting }, calls), 'get_communication').handle(getCommunicationArgsSchema.parse({ limit: 30 }));
    expect(result).toMatchObject({ ok: true, data: { account: receipt(WORK), messages: [{ subject: 'Board deck' }] } });
    expect(calls).toEqual([['mail', undefined]]);
    expect(limits).toEqual([30]);
  });
  it('an account that holds the feature but is failing is still read and named', async () => {
    const result = await handler(accessFor([{ ...WORK, error: 'google token failed: invalid_grant' }, HOME, { id: 'conn-x', email: 'x@example.test', error: null, calendar: true, mail: false, tasks: false }], both), 'get_tasks').handle(getTasksArgsSchema.parse({}));
    expect(entries(result).map((entry) => [entry.email, entry.read])).toEqual([[WORK.email, 'failed'], [HOME.email, 'ok']]);
    expect(entries(result)[0]).toMatchObject({ reason: 'reauth_needed' });
  });
});

describe('one read covers at most five accounts and names the rest', () => {
  const ELEVEN: Known[] = Array.from({ length: 11 }, (_, index) => ({ id: `conn-${index}`, email: `account${index}@example.test`, error: null, calendar: true, mail: true, tasks: true }));
  it('eleven accounts: five are read, at most five at a time, each with its share of the page, and the other six are named as not read', async () => {
    const calls: Array<readonly [GoogleFeature | undefined, string | undefined]> = [];
    const limits: number[] = [];
    let inFlight = 0;
    let peak = 0;
    const people = (known: Known) => ({ searchContacts: async (_query: string, limit: number) => {
      limits.push(limit);
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return [{ name: `Priya ${known.id}`, emails: [`priya.${known.id}@example.test`], source: 'contacts' as const }];
    } });
    const result = await handler(accessFor(ELEVEN, Object.fromEntries(ELEVEN.map((known) => [known.email, people(known)])), calls), 'search_contacts').handle(searchContactsArgsSchema.parse({ query: 'Priya', limit: 10 }));
    expect(calls.map(([, account]) => account)).toEqual(ELEVEN.slice(0, 5).map((known) => known.email));
    expect(peak).toBeLessThanOrEqual(5);
    expect(limits).toEqual([2, 2, 2, 2, 2]);
    expect(sections(result)).toHaveLength(5);
    const summary = entries(result);
    expect(summary.map((entry) => entry.email)).toEqual(ELEVEN.map((known) => known.email));
    expect(summary.slice(0, 5).every((entry) => entry.read === 'ok')).toBe(true);
    for (const entry of summary.slice(5)) {
      expect(entry.read).toBe('not_read');
      expect(entry.fix).toContain(entry.email);
    }
    expect((result as { data: { note: string } }).data.note).toMatch(/not read.*unknown, not empty/i);
  });
  it("free time over eleven accounts leaves the six unread primary calendars unchecked, so nothing is offered as surely free", async () => {
    const open = { freeBusy: async (from: string, to: string) => ({ from, to, calendars: { primary: { busy: [] } } }) };
    const result = await handler(accessFor(ELEVEN, Object.fromEntries(ELEVEN.map((known) => [known.email, open]))), 'query_availability').handle({ date_range: { from: '2026-10-25T09:00:00Z', to: '2026-10-25T12:00:00Z' }, calendar_ids: ['primary'], duration_minutes: 30, work_windows: [] });
    expect(result).toMatchObject({ ok: true, data: { status: 'partial_provider_coverage', free_windows: [], unavailable_calendar_ids: ELEVEN.slice(5).map((known) => known.email) } });
  });
});

describe('free time and Drive cover every account too', () => {
  const range = { from: '2026-10-25T09:00:00Z', to: '2026-10-25T12:00:00Z' };
  const busy = (start: string, end: string) => ({ freeBusy: async (from: string, to: string) => ({ from, to, calendars: { primary: { busy: [{ start, end }] } } }) });
  it("free time without an account is free on every account's primary calendar", async () => {
    const access = accessFor([WORK, HOME], { [WORK.email]: busy('2026-10-25T09:00:00Z', '2026-10-25T10:00:00Z'), [HOME.email]: busy('2026-10-25T10:00:00Z', '2026-10-25T11:00:00Z') });
    const result = await handler(access, 'query_availability').handle({ date_range: range, calendar_ids: ['primary'], duration_minutes: 30, work_windows: [] });
    expect(result).toMatchObject({ ok: true, data: { accounts: [{ email: WORK.email, read: 'ok' }, { email: HOME.email, read: 'ok' }], status: 'complete_provider_coverage', calendar_ids: [WORK.email, HOME.email] } });
    expect((result as { data: { free_windows: { start: string }[] } }).data.free_windows.map((window) => window.start)).toEqual(['2026-10-25T11:00:00+00:00']);
  });
  it('an account that cannot answer leaves its calendar unchecked, so the time is only tentative', async () => {
    const access = accessFor([WORK, { ...HOME, error: 'google token failed: invalid_grant' }], { [WORK.email]: busy('2026-10-25T09:00:00Z', '2026-10-25T10:00:00Z') });
    const result = await handler(access, 'query_availability').handle({ date_range: range, calendar_ids: ['primary'], duration_minutes: 30, work_windows: [] });
    expect(result).toMatchObject({ ok: true, data: { accounts: [{ read: 'ok' }, { email: HOME.email, read: 'failed', reason: 'reauth_needed' }], status: 'partial_provider_coverage', free_windows: [], unavailable_calendar_ids: [HOME.email] } });
  });

  // A shared calendar both accounts can name: the one that cannot see it answers with an error, and the clean answer is
  // the one used, whichever account answers first.
  const TEAM = 'team@group.example.test';
  const sharedAnswer = (answer: FreeBusyResult['calendars'][string]) => ({ freeBusy: async (from: string, to: string) => ({ from, to, calendars: { [TEAM]: answer } }) });
  const CLEAN = { busy: [{ start: '2026-10-25T09:00:00Z', end: '2026-10-25T11:00:00Z' }] };
  const UNSEEN = { busy: [], errors: [{ reason: 'notFound' }] };
  it.each([['the first account cannot see it', UNSEEN, CLEAN], ['the second account cannot see it', CLEAN, UNSEEN]])('a calendar other than primary takes the clean answer when %s', async (_case, work, home) => {
    const result = await handler(accessFor([WORK, HOME], { [WORK.email]: sharedAnswer(work), [HOME.email]: sharedAnswer(home) }), 'query_availability').handle({ date_range: range, calendar_ids: [TEAM], duration_minutes: 30, work_windows: [] });
    expect(result).toMatchObject({ ok: true, data: { status: 'complete_provider_coverage', calendar_ids: [TEAM], unavailable_calendar_ids: [] } });
    expect((result as { data: { free_windows: { start: string }[] } }).data.free_windows.map((window) => window.start)).toEqual(['2026-10-25T11:00:00+00:00']);
  });

  const drive = (name: string) => ({ driveListFiles: async () => ({ files: [{ id: `${name}-file`, name, mimeType: 'text/plain', modifiedTime: null, webViewLink: null, size: null }], nextPageToken: null, incompleteSearch: false }) });
  const driveHandler = (access: GoogleAccess) => readDriveHandler(access, true) as unknown as { handle(args: unknown, ctx?: unknown): Promise<unknown> };
  it('Drive recent files come from every account, each under its account', async () => {
    const result = await driveHandler(accessFor([WORK, HOME], { [WORK.email]: drive('Deck'), [HOME.email]: drive('Recipes') })).handle(readDriveArgsSchema.parse({ action: 'recent' }));
    expect(result).toMatchObject({ ok: true, data: { accounts: [{ email: WORK.email, read: 'ok' }, { email: HOME.email, read: 'ok' }], by_account: [{ account: receipt(WORK), files: [{ name: 'Deck' }] }, { account: receipt(HOME), files: [{ name: 'Recipes' }] }] } });
  });
  it('a Drive file id asks for its account, and a content read follows its connection', async () => {
    const calls: Array<readonly [GoogleFeature | undefined, string | undefined]> = [];
    const access = accessFor([WORK, HOME], { [WORK.email]: drive('Deck'), [HOME.email]: drive('Recipes') }, calls);
    expect(await driveHandler(access).handle(readDriveArgsSchema.parse({ action: 'get', file_id: 'file-0123456789' }))).toMatchObject({ ok: false, code: 'rejected' });
    await readDriveHandler(access, true, true).handle(readDriveArgsSchema.parse({ action: 'content', file_id: 'file-0123456789', connection_id: HOME.id, expected_modified_time: '2026-10-25T08:00:00Z' }), undefined as never);
    expect(calls).toEqual([['drive', HOME.email]]);
  });
});
