import { ownerEffectOperationRef } from '../../channels/owner-effect-ledger';
import {
  sendMessageArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type SendMessageArgs, type ToolHandler, type ToolName, type ToolResult,
} from '@waldo/contracts';
import { proposalStatus, type CardPlacement, type MessageSendProposal } from '../../channels/approvals';
import type { ToolDispatcherContext } from '../dispatcher';

export type MessageDesk = Readonly<{
  proposeSendMessage(proposal: MessageSendProposal): Promise<string>;
  placement?(id: string): CardPlacement;
}>;

const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));

// The tool only proposes (same shape as send_email): the card carries the exact channel + content
// and the desk replays them verbatim on Send it. There is no direct-send path on this surface;
// ADR-0054's idempotency key collapses a second approval onto the first send.
export const sendMessageHandler = (desk: MessageDesk): ToolHandler<SendMessageArgs, unknown, ToolDispatcherContext> => ({
  name: 'send_message',
  description: "Send a message on one of the owner's channels. Goes to the owner first as a review card; nothing sends until they approve it.",
  schema: sendMessageArgsSchema,
  trigger_allowlist: allowlist('send_message'),
  autonomy_gated: false,
  mutates_state: true,
  handle: async (args: SendMessageArgs, ctx?: ToolDispatcherContext): Promise<ToolResult<unknown>> => {
    const proposal_id = await desk.proposeSendMessage({
      operation_ref: await ownerEffectOperationRef(ctx),
      channel: args.channel,
      content: args.content,
      idempotency_key: args.idempotency_key,
    });
    return { ok: true, data: { proposal_id, status: proposalStatus(desk.placement?.(proposal_id), 'sent to the owner with Send it / Modify / Not now buttons', 'Nothing was sent.'), sent: false }, source_taint: null };
  },
});
