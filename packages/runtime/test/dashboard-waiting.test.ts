import { describe, expect, it } from 'vitest';
import { dashboardWaiting, dashboardWaitingDetail, DASHBOARD_WAITING_PATH } from '../src/channels/dashboard-waiting';
import type { ApprovalItem } from '../src/channels/approvals';

const cal: ApprovalItem = { id: 'a1', kind: 'calendar_change', summary: 'Move standup', state: 'open', undoable: false, review: { kind: 'calendar_change', action: 'move', title: 'Standup', event_id: 'e1', start: '2026-10-03T10:00:00+05:30', end: null, reason: 'conflict' } };
const mail: ApprovalItem = { id: 'a2', kind: 'email_send', summary: 'Send to Sam', state: 'open', undoable: false, review: { kind: 'email_send', to: ['sam@example.com'], cc: [], bcc: [], subject: 'Hi', body: 'Secret body text' } };
const done: ApprovalItem = { id: 'a3', kind: 'calendar_change', summary: 'Created lunch', state: 'done', undoable: true, review: null };
const mismatch: ApprovalItem = { id: 'a4', kind: 'calendar_change', summary: 'x', state: 'open', undoable: false, review: { kind: 'message_send', channel: 'telegram', content: 'wrong kind' } };
const now = Date.parse('2026-10-02T00:00:00Z');

describe('dashboard waiting projection', () => {
  it('queue lists waiting items and receipts separately, with no review bodies', () => {
    expect(DASHBOARD_WAITING_PATH).toBe('/console/dashboard/api/v1/waiting');
    const out = dashboardWaiting({ now, approvals: [cal, mail, done] });
    expect(out.waiting.map((w) => w.id)).toEqual(['a1', 'a2']);
    expect(out.waiting[0]).toEqual({ id: 'a1', kind: 'calendar_change', label: 'Calendar adjustment', summary: 'Move standup', state: 'open', may_approve_here: true, may_dismiss_here: false });
    expect(out.waiting[1]).toMatchObject({ may_approve_here: false, may_dismiss_here: true, label: 'Email send' });
    expect(out.receipts).toEqual([{ id: 'a3', kind: 'calendar_change', label: 'Calendar adjustment', summary: 'Created lunch', undoable: true }]);
    expect(JSON.stringify(out)).not.toMatch(/Secret body|sam@example/);
  });
  it('detail returns the typed review only when it matches the item kind', () => {
    expect(dashboardWaitingDetail(mail)).toMatchObject({ version: 1, id: 'a2', review: { kind: 'email_send', to: ['sam@example.com'], body: 'Secret body text' }, may_approve_here: false });
    expect(dashboardWaitingDetail(mismatch)?.review).toBeNull();
    expect(dashboardWaitingDetail(undefined)).toBeNull();
  });
  it('carries no csrf or extra fields', () => {
    expect(JSON.stringify(dashboardWaiting({ now, approvals: [{ ...cal, csrf: 'tok' } as never] }))).not.toMatch(/csrf|tok"/);
  });
});
