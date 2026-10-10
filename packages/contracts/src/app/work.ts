import { z } from 'zod';
import { appApprovalReviewV1Schema } from './controls';
import { appArtifactV1Schema, appFileV1Schema } from './artifacts';

export const APP_WORK_MAX_REQUEST_BYTES = 32768;
export const appWorkRefV1Schema = z.string().regex(/^(responsibility|work_unit|run):[A-Za-z0-9_.:-]{1,160}$/);
export const appWorkOperationIdV1Schema = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.int().nonnegative();
export const appWorkControlV1Schema = z.strictObject({
  state: z.enum(['active', 'paused', 'stopped', 'unavailable']), revision: z.int().nonnegative(),
  allowed: z.array(z.enum(['pause', 'resume', 'stop', 'reconcile'])), unresolved_effects: z.int().nonnegative(),
});
export const appWorkItemV1Schema = z.strictObject({
  id: z.string(), title: z.string(), owner: z.string(), status: z.enum(['pending', 'running', 'blocked', 'done', 'failed', 'cancelled']),
  revision: z.int().positive(), depends_on: z.array(z.string()), result_ref: z.string().nullable(),
  superseded_result: z.string().nullable(), updated_at: timestamp,
});
export const appWorkTaskV1Schema = z.strictObject({
  work_ref: appWorkRefV1Schema, kind: z.enum(['responsibility', 'work_unit', 'run']), source_ref: z.string(),
  title: z.string(), intent: z.string().nullable(), status: z.string().min(1), revision: z.int().nonnegative().nullable(),
  account: z.string().nullable(), grant_ref: z.string().nullable(), outcome_ref: z.string().nullable(), parent_ref: z.string().nullable(),
  created_at: timestamp.nullable(), updated_at: timestamp.nullable(), closed_at: timestamp.nullable(),
  closure_evidence_ref: z.string().nullable(), items: z.array(appWorkItemV1Schema), controls: appWorkControlV1Schema,
});
export const appWorkEffectV1Schema = z.strictObject({
  operation_ref: z.string(), tool: z.string(), state: z.enum(['reserved', 'attempting', 'unknown', 'done', 'rejected']),
  created_at: timestamp, provider_ref: z.string().nullable(), payload_digest: digest,
});
export const appWorkApprovalV1Schema = z.strictObject({
  id: z.string(), kind: z.string(), summary: z.string(), state: z.enum(['open', 'done', 'unconfirmed', 'review_only']),
  undoable: z.boolean(), review: appApprovalReviewV1Schema.nullable(), proposal_digest: digest.nullable(),
  operation_ref: z.string().nullable(), actions: z.array(z.enum(['approve', 'deny', 'edit', 'undo'])),
});
export const appWorkFileV1Schema = z.union([appFileV1Schema, appArtifactV1Schema]);
export const appWorkListQueryV1Schema = z.strictObject({
  kind: z.enum(['responsibility', 'work_unit', 'run']).optional(), limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: appWorkRefV1Schema.optional(),
});
const envelope = { version: z.literal('work.v1'), account_ref: z.string().regex(/^acct_[a-f0-9]{64}$/), source_revision: z.int().nonnegative(), revision: digest, observed_at: timestamp };
export const appWorkCountsV1Schema = z.strictObject({
  scope: z.literal('retained_owner_records'), total: z.int().nonnegative(),
  by_kind: z.strictObject({ responsibility: z.int().nonnegative(), work_unit: z.int().nonnegative(), run: z.int().nonnegative() }),
  by_status: z.array(z.strictObject({ kind: z.enum(['responsibility', 'work_unit', 'run']), status: z.string().min(1), count: z.int().positive() })),
});
export const appWorkProjectionV1Schema = z.strictObject({
  ...envelope, counts: appWorkCountsV1Schema, tasks: z.array(appWorkTaskV1Schema), approvals: z.array(appWorkApprovalV1Schema),
  effects: z.array(appWorkEffectV1Schema), files: z.array(appWorkFileV1Schema), next_cursor: appWorkRefV1Schema.nullable(),
});
export const appWorkDetailV1Schema = z.strictObject({ ...envelope, task: appWorkTaskV1Schema });
export const appWorkIntentV1Schema = z.strictObject({
  operation_id: appWorkOperationIdV1Schema, work_ref: appWorkRefV1Schema,
  action: z.enum(['pause', 'resume', 'stop', 'reconcile']), expected_revision: z.int().nonnegative(),
  expected_source_revision: z.int().nonnegative(), projection_revision: digest,
});
export const appWorkApprovalIntentV1Schema = z.strictObject({
  operation_id: appWorkOperationIdV1Schema, approval_id: z.string().min(1).max(160), action: z.enum(['approve', 'deny', 'edit', 'undo']),
  proposal_digest: digest, expected_source_revision: z.int().nonnegative(), projection_revision: digest,
});
export const appWorkHandoffIdentityV1Schema = z.strictObject({
  session_handle: z.string().min(1).max(256), generation: z.int().positive(), handoff_id: z.string().min(1).max(256),
});
export const appWorkBrowserStateV1Schema = z.strictObject({
  version: z.literal('work.v1'), state: z.enum(['waiting_for_owner', 'none_recorded']), revision: digest,
  handoff: appWorkHandoffIdentityV1Schema.extend({ origin: z.url(), reason: z.string(), expires_at: timestamp }).nullable(),
});
export const appWorkBrowserIntentV1Schema = z.strictObject({
  operation_id: appWorkOperationIdV1Schema, expected: appWorkHandoffIdentityV1Schema, revision: digest,
});
export const appWorkReceiptV1Schema = z.strictObject({
  version: z.literal('work.v1'), operation_id: appWorkOperationIdV1Schema, target_ref: z.string(),
  action: z.enum(['pause', 'resume', 'stop', 'reconcile', 'approve', 'deny', 'edit', 'undo', 'browser.open', 'browser.resume', 'browser.revoke']),
  state: z.enum(['recorded', 'rejected', 'unconfirmed']), recorded_at: timestamp,
  revision: z.int().nonnegative().nullable(), cancellation: z.enum(['not_requested', 'fenced', 'unconfirmed']),
  external_effects: z.enum(['none_recorded', 'unresolved', 'verified']), message: z.string(),
  evidence_refs: z.array(z.string()),
});
export const appWorkOperationResultV1Schema = z.strictObject({
  receipt: appWorkReceiptV1Schema, duplicate: z.boolean(),
  handoff: z.strictObject({ url: z.url(), origin: z.url(), expires_at: timestamp }).nullable(),
});
export const appWorkRoutesV1 = [
  { method: 'GET', path: '/app/v1/work', query: appWorkListQueryV1Schema, response: appWorkProjectionV1Schema },
  { method: 'GET', path: '/app/v1/work/tasks/{work_ref}', response: appWorkDetailV1Schema },
  { method: 'POST', path: '/app/v1/work/operations', request: appWorkIntentV1Schema, response: appWorkOperationResultV1Schema, max_request_bytes: APP_WORK_MAX_REQUEST_BYTES },
  { method: 'POST', path: '/app/v1/work/approvals', request: appWorkApprovalIntentV1Schema, response: appWorkOperationResultV1Schema, max_request_bytes: APP_WORK_MAX_REQUEST_BYTES },
  { method: 'GET', path: '/app/v1/work/operations/{operation_id}', response: appWorkOperationResultV1Schema },
  { method: 'GET', path: '/app/v1/work/browser', response: appWorkBrowserStateV1Schema },
  { method: 'POST', path: '/app/v1/work/browser/open', request: appWorkBrowserIntentV1Schema, response: appWorkOperationResultV1Schema, max_request_bytes: APP_WORK_MAX_REQUEST_BYTES },
  { method: 'POST', path: '/app/v1/work/browser/resume', request: appWorkBrowserIntentV1Schema, response: appWorkOperationResultV1Schema, max_request_bytes: APP_WORK_MAX_REQUEST_BYTES },
  { method: 'POST', path: '/app/v1/work/browser/revoke', request: appWorkBrowserIntentV1Schema, response: appWorkOperationResultV1Schema, max_request_bytes: APP_WORK_MAX_REQUEST_BYTES },
] as const;

export type AppWorkTaskV1 = z.infer<typeof appWorkTaskV1Schema>;
export type AppWorkControlV1 = z.infer<typeof appWorkControlV1Schema>;
export type AppWorkApprovalV1 = z.infer<typeof appWorkApprovalV1Schema>;
export type AppWorkFileV1 = z.infer<typeof appWorkFileV1Schema>;
export type AppWorkIntentV1 = z.infer<typeof appWorkIntentV1Schema>;
export type AppWorkApprovalIntentV1 = z.infer<typeof appWorkApprovalIntentV1Schema>;
export type AppWorkBrowserIntentV1 = z.infer<typeof appWorkBrowserIntentV1Schema>;
export type AppWorkReceiptV1 = z.infer<typeof appWorkReceiptV1Schema>;
export type AppWorkOperationResultV1 = z.infer<typeof appWorkOperationResultV1Schema>;
export type AppWorkProjectionV1 = z.infer<typeof appWorkProjectionV1Schema>;
