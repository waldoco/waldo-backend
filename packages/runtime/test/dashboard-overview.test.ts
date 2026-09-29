import { describe, expect, it, vi } from 'vitest';
import { dashboardOverview, DASHBOARD_OVERVIEW_HEADERS, DASHBOARD_OVERVIEW_PATH } from '../src/channels/dashboard-overview';
import { handleConsole } from '../src/channels/console-signin';
import type { ConsoleAuth } from '../src/identity/console-auth';

const now = Date.parse('2026-09-29T07:30:00Z'); // 13:00 Asia/Kolkata
const base = () => ({
  now, timezone: 'Asia/Kolkata',
  plans: [] as { card: string; time: string | null; reason: string; sent: boolean }[],
  cards: [{ id: 'card:brief', name: 'Brief' }, { id: 'card:close', name: 'Close' }],
  approvals: [] as Parameters<typeof dashboardOverview>[0]['approvals'],
  run: null as Parameters<typeof dashboardOverview>[0]['run'],
  trace: null as Parameters<typeof dashboardOverview>[0]['trace'],
  grants: [] as Parameters<typeof dashboardOverview>[0]['grants'],
});

describe('dashboard owner-state projection', () => {
  it('has strict empty fields and no console secrets or sample content', () => {
    const result = dashboardOverview(base());
    expect(result).toEqual({ version: 1, as_of: '2026-09-29T07:30:00.000Z', timezone: 'Asia/Kolkata',
      brief: { status: 'not_scheduled', at: null }, waiting: { count: 0, first: null }, next_card: null,
      latest_activity: null, services: [] });
    expect(JSON.stringify(result)).not.toMatch(/csrf|profile|memory|refresh_token|session/);
  });

  it('uses stored sent state and a truly future card, without treating grant health as a live read', () => {
    const result = dashboardOverview({ ...base(), plans: [
      { card: 'card:brief', time: '08:00', reason: 'planned', sent: true },
      { card: 'card:close', time: '18:00', reason: 'planned', sent: false },
    ], grants: [{ id: 'g1', email: 'a@example.com', error: 'expired', calendar: true, mail: true, tasks: false }] });
    expect(result.brief).toEqual({ status: 'sent_recorded', at: null });
    expect(result.next_card).toEqual({ id: 'card:close', label: 'Close', scheduled_at: '2026-09-29T12:30:00.000Z' });
    expect(result.services).toEqual([{ account_id: 'g1', email: 'a@example.com', grants: ['calendar', 'gmail'], health: 'needs_reconnect' }]);
  });

  it('picks the newer timestamp across raw trace and run records and bounds waiting to its first summary', () => {
    const result = dashboardOverview({ ...base(),
      trace: { at: now - 1000, hop: 'tool_failed', ok: false },
      run: { id: 'bg:1', kind: 'heartbeat', status: 'completed', summary: 'Done', parent_id: null, started_at: now - 2000, ended_at: now - 1800 },
      approvals: [
        { id: 'p1', kind: 'calendar', summary: 'Confirm time', state: 'open', undoable: false, review: null },
        { id: 'p2', kind: 'mail', summary: 'Private second item', state: 'review_only', undoable: false, review: null },
      ] });
    expect(result.latest_activity).toEqual({ kind: 'tool_failed', status: 'failed', at: '2026-09-29T07:29:59.000Z', summary: null });
    expect(result.waiting).toEqual({ count: 2, first: { id: 'p1', summary: 'Confirm time' } });
    expect(JSON.stringify(result)).not.toContain('Private second item');
    const completedLater = dashboardOverview({ ...base(), trace: { at: now - 1000, hop: 'tool_failed', ok: false },
      run: { id: 'bg:1', kind: 'heartbeat', status: 'completed', summary: 'Done', parent_id: null, started_at: now - 2000, ended_at: now } });
    expect(completedLater.latest_activity).toEqual({ kind: 'heartbeat', status: 'completed', at: '2026-09-29T07:30:00.000Z', summary: 'Done' });
  });
});

describe('dashboard session routing', () => {
  it('returns 401 with privacy headers before owner routing for an unsigned or expired cookie', async () => {
    const fetch = vi.fn(async () => new Response('wrong owner'));
    const ns = { idFromName: vi.fn((name: string) => name), get: () => ({ fetch }) } as unknown as DurableObjectNamespace;
    const auth = { readOwnerCookie: vi.fn(async () => null) } as unknown as ConsoleAuth;
    for (const cookie of ['', 'waldo_owner=expired']) {
      const response = await handleConsole(new Request(`https://w.test${DASHBOARD_OVERVIEW_PATH}`, { headers: { cookie } }), { TELEGRAM_OWNER_DO: ns }, auth);
      expect(response?.status).toBe(401);
      for (const [key, value] of Object.entries(DASHBOARD_OVERVIEW_HEADERS)) expect(response?.headers.get(key)).toBe(value);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('routes only by the verified owner identity, ignoring attempted query owner', async () => {
    const fetch = vi.fn(async (request: Request) => Response.json({ owner: request.headers.get('x-waldo-do-name') }));
    const idFromName = vi.fn((name: string) => name);
    const ns = { idFromName, get: () => ({ fetch }) } as unknown as DurableObjectNamespace;
    const auth = { readOwnerCookie: vi.fn(async () => 'owner-a') } as unknown as ConsoleAuth;
    const response = await handleConsole(new Request(`https://w.test${DASHBOARD_OVERVIEW_PATH}?owner=owner-b`, { headers: { cookie: 'waldo_owner=signed; waldo_console=session' } }), { TELEGRAM_OWNER_DO: ns }, auth);
    expect(await response?.json()).toEqual({ owner: 'owner-a' });
    expect(idFromName).toHaveBeenCalledWith('owner-a');
    expect(idFromName).not.toHaveBeenCalledWith('owner-b');
    for (const [key, value] of Object.entries(DASHBOARD_OVERVIEW_HEADERS)) expect(response?.headers.get(key)).toBe(value);
  });

  it('keeps private headers on a DO failure passed through the router', async () => {
    const fetch = vi.fn(async () => new Response('down', { status: 503, headers: { 'cache-control': 'public' } }));
    const ns = { idFromName: (name: string) => name, get: () => ({ fetch }) } as unknown as DurableObjectNamespace;
    const auth = { readOwnerCookie: vi.fn(async () => 'owner-a') } as unknown as ConsoleAuth;
    const response = await handleConsole(new Request(`https://w.test${DASHBOARD_OVERVIEW_PATH}`, { headers: { cookie: 'waldo_owner=signed; waldo_console=session' } }), { TELEGRAM_OWNER_DO: ns }, auth);
    expect(response?.status).toBe(503);
    for (const [key, value] of Object.entries(DASHBOARD_OVERVIEW_HEADERS)) expect(response?.headers.get(key)).toBe(value);
  });
});

describe('owner DO read seam', () => {
  it('rejects unsigned and cross-owner sessions across two owner DOs, with hardened error responses', async () => {
    const { env } = await import('cloudflare:workers');
    const { runInDurableObject } = await import('cloudflare:test');
    const { consoleAccess } = await import('../src/channels/console');
    const a = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('dashboard-owner-a'));
    const b = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('dashboard-owner-b'));
    const aToken = await runInDurableObject(a, (_instance, state) => consoleAccess(state.storage).grant());
    const bToken = await runInDurableObject(b, (_instance, state) => consoleAccess(state.storage).grant());
    const fetch = (stub: typeof a, token?: string) => stub.fetch(`https://telegram-owner${DASHBOARD_OVERVIEW_PATH}`, { headers: token ? { cookie: `waldo_console=${token}` } : {} });
    for (const response of [await fetch(a), await fetch(b, aToken), await fetch(a, bToken)]) {
      expect(response.status).toBe(401);
      for (const [key, value] of Object.entries(DASHBOARD_OVERVIEW_HEADERS)) expect(response.headers.get(key)).toBe(value);
    }
    // The unit-test worker intentionally has no bot token or LLM key: an otherwise valid
    // session fails closed rather than leaking setup details or unprotected cache headers.
    const deniedMethod = await a.fetch(`https://telegram-owner${DASHBOARD_OVERVIEW_PATH}`, { method: 'POST', headers: { cookie: `waldo_console=${aToken}` } });
    expect(deniedMethod.status).toBe(405);
    for (const [key, value] of Object.entries(DASHBOARD_OVERVIEW_HEADERS)) expect(deniedMethod.headers.get(key)).toBe(value);
    const response = await fetch(a, aToken);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'overview_unavailable' });
    for (const [key, value] of Object.entries(DASHBOARD_OVERVIEW_HEADERS)) expect(response.headers.get(key)).toBe(value);
  });
});
