import { ownerEffectOperationRef } from '../../channels/owner-effect-ledger';
import {
  PRIVILEGED_ACTION_TOOLS, TOOL_PERMISSIONS, buildSessionState, proposeActionArgsSchema, toolNameSchema, triggerTypeSchema,
  type ProposeActionArgs, type ToolHandler, type ToolName, type ToolResult,
} from '@waldo/contracts';
import type { z } from 'zod';
import { proposalStatus, type CardPlacement, type TaintedActionOutcome, type TaintedActionProposal } from '../../channels/approvals';
import { TOOL_ARG_SCHEMAS } from '../../hooks/registry';
import { argumentDigest, dispatchTool, type DispatchToolOptions, type ToolDispatcherContext } from '../dispatcher';

export type TaintedActionDesk = Readonly<{
  proposeTaintedAction(proposal: TaintedActionProposal): Promise<string>;
  placement?(id: string): CardPlacement;
}>;

const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));
const OUTCOME_CHARS = 300;

// The owner-confirm route the taint gate points at (ADR-0049). The handler only freezes the call: the tool, its
// arguments validated against that tool's own schema, and their digest, on a card. Nothing runs here; the approval
// replays exactly the frozen call once, through the same dispatcher and hooks as a turn.
// What the host can do with an approved call: replayable names the tools in its own handler set, and raisesOwnCard
// the ones whose handler only raises the owner's card (send_message), which the model calls directly instead.
// A proposal for any other tool is refused here, so the owner is never shown a card that cannot run.
export type ProposeActionHost = Readonly<{
  replayable?(tool: ToolName): boolean;
  raisesOwnCard?(tool: ToolName): boolean;
}>;

export const proposeActionHandler = (desk: TaintedActionDesk, host: ProposeActionHost = {}): ToolHandler<ProposeActionArgs, unknown, ToolDispatcherContext> => ({
  name: 'propose_action',
  description: 'Ask the owner to approve one tool call whose arguments came from an email, web page or other external content. Give the exact tool name and the exact arguments you would have passed it; the owner gets a card showing both, and on approval that call runs once. Nothing runs until they approve.',
  schema: proposeActionArgsSchema,
  trigger_allowlist: allowlist('propose_action'),
  autonomy_gated: false,
  mutates_state: true,
  handle: async (args: ProposeActionArgs, ctx: ToolDispatcherContext): Promise<ToolResult<unknown>> => {
    // The card is the route for arguments that came from outside; a turn that read nothing from outside calls the tool.
    if ((ctx as { toolArgSourceTaint?: unknown }).toolArgSourceTaint !== 'external') return { ok: false, error: 'Nothing in this turn came from an email, web page or other outside source, so no approval card is needed; call the tool directly.', code: 'rejected' };
    const tool = toolNameSchema.safeParse(args.tool);
    if (!tool.success) return { ok: false, error: `No tool is named ${args.tool}; propose one of the tools you were offered.`, code: 'invalid_args' };
    if (!PRIVILEGED_ACTION_TOOLS.includes(tool.data)) return { ok: false, error: `${tool.data} needs no approval; call it directly.`, code: 'rejected' };
    if (host.raisesOwnCard?.(tool.data) === true) return { ok: false, error: `${tool.data} already asks the owner on its own card; call it directly.`, code: 'rejected' };
    // use_mac admits only an untainted owner turn by its own law, so an approved replay could never run it.
    if (tool.data === 'use_mac' || host.replayable?.(tool.data) === false) {
      return { ok: false, error: `${tool.data} cannot run from an approval on this Waldo; tell the owner what you would do so they can do it themselves.`, code: 'rejected' };
    }
    const schema = TOOL_ARG_SCHEMAS[tool.data] as z.ZodType | undefined;
    if (schema === undefined) return { ok: false, error: `${tool.data} cannot be proposed on this Waldo.`, code: 'not_found' };
    const parsed = schema.safeParse(args.args);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
      return { ok: false, error: `The args do not match ${tool.data}'s schema: ${issues}.`, code: 'invalid_args' };
    }
    const frozen = parsed.data as Record<string, unknown>;
    // The host's own approval line still applies on replay; a tool it never admits is refused now, not after the card.
    if (ctx.hasApproval !== undefined) {
      const check = ctx.hasApproval;
      const admitted = await (async () => check({ tool: tool.data, args: frozen, session: ctx.session ?? null }))().catch(() => false);
      if (!admitted) return { ok: false, error: `${tool.data} is not allowed on this Waldo even with approval; tell the owner what you would do.`, code: 'forbidden' };
    }
    const digest = await argumentDigest(frozen);
    if (digest === null) return { ok: false, error: 'The args could not be frozen as plain JSON.', code: 'invalid_args' };
    const proposal_id = await desk.proposeTaintedAction({
      operation_ref: await ownerEffectOperationRef(ctx), tool: tool.data, args: frozen, args_digest: digest, reasoning: args.reasoning, source: 'external',
    });
    return {
      ok: true,
      data: { proposal_id, tool: tool.data, status: proposalStatus(desk.placement?.(proposal_id), 'sent to the owner with Do it / Not now buttons', 'Nothing ran.'), executed: false },
      source_taint: null,
    };
  },
});

// Runs an approved tainted action exactly as frozen: the same dispatcher, hooks and handlers as a turn, with the
// approval token naming this one call. The outcome claims only what the replay established, so the desk can tell a
// refusal before the handler ran from a handler that ran and failed, and leaves anything else uncertain.
export const taintedActionReplay = (input: Readonly<{
  handlers: () => DispatchToolOptions<ToolDispatcherContext>['handlers'];
  context: () => ToolDispatcherContext;
}>) => async (proposal: TaintedActionProposal, approvalRef: string): Promise<TaintedActionOutcome> => {
  const tool = toolNameSchema.safeParse(proposal.tool);
  if (!tool.success) return { status: 'rejected', message: `No tool is named ${proposal.tool}.` };
  let ran = false;
  const handlers = input.handlers().map((handler) => handler.name !== tool.data ? handler : {
    ...handler,
    handle: async (args: unknown, ctx: ToolDispatcherContext) => { ran = true; return handler.handle(args, ctx); },
  });
  const callRef = `approval:${approvalRef}`;
  const ctx: ToolDispatcherContext = {
    ...input.context(), toolArgSourceTaint: 'external', turnId: callRef, toolCallId: callRef,
    approvedTaintedAction: { tool: tool.data, args_digest: proposal.args_digest },
  };
  const result = await dispatchTool({ id: callRef, name: tool.data, args: proposal.args }, ctx, { handlers });
  if (result.ok) {
    const shown = JSON.stringify(result.data);
    return { status: 'done', message: shown.length > OUTCOME_CHARS ? `${shown.slice(0, OUTCOME_CHARS - 1)}…` : shown };
  }
  if (!ran) return { status: 'rejected', message: result.error };
  return { status: result.reason === 'tool_result_error' ? 'failed' : 'uncertain', message: result.error };
};

// The dispatcher context an approved replay runs under: the owner's identity and the host's own approval line,
// sanitiser and egress allowlist, with fresh canaries. The replay adds the taint and the approval token itself.
export const approvalReplayContext = (input: Readonly<{
  authenticatedUserId: string;
  hasApproval: NonNullable<ToolDispatcherContext['hasApproval']>;
  sanitise: NonNullable<ToolDispatcherContext['sanitise']>;
  egressAllowlist?: readonly string[];
}>): ToolDispatcherContext => {
  const canaryTokens = Array.from({ length: 3 }, () => crypto.randomUUID().replaceAll('-', '').slice(0, 16));
  return {
    authenticatedUserId: input.authenticatedUserId, trigger: 'user_message', canaryTokens, sourceTaint: null, toolArgSourceTaint: 'external',
    hasApproval: input.hasApproval, sanitise: input.sanitise,
    ...(input.egressAllowlist === undefined ? {} : { egressAllowlist: input.egressAllowlist }),
    session: buildSessionState({ trigger: 'user_message', canary_tokens: canaryTokens, started_at: Date.now() }),
  };
};
