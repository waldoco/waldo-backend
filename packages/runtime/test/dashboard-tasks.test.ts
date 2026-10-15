import { describe, expect, it, vi } from 'vitest';
import { dashboardTasks, DASHBOARD_TASKS_PATH, TASKS_CLOSED_LIMIT } from '../src/channels/dashboard-tasks';
import { DASHBOARD_OVERVIEW_HEADERS } from '../src/channels/dashboard-overview';
import { handleConsole } from '../src/channels/console-signin';
import type { ConsoleAuth } from '../src/identity/console-auth';
import type { Loop } from '../src/channels/loops';

const now = Date.parse('2026-10-15T04:00:00Z');
const loop = (id: string, over: Partial<Loop> = {}): Loop => ({ id, title: `Synthetic ${id}`, due: null, status: 'open', created_at: now - 1000, closed_at: null, ...over });

describe('dashboard tasks projection', () => {
  it('orders open items by due, undated last, then by creation, and keeps due as owner-local text', () => {
    const out = dashboardTasks({ now, held: [], closed: [], open: [
      loop('o-undated-old', { created_at: 1 }),
      loop('o-late', { due: '2026-10-17T09:00', created_at: 5 }),
      loop('o-day', { due: '2026-10-16', created_at: 9 }),
      loop('o-undated-new', { created_at: 2 }),
      loop('o-same-day-time', { due: '2026-10-16T08:30', created_at: 3 }),
      loop('o-day-earlier', { due: '2026-10-16', created_at: 4 }),
    ] });
    expect(DASHBOARD_TASKS_PATH).toBe('/console/dashboard/api/v1/tasks');
    expect(out).toMatchObject({ version: 1, as_of: '2026-10-15T04:00:00.000Z', withheld: false });
    expect(out.open.map((item) => item.id)).toEqual(['o-day-earlier', 'o-day', 'o-same-day-time', 'o-late', 'o-undated-old', 'o-undated-new']);
    expect(out.open[0]).toEqual({ id: 'o-day-earlier', title: 'Synthetic o-day-earlier', due_local: '2026-10-16', source: 'agent', created_at: new Date(4).toISOString() });
    expect(out.open[3]?.due_local).toBe('2026-10-17T09:00');
    expect(out.open[4]?.due_local).toBeNull();
  });

  it('labels a mail-linked loop as mail and never exposes its source reference', () => {
    const out = dashboardTasks({ now, held: [], closed: [], open: [loop('o-mail', { due: '2026-10-16', source_ref: 'gmail:synthetic-ref-1' }), loop('o-own')] });
    expect(out.open.map((item) => [item.id, item.source])).toEqual([['o-mail', 'mail'], ['o-own', 'agent']]);
    expect(JSON.stringify(out)).not.toContain('synthetic-ref-1');
  });

  it('shows recently closed items newest first with their outcome, capped', () => {
    const closed = Array.from({ length: TASKS_CLOSED_LIMIT + 3 }, (_, index) => loop(`c${index}`, { status: index % 2 ? 'dropped' : 'done', closed_at: now - index * 60_000 }));
    const out = dashboardTasks({ now, held: [], open: [], closed: [...closed].reverse() });
    expect(out.recently_closed).toHaveLength(TASKS_CLOSED_LIMIT);
    expect(out.recently_closed[0]).toEqual({ id: 'c0', title: 'Synthetic c0', outcome: 'done', closed_at: new Date(now).toISOString() });
    expect(out.recently_closed[1]?.outcome).toBe('dropped');
    expect(out.recently_closed.map((item) => item.id)).toEqual(closed.slice(0, TASKS_CLOSED_LIMIT).map((item) => item.id));
  });

  it('withholds rows that carry or may hide a forget-pending topic, and says so without naming it', () => {
    const out = dashboardTasks({ now, held: ['Project Nightjar'], open: [
      loop('o-plain', { title: 'Book the dentist' }),
      loop('o-carries', { title: 'Follow up on project nightjar budget' }),
      loop('o-escaped', { title: 'Ask about Project Nightj\\u0061r' }),
      loop('o-mail-ref', { title: 'Reply to the vendor', source_ref: 'mail:project nightjar thread' }),
    ], closed: [loop('c-carries', { status: 'done', title: 'Project Nightjar kickoff', closed_at: now }), loop('c-plain', { status: 'done', title: 'Renew passport', closed_at: now - 1 })] });
    expect(out.open.map((item) => item.id)).toEqual(['o-plain']);
    expect(out.recently_closed.map((item) => item.id)).toEqual(['c-plain']);
    expect(out.withheld).toBe(true);
    expect(JSON.stringify(out).toLowerCase()).not.toContain('nightjar');
  });

  it('reports nothing withheld when a held topic matches no row', () => {
    const out = dashboardTasks({ now, held: ['Unrelated topic'], open: [loop('o-plain', { title: 'Book the dentist' })], closed: [] });
    expect(out.withheld).toBe(false);
    expect(out.open).toHaveLength(1);
  });
});

describe('dashboard tasks session routing', () => {
  it('refuses an unsigned or expired owner cookie with private headers before owner routing', async () => {
    const fetch = vi.fn(async () => new Response('wrong owner'));
    const ns = { idFromName: vi.fn((name: string) => name), get: () => ({ fetch }) } as unknown as DurableObjectNamespace;
    const auth = { readOwnerCookie: vi.fn(async () => null) } as unknown as ConsoleAuth;
    for (const cookie of ['', 'waldo_owner=expired']) {
      const response = await handleConsole(new Request(`https://w.test${DASHBOARD_TASKS_PATH}`, { headers: { cookie } }), { OWNER_DO: ns }, auth);
      expect(response?.status).toBe(401);
      for (const [key, value] of Object.entries(DASHBOARD_OVERVIEW_HEADERS)) expect(response?.headers.get(key)).toBe(value);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('routes only to the verified cookie owner, ignoring a query owner, and keeps private headers', async () => {
    const fetch = vi.fn(async (request: Request) => Response.json({ owner: request.headers.get('x-waldo-do-name') }, { headers: { 'cache-control': 'public' } }));
    const idFromName = vi.fn((name: string) => name);
    const ns = { idFromName, get: () => ({ fetch }) } as unknown as DurableObjectNamespace;
    const auth = { readOwnerCookie: vi.fn(async () => 'owner-a') } as unknown as ConsoleAuth;
    const response = await handleConsole(new Request(`https://w.test${DASHBOARD_TASKS_PATH}?owner=owner-b`, { headers: { cookie: 'waldo_owner=signed; waldo_console=session' } }), { OWNER_DO: ns }, auth);
    expect(await response?.json()).toEqual({ owner: 'owner-a' });
    expect(idFromName).not.toHaveBeenCalledWith('owner-b');
    for (const [key, value] of Object.entries(DASHBOARD_OVERVIEW_HEADERS)) expect(response?.headers.get(key)).toBe(value);
  });
});

describe('dashboard tasks owner DO read seam', () => {
  it('refuses unsigned, cross-owner and non-GET requests, then serves the owner their own loops', async () => {
    const { env } = await import('cloudflare:workers');
    const { runInDurableObject } = await import('cloudflare:test');
    const { consoleAccess } = await import('../src/channels/console');
    const { loopBook } = await import('../src/channels/loops');
    const a = env.OWNER_DO!.get(env.OWNER_DO!.idFromName('tasks-owner-a'));
    const b = env.OWNER_DO!.get(env.OWNER_DO!.idFromName('tasks-owner-b'));
    const seed = (stub: typeof a) => runInDurableObject(stub, (instance, state) => {
      Object.assign((instance as unknown as { env: Record<string, unknown> }).env, { TELEGRAM_BOT_TOKEN: '123:synthetic', OPENAI_API_KEY: 'synthetic-key' });
      return consoleAccess(state.storage).grant();
    });
    const aToken = await seed(a), bToken = await seed(b);
    await runInDurableObject(b, (_instance, state) => { loopBook(state.storage.sql, { newId: () => 'b1', now: () => now }).open({ title: 'Owner B private loop', due: null }); });
    const url = `https://telegram-owner${DASHBOARD_TASKS_PATH}`;
    for (const response of [await a.fetch(url), await b.fetch(url, { headers: { cookie: `waldo_console=${aToken}` } }), await a.fetch(url, { headers: { cookie: `waldo_console=${bToken}` } })]) {
      expect(response.status).toBe(401);
      for (const [key, value] of Object.entries(DASHBOARD_OVERVIEW_HEADERS)) expect(response.headers.get(key)).toBe(value);
      expect(await response.text()).not.toContain('Owner B private loop');
    }
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const denied = await a.fetch(url, { method, headers: { cookie: `waldo_console=${aToken}` } });
      expect(denied.status).toBe(405);
      for (const [key, value] of Object.entries(DASHBOARD_OVERVIEW_HEADERS)) expect(denied.headers.get(key)).toBe(value);
    }
    let id = 0;
    await runInDurableObject(a, (_instance, state) => {
      const book = loopBook(state.storage.sql, { newId: () => `a${++id}`, now: () => now + id });
      book.open({ title: 'Call the <b>plumber</b>', due: '2026-10-16T09:00' });
      book.open({ title: 'Undated synthetic errand', due: null });
      const closed = book.open({ title: 'Closed synthetic errand', due: null });
      book.close(closed.id, 'dropped');
    });
    const response = await a.fetch(url, { headers: { cookie: `waldo_console=${aToken}` } });
    expect(response.status).toBe(200);
    for (const [key, value] of Object.entries(DASHBOARD_OVERVIEW_HEADERS)) expect(response.headers.get(key)).toBe(value);
    const body = await response.json() as ReturnType<typeof dashboardTasks>;
    expect(body).toMatchObject({ version: 1, withheld: false });
    expect(Date.parse(body.as_of)).not.toBeNaN();
    expect(body.open.map((item) => [item.title, item.due_local, item.source])).toEqual([['Call the <b>plumber</b>', '2026-10-16T09:00', 'agent'], ['Undated synthetic errand', null, 'agent']]);
    expect(body.recently_closed).toEqual([{ id: 'oa3', title: 'Closed synthetic errand', outcome: 'dropped', closed_at: expect.any(String) }]);
    expect(JSON.stringify(body)).not.toMatch(/csrf|Owner B private loop/);
    expect((await a.fetch(`${url}?view=all`, { headers: { cookie: `waldo_console=${aToken}` } })).status).toBe(400);
    await runInDurableObject(a, (_instance, state) => { state.storage.sql.exec("INSERT INTO topic_purge_pending (fingerprint, topic, created_at) VALUES ('synthetic-fingerprint', 'Plumber', '2026-10-15')"); });
    const held = await (await a.fetch(url, { headers: { cookie: `waldo_console=${aToken}` } })).json() as ReturnType<typeof dashboardTasks>;
    expect(held.withheld).toBe(true);
    expect(held.open.map((item) => item.title)).toEqual(['Undated synthetic errand']);
    expect(JSON.stringify(held).toLowerCase()).not.toContain('plumber');
  });
});
