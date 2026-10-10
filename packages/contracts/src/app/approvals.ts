import { z } from 'zod';
import { appControlRequestIdV1Schema, appControlResultV1Schema } from './controls';
import {
  approvalActionV1Schema, approvalIdV1Schema, approvalKindV1Schema, approvalReviewV1Schema, epochMsV1Schema, payloadDigestV1Schema,
  type ApprovalActionV1, type ApprovalKindV1,
} from './parts';
import { surfaceNameV1Schema } from './surfaces';

// One state per desk ledger status. Approval is not an outcome: an approved effect reads done,
// not_done or outcome_unknown, and an approval claimed before its effect resolves reads outcome_unknown.
export const appApprovalStateV1Schema = z.enum([
  'unconfirmed', 'open', 'review_only', 'edit_requested', 'skipped', 'expired', 'superseded', 'done', 'not_done', 'outcome_unknown', 'undone',
]);
export type AppApprovalStateV1 = z.infer<typeof appApprovalStateV1Schema>;
const DECISIONS_BY_STATE: Readonly<Partial<Record<AppApprovalStateV1, readonly ApprovalActionV1[]>>> = {
  open: ['approve', 'edit', 'skip'], review_only: ['skip'], done: ['undo'],
};

const addresses = z.array(z.string().min(1).max(320)).max(100);
// Derived from the frozen desk payload, exposing no more than the desk review does: never raw MIME,
// tokens, browser bindings or MCP arguments.
export const appApprovalExactV1Schema = z.strictObject({
  recipients: z.strictObject({ to: addresses.min(1), cc: addresses, bcc: addresses }).optional(),
  changes: z.strictObject({
    action: z.enum(['create', 'move', 'cancel']), title: z.string().min(1).max(200).nullable(),
    start: z.iso.datetime({ offset: true }).nullable(), end: z.iso.datetime({ offset: true }).nullable(),
  }).optional(),
  scope: z.string().min(1).max(2048).optional(),
});
// What each kind must show before it can be decided: who receives a send, what a calendar change
// does, and where a browser or MCP action lands.
const EXACT_BY_KIND = {
  email_send: 'recipients', message_send: 'recipients', calendar_change: 'changes', browser_submit: 'scope', mcp_call: 'scope',
} as const satisfies Readonly<Record<ApprovalKindV1, keyof z.infer<typeof appApprovalExactV1Schema>>>;

export const appApprovalV1Schema = z.strictObject({
  approval_id: approvalIdV1Schema, kind: approvalKindV1Schema, state: appApprovalStateV1Schema,
  review: approvalReviewV1Schema, exact: appApprovalExactV1Schema,
  payload_digest: payloadDigestV1Schema, expires_at: epochMsV1Schema,
  actions: z.array(approvalActionV1Schema).max(3),
  presented_surfaces: z.array(surfaceNameV1Schema).max(surfaceNameV1Schema.options.length)
    .refine(surfaces => new Set(surfaces).size === surfaces.length, 'surfaces repeat').optional(),
}).refine(approval => approval.exact[EXACT_BY_KIND[approval.kind]] !== undefined, { error: 'exact must name what this kind changes', path: ['exact'] })
  .refine(approval => new Set(approval.actions).size === approval.actions.length
    && approval.actions.every(action => DECISIONS_BY_STATE[approval.state]?.includes(action)), { error: 'actions must be decisions the desk accepts in this state', path: ['actions'] });
export const appApprovalListQueryV1Schema = z.strictObject({ state: appApprovalStateV1Schema.optional() });
export const appApprovalListV1Schema = z.strictObject({ approvals: z.array(appApprovalV1Schema).max(100) });

// Retrying with the same request_id returns the stored result marked duplicate.
export const appApprovalDecisionV1Schema = z.strictObject({
  approval_id: approvalIdV1Schema, action: approvalActionV1Schema,
  expected_digest: payloadDigestV1Schema, request_id: appControlRequestIdV1Schema,
});
// approval_state is the state of the version the client reviewed. A stale expected_digest records
// nothing: the receipt is rejected and approval_state is superseded.
export const appApprovalDecisionResultV1Schema = appControlResultV1Schema.extend({ approval_state: appApprovalStateV1Schema });

export const appApprovalRoutesV1 = [
  { method: 'GET', path: '/app/v1/approvals', query: appApprovalListQueryV1Schema, response: appApprovalListV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/approvals/decisions', request: appApprovalDecisionV1Schema, response: appApprovalDecisionResultV1Schema, authenticated: true, success_status: 200 },
] as const;

export type AppApprovalV1 = z.infer<typeof appApprovalV1Schema>;
export type AppApprovalDecisionV1 = z.infer<typeof appApprovalDecisionV1Schema>;
export type AppApprovalDecisionResultV1 = z.infer<typeof appApprovalDecisionResultV1Schema>;
