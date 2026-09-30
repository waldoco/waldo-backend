import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Dashboard, DashboardNavigation, DashboardFeedback, resolveRoute } from './App';
import type { OverviewV1 } from './model';
const empty: OverviewV1 = { version: 1, as_of: '2026-09-29T07:40:00Z', timezone: 'Asia/Kolkata', brief: { status: 'not_sent', at: null }, waiting: { count: 0, first: null }, next_card: null, latest_activity: null, services: [] };
describe('dashboard read-only copy', () => {
  it('escapes hostile proposal, activity, account and card text on every read surface', () => {
    const hostile = '<script>alert("owner")</script>';
    const record: OverviewV1 = { ...empty, waiting: { count: 1, first: { id: 'p1', summary: hostile } }, next_card: { id: 'c1', label: hostile, scheduled_at: empty.as_of }, latest_activity: { kind: hostile, status: hostile, summary: hostile, at: empty.as_of }, services: [{ account_id: 'g1', email: hostile, grants: [], health: 'needs_reconnect' }] };
    for (const route of ['today', 'waiting', 'patrol', 'connections'] as const) {
      const html = renderToStaticMarkup(<Dashboard data={record} route={route} />);
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    }
  });
  it('offers sign-in for an expired session and retry for an unavailable read', () => {
    const signedOut = renderToStaticMarkup(<DashboardFeedback state={{ kind: 'error', message: 'Sign in to see your dashboard.', signedOut: true }} onRetry={() => {}} />);
    expect(signedOut).toContain('href="/console/signin"');
    expect(signedOut).not.toContain('Try again');
    const unavailable = renderToStaticMarkup(<DashboardFeedback state={{ kind: 'error', message: 'The dashboard could not load right now.', signedOut: false }} onRetry={() => {}} />);
    expect(unavailable).toContain('Try again');
    expect(unavailable).not.toContain('Not available yet');
    expect(renderToStaticMarkup(<DashboardFeedback state={{ kind: 'loading' }} onRetry={() => {}} />)).toContain('role="status"');
  });
  it('opens Today by default, preserves Overview links, and keeps existing controls reachable', () => {
    expect(resolveRoute('')).toBe('today');
    expect(resolveRoute('overview')).toBe('today');
    const html = renderToStaticMarkup(<DashboardNavigation route="today" />);
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('href="#/today"');
    for (const path of ['setup', 'day', 'files', 'usage', 'invites', 'account']) {
      expect(html).toContain(`href="/console/${path}"`);
    }
    for (const [route, paths] of [
      ['waiting', ['waiting']], ['patrol', ['activity']],
      ['memory', ['spots', 'constellation', 'memory']], ['connections', ['connections']],
    ] as const) {
      const page = renderToStaticMarkup(<Dashboard data={empty} route={route} />);
      for (const path of paths) expect(page).toContain(`href="/console/${path}"`);
    }
  });
  it('keeps pending decisions visible when their summary is unavailable', () => {
    const record: OverviewV1 = { ...empty, waiting: { count: 2, first: null } };
    for (const route of ['overview', 'waiting'] as const) {
      const html = renderToStaticMarkup(<Dashboard data={record} route={route} />);
      expect(html).toContain('The decision summary is unavailable. Open the full proposals to review.');
      expect(html).not.toMatch(/Nothing is waiting|No decision is waiting/);
    }
  });
  it('does not invent a Brief, health score, future card or activity', () => {
    const html = renderToStaticMarkup(<Dashboard data={empty} route="overview" />);
    expect(html).toContain('The Brief has not been sent.');
    expect(html).toContain('No card scheduled ahead.');
    expect(html).toContain('No owner-facing activity in the latest record.');
    expect(html).not.toMatch(/Form 78|delivered|recovery score/);
  });
  it('describes a recorded send without claiming delivery and leaves decisions read-only', () => {
    const record: OverviewV1 = { ...empty, brief: { status: 'sent_recorded', at: '2026-09-29T05:00:00Z' }, waiting: { count: 1, first: { id: 'p1', summary: 'Review a calendar move' } } };
    expect(renderToStaticMarkup(<Dashboard data={record} route="overview" />)).toContain('does not confirm delivery');
    const waiting = renderToStaticMarkup(<Dashboard data={record} route="waiting" />);
    expect(waiting).toContain('cannot approve a change');
    expect(waiting).not.toContain('<button');
  });
  it('does not mistake a system heartbeat for owner-facing activity', () => {
    const heartbeat: OverviewV1 = { ...empty, latest_activity: { kind: 'heartbeat', status: 'completed', at: empty.as_of, summary: 'tick completed' } };
    const patrol = renderToStaticMarkup(<Dashboard data={heartbeat} route="patrol" />);
    const overview = renderToStaticMarkup(<Dashboard data={heartbeat} route="overview" />);
    expect(patrol).toContain('No owner-facing activity in the latest record.');
    expect(patrol).not.toContain('tick completed');
    expect(overview).not.toContain('heartbeat');
    const failure: OverviewV1 = { ...empty, latest_activity: { kind: 'heartbeat', status: 'failed', at: empty.as_of, summary: 'attempt did not complete' } };
    expect(renderToStaticMarkup(<Dashboard data={failure} route="patrol" />)).toContain('attempt did not complete');
  });
  it('does not contradict a recorded activity when its summary is absent', () => {
    const record: OverviewV1 = { ...empty, latest_activity: { kind: 'update_card', status: 'completed', at: empty.as_of, summary: null } };
    const patrol = renderToStaticMarkup(<Dashboard data={record} route="patrol" />);
    expect(patrol).toContain('update_card');
    expect(patrol).toContain('No summary is recorded for this activity.');
    expect(patrol).not.toContain('No owner-facing work appears');
  });
  it('orders a waiting decision before the Brief on a small screen without hiding its summary', () => {
    const waiting: OverviewV1 = { ...empty, waiting: { count: 1, first: { id: 'w1', summary: 'Review recipient and effect' } } };
    const html = renderToStaticMarkup(<Dashboard data={waiting} route="overview" />);
    expect(html).toContain('overview-grid has-waiting');
    expect(html).toContain('Review recipient and effect');
  });
  it('does not fake claim provenance or tested connection reads', () => {
    const memory = renderToStaticMarkup(<Dashboard data={empty} route="memory" />);
    expect(memory).toContain('No memory details here yet.');
    expect(memory).toContain('href="/console/spots"');
    expect(memory).not.toContain('read contract');
    const html = renderToStaticMarkup(<Dashboard data={{ ...empty, services: [{ account_id: 'g1', email: 'owner@example.test', grants: ['calendar'], health: 'access_granted' }] }} route="connections" />);
    expect(html).toContain('Access granted · read unverified');
  });
});
