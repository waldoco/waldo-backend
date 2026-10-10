import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import {
  approvalActionV1Schema, approvalIdV1Schema, approvalKindV1Schema, payloadDigestV1Schema, REPLY_TEXT_MAX_CHARS,
  type ApprovalActionV1,
} from '../runtime/reply-parts';
import { surfaceNameV1Schema } from '../runtime/surface-capabilities';
import { appControlRequestIdV1Schema, appControlResultV1Schema } from './controls';

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
    start: iso8601Schema.nullable(), end: iso8601Schema.nullable(),
  }).optional(),
  scope: z.string().min(1).max(2048).optional(),
}).refine(exact => exact.recipients !== undefined || exact.changes !== undefined || exact.scope !== undefined, 'exact names recipients, changes or scope');

export const appApprovalV1Schema = z.strictObject({
  approval_id: approvalIdV1Schema, kind: approvalKindV1Schema, state: appApprovalStateV1Schema,
  review: z.string().max(REPLY_TEXT_MAX_CHARS).regex(/\S/), exact: appApprovalExactV1Schema,
  payload_digest: payloadDigestV1Schema, expires_at: z.int().nonnegative(),
  actions: z.array(approvalActionV1Schema).max(3),
  presented_surfaces: z.array(surfaceNameV1Schema).max(surfaceNameV1Schema.options.length)
    .refine(surfaces => new Set(surfaces).size === surfaces.length, 'surfaces repeat').optional(),
}).refine(approval => new Set(approval.actions).size === approval.actions.length
  && approval.actions.every(action => DECISIONS_BY_STATE[approval.state]?.includes(action)), { error: 'actions must be decisions the desk accepts in this state', path: ['actions'] });
export const appApprovalListV1Schema = z.strictObject({ approvals: z.array(appApprovalV1Schema).max(100) });

// Retrying with the same client_request_id returns the stored result marked duplicate.
export const appApprovalDecisionV1Schema = z.strictObject({
  approval_id: approvalIdV1Schema, action: approvalActionV1Schema,
  expected_digest: payloadDigestV1Schema, client_request_id: appControlRequestIdV1Schema,
});
// approval_state is the state of the version the client reviewed. A stale expected_digest records
// nothing: the receipt is rejected and approval_state is superseded.
export const appApprovalDecisionResultV1Schema = appControlResultV1Schema.extend({ approval_state: appApprovalStateV1Schema });

export const appApprovalRoutesV1 = [
  { method: 'GET', path: '/app/v1/approvals', response: appApprovalListV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/approvals/decisions', request: appApprovalDecisionV1Schema, response: appApprovalDecisionResultV1Schema, authenticated: true, success_status: 200 },
] as const;

export type AppApprovalV1 = z.infer<typeof appApprovalV1Schema>;
export type AppApprovalDecisionV1 = z.infer<typeof appApprovalDecisionV1Schema>;
export type AppApprovalDecisionResultV1 = z.infer<typeof appApprovalDecisionResultV1Schema>;
