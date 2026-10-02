import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Dashboard, DashboardNavigation, DashboardFeedback, resolveRoute } from './App';
import type { OverviewV1 } from './model';
const empty: OverviewV1 = { version: 1, as_of: '2026-09-29T07:40:00Z', timezone: 'Asia/Kolkata', brief: { status: 'not_sent', at: null }, waiting: { count: 0, first: null }, next_card: null, latest_activity: null, services: [] };
describe('dashboard read-only copy', () => {
  it('exposes private retained workspace separately from Telegram references', () => {
    const html = renderToStaticMarkup(<DashboardNavigation route="today" />);
    expect(html).toMatch(/href="\/console\/workspace"[^>]*>Private workspace/);
    expect(html).toContain('Retained files &amp; downloads');
    expect(html).toMatch(/href="\/console\/files"[^>]*>Files <small>Telegram references/);
  });
  it('labels Account accurately and locates sessions at Connections', () => {
    const html = renderToStaticMarkup(<DashboardNavigation route="connections" />);
    expect(html).not.toContain('Account &amp; sign out');
    expect(html).toMatch(/href="\/console\/connections"[^>]*>Sessions &amp; sign out/);
    expect(html).toMatch(/href="\/console\/account"[^>]*>Account</);
  });
  it('separates recorded Google permissions from unknown Telegram and live-read state', () => {
    const html = renderToStaticMarkup(<Dashboard data={{ ...empty, services: [{ account_id: 'g1', email: 'owner@example.test', grants: ['calendar', 'gmail'], health: 'needs_reconnect' }] }} route="connections" />);
    expect(html).toContain('Reconnect needed');
    expect(html).toContain('Calendar');
    expect(html).toContain('Gmail');
    expect(html).toContain('Telegram and session details are unavailable in this view.');
    expect(html).toContain('Sessions &amp; sign out');
    expect(html).not.toMatch(/Telegram connected|Live read verified/);
    expect(html).not.toContain('<form');
  });
  it('keeps Memory subviews unavailable until real items are supplied, with supported control links', () => {
    for (const [route, path] of [['memory/spots', 'spots'], ['memory/constellation', 'constellation'], ['memory/profile', 'memory']] as const) {
      const html = renderToStaticMarkup(<Dashboard data={empty} route={route} />);
      expect(html).toContain('Memory details unavailable');
      expect(html).toContain(`href="/console/${path}"`);
      expect(html).toContain('href="#/memory/spots"');
      expect(html).not.toMatch(/No spots yet|No constellation yet|Nothing remembered|<canvas/);
      expect(html).not.toContain('<button');
    }
    const spots = renderToStaticMarkup(<Dashboard data={empty} route="memory/spots" />);
    expect(spots).toContain('Source IDs are audit hints');
    expect(spots).toContain('Retry forget');
    const constellation = renderToStaticMarkup(<Dashboard data={empty} route="memory/constellation" />);
    expect(constellation).toContain('Supporting Spots stay');
  });
  it('keeps one Memory navigation destination and exposes Your day without inventing settings', () => {
    expect(resolveRoute('memory/constellation')).toBe('memory/constellation');
    expect(resolveRoute('memory/profile')).toBe('memory/profile');
    expect(resolveRoute('day')).toBe('day');
    const nav = renderToStaticMarkup(<DashboardNavigation route="memory/constellation" waitingCount={2} />);
    expect(nav).toMatch(/aria-current="page"[^>]*href="#\/memory"/);
    expect(nav).toContain('href="#/day"');
    expect(nav).toContain('2 waiting decisions');
    const day = renderToStaticMarkup(<Dashboard data={empty} route="day" />);
    expect(day).toContain('href="/console/day"');
    expect(day).toContain('Asia/Kolkata');
    expect(day).toContain('Timing and pin details are unavailable in this view.');
    expect(day).toContain('Quiet hours and volume values are unavailable in this view.');
    expect(day).not.toContain('<input');
    expect(day).not.toContain('No day cards');
  });
  it('escapes hostile proposal, activity, account and card text on every read surface', () => {
    const hostile = '<script>alert("owner")</script>';
    const record: OverviewV1 = { ...empty, waiting: { count: 1, first: { id: 'p1', summary: hostile } }, next_card: { id: 'c1', label: hostile, scheduled_at: empty.as_of }, latest_activity: { kind: hostile, status: hostile, summary: hostile, at: empty.as_of }, services: [{ account_id: 'g1', email: hostile, grants: [], health: 'needs_reconnect' }] };
    for (const route of ['today', 'waiting', 'patrol', 'connections', 'day'] as const) {
      const html = renderToStaticMarkup(<Dashboard data={record} route={route} />);
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    }
  });
  it('never moves an effect or memory mutation into a summary or unavailable subview', () => {
    for (const route of ['waiting', 'memory/spots', 'memory/constellation', 'memory/profile', 'connections', 'day'] as const) {
      const html = renderToStaticMarkup(<Dashboard data={empty} route={route} />);
      expect(html).not.toContain('<form');
      expect(html).not.toContain('<input');
      expect(html).not.toMatch(/<button[^>]*>Approve|action="\/console\/action"/);
    }
    const missingCount = renderToStaticMarkup(<DashboardNavigation route="today" />);
    expect(missingCount).not.toContain('0 waiting decisions');
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
    for (const path of ['setup', 'files', 'usage', 'invites', 'account']) {
      expect(html).toContain(`href="/console/${path}"`);
    }
    for (const [route, paths] of [
      ['waiting', ['waiting']], ['patrol', ['activity']],
      ['memory', ['spots', 'constellation', 'memory']], ['connections', ['connections']],
      ['day', ['day']],
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
