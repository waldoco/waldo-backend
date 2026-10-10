import { guardArtifactLinks, receiptUrl } from './artifact-link-guard';
import { toolNameSchema, toolParameters, type ConnectIntent, type LLMTool, type LLMToolCall, type LLMToolTurn } from '@waldo/contracts';
import { dispatchTool, type DispatchToolOptions, type ToolDispatcherContext } from '../tools/dispatcher';
import type { ToolOutputStore } from './tool-output-store';


export const TOOL_OUTPUT_LIMIT = 16_000;

export const TOOL_OUTPUT_HEAD = 4_000;

export const capToolOutput = (output: string, offload?: ToolOutputStore, callId?: string): string => {
  if (output.length <= TOOL_OUTPUT_LIMIT) return output;
  if (offload === undefined) return `${output.slice(0, TOOL_OUTPUT_LIMIT)}\n[cut: ${output.length - TOOL_OUTPUT_LIMIT} more characters not shown; narrow the request]`;
  // The call id is the provenance the store records (owner re-review on #212): receipts later
  // honor a marker only when the stored record belongs to the call whose text carries it.
  const stored = offload.put(output, callId === undefined ? undefined : { call_id: callId });
  return stored.truncated
    ? `${output.slice(0, TOOL_OUTPUT_HEAD)}\n[partial output stored as ${stored.id}: first ${stored.stored_chars} of ${stored.original_chars} characters kept (store bound); the tail is NOT retrievable - re-run the tool with narrower arguments if you need it. call read_tool_output with this id, offset and length to read the stored part]`
    : `${output.slice(0, TOOL_OUTPUT_HEAD)}\n[full output stored as ${stored.id}: ${stored.stored_chars} characters total; call read_tool_output with this id, offset and length to read more]`;
};

export type ToolLoopStep = (
  tools: readonly LLMTool[] | undefined,
  turns: readonly LLMToolTurn[],
) => Promise<Readonly<{ text: string; tool_calls?: readonly LLMToolCall[]; output_items?: readonly Record<string, unknown>[] }>>;

export type ToolLoopEvent = Readonly<{ call: LLMToolCall; ok: boolean; ms: number; output: string; error?: string; code?: string; reason?: string; guard?: string; taint: 'external' | null }>;

export const toolDefinitions = (handlers: DispatchToolOptions<ToolDispatcherContext>['handlers']): LLMTool[] =>
  handlers.map((handler) => ({
    name: handler.name,
    description: handler.description,
    parameters: toolParameters(handler.schema),
  }));

// The model judges progress within hard round/shared budgets and run-scope fences.
// Settled exact calls stay deduped; read-only transient failures get bounded recovery.
export const WARN_WINDOW_ROUNDS = 5;

// 'completed' means the model closed while resources remained. 'budget_exhausted'
// means the loop withdrew tools at its local/shared cap. Keep 'withdrawn' in the
// caller contract for existing child outcome consumers.
export type LoopExit = 'completed' | 'budget_exhausted' | 'withdrawn';


export async function runToolLoop(input: Readonly<{
  step: ToolLoopStep;
  handlers: DispatchToolOptions<ToolDispatcherContext>['handlers'];
  ctx: ToolDispatcherContext;
  maxSteps: number;
  offload?: ToolOutputStore;
  // Host custody can withdraw ordinary offload after a protected handler runs.
  // Recheck at actual put boundaries, not once before the awaited handler.
  offloadCurrent?(): ToolOutputStore | undefined;
  onTool?: (event: ToolLoopEvent) => void;
  // Fired once, just before the loop returns, with the truthful exit classification.
  onSettle?: (exit: LoopExit) => void;
  // Shared tool-round budget across a parent turn and its children (subagent orchestration
  // spec): when present, every offered round in EVERY loop holding the same object decrements
  // it, so a turn's stated round cap is absolute - children can never dispatch past it.
  budget?: { remaining: number };
  // S4 (CONNECT_FLOW_DESIGN 4.4): a tool's typed auth intent is acted on by the responder via
  // the channel's offerConnect seam. Fired at most once per (service, reason) per turn.
  onConnect?: (intent: ConnectIntent) => Promise<boolean>;
}>): Promise<string> {
  const tools = toolDefinitions(input.handlers);
  const turns: LLMToolTurn[] = [];
  const seen = new Map<string, Awaited<ReturnType<typeof dispatch>>>();
  const offered = new Set<string>();
  const browserActions = new Map<string, number>();
  const browserReads = new Map<string, {handle:string; epoch:number}>();
  const sessionHandle = (data:unknown, field:string):string|undefined => {
    if (!data || typeof data !== 'object' || !(field in data)) return;
    const value=(data as Record<string,unknown>)[field];
    return typeof value==='string' && value.length>0 ? value : undefined;
  };
  // Delivery URLs returned by successful tool receipts this loop; the final reply may show no other artifact link.
  const receiptUrls = new Set<string>();
  // A landed mutation opens a new read epoch. Mutation replay keys survive resets,
  // so a state change cannot re-fire a write. Recovery shares the finite round budget.
  const mutationTools = new Set(input.handlers.filter((h) => h.autonomy_gated || h.mutates_state).map((h) => h.name));
  let exit: LoopExit = 'completed';
  for (let round = 0; ; round += 1) {
    const roundsAvailable = round < input.maxSteps && (input.budget === undefined || input.budget.remaining > 0);
    const offer = tools.length > 0 && roundsAvailable;
    // An initially empty authority ceiling can reject an illegal request once and
    // give the model a final closing step. This consumes a round and performs no I/O.
    const repairEmptyCeiling = tools.length === 0 && round === 0 && roundsAvailable;
    if (!roundsAvailable && exit === 'completed') {
      exit = 'budget_exhausted';
    }
    if ((offer || repairEmptyCeiling) && input.budget !== undefined) input.budget.remaining -= 1;
    input.ctx.runScope?.admit();
    const response = await input.step(offer ? tools : undefined, turns);
    input.ctx.runScope?.admit();
    if (response.tool_calls === undefined || (!offer && !repairEmptyCeiling)) {
      input.onSettle?.(exit);
      return guardArtifactLinks(response.text || (exit === 'budget_exhausted'
        ? 'Tool budget exhausted; no further tools were run.'
        : tools.length === 0 ? 'No tools are available this turn; no tool calls were executed.' : ''), receiptUrls);
    }
    let firstCall = true;
    for (const call of response.tool_calls) {
      input.ctx.runScope?.admit();
      const started = Date.now();
      const key = `${call.name}\u0000${call.arguments}`;
      const cached = seen.get(key);
      // Only a completed host action in this exact retained session opens another
      // identical read. Reads and unrelated mutation successes are not action proof.
      const anchor = browserReads.get(key);
      const retainedRead = call.name === 'browse_page' && cached?.ok && anchor
        && sessionHandle(cached.data,'session_handle') === anchor.handle
        && (browserActions.get(anchor.handle) ?? 0) > anchor.epoch;
      const previous = retainedRead ? undefined : cached;
      // Preserve settled nonretryable failures and mutation failures verbatim.
      // Replaying them performs no I/O; transient reads may retry within the budget.
      const result = previous
        ? previous.ok
          ? { ok: false, error: 'Same call already made this turn; use its result.', code: 'repeat_refusal' as const }
          : previous
        : !offer
          ? { ok: false, error: 'Tool handler unavailable.', code: 'not_found' as const, reason: 'handler_unavailable' }
          : await dispatch(call, input);
      input.ctx.runScope?.admit();
      if (!result.ok && result.connect) {
        const offerKey = `${result.connect.service}:${result.connect.reason}`;
        if (!offered.has(offerKey)) {
          offered.add(offerKey);
          const intent = result.connect;
          try { await input.onConnect?.(intent); } catch { /* an offer failure must not break the turn */ }
        }
      }
      const mutation = mutationTools.has(call.name as never);
      // Only a typed adapter failure explicitly classified transient permits recovery.
      // Validation, hook halts and unexpected handler throws are not evidence of retryability.
      const retryableRead = !result.ok && result.code === 'transient'
        && 'reason' in result && result.reason === 'tool_result_error';
      if (mutation || !retryableRead) {
        // Keep the successful retained anchor through a loop refusal; a later real
        // action may unlock it. Settled provider failures still replace the anchor.
        if (!(anchor && previous?.ok && !result.ok && result.code==='repeat_refusal')) seen.set(key, result);
      }
      if (!previous && result.ok && call.name==='browse_page') {
        const handle=sessionHandle(result.data,'session_handle');
        if(handle) browserReads.set(key,{handle,epoch:browserActions.get(handle) ?? 0});
      }
      if (result.ok && call.name==='browse_act') {
        const handle=sessionHandle(result.data,'browser_action_session_handle');
        if(handle) browserActions.set(handle,(browserActions.get(handle) ?? 0)+1);
      }
      const receipt = receiptUrl(call.name, result);
      if (receipt !== null) receiptUrls.add(receipt);
      if (result.ok && mutationTools.has(call.name as never)) {
        for (const seenKey of seen.keys()) {
          if (!browserReads.has(seenKey) && !mutationTools.has(seenKey.slice(0, seenKey.indexOf('\u0000')) as never)) seen.delete(seenKey);
        }
      }
      // Turn taint accumulation (ADR-0049): a result stamped external taints the rest of the
      // turn, so a later privileged call in this loop - including one shaped by a subagent's
      // delegate_task handback - is refused direct execution by the autonomy gate. The do.ts
      // trusted path seeds the same field from committed checkpoints; this loop owns the
      // per-round derivation for conversational turns.
      if ((result as { source_taint?: 'external' | null }).source_taint === 'external') {
        (input.ctx as { toolArgSourceTaint?: unknown }).toolArgSourceTaint = 'external';
      }
      const roundsLeft = Math.min(input.maxSteps - round - 1, input.budget?.remaining ?? Infinity);
      // Notes only exist when the cap exceeds the window (the real 25); tiny test caps that
      // exercise the withdrawal mechanism itself stay note-free. Pressure escalates as the
      // window closes, and the
      // roundsLeft 0 notice is the graceful close - the model is told the budget is exhausted
      // alongside its last tool result, so the final no-tools step comes back as words.
      const budgetNote = input.maxSteps > WARN_WINDOW_ROUNDS && roundsLeft >= 0 && roundsLeft < WARN_WINDOW_ROUNDS
        ? roundsLeft === 0
          ? '\n[budget: tool budget exhausted this turn - no more tool calls; answer now with what you have]'
          : roundsLeft <= 2
            ? `\n[budget: ${roundsLeft} tool round${roundsLeft === 1 ? '' : 's'} left this turn - wrap up and answer now]`
            : `\n[budget: ${roundsLeft} tool rounds left this turn - start wrapping up]`
        : '';
      const replayNote = previous && !previous.ok
        ? '\n[repeat: cached failure from this turn; no new tool execution]'
        : '';
      const output = capToolOutput(JSON.stringify(result), input.offloadCurrent ? input.offloadCurrent() : input.offload, call.call_id) + replayNote + budgetNote;
      turns.push({ call, output, ...(firstCall && response.output_items?.length ? { prior_items: [...response.output_items] } : {}) });
      firstCall = false;
      // The typed code/reason ride the span as their own fields so a failed hop stays
      // diagnosable from the trace or tail even when the capture switch gates free-form error
      // text off; error keeps the human-facing message for capture-on.
      const typed = result.ok ? undefined : (result as { code?: string; reason?: string; guard?: string });
      const failure = result.ok ? undefined : result.error ?? (typed?.code ? `${typed.code}${typed.reason ? `:${typed.reason}` : ''}` : undefined);
      input.onTool?.({
        call, ok: result.ok, ms: Date.now() - started, output,
        taint: (result as { source_taint?: 'external' | null }).source_taint ?? null,
        ...(failure ? { error: failure } : {}),
        ...(typed?.code ? { code: typed.code } : {}),
        ...(typed?.reason ? { reason: typed.reason } : {}),
        ...(typed?.guard ? { guard: typed.guard } : {}),
      });
    }
  }
}

async function dispatch(
  call: LLMToolCall,
  input: Readonly<{ handlers: DispatchToolOptions<ToolDispatcherContext>['handlers']; ctx: ToolDispatcherContext; offload?: ToolOutputStore; offloadCurrent?(): ToolOutputStore | undefined }>,
): Promise<Readonly<{ ok: boolean; data?: unknown; error?: string; code?: string; reason?: string; guard?: string; source_taint?: 'external' | null; connect?: ConnectIntent }>> {
  const name = toolNameSchema.safeParse(call.name);
  if (!name.success) return { ok: false, error: `Unknown tool ${call.name}.` };
  let args: unknown;
  try {
    args = JSON.parse(call.arguments || '{}');
  } catch {
    return { ok: false, error: 'Arguments were not valid JSON.' };
  }
  const result = await dispatchTool({ id: call.call_id, name: name.data, args }, input.ctx, { handlers: input.handlers, get offload() { return input.offloadCurrent ? input.offloadCurrent() : input.offload; } });
  // The untrusted marker crosses the model boundary on BOTH arms: a successful external result
  // keeps source_taint 'external' in the JSON the model reads, so provider text never presents
  // as internal truth (security review 2026-09-26); the failure arm keeps it for the same reason.
  if (result.ok) return { ok: true, data: result.data, ...(result.source_taint ? { source_taint: result.source_taint } : {}) };
  // Keep the dispatcher's typed code/reason so spans carry the machine-readable failure, not
  // just the human-facing message.
  const typed = result as { code?: string; reason?: string };
  return {
    ok: false,
    error: result.error,
    ...(typed.code ? { code: typed.code } : {}),
    ...(typed.reason ? { reason: typed.reason } : {}),
    // Enum-only guard stage:reason - the trace-visible diagnostic when capture is off.
    ...(result.guard ? { guard: `${result.guard.check}:${result.guard.reason}` } : {}),
    ...(result.source_taint ? { source_taint: result.source_taint } : {}),
    ...(result.connect ? { connect: result.connect } : {}),
  };
}
