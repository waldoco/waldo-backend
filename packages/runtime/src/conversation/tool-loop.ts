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

export type ToolLoopEvent = Readonly<{ call: LLMToolCall; ok: boolean; ms: number; output: string; error?: string; code?: string; reason?: string; guard?: string }>;

export const toolDefinitions = (handlers: DispatchToolOptions<ToolDispatcherContext>['handlers']): LLMTool[] =>
  handlers.map((handler) => ({
    name: handler.name,
    description: handler.description,
    parameters: toolParameters(handler.schema),
  }));

// The model calls tools until it answers. maxSteps is a safety budget, not a plan (see
// docs/planning/TOOL_LOOP_BUDGET.md). The loop also stops offering tools after
// FAILED_ROUNDS_LIMIT rounds in a row where every call failed. Once tools are withdrawn the
// model must answer, so a turn always ends in words. Identical repeated calls are refused.
export const FAILED_ROUNDS_LIMIT = 3;

// Warn-first escalation: a silent hard stop at maxSteps surprises the model mid-plan, so
// results delivered inside the last WARN_WINDOW_ROUNDS rounds carry an explicit
// remaining-rounds notice and the model can close in words before tools are withdrawn.
export const WARN_WINDOW_ROUNDS = 5;

// Semantic no-progress detection: byte-exact dedupe misses the same call re-issued with fresh
// request ids, cursors or timestamps in args, or answered with fresh ids/timestamps in the
// result. Volatile spans - ISO-8601 timestamps, uuid-shaped ids, and 20+ char token runs that
// carry a digit, underscore, or hyphen (cursors, request ids) - are blanked before hashing.
// Pure-alphabetic long words (ordinary search terms like electroencephalography) survive, so
// genuinely different calls never collide; small integers (page numbers, amounts) survive too.
// Once the same stabilized (tool, args, result) triple appears NO_PROGRESS_LIMIT times in a
// turn, that stabilized (tool, args) pair is refused pre-dispatch for the rest of the turn.
export const NO_PROGRESS_LIMIT = 3;

// Token shapes only: dates, UUIDs, and 20+ char runs carrying digit/underscore evidence
// (cursors, ids, keys). Hyphenated natural-language phrases carry no such evidence and must
// never blank - 'post-traumatic-stress-disorder' and 'large-language-model-evaluation' are
// distinct searches, not volatile tokens.
const VOLATILE_SPANS = /(\d{4}-\d{2}-\d{2}[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)|([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})|((?=[\w-]*[\d_])[\w-]{20,})/gi;
const stabilize = (text: string): string => text.replace(VOLATILE_SPANS, '#');

export async function runToolLoop(input: Readonly<{
  step: ToolLoopStep;
  handlers: DispatchToolOptions<ToolDispatcherContext>['handlers'];
  ctx: ToolDispatcherContext;
  maxSteps: number;
  offload?: ToolOutputStore;
  onTool?: (event: ToolLoopEvent) => void;
  // S4 (CONNECT_FLOW_DESIGN 4.4): a tool's typed auth intent is acted on by the responder via
  // the channel's offerConnect seam. Fired at most once per (service, reason) per turn.
  onConnect?: (intent: ConnectIntent) => Promise<boolean>;
}>): Promise<string> {
  const tools = toolDefinitions(input.handlers);
  const turns: LLMToolTurn[] = [];
  const seen = new Set<string>();
  const offered = new Set<string>();
  const noProgressTriples = new Map<string, number>();
  const noProgressBlocked = new Set<string>();
  let failedRounds = 0;
  for (let round = 0; ; round += 1) {
    const offer = tools.length > 0 && round < input.maxSteps && failedRounds < FAILED_ROUNDS_LIMIT;
    const response = await input.step(offer ? tools : undefined, turns);
    if (response.tool_calls === undefined) return response.text;
    let anyOk = false;
    let anyGenuineFailure = false;
    let firstCall = true;
    for (const call of response.tool_calls) {
      const started = Date.now();
      const key = `${call.name}\u0000${call.arguments}`;
      const stablePair = `${call.name}\u0000${stabilize(call.arguments)}`;
      // Harness refusals carry a typed code and never feed FAILED_ROUNDS_LIMIT: a refusal is the
      // harness declining a redundant call, not a tool failure. Counting refusals lets a cheap
      // refusal feed the streak that fires the next, harder one.
      const result = seen.has(key)
        ? { ok: false, error: 'Same call already made this turn; use its result.', code: 'repeat_refusal' as const }
        : noProgressBlocked.has(stablePair)
          ? { ok: false, error: 'No progress: this call keeps returning the same outcome apart from volatile ids/timestamps; stop retrying it and answer with what you have.', code: 'no_progress' as const }
          : await dispatch(call, input);
      if (!result.ok && result.connect) {
        const offerKey = `${result.connect.service}:${result.connect.reason}`;
        if (!offered.has(offerKey)) {
          offered.add(offerKey);
          const intent = result.connect;
          try { await input.onConnect?.(intent); } catch { /* an offer failure must not break the turn */ }
        }
      }
      seen.add(key);
      if (!noProgressBlocked.has(stablePair)) {
        const triple = `${stablePair}\u0000${stabilize(JSON.stringify(result))}`;
        const hits = (noProgressTriples.get(triple) ?? 0) + 1;
        noProgressTriples.set(triple, hits);
        if (hits >= NO_PROGRESS_LIMIT) noProgressBlocked.add(stablePair);
      }
      const roundsLeft = input.maxSteps - round - 1;
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
      const output = capToolOutput(JSON.stringify(result), input.offload, call.call_id) + budgetNote;
      turns.push({ call, output, ...(firstCall && response.output_items?.length ? { prior_items: [...response.output_items] } : {}) });
      firstCall = false;
      // The typed code/reason ride the span as their own fields so a failed hop stays
      // diagnosable from the trace or tail even when the capture switch gates free-form error
      // text off; error keeps the human-facing message for capture-on.
      const typed = result.ok ? undefined : (result as { code?: string; reason?: string; guard?: string });
      const failure = result.ok ? undefined : result.error ?? (typed?.code ? `${typed.code}${typed.reason ? `:${typed.reason}` : ''}` : undefined);
      input.onTool?.({
        call, ok: result.ok, ms: Date.now() - started, output,
        ...(failure ? { error: failure } : {}),
        ...(typed?.code ? { code: typed.code } : {}),
        ...(typed?.reason ? { reason: typed.reason } : {}),
        ...(typed?.guard ? { guard: typed.guard } : {}),
      });
      anyOk ||= result.ok;
      anyGenuineFailure ||= !result.ok && (result as { code?: string }).code !== 'repeat_refusal' && (result as { code?: string }).code !== 'no_progress';
    }
    // A refusal-only round neither feeds nor resets the failure streak: nothing failed.
    failedRounds = anyOk ? 0 : anyGenuineFailure ? failedRounds + 1 : failedRounds;
  }
}

async function dispatch(
  call: LLMToolCall,
  input: Readonly<{ handlers: DispatchToolOptions<ToolDispatcherContext>['handlers']; ctx: ToolDispatcherContext; offload?: ToolOutputStore }>,
): Promise<Readonly<{ ok: boolean; data?: unknown; error?: string; code?: string; reason?: string; guard?: string; source_taint?: 'external' | null; connect?: ConnectIntent }>> {
  const name = toolNameSchema.safeParse(call.name);
  if (!name.success) return { ok: false, error: `Unknown tool ${call.name}.` };
  let args: unknown;
  try {
    args = JSON.parse(call.arguments || '{}');
  } catch {
    return { ok: false, error: 'Arguments were not valid JSON.' };
  }
  const result = await dispatchTool({ id: call.call_id, name: name.data, args }, input.ctx, { handlers: input.handlers, ...(input.offload === undefined ? {} : { offload: input.offload }) });
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
