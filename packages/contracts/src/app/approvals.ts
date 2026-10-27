import { z } from 'zod';
import { appControlRequestIdV1Schema, appControlResultV1Schema } from './controls';
import {
  approvalActionV1Schema, approvalIdV1Schema, approvalKindV1Schema, approvalLabelsV1Schema, approvalQuestionV1Schema, approvalReviewV1Schema,
  epochMsV1Schema, labelsOfferedActions, payloadDigestV1Schema, REPLY_TEXT_MAX_CHARS, type ApprovalActionV1, type ApprovalKindV1,
} from './parts';
import { surfaceNameV1Schema } from './surfaces';

// One state per desk ledger status. Approval is not an outcome: an approved effect reads done,
// not_done or outcome_unknown, and an approval claimed before its effect resolves reads outcome_unknown.
export const appApprovalStateV1Schema = z.enum([
  'unconfirmed', 'open', 'review_only', 'edit_requested', 'skipped', 'expired', 'superseded', 'done', 'not_done', 'outcome_unknown', 'undone',
]);
export type AppApprovalStateV1 = z.infer<typeof appApprovalStateV1Schema>;
// Deferring is desk state, so every surface sees it: the approval stays open (it can still expire), the
// default list leaves it out until Waldo raises it again, and the decision is recorded with approval_state open.
const DECISIONS_BY_STATE: Readonly<Partial<Record<AppApprovalStateV1, readonly ApprovalActionV1[]>>> = {
  open: ['approve', 'edit', 'skip', 'defer'], review_only: ['skip', 'defer'], done: ['undo'],
};

const addresses = z.array(z.string().min(1).max(320)).max(100);
const taskText = z.string().max(2000);
const change = <T extends z.ZodType>(value: T) => z.strictObject({ before: value.nullable(), after: value });
// Only the fields the change touches, as the desk review shows them; no task, list or connection ids.
export const appApprovalTaskExactV1Schema = z.strictObject({
  action: z.enum(['create', 'update', 'complete', 'reopen']), account: z.email(), list: taskText, task: taskText.nullable(),
  changes: z.strictObject({
    title: change(taskText).optional(),
    notes: z.strictObject({ before: z.string().max(100_000).nullable(), after: z.string().max(8192).nullable() }).optional(),
    due_date: z.strictObject({ before: z.iso.date().nullable(), after: z.iso.date().nullable() }).optional(), status: change(z.enum(['todo', 'done'])).optional(),
  }),
});
// Derived from the frozen desk payload, exposing no more than the desk review does: never raw MIME,
// tokens, browser bindings or MCP arguments. Bindings and arguments appear only in `review`, with
// credential values masked; a browser scope is the page without its query string or fragment.
const instant = z.iso.datetime({ offset: true });
// The calendar details are approvals revision 2, each present exactly when the review states it: the invited guests,
// whether Google emails the guests, the place, a calendar other than the primary one, the Google account, the event's
// time before a move, and the time zone the review's times are written in.
const CALENDAR_DETAILS = ['guests', 'emails_guests', 'location', 'calendar', 'account', 'previous', 'time_zone'] as const;
// The draft of a send is approvals revision 3: the frozen words that go out, byte for byte. An email's subject is its
// one header line, so it never breaks across lines; a message has no subject.
export const appApprovalMessageV1Schema = z.strictObject({
  subject: z.string().min(1).max(998).regex(/^[^\r\n]*$/).nullable(), body: z.string().min(1).max(REPLY_TEXT_MAX_CHARS),
});
export const appApprovalExactV1Schema = z.strictObject({
  recipients: z.strictObject({ to: addresses.min(1), cc: addresses, bcc: addresses }).optional(),
  message: appApprovalMessageV1Schema.optional(),
  changes: z.strictObject({
    action: z.enum(['create', 'move', 'cancel']), title: z.string().min(1).max(200).nullable(),
    start: instant.nullable(), end: instant.nullable(),
    guests: z.array(z.email()).min(1).max(50).optional(), emails_guests: z.boolean().optional(),
    location: z.string().min(1).max(300).optional(), calendar: z.string().min(1).max(254).optional(), account: z.email().optional(),
    previous: z.strictObject({ start: instant, end: instant }).optional(), time_zone: z.string().min(1).max(64).optional(),
  }).optional(),
  scope: z.string().min(1).max(2048).optional(),
  task: appApprovalTaskExactV1Schema.optional(),
});
// What each kind must show before it can be decided: who receives a send, what a calendar change
// does, where a browser or MCP action lands, and which task fields change.
const EXACT_BY_KIND = {
  email_send: 'recipients', message_send: 'recipients', calendar_change: 'changes', browser_submit: 'scope', mcp_call: 'scope', google_task_change: 'task', tainted_action: 'scope',
} as const satisfies Readonly<Record<ApprovalKindV1, keyof z.infer<typeof appApprovalExactV1Schema>>>;

// An approval the health trigger raised carries the model's one-line reason for it, approvals revision 4. Only the
// reason is in it, never a reading or a zone of its own: the bound is the longest a proposal's reason can be.
export const appApprovalHealthV1Schema = z.strictObject({ reason: z.string().min(1).max(300) });

export const appApprovalV1Schema = z.strictObject({
  approval_id: approvalIdV1Schema, kind: approvalKindV1Schema, state: appApprovalStateV1Schema,
  review: approvalReviewV1Schema, exact: appApprovalExactV1Schema,
  payload_digest: payloadDigestV1Schema, expires_at: epochMsV1Schema,
  actions: z.array(approvalActionV1Schema).max(4),
  presented_surfaces: z.array(surfaceNameV1Schema).max(surfaceNameV1Schema.options.length)
    .refine(surfaces => new Set(surfaces).size === surfaces.length, 'surfaces repeat').optional(),
  // undo_until is when the undo on offer closes, so the app can count it down; it comes only while undo is offered.
  question: approvalQuestionV1Schema.optional(), labels: approvalLabelsV1Schema.optional(), undo_until: epochMsV1Schema.optional(),
  health: appApprovalHealthV1Schema.optional(),
}).refine(approval => approval.exact[EXACT_BY_KIND[approval.kind]] !== undefined, { error: 'exact must name what this kind changes', path: ['exact'] })
  .refine(({ kind, exact: { message } }) => message === undefined || (kind === 'email_send' ? message.subject !== null : kind === 'message_send' && message.subject === null),
    { error: 'a draft belongs to a send: an email with its subject, a message without one', path: ['exact', 'message'] })
  .refine(labelsOfferedActions, { error: 'labels name only actions offered', path: ['labels'] })
  .refine(approval => approval.undo_until === undefined || approval.actions.includes('undo'), { error: 'undo_until needs undo offered', path: ['undo_until'] })
  .refine(approval => new Set(approval.actions).size === approval.actions.length
    && approval.actions.every(action => DECISIONS_BY_STATE[approval.state]?.includes(action)), { error: 'actions must be decisions the desk accepts in this state', path: ['actions'] });
export const APP_APPROVALS_CONTRACT_REVISION = 4;
// An approval as a build reading `revision` parses it: revision 3 is the shape before the health origin, revision 2 the
// shape before the draft of a send, and revision 1 the shape before the calendar details too. An approval a revision
// leaves whole is returned as it is.
export const appApprovalAtRevision = (approval: AppApprovalV1, revision: number): AppApprovalV1 => {
  const { health, ...withoutHealth } = approval;
  const whole = revision < 4 && health !== undefined ? withoutHealth : approval;
  const { message, ...withoutMessage } = whole.exact;
  const exact = revision < 3 && message !== undefined ? withoutMessage : whole.exact;
  const changes = exact.changes;
  if (revision < 2 && changes) {
    const first = Object.fromEntries(Object.entries(changes).filter(([key]) => !(CALENDAR_DETAILS as readonly string[]).includes(key))) as typeof changes;
    return { ...whole, exact: { ...exact, changes: first } };
  }
  return exact === whole.exact ? whole : { ...whole, exact };
};
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
