import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Dashboard, DashboardNavigation, DashboardFeedback, resolveRoute } from './App';
import type { OverviewV1 } from './model';
const empty: OverviewV1 = { version: 1, as_of: '2026-09-29T07:40:00Z', timezone: 'Asia/Kolkata', brief: { status: 'not_sent', at: null }, waiting: { count: 0, first: null }, next_card: null, latest_activity: null, services: [] };
describe('dashboard routing and overview boundaries', () => {
  it('groups account and sessions in Settings while keeping connections separate', () => {
    const html = renderToStaticMarkup(<DashboardNavigation route="connections" />);
    expect(html).not.toContain('Account &amp; sign out');
    expect(html).toContain('href="/console/legacy"');
    expect(html).not.toContain('Original console');
    expect(html).toContain('href="#/settings"');
    expect(html).not.toContain('href="#/account"');
  });
  it('loads controls independently rather than turning overview summaries into complete records', () => {
    const record: OverviewV1 = { ...empty, waiting: { count: 1, first: { id: 'p1', summary: 'Overview-only proposal' } }, services: [{ account_id: 'g1', email: 'owner@example.test', grants: ['calendar'], health: 'needs_reconnect' }] };
    for (const [route, title] of [['waiting', 'Waiting.'], ['patrol', 'Patrol.'], ['connections', 'Connections.'], ['day', 'Settings.'], ['files', 'Files.'], ['usage', 'Settings.'], ['setup', 'Settings.']] as const) {
      const html = renderToStaticMarkup(<Dashboard data={record} route={route} />);
      expect(html).toContain(title);
      expect(html).toContain('role="status"');
      expect(html).toContain('Loading your controls');
      expect(html).not.toMatch(/Overview-only proposal|owner@example.test|No Google accounts|No day cards/);
      expect(html).not.toContain('<form');
    }
  });
  it('loads Memory subviews in-shell without manufacturing saved context', () => {
    for (const route of ['memory', 'memory/spots', 'memory/constellation'] as const) {
      const html = renderToStaticMarkup(<Dashboard data={empty} route={route}/>);
      expect(html).toContain('Loading your saved');
      expect(html).toContain('role="status"');
      expect(html).toContain('href="#/memory/spots"');
      expect(html).not.toMatch(/Open Spots|No saved Spots|<svg/);
    }
    const profile = renderToStaticMarkup(<Dashboard data={empty} route="memory/profile"/>);
    expect(profile).toContain('Loading your controls');
    expect(profile).toContain('role="status"');
    expect(profile).not.toContain('href="/console/memory"');
    expect(profile).not.toContain('No saved profile');
  });
  it('keeps one Memory destination and backed waiting counts in navigation', () => {
    const nav = renderToStaticMarkup(<DashboardNavigation route="memory/constellation" waitingCount={2}/>);
    expect(nav).toMatch(/aria-current="page"[^>]*href="#\/memory"/);
    expect(nav).toContain('href="#/settings"');
    expect(nav).toContain('2 waiting decisions');
    expect(renderToStaticMarkup(<DashboardNavigation route="today"/>)).not.toContain('0 waiting decisions');
  });
  it('preserves sibling routes with hash query strings', () => {
    for (const route of ['today', 'waiting', 'patrol', 'connections', 'day', 'files', 'usage', 'setup', 'admin'] as const) {
      expect(resolveRoute(`${route}?id=scope%3Aclaim%3A1&owner=other&explore=1`)).toBe(route);
    }
    expect(resolveRoute('memory/spots?id=scope%3Aclaim%3A1')).toBe('memory/spots');
    expect(resolveRoute('memory/constellation?id=scope%3Anode%3A1&explore=1')).toBe('memory/constellation');
    expect(resolveRoute('memory/profile')).toBe('memory/profile');
    for(const value of ['memory/spots?owner=other','memory/profile?id=1','memory/unknown'])expect(resolveRoute(value)).toBe('memory');
    expect(resolveRoute('')).toBe('today');
    expect(resolveRoute('overview?owner=other')).toBe('today');
    expect(resolveRoute('unknown?view=waiting')).toBe('not-found');
  });
  it('keeps supported destinations and Today links inside the shell', () => {
    const nav = renderToStaticMarkup(<DashboardNavigation route="today"/>);
    for (const path of ['today', 'waiting', 'patrol', 'memory', 'connections', 'files', 'settings']) expect(nav).toContain(`href="#/${path}"`);
    for (const path of ['legacy']) expect(nav).toContain(`href="/console/${path}"`);
    const today = renderToStaticMarkup(<Dashboard data={empty} route="today"/>);
    for (const path of ['waiting', 'settings/day', 'patrol']) expect(today).toContain(`href="#/${path}"`);
    expect(today).not.toContain('href="/console/day"');
  });
  it('escapes hostile overview text without exposing it in independently loaded panels', () => {
    const hostile = '<script>alert("owner")</script>';
    const record: OverviewV1 = { ...empty, waiting: { count: 1, first: { id: 'p1', summary: hostile } }, next_card: { id: 'c1', label: hostile, scheduled_at: empty.as_of }, latest_activity: { kind: hostile, status: hostile, summary: hostile, at: empty.as_of }, services: [{ account_id: 'g1', email: hostile, grants: [], health: 'needs_reconnect' }] };
    const today = renderToStaticMarkup(<Dashboard data={record} route="today"/>);
    expect(today).toContain('&lt;script&gt;');
    expect(today).not.toContain('<script>');
    for (const route of ['waiting', 'patrol', 'connections', 'day'] as const) {
      const html = renderToStaticMarkup(<Dashboard data={record} route={route}/>);
      expect(html).toContain('Loading your controls');
      expect(html).not.toMatch(/<script>|alert\(/);
    }
  });
  it('does not expose summary approval or mutations before a protected read', () => {
    for (const route of ['today', 'waiting', 'memory/spots', 'memory/constellation', 'memory/profile', 'connections', 'files', 'settings', 'invites'] as const) {
      const html = renderToStaticMarkup(<Dashboard data={empty} route={route}/>);
      expect(html).not.toContain('<form');
      expect(html).not.toContain('<input');
      expect(html).not.toMatch(/<button[^>]*>Approve|action="\/console\/action"/);
    }
  });
  it('offers sign-in for an expired session and retry for a failed read without inventing an empty state', () => {
    const signedOut = renderToStaticMarkup(<DashboardFeedback state={{ kind: 'error', message: 'Sign in to see your dashboard.', signedOut: true }} onRetry={() => {}}/>);
    expect(signedOut).toContain('href="/console/signin"');
    expect(signedOut).not.toContain('Try again');
    const unavailable = renderToStaticMarkup(<DashboardFeedback state={{ kind: 'error', message: 'The dashboard could not load right now.', signedOut: false }} onRetry={() => {}}/>);
    expect(unavailable).toContain('Try again');
    expect(unavailable).not.toMatch(/Not available yet|Nothing waiting|No saved Spots/);
    expect(renderToStaticMarkup(<DashboardFeedback state={{ kind: 'loading' }} onRetry={() => {}}/>)).toContain('role="status"');
  });
  it('keeps pending decisions visible when their summary is unavailable', () => {
    const record: OverviewV1 = { ...empty, waiting: { count: 2, first: null } };
    for (const route of ['overview', 'today'] as const) {
      const html = renderToStaticMarkup(<Dashboard data={record} route={route}/>);
      expect(html).toContain('2 decisions waiting.');
      expect(html).toContain('The decision summary is unavailable. Open the full proposals to review.');
      expect(html).not.toMatch(/Nothing is waiting|No decision is waiting/);
    }
  });
  it('does not invent a Brief, health score, future card or activity', () => {
    const html = renderToStaticMarkup(<Dashboard data={empty} route="overview"/>);
    expect(html).toContain('The Brief has not been sent.');
    expect(html).toContain('No card scheduled ahead.');
    expect(html).toContain('No owner-facing activity in the latest record.');
    expect(html).not.toMatch(/Form 78|delivered|recovery score/);
  });
  it('describes recorded sends without claiming delivery or approving a Today summary', () => {
    const record: OverviewV1 = { ...empty, brief: { status: 'sent_recorded', at: empty.as_of }, waiting: { count: 1, first: { id: 'p1', summary: 'Review a calendar move' } } };
    const html = renderToStaticMarkup(<Dashboard data={record} route="today"/>);
    expect(html).toContain('does not confirm delivery');
    expect(html).toContain('Review the full details before deciding.');
    expect(html).not.toMatch(/<button|>Approve|action="\/console\/action"/);
  });
  it('does not mistake a completed heartbeat for owner-facing activity while preserving failed attempts', () => {
    const heartbeat: OverviewV1 = { ...empty, latest_activity: { kind: 'heartbeat', status: 'completed', at: empty.as_of, summary: 'tick completed' } };
    expect(renderToStaticMarkup(<Dashboard data={heartbeat} route="today"/>)).not.toMatch(/heartbeat|tick completed/);
    const failure: OverviewV1 = { ...empty, latest_activity: { kind: 'heartbeat', status: 'failed', at: empty.as_of, summary: 'attempt did not complete' } };
    expect(renderToStaticMarkup(<Dashboard data={failure} route="today"/>)).toContain('attempt did not complete');
  });
  it('preserves an activity with an absent summary and places waiting before the Brief', () => {
    const record: OverviewV1 = { ...empty, waiting: { count: 1, first: { id: 'w1', summary: 'Review recipient and effect' } }, latest_activity: { kind: 'update_card', status: 'completed', at: empty.as_of, summary: null } };
    const html = renderToStaticMarkup(<Dashboard data={record} route="today"/>);
    expect(html).toContain('Update card');
    expect(html).toContain('No outcome summary recorded. This record does not confirm delivery or an external change.');
    expect(html).not.toContain('No owner-facing work appears');
    expect(html).toContain('overview-grid has-waiting');
    expect(html.indexOf('Review recipient and effect')).toBeLessThan(html.indexOf('The Brief has not been sent.'));
  });
});
