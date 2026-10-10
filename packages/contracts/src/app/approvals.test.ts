import { describe, expect, it } from 'vitest';
import {
  appApprovalDecisionResultV1Schema,
  appApprovalDecisionV1Schema,
  appApprovalListQueryV1Schema,
  appApprovalListV1Schema,
  appApprovalRoutesV1,
  appApprovalStateV1Schema,
  appApprovalV1Schema,
} from './approvals';
import { appControlReceiptV1Schema, appControlRequestIdV1Schema } from './controls';
import { payloadDigestV1Schema, replyApprovalPartV1Schema } from './parts';

const digest = `sha256:${'a'.repeat(64)}`;
const expiresAtMs = Date.UTC(2026, 9, 11, 4, 0, 0);
const email = {
  approval_id: 'p0001', kind: 'email_send', state: 'open',
  review: 'From: me@example.com\nTo: sam@example.com\nSubject: Friday\n\nSee you at 4.',
  exact: { recipients: { to: ['sam@example.com'], cc: [], bcc: [] }, scope: 'me@example.com' },
  payload_digest: digest, expires_at: expiresAtMs, actions: ['approve', 'edit', 'skip'], presented_surfaces: ['telegram', 'app'],
} as const;
const calendar = {
  ...email, approval_id: 'p0002', kind: 'calendar_change', review: 'Move "Design review" to Fri 16:00 to 17:00.',
  exact: { changes: { action: 'move', title: 'Design review', start: '2026-10-11T16:00:00+01:00', end: '2026-10-11T17:00:00+01:00' } },
} as const;
const message = { ...email, approval_id: 'p0003', kind: 'message_send', review: 'Send this on whatsapp: "Running late."', exact: { recipients: { to: ['whatsapp'], cc: [], bcc: [] } } } as const;
const browser = { ...email, approval_id: 'p0004', kind: 'browser_submit', review: 'Book the 18:30 table on the reservation page.', exact: { scope: 'https://reservations.example/book' }, actions: ['approve', 'skip'] } as const;
const mcp = { ...email, approval_id: 'p0005', kind: 'mcp_call', review: 'Run lookup on the crm server.', exact: { scope: 'lookup on the crm server' }, actions: ['approve', 'skip'] } as const;
const task = {
  ...email, approval_id: 'p0006', kind: 'google_task_change', review: 'Google task change to review\nAction: Edit',
  exact: { task: { action: 'update', account: 'me@example.com', list: 'Errands', task: 'Buy milk', changes: { title: { before: 'Buy milk', after: 'Buy oat milk' }, due_date: { before: null, after: '2026-10-12' } } } },
} as const;
const decision = { approval_id: 'p0001', action: 'approve', expected_digest: digest, request_id: 'decision-0001' } as const;
const result = { request_id: 'decision-0001', receipt: { state: 'rejected', message: 'That proposal changed. Review the new version.' }, duplicate: false, approval_state: 'superseded' } as const;

describe('appApprovalV1', () => {
  it('accepts one open approval of every kind with the exact block that kind needs', () => {
    for (const approval of [email, calendar, message, browser, mcp, task]) expect(appApprovalV1Schema.safeParse(approval).success).toBe(true);
  });

  it('requires recipients for sends, changes for calendar and scope for browser and MCP actions', () => {
    const recipients = { to: ['sam@example.com'], cc: [], bcc: [] };
    expect(appApprovalV1Schema.safeParse({ ...email, exact: { scope: 'me@example.com' } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...message, exact: { scope: 'whatsapp' } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, exact: { recipients: { to: [], cc: ['x@example.com'], bcc: [] } } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...calendar, exact: { scope: 'me@example.com' } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...browser, exact: { recipients } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...mcp, exact: { changes: calendar.exact.changes } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...mcp, exact: {} }).success).toBe(false);
  });

  it('maps every desk ledger status to one state, with no state implying an effect landed before it did', () => {
    expect(appApprovalStateV1Schema.options).toEqual([
      'unconfirmed', 'open', 'review_only', 'edit_requested', 'skipped', 'expired', 'superseded', 'done', 'not_done', 'outcome_unknown', 'undone',
    ]);
  });

  it('offers decisions only where the desk accepts them', () => {
    expect(appApprovalV1Schema.safeParse({ ...email, state: 'review_only', actions: ['skip'] }).success).toBe(true);
    expect(appApprovalV1Schema.safeParse({ ...calendar, state: 'done', actions: ['undo'] }).success).toBe(true);
    expect(appApprovalV1Schema.safeParse({ ...email, state: 'outcome_unknown', actions: [] }).success).toBe(true);
    expect(appApprovalV1Schema.safeParse({ ...email, state: 'review_only', actions: ['approve', 'skip'] }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, state: 'superseded' }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, state: 'outcome_unknown', actions: ['approve'] }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, state: 'open', actions: ['undo'] }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, actions: ['skip', 'skip'] }).success).toBe(false);
  });

  it('expires_at is epoch milliseconds: a seconds value or a fraction fails', () => {
    expect(appApprovalV1Schema.safeParse({ ...email, expires_at: Math.floor(expiresAtMs / 1000) }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, expires_at: expiresAtMs + 0.5 }).success).toBe(false);
  });

  it('rejects merged recipients, raw arguments, free-text times and unknown keys', () => {
    expect(appApprovalV1Schema.safeParse({ ...email, exact: { recipients: ['sam@example.com'] } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, exact: { ...email.exact, args: { query: 'x' } } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...calendar, exact: { changes: { ...calendar.exact.changes, start: 'Friday 4pm' } } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, raw: 'MIME' }).success).toBe(false);
  });

  it('a Google task change shows the task block with only changed fields, and never provider ids', () => {
    expect(appApprovalV1Schema.safeParse(task).success).toBe(true);
    const created = { action: 'create', account: 'me@example.com', list: 'Errands', task: null, changes: { title: { before: null, after: 'Call Sam' }, notes: { before: null, after: 'About Friday' } } };
    expect(appApprovalV1Schema.safeParse({ ...task, exact: { task: created } }).success).toBe(true);
    expect(appApprovalV1Schema.safeParse({ ...task, exact: { task: { ...task.exact.task, changes: { status: { before: 'todo', after: 'done' } }, action: 'complete' } } }).success).toBe(true);
    expect(appApprovalV1Schema.safeParse({ ...task, exact: { scope: 'Errands' } }).success).toBe(false);
    for (const leak of [{ task_id: 't1' }, { etag: '"e1"' }, { connection_id: 'c1' }, { task_list_id: 'l1' }])
      expect(appApprovalV1Schema.safeParse({ ...task, exact: { task: { ...task.exact.task, ...leak } } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...task, exact: { task: { ...task.exact.task, changes: { title: { before: 'a', after: 'b', id: 't1' } } } } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...task, exact: { task: { ...task.exact.task, action: 'delete' } } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...task, exact: { task: { ...task.exact.task, account: 'not-an-address' } } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...task, exact: { task: { ...task.exact.task, changes: { due_date: { before: null, after: 'Friday' } } } } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...task, exact: { task: { ...task.exact.task, changes: { due_date: { before: '2026-10-12', after: null } } } } }).success).toBe(true);
    expect(appApprovalV1Schema.safeParse({ ...task, exact: { task: { ...task.exact.task, changes: { notes: { before: 'Oat, not dairy', after: null } } } } }).success).toBe(true);
    expect(appApprovalV1Schema.safeParse({ ...task, exact: { task: { ...task.exact.task, changes: { title: { before: 'Buy milk', after: null } } } } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...task, exact: { task: { ...task.exact.task, changes: { notes: { before: null, after: 'x'.repeat(8193) } } } } }).success).toBe(false);
    const { approval_id, kind, review, payload_digest, expires_at } = task;
    expect(replyApprovalPartV1Schema.safeParse({ type: 'approval', approval_id, kind, review, payload_digest, expires_at, actions: ['approve', 'edit', 'skip'], fallback_text: review }).success).toBe(true);
  });

  it('rejects unknown kinds and surfaces, bare digests and blank reviews', () => {
    expect(appApprovalV1Schema.safeParse({ ...email, kind: 'task_sources' }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, presented_surfaces: ['sms'] }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, presented_surfaces: ['app', 'app'] }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, payload_digest: 'a'.repeat(64) }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, review: ' ' }).success).toBe(false);
    const { presented_surfaces: _surfaces, ...unpresented } = email;
    expect(appApprovalV1Schema.safeParse(unpresented).success).toBe(true);
  });

  it('lists approvals in a bounded strict envelope, filterable by one state', () => {
    expect(appApprovalListV1Schema.safeParse({ approvals: [email, calendar] }).success).toBe(true);
    expect(appApprovalListV1Schema.safeParse({ approvals: [] }).success).toBe(true);
    expect(appApprovalListV1Schema.safeParse({ approvals: Array.from({ length: 101 }, () => email) }).success).toBe(false);
    expect(appApprovalListV1Schema.safeParse({ approvals: [], next_cursor: null }).success).toBe(false);
    expect(appApprovalListQueryV1Schema.safeParse({}).success).toBe(true);
    expect(appApprovalListQueryV1Schema.safeParse({ state: 'open' }).success).toBe(true);
    expect(appApprovalListQueryV1Schema.safeParse({ state: 'approved' }).success).toBe(false);
    expect(appApprovalListQueryV1Schema.safeParse({ state: 'open,done' }).success).toBe(false);
    expect(appApprovalListQueryV1Schema.safeParse({ state: 'open', limit: '5' }).success).toBe(false);
  });
});

describe('approval decisions', () => {
  it('decides against the exact digest with the /actions request id field', () => {
    expect(appApprovalDecisionV1Schema.shape.request_id).toBe(appControlRequestIdV1Schema);
    expect(appApprovalDecisionV1Schema.shape.expected_digest).toBe(payloadDigestV1Schema);
    for (const action of ['approve', 'skip', 'edit', 'undo']) expect(appApprovalDecisionV1Schema.safeParse({ ...decision, action }).success).toBe(true);
    expect(appApprovalDecisionV1Schema.safeParse({ ...decision, action: 'deny' }).success).toBe(false);
    expect(appApprovalDecisionV1Schema.safeParse({ ...decision, expected_digest: undefined }).success).toBe(false);
    expect(appApprovalDecisionV1Schema.safeParse({ ...decision, request_id: 'short' }).success).toBe(false);
    const { request_id, ...unnamed } = decision;
    expect(appApprovalDecisionV1Schema.safeParse({ ...unnamed, client_request_id: request_id }).success).toBe(false);
    expect(appApprovalDecisionV1Schema.safeParse({ ...decision, surface: 'app' }).success).toBe(false);
  });

  it('returns the /actions receipt unchanged and carries superseded in a new field', () => {
    expect(appApprovalDecisionResultV1Schema.shape.receipt).toBe(appControlReceiptV1Schema);
    expect(appApprovalDecisionResultV1Schema.safeParse(result).success).toBe(true);
    expect(appApprovalDecisionResultV1Schema.safeParse({ ...result, receipt: { state: 'recorded', message: 'Moved.' }, approval_state: 'done' }).success).toBe(true);
    expect(appApprovalDecisionResultV1Schema.safeParse({ ...result, receipt: { state: 'superseded', message: 'x' } }).success).toBe(false);
    const { approval_state: _state, ...bare } = result;
    expect(appApprovalDecisionResultV1Schema.safeParse(bare).success).toBe(false);
    expect(appApprovalDecisionResultV1Schema.safeParse({ ...result, effect_id: 'e1' }).success).toBe(false);
  });

  it('publishes the list route with its state query and the decision route', () => {
    expect(appApprovalRoutesV1.map(route => `${route.method} ${route.path}`)).toEqual(['GET /app/v1/approvals', 'POST /app/v1/approvals/decisions']);
    expect(appApprovalRoutesV1[0].query).toBe(appApprovalListQueryV1Schema);
  });
});
