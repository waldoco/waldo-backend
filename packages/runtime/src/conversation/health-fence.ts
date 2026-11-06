import { EXTERNAL_ORIGIN_TOOLS, sanitiseInputSchema, sanitiseResultSchema, toolError, type LLMToolCall, type LLMToolTurn, type ToolError, type ToolName } from '@waldo/contracts';
import { EGRESS_READ_TOOLS } from '../tools/records';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import { toolOfCall } from '../tools/loader';

// The owner's health readings stay in the model's view beside outside content, so a plan can use them. What keeps them in the
// account is this fence: once a request has shown the model both, no call it makes for the rest of the turn may carry
// model-chosen text to a third party. A provider-hosted search runs inside the model's call, reading results and searching
// again with no dispatch in between, so a request that shows a reading offers none (conversation/tool-loop). That is the reads whose arguments leave the account, a browser step (its URL), an MCP
// call, and work handed to a child or a background task, whose brief the model writes. Reads of the owner's own accounts and
// writes into them go on; sends and grants stay on the owner's card as before.
export const HEALTH_FENCED_TOOLS: ReadonlySet<ToolName> = new Set([...EGRESS_READ_TOOLS, 'browse_act', 'call_mcp_tool', 'delegate_task', 'start_task']);

export const HEALTH_FENCE_ERROR: ToolError = toolError(
  'egress_denied',
  "This turn has the owner's health readings beside outside content (an email, a page or a connected tool), so nothing that sends text out of the owner's accounts runs for the rest of it. Nothing was sent.",
  undefined,
  'Answer with what you have. If the owner wants this looked up, they can ask again in a new message.',
);

// A request's own context (its system prompt and conversation) holds a reading when the scribe, reading it as outside content,
// would withhold health from it: the provider sends that context at the turn's starting taint, so a number the owner stated in
// memory or an earlier reply stays in view after outside text arrives. No scribe, or a check that cannot finish, counts as one.
export const healthInContext = async (payload: unknown, ctx: Pick<ToolDispatcherContext, 'sanitise' | 'session' | 'canaryTokens'>): Promise<boolean> => {
  if (ctx.sanitise === undefined) return true;
  const input = sanitiseInputSchema.safeParse({ payload, destination: 'internal_context', source_taint: 'external', canary_tokens: ctx.session?.canary_tokens ?? ctx.canaryTokens });
  if (!input.success) return true;
  try {
    const result = sanitiseResultSchema.parse(await ctx.sanitise(input.data));
    return !result.ok || result.redactions.some((redaction) => redaction.kind === 'health_value');
  } catch { return true; }
};

// A call is fenced by its own tool, or by the tool a proposal would run once the owner approves it.
export const fencedCall = (call: Pick<LLMToolCall, 'name' | 'arguments'>): boolean => {
  const tool = toolOfCall(call);
  if (HEALTH_FENCED_TOOLS.has(tool as ToolName)) return true;
  if (tool !== 'propose_action') return false;
  try {
    const proposed = (JSON.parse(call.arguments) as { tool?: unknown }).tool;
    return typeof proposed === 'string' && HEALTH_FENCED_TOOLS.has(proposed as ToolName);
  } catch { return false; }
};

// An owner-side tool turn holds a reading when the scribe, which lets the owner's readings through on their own, denies the
// same turn as outside content for health (llm/provider.ts makes the same call per turn). Without a scribe nothing can tell,
// so every owner-side turn counts.
export const ownerHealthTurn = async (turn: LLMToolTurn, ctx: Pick<ToolDispatcherContext, 'sanitise' | 'session' | 'canaryTokens'>): Promise<boolean> => {
  if (turn.source_taint === 'external' || (EXTERNAL_ORIGIN_TOOLS as readonly string[]).includes(toolOfCall(turn.call))) return false;
  if (ctx.sanitise === undefined) return true;
  const input = sanitiseInputSchema.safeParse({
    payload: [{ call: turn.call, output: turn.output }], destination: 'internal_context', source_taint: 'external',
    canary_tokens: ctx.session?.canary_tokens ?? ctx.canaryTokens,
  });
  if (!input.success) return true;
  try {
    const result = sanitiseResultSchema.parse(await ctx.sanitise(input.data));
    return !result.ok && result.reason === 'health_value_leak';
  } catch { return true; }
};
