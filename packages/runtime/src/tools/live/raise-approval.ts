import { raiseApprovalArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type RaiseApprovalArgs, type ToolHandler, type ToolName } from '@waldo/contracts';
import type { ApprovalDesk, ReraiseOutcome } from '../../channels/approvals';
import type { ToolDispatcherContext } from '../dispatcher';

const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));

// Fixed words for each outcome, so the model never tells the owner about a card they did not get.
const note = (result: ReraiseOutcome): string => {
  if (result.outcome !== 'raised') return {
    expired: 'It expired, so it was closed and not shown. If the owner still wants it, propose it again.',
    not_put_off: 'The owner has not put it off, so nothing was sent; its card is still waiting.',
    not_waiting: 'It is not waiting on the owner, so nothing was sent.',
    unshown: 'Its card could not be shown, so it is still put off. Nothing was sent.',
  }[result.outcome];
  if (result.on_this_reply) return 'Its card is on this reply.';
  return result.shown_on.some(surface => surface !== 'app') ? 'A fresh card with its buttons was sent to the owner.' : "It is back in the owner's approvals list; no card is on this reply.";
};

export const approvalHandlers = (desk: Pick<ApprovalDesk, 'waiting' | 'reraise'>) => [
  {
    name: 'raise_approval',
    description: "Approvals the owner put off with Not now wait until you raise them again. list shows the approvals waiting on the owner, with put_off marked. raise shows one they put off to them again: do it when it matters again (they ask about it, or its moment is near), never just because it is waiting.",
    schema: raiseApprovalArgsSchema,
    trigger_allowlist: allowlist('raise_approval'),
    autonomy_gated: false,
    mutates_state: true,
    async handle(args: RaiseApprovalArgs) {
      if (args.operation === 'list') return { ok: true as const, data: { approvals: desk.waiting() }, source_taint: null };
      const result = await desk.reraise(args.approval_id!);
      return { ok: true as const, data: { approval_id: args.approval_id!, ...result, note: note(result) }, source_taint: null };
    },
  } satisfies ToolHandler<RaiseApprovalArgs, unknown, ToolDispatcherContext>,
];
