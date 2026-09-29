import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Dashboard } from './App';
import type { OverviewV1 } from './model';
const empty: OverviewV1 = { version: 1, as_of: '2026-09-29T07:40:00Z', timezone: 'Asia/Kolkata', brief: { status: 'not_sent', at: null }, waiting: { count: 0, first: null }, next_card: null, latest_activity: null, services: [] };
describe('dashboard read-only copy', () => {
  it('does not invent a Brief, health score, future card or activity', () => {
    const html = renderToStaticMarkup(<Dashboard data={empty} route="overview" />);
    expect(html).toContain('The Brief has not been sent.');
    expect(html).toContain('No card scheduled ahead.');
    expect(html).toContain('No activity record available yet.');
    expect(html).not.toMatch(/Form 78|delivered|recovery score/);
  });
  it('describes a recorded send without claiming delivery and leaves decisions read-only', () => {
    const record: OverviewV1 = { ...empty, brief: { status: 'sent_recorded', at: '2026-09-29T05:00:00Z' }, waiting: { count: 1, first: { id: 'p1', summary: 'Review a calendar move' } } };
    expect(renderToStaticMarkup(<Dashboard data={record} route="overview" />)).toContain('does not confirm delivery');
    const waiting = renderToStaticMarkup(<Dashboard data={record} route="waiting" />);
    expect(waiting).toContain('cannot approve a change');
    expect(waiting).not.toContain('<button');
  });
  it('does not fake claim provenance or tested connection reads', () => {
    expect(renderToStaticMarkup(<Dashboard data={empty} route="memory" />)).toContain('No memory details here yet.');
    const html = renderToStaticMarkup(<Dashboard data={{ ...empty, services: [{ account_id: 'g1', email: 'owner@example.test', grants: ['calendar'], health: 'access_granted' }] }} route="connections" />);
    expect(html).toContain('Access granted · read unverified');
  });
});
