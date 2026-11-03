import { z } from 'zod';
import { APP_WHY_STEPS_MAX_V1, appWhyLabelV1Schema, appWhySourceV1Schema, appWhyVerbV1Schema } from '../../app/why';

// An approval card Waldo raised for this owner, as the desk names it.
export const approvalRefSchema = z.string().regex(/^p[A-Za-z0-9-]{1,63}$/);

// Approvals the owner put off ("Not now") wait until Waldo raises them again, and Waldo may withdraw a card of its own that
// still waits on the owner. When is the model's judgment; the desk raises only an approval that is still put off, waiting and
// unexpired, and withdraws only one still waiting. Nothing here approves.
export const raiseApprovalArgsSchema = z.strictObject({
  operation: z.enum(['list', 'raise', 'withdraw']).describe('list: your cards waiting on the owner, with what each one shows. raise: show one they put off to them again. withdraw: close one of yours that is stale.'),
  approval_id: approvalRefSchema.optional().describe('The approval, from list. With raise and withdraw only.'),
  reason: z.string().min(1).max(200).regex(/^[^\r\n]*$/).optional().describe('withdraw only: why, in a few words the owner reads on the closed card.'),
}).refine(args => (args.operation === 'list') === (args.approval_id === undefined), { error: 'raise and withdraw need approval_id; list takes none', path: ['approval_id'] })
  .refine(args => (args.operation === 'withdraw') === (args.reason !== undefined), { error: 'withdraw needs a reason, and only withdraw takes one', path: ['reason'] });
export type RaiseApprovalArgs = z.infer<typeof raiseApprovalArgsSchema>;

// On a proposing tool: the earlier card of the owner's that this one is a revised version of. Raising the new card closes
// that one in the same write; whether two cards are the same action is the model's call.
export const replacesApprovalSchema = approvalRefSchema.optional()
  .describe('When this revises a card of yours still waiting on the owner: its approval_id (from raise_approval list). Showing this card closes that one.');

// On a proposing tool, while the trail is on: the steps that led to this card, shown under "Why this changed". The host keeps
// a step only when its source is something a read earlier in this turn returned, and takes the step's time from that read;
// it is never part of the change the owner approves. Which steps matter and how to word them is the model's call.
export const whyStepArgSchema = z.strictObject({
  verb: appWhyVerbV1Schema.describe('read, checked, found, prepared or watching'),
  label: appWhyLabelV1Schema.describe('One short line the owner reads, e.g. "Found the 3pm clash". For health, name the score, never a number.'),
  source: z.strictObject({
    kind: appWhySourceV1Schema,
    ref: z.string().min(1).max(256).describe('What you read: the event id, the thread id or the memory node id from that read; for calendar_free_busy the calendar id; for health_score the score or signal name (recovery, form, load, sleep, hrv...).'),
  }),
});
export const whyArgSchema = z.array(whyStepArgSchema).min(1).max(APP_WHY_STEPS_MAX_V1)
  .describe('Optional. Up to 8 steps behind this card, each tied to something you read this turn. A step naming nothing you read is dropped.');
export type WhyStepArg = z.infer<typeof whyStepArgSchema>;
