import { describe, expect, it } from 'vitest';
import { dashboardConnections, DASHBOARD_CONNECTIONS_PATH } from '../src/channels/dashboard-connections';

const base = () => ({
  now: Date.parse('2026-10-02T00:00:00Z'), sessionCount: 2, sessionUntil: '2026-10-09T00:00:00.000Z',
  google: { accounts: [] as { id: string; email: string; error: string | null; calendar: boolean; mail: boolean; tasks: boolean }[], connectAvailable: true },
  telegram: { linked: true, unlinkAvailable: false },
});

describe('dashboard connections projection', () => {
  it('has a versioned path under the dashboard api and strict empty fields', () => {
    expect(DASHBOARD_CONNECTIONS_PATH).toBe('/console/dashboard/api/v1/connections');
    expect(dashboardConnections(base())).toEqual({
      version: 1, as_of: '2026-10-02T00:00:00.000Z',
      google: { connect_available: true, accounts: [] },
      telegram: { linked: true, unlink_available: false },
      sessions: { count: 2, current_until: '2026-10-09T00:00:00.000Z' },
    });
  });
  it('maps grants and error state; reconnect is offered only when connect is available', () => {
    const accounts = [{ id: 'g1', email: 'a@example.com', error: 'expired', calendar: true, mail: true, tasks: false }, { id: 'g2', email: 'b@example.com', error: null, calendar: false, mail: true, tasks: true }];
    const open = dashboardConnections({ ...base(), google: { accounts, connectAvailable: true } });
    expect(open.google.accounts).toEqual([
      { account_id: 'g1', email: 'a@example.com', grants: ['calendar', 'gmail'], health: 'needs_reconnect', can_reconnect: true },
      { account_id: 'g2', email: 'b@example.com', grants: ['gmail', 'tasks'], health: 'access_granted', can_reconnect: false },
    ]);
    const closed = dashboardConnections({ ...base(), google: { accounts, connectAvailable: false } });
    expect(closed.google.accounts[0]!.can_reconnect).toBe(false);
  });
  it('never carries csrf, tokens, raw error text or extra input fields', () => {
    const accounts = [{ id: 'g1', email: 'a@example.com', error: 'invalid_grant refresh_token=abc', calendar: true, mail: false, tasks: false, refresh_token: 'secret' }];
    const text = JSON.stringify(dashboardConnections({ ...base(), google: { accounts, connectAvailable: true }, csrf: 'c-s-r-f' } as never));
    expect(text).not.toMatch(/csrf|c-s-r-f|refresh_token|invalid_grant|secret/);
  });
});
