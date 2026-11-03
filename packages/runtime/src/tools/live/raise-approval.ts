import { raiseApprovalArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type RaiseApprovalArgs, type ToolHandler, type ToolName } from '@waldo/contracts';
import { turnReadOutside, type ApprovalDesk, type ReraiseOutcome, type WithdrawOutcome } from '../../channels/approvals';
import type { ToolDispatcherContext } from '../dispatcher';

const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));

// Fixed words for each outcome, so the model never tells the owner about a card they did not get.
const note = (result: ReraiseOutcome): string => {
  if (result.outcome !== 'raised') return {
    expired: 'It expired, so it was closed and not shown. If the owner still wants it, propose it again.',
    not_put_off: 'The owner has not put it off, so nothing was sent; its card is still waiting.',
    not_waiting: 'It is not waiting on the owner, so nothing was sent.',
    unshown: 'Its card was not confirmed as shown, so it is still put off. Tell the owner only that you could not bring it back.',
  }[result.outcome];
  if (result.on_this_reply) return 'Its card is on this reply.';
  return result.shown_on.some(surface => surface !== 'app') ? 'A fresh card with its buttons was sent to the owner.' : "It is back in the owner's approvals list; no card is on this reply.";
};
const SURFACE_NAMES: Readonly<Record<string, string>> = { whatsapp: 'WhatsApp', imessage: 'iMessage' };
const withdrawNote = (result: WithdrawOutcome): string => {
  if (result.outcome === 'not_found') return 'No card of yours has that id, so nothing changed.';
  if (result.outcome === 'not_waiting') return `It is no longer waiting on the owner (it is ${result.state}), so nothing changed.`;
  const kept = result.still_shown_on.map(surface => SURFACE_NAMES[surface] ?? surface);
  return `It is closed with your reason and can no longer be approved; nothing was sent or done.${kept.length ? ` Its message on ${kept.join(' and ')} cannot be changed, but a tap or reply on it now answers that you withdrew it.` : ''} Tell the owner in a few words.`;
};

export const approvalHandlers = (desk: Pick<ApprovalDesk, 'waiting' | 'reraise' | 'withdraw'>) => [
  {
    name: 'raise_approval',
    description: "Your approval cards that the owner has not settled. list shows each one with when you raised it, who a send goes out from, the card's exact words, and which earlier card it replaces. raise shows one the owner put off to them again: do it when their conversation makes it matter again, never just because it waits. withdraw closes one of your own cards that is stale, such as an earlier draft you have since revised, with a short reason the owner reads; it never approves anything, and a card the owner already decided stays as it is. To revise a card, prefer proposing the new version with replaces, which closes the old one when the new one reaches the owner.",
    schema: raiseApprovalArgsSchema,
    trigger_allowlist: allowlist('raise_approval'),
    autonomy_gated: false,
    mutates_state: true,
    async handle(args: RaiseApprovalArgs, ctx?: ToolDispatcherContext) {
      // A list that shows any card whose words may carry outside text is outside text itself.
      if (args.operation === 'list') {
        const approvals = desk.waiting();
        return { ok: true as const, data: { approvals }, source_taint: approvals.some(card => card.outside_text) ? 'external' as const : null };
      }
      if (args.operation === 'withdraw') {
        // In a turn that read outside text the desk closes the card with its own fixed words and tells the owner itself.
        const result = await desk.withdraw(args.approval_id!, args.reason!, { outside: turnReadOutside(ctx) });
        return { ok: true as const, data: { approval_id: args.approval_id!, ...result, note: withdrawNote(result) }, source_taint: null };
      }
      const result = await desk.reraise(args.approval_id!);
      return { ok: true as const, data: { approval_id: args.approval_id!, ...result, note: note(result) }, source_taint: null };
    },
  } satisfies ToolHandler<RaiseApprovalArgs, unknown, ToolDispatcherContext>,
];
