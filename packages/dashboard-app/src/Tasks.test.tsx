import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Dashboard, DashboardNavigation, resolveRoute } from './App';
import { fetchTasks, readTasks, TasksFeedback, TasksPanel, TasksView, TASKS_URL, type TasksV1 } from './Tasks';
import { SignInRequired, type OverviewV1 } from './model';

const tasks: TasksV1 = { version: 1, as_of: '2026-10-15T04:00:00.000Z', withheld: false,
  open: [
    { id: 'oa1', title: 'Call the <b>plumber</b>', due_local: '2026-10-16T09:00', source: 'agent', created_at: '2026-10-15T04:00:00.001Z' },
    { id: 'oa2', title: '<img src=x onerror=alert(1)>', due_local: null, source: 'mail', created_at: '2026-10-15T04:00:00.002Z' },
  ],
  recently_closed: [
    { id: 'oa3', title: 'Closed synthetic errand', outcome: 'dropped', closed_at: '2026-10-15T04:00:00.003Z' },
    { id: 'oa4', title: 'Renew passport', outcome: 'done', closed_at: '2026-10-14T04:00:00.000Z' },
  ] };
const overview: OverviewV1 = { version: 1, as_of: '2026-10-15T04:00:00Z', timezone: 'UTC', brief: { status: 'not_sent', at: null }, waiting: { count: 0, first: null }, next_card: null, latest_activity: null, services: [] };

describe('tasks projection reader', () => {
  it('accepts the server projection exactly and drops unknown fields', () => {
    expect(readTasks(tasks)).toEqual(tasks);
    const extra = { ...tasks, csrf: 'never-kept', open: [{ ...tasks.open[0], source_ref: 'gmail:synthetic-ref' }], recently_closed: [] };
    const read = readTasks(extra);
    expect(JSON.stringify(read)).not.toMatch(/never-kept|synthetic-ref/);
    expect(read.open[0]).toEqual(tasks.open[0]);
  });

  it('rejects unsupported versions, rows and outcomes', () => {
    for (const bad of [null, [], { ...tasks, version: 2 }, { ...tasks, withheld: 'no' }, { ...tasks, as_of: 'not a time' }, { ...tasks, open: {} },
      { ...tasks, open: [{ ...tasks.open[0], source: 'calendar' }] }, { ...tasks, open: [{ ...tasks.open[0], due_local: 5 }] },
      { ...tasks, recently_closed: [{ ...tasks.recently_closed[0], outcome: 'open' }] }, { ...tasks, recently_closed: [{ ...tasks.recently_closed[0], closed_at: null }] }])
      expect(() => readTasks(bad)).toThrow('unsupported shape');
  });
});

describe('tasks view', () => {
  it('renders open and closed loops as escaped text with owner-local due dates and no mutating controls', () => {
    const html = renderToStaticMarkup(<TasksView data={tasks} zone="UTC"/>);
    expect(html).toContain('Call the &lt;b&gt;plumber&lt;/b&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toMatch(/<b>plumber|<img/);
    expect(html).toContain('Due 2026-10-16 09:00');
    expect(html).toContain('No due date · From mail, completion unknown');
    expect(html).toContain('Dropped');
    expect(html).toContain('Done');
    expect(html).not.toMatch(/<button|<form|<input|<select|<textarea/);
    expect(html).not.toContain('hidden while a forget request');
  });

  it('shows empty lists plainly and says when rows are withheld without naming them', () => {
    const html = renderToStaticMarkup(<TasksView data={{ ...tasks, withheld: true, open: [], recently_closed: [] }} zone="UTC"/>);
    expect(html).toContain('Nothing open is recorded.');
    expect(html).toContain('Nothing closed recently.');
    expect(html).toContain('Some items are hidden while a forget request finishes.');
  });

  it('shows loading, retryable error and signed-out states', () => {
    expect(renderToStaticMarkup(<TasksPanel zone="UTC"/>)).toContain('Loading tasks…');
    const failed = renderToStaticMarkup(<TasksFeedback state={{ kind: 'error', message: 'Tasks could not load right now.', signedOut: false }} onRetry={() => {}}/>);
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Try again');
    const signedOut = renderToStaticMarkup(<TasksFeedback state={{ kind: 'error', message: 'Sign in to see your dashboard.', signedOut: true }} onRetry={() => {}}/>);
    expect(signedOut).toContain('href="/console/signin"');
    expect(signedOut).not.toContain('Try again');
  });

  it('is a primary destination reached at #/tasks', () => {
    expect(resolveRoute('tasks')).toBe('tasks');
    expect(renderToStaticMarkup(<DashboardNavigation route="tasks"/>)).toMatch(/aria-current="page"[^>]*href="#\/tasks"/);
    expect(renderToStaticMarkup(<Dashboard data={overview} route="tasks"/>)).toContain('Loading tasks…');
  });
});

describe('tasks fetch', () => {
  it('reads the tasks route with GET only, same-origin credentials and no cache', async () => {
    const fetch = vi.fn(async () => Response.json(tasks));
    vi.stubGlobal('fetch', fetch);
    try {
      expect(await fetchTasks()).toEqual(tasks);
      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('/console/dashboard/api/v1/tasks');
      expect(TASKS_URL).toBe(url);
      expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      expect(init.method).toBeUndefined();
      expect(init.body).toBeUndefined();
    } finally { vi.unstubAllGlobals(); }
  });

  it('maps 401 to sign-in, other failures and bad bodies to plain errors', async () => {
    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));
      await expect(fetchTasks()).rejects.toBeInstanceOf(SignInRequired);
      vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 429 })));
      await expect(fetchTasks()).rejects.toThrow('Tasks could not load right now.');
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
      await expect(fetchTasks()).rejects.toThrow('Tasks could not load right now.');
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{', { status: 200 })));
      await expect(fetchTasks()).rejects.toThrow('unsupported shape');
    } finally { vi.unstubAllGlobals(); }
  });
});
