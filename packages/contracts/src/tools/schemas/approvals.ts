import { z } from 'zod';

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

// The owner told Waldo, in their own message, to go ahead with one card they were shown in full in this conversation. Which
// card, and whether they said to go ahead, is the model's judgment; it names exactly one card and never a default. The desk
// approves only a card shown here before that message, unchanged since, in a turn that has read no outside text.
export const approveShownArgsSchema = z.strictObject({
  approval_id: approvalRefSchema.describe('The one card the owner told you to go ahead with, from its proposal or raise_approval list.'),
});
export type ApproveShownArgs = z.infer<typeof approveShownArgsSchema>;

// On a proposing tool: the earlier card of the owner's that this one is a revised version of. Raising the new card closes
// that one in the same write; whether two cards are the same action is the model's call.
export const replacesApprovalSchema = approvalRefSchema.optional()
  .describe('When this revises a card of yours still waiting on the owner: its approval_id (from raise_approval list). Showing this card closes that one.');
