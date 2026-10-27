import { z } from 'zod';
import { appControlRequestIdV1Schema, appControlResultV1Schema } from './controls';
import { approvalIdV1Schema, epochMsV1Schema, opaqueRefV1Schema } from './parts';
import { surfaceNameV1Schema } from './surfaces';

// The owner's autonomy opt-in, its own contract (`x-waldo-app-contract: autonomy=1`): a build that does not declare it
// gets 404 from these routes. Autonomy is the set of standing grants the owner holds plus one pause; there is no
// separate mode or level, so the settings view is a projection of grant rows and nothing else can authorize an effect.
export const APP_AUTONOMY_CONTRACT_REVISION = 1;
// Every class Waldo will offer is named now, so turning one on later never puts a new enum value in front of an
// installed build; a class the server cannot run yet reads `not_yet`.
export const autonomyClassV1Schema = z.enum([
  'calendar.move_own_block', 'followup.close_on_reply', 'backlog.add_inferred', 'message.send_to_named', 'errand.run_on_site',
]);
export type AutonomyClassV1 = z.infer<typeof autonomyClassV1Schema>;

const visibleText = (max: number) => z.string().max(max).regex(/\S/);
const distinct = (values: readonly unknown[]) => new Set(values).size === values.length;
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const grantId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const localTime = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
// What the owner wants a grant used for, in their words. The model judges whether an action serves it; the host
// enforces only the resource, parameter, time and budget bounds beside it.
const purpose = visibleText(200).regex(/^[^\n\r\u2028\u2029]*$/);
const DAY_MS = 86_400_000;
export const AUTONOMY_GRANT_MAX_DAYS = 90;

// Waldo's own focus blocks on the owner's primary calendar: times only, the same local day, the duration unchanged.
const moveOwnBlock = z.strictObject({
  class: z.literal('calendar.move_own_block'), account: z.email(),
  window: z.strictObject({ from: localTime, to: localTime }).refine(({ from, to }) => from < to, 'the window ends after it starts'),
  weekdays: z.array(z.int().min(0).max(6)).min(1).max(7).refine(distinct, 'weekdays repeat'),
  min_lead_minutes: z.int().min(5).max(240),
});
// Waldo-held follow-ups only, closed on a reply in the watched thread; the owner's own items keep owner closure.
const closeOnReply = z.strictObject({ class: z.literal('followup.close_on_reply') });
// Inferred backlog items open without a candidate step, except from a turn that read outside text.
const addInferred = z.strictObject({ class: z.literal('backlog.add_inferred') });
// Sends as the owner reach only the named recipients on the named account. Email addresses or Slack channel names.
const sendToNamed = z.strictObject({
  class: z.literal('message.send_to_named'), channel: z.enum(['email', 'slack']), account: visibleText(254),
  recipients: z.array(visibleText(320)).min(1).max(20).refine(distinct, 'recipients repeat'), purpose,
});
const origin = z.string().max(253).regex(/^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/);
// Spending is in minor units of one currency; null means the errand may not spend at all.
const spend = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/), per_action_minor: z.int().min(1), per_30_days_minor: z.int().min(1),
}).refine(({ per_action_minor, per_30_days_minor }) => per_action_minor <= per_30_days_minor, 'one action cannot exceed the 30-day budget');
const runOnSite = z.strictObject({
  class: z.literal('errand.run_on_site'), sites: z.array(origin).min(1).max(5).refine(distinct, 'sites repeat'), purpose, spend: spend.nullable(),
});
export const autonomyGrantScopeV1Schema = z.discriminatedUnion('class', [moveOwnBlock, closeOnReply, addInferred, sendToNamed, runOnSite]);

// What the owner agrees to, as one card or one settings confirmation shows it. The same terms are approvals revision 5's
// `standing_grant` review, so a grant approved in chat and one set in settings are the same thing.
export const appAutonomyGrantTermsV1Schema = z.strictObject({
  scope: autonomyGrantScopeV1Schema,
  limits: z.strictObject({ max_per_day: z.int().min(1).max(20), timezone: z.string().min(1).max(64) }),
  valid_from: epochMsV1Schema, expires_at: epochMsV1Schema,
}).refine(({ valid_from, expires_at }) => expires_at > valid_from && expires_at - valid_from <= AUTONOMY_GRANT_MAX_DAYS * DAY_MS,
  { error: 'a grant ends after it starts and lasts at most 90 days', path: ['expires_at'] });
export const appAutonomyGrantV1Schema = z.strictObject({
  grant_id: grantId, revision: z.int().positive(), terms: appAutonomyGrantTermsV1Schema,
  created_at: epochMsV1Schema, created_via: surfaceNameV1Schema, uses_today: z.int().nonnegative(),
});

// `step_up` says turning the class on needs a recent sign-in: every class that reaches other people or spends does.
// A paused owner keeps their grants and none of them authorizes anything until resumed.
export const appAutonomyV1Schema = z.strictObject({
  version: z.literal(1), revision,
  paused: z.strictObject({ at: epochMsV1Schema, via: surfaceNameV1Schema }).nullable(),
  classes: z.array(z.strictObject({
    class: autonomyClassV1Schema, availability: z.enum(['available', 'not_yet']), step_up: z.boolean(),
    grants: z.array(appAutonomyGrantV1Schema).max(10),
  })).max(autonomyClassV1Schema.options.length),
}).refine(({ classes }) => distinct(classes.map(entry => entry.class)), { error: 'classes repeat', path: ['classes'] })
  .refine(({ classes }) => classes.every(entry => entry.grants.every(grant => grant.terms.scope.class === entry.class)),
    { error: 'a grant sits under its own class', path: ['classes'] })
  .refine(({ classes }) => classes.every(entry => entry.availability === 'available' || entry.grants.length === 0),
    { error: 'a class not yet available holds no grants', path: ['classes'] });

// Narrowing authority (revoke, pause) always applies to the current state. Widening it (grant, resume) names the
// revision the owner reviewed, so a change made elsewhere in the meantime is refused instead of silently extended.
export const appAutonomyChangeV1Schema = z.strictObject({
  request_id: appControlRequestIdV1Schema, expected_revision: revision.optional(),
  change: z.discriminatedUnion('op', [
    z.strictObject({ op: z.literal('grant'), terms: appAutonomyGrantTermsV1Schema }),
    z.strictObject({ op: z.literal('revoke'), grant_id: grantId }),
    z.strictObject({ op: z.literal('pause') }),
    z.strictObject({ op: z.literal('resume') }),
  ]),
}).refine(({ change, expected_revision }) => (change.op === 'grant' || change.op === 'resume') === (expected_revision !== undefined),
  { error: 'grant and resume name the reviewed revision; revoke and pause do not', path: ['expected_revision'] });
export const appAutonomyChangeResultV1Schema = appControlResultV1Schema.extend({ revision });

// "What Waldo did for you": one row per effect Waldo ran, keyed by its effect-ledger operation. `done` needs evidence the
// provider returned or a readback confirmed; an effect whose outcome is not known reads `outcome_unknown`, never done.
// `sending` is a send still inside its hold, which undo cancels before anything leaves.
export const appAutonomyReceiptStateV1Schema = z.enum(['sending', 'done', 'not_done', 'outcome_unknown', 'undone']);
export const appAutonomyReceiptV1Schema = z.strictObject({
  receipt_id: opaqueRefV1Schema, at: epochMsV1Schema, state: appAutonomyReceiptStateV1Schema,
  // Built by the host from the effect's own fields, never the model's reason for it.
  summary: visibleText(300),
  authority: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('standing_grant'), class: autonomyClassV1Schema, grant_id: grantId, grant_revision: z.int().positive() }),
    z.strictObject({ kind: z.literal('your_yes'), approval_id: approvalIdV1Schema }),
  ]),
  evidence: z.enum(['provider_receipt', 'readback', 'none']),
  undo_until: epochMsV1Schema.nullable(),
}).refine(({ state, evidence }) => (state === 'done') === (evidence !== 'none') || state === 'undone',
  { error: 'done carries evidence and nothing else claims it', path: ['evidence'] })
  .refine(({ state, undo_until }) => undo_until === null || state === 'done' || state === 'sending',
    { error: 'only a done or held effect offers undo', path: ['undo_until'] })
  .refine(({ state, undo_until }) => state !== 'sending' || undo_until !== null, { error: 'a held send offers undo until it leaves', path: ['undo_until'] });
const cursor = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/);
export const APP_AUTONOMY_RECEIPTS_PAGE_MAX = 50;
export const appAutonomyReceiptsQueryV1Schema = z.strictObject({
  before: cursor.optional(),
  limit: z.string().regex(/^[0-9]{1,2}$/).refine(value => Number(value) >= 1 && Number(value) <= APP_AUTONOMY_RECEIPTS_PAGE_MAX).optional(),
});
// Newest first. A build that ignores next_cursor still sees a bounded, ordered first page.
export const appAutonomyReceiptsV1Schema = z.strictObject({
  receipts: z.array(appAutonomyReceiptV1Schema).max(APP_AUTONOMY_RECEIPTS_PAGE_MAX), next_cursor: cursor.nullable(),
});
export const appAutonomyUndoV1Schema = z.strictObject({ request_id: appControlRequestIdV1Schema, receipt_id: opaqueRefV1Schema });
export const appAutonomyUndoResultV1Schema = appControlResultV1Schema.extend({ receipt_state: appAutonomyReceiptStateV1Schema });

export const appAutonomyRoutesV1 = [
  { method: 'GET', path: '/app/v1/autonomy', response: appAutonomyV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/autonomy/changes', request: appAutonomyChangeV1Schema, response: appAutonomyChangeResultV1Schema, authenticated: true, success_status: 200 },
  { method: 'GET', path: '/app/v1/autonomy/receipts', query: appAutonomyReceiptsQueryV1Schema, response: appAutonomyReceiptsV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/autonomy/undo', request: appAutonomyUndoV1Schema, response: appAutonomyUndoResultV1Schema, authenticated: true, success_status: 200 },
] as const;

export type AppAutonomyV1 = z.infer<typeof appAutonomyV1Schema>;
export type AppAutonomyGrantTermsV1 = z.infer<typeof appAutonomyGrantTermsV1Schema>;
export type AppAutonomyChangeV1 = z.infer<typeof appAutonomyChangeV1Schema>;
export type AppAutonomyReceiptV1 = z.infer<typeof appAutonomyReceiptV1Schema>;
