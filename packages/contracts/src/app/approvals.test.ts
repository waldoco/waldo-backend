import { describe, expect, it } from 'vitest';
import { payloadDigestV1Schema } from '../runtime/reply-parts';
import {
  appApprovalDecisionResultV1Schema,
  appApprovalDecisionV1Schema,
  appApprovalListV1Schema,
  appApprovalRoutesV1,
  appApprovalStateV1Schema,
  appApprovalV1Schema,
} from './approvals';
import { appControlReceiptV1Schema, appControlRequestIdV1Schema } from './controls';

const digest = `sha256:${'a'.repeat(64)}`;
const email = {
  approval_id: 'p0001', kind: 'email_send', state: 'open',
  review: 'From: me@example.com\nTo: sam@example.com\nSubject: Friday\n\nSee you at 4.',
  exact: { recipients: { to: ['sam@example.com'], cc: [], bcc: [] }, scope: 'me@example.com' },
  payload_digest: digest, expires_at: 1_760_000_000_000, actions: ['approve', 'edit', 'skip'], presented_surfaces: ['telegram', 'app'],
} as const;
const calendar = {
  ...email, approval_id: 'p0002', kind: 'calendar_change', review: 'Move "Design review" to Fri 16:00 to 17:00.',
  exact: { changes: { action: 'move', title: 'Design review', start: '2026-10-11T16:00:00+01:00', end: '2026-10-11T17:00:00+01:00' } },
} as const;
const decision = { approval_id: 'p0001', action: 'approve', expected_digest: digest, client_request_id: 'decision-0001' } as const;
const result = { request_id: 'decision-0001', receipt: { state: 'rejected', message: 'That proposal changed. Review the new version.' }, duplicate: false, approval_state: 'superseded' } as const;

describe('appApprovalV1', () => {
  it('accepts open email and calendar approvals with an exact block from the frozen payload', () => {
    expect(appApprovalV1Schema.safeParse(email).success).toBe(true);
    expect(appApprovalV1Schema.safeParse(calendar).success).toBe(true);
    expect(appApprovalV1Schema.safeParse({ ...email, kind: 'mcp_call', exact: { scope: 'lookup on the crm server' }, actions: ['approve', 'skip'] }).success).toBe(true);
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

  it('rejects an empty exact block, merged recipients, raw arguments and unknown keys', () => {
    expect(appApprovalV1Schema.safeParse({ ...email, exact: {} }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, exact: { recipients: ['sam@example.com'] } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, exact: { recipients: { to: [], cc: [], bcc: [] } } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, exact: { ...email.exact, args: { query: 'x' } } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...calendar, exact: { changes: { ...calendar.exact.changes, start: 'Friday 4pm' } } }).success).toBe(false);
    expect(appApprovalV1Schema.safeParse({ ...email, raw: 'MIME' }).success).toBe(false);
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

  it('lists approvals in a bounded strict envelope', () => {
    expect(appApprovalListV1Schema.safeParse({ approvals: [email, calendar] }).success).toBe(true);
    expect(appApprovalListV1Schema.safeParse({ approvals: [] }).success).toBe(true);
    expect(appApprovalListV1Schema.safeParse({ approvals: Array.from({ length: 101 }, () => email) }).success).toBe(false);
    expect(appApprovalListV1Schema.safeParse({ approvals: [], next_cursor: null }).success).toBe(false);
  });
});

describe('approval decisions', () => {
  it('decides against the exact digest with the /actions request id format', () => {
    expect(appApprovalDecisionV1Schema.shape.client_request_id).toBe(appControlRequestIdV1Schema);
    expect(appApprovalDecisionV1Schema.shape.expected_digest).toBe(payloadDigestV1Schema);
    for (const action of ['approve', 'skip', 'edit', 'undo']) expect(appApprovalDecisionV1Schema.safeParse({ ...decision, action }).success).toBe(true);
    expect(appApprovalDecisionV1Schema.safeParse({ ...decision, action: 'deny' }).success).toBe(false);
    expect(appApprovalDecisionV1Schema.safeParse({ ...decision, expected_digest: undefined }).success).toBe(false);
    expect(appApprovalDecisionV1Schema.safeParse({ ...decision, client_request_id: 'short' }).success).toBe(false);
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

  it('publishes the list and decision routes', () => {
    expect(appApprovalRoutesV1.map(route => `${route.method} ${route.path}`)).toEqual(['GET /app/v1/approvals', 'POST /app/v1/approvals/decisions']);
  });
});
