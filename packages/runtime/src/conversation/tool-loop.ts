import { guardArtifactLinks, receiptUrl } from './artifact-link-guard';
import { LLM_TOOL_TURNS_MAX, PROVIDER_OF, toolError, toolNameSchema, toolParameters, type ConnectIntent, type LLMTool, type LLMToolCall, type LLMToolTurn, type ModelName, type Provider, type RungBlockedOutcome, type ToolError, type ToolName } from '@waldo/contracts';
import { dispatchTool, type DispatchToolOptions, type ToolDispatcherContext } from '../tools/dispatcher';
import { CONNECT_BUTTON_SENT, CONNECT_BUTTON_UNSENT } from '../tools/live/connect-text';
import { ClosedRunError } from '../channels/run-effect-scope';
import { FINAL_ANSWER_RESERVE_MS, MODEL_CALL_TIMEOUT_MS, PROMPT_CACHE_TTL_MS, turnDeadlineFor, withCallDeadline } from '../llm/time-budget';
import type { RunEffectScope } from '../channels/run-effect-scope';
import type { StoredPut, ToolOutputStore } from './tool-output-store';


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

// model: the model that answered, when one did; its provider's cache lifetime decides when old results may be cleared.
export type ToolLoopStep = (
  tools: readonly LLMTool[] | undefined,
  turns: readonly LLMToolTurn[],
) => Promise<Readonly<{ text: string; tool_calls?: readonly LLMToolCall[]; output_items?: readonly Record<string, unknown>[]; model?: ModelName }>>;

// taint is the turn's once this result landed: external when this result, an earlier one, or the turn's own context was.
// parallel_batches is 1 on the first call of a dispatch batch and 0 on the calls that ran beside it, so summing it over a
// turn's tool hops counts its batches.
export type ToolLoopEvent = Readonly<{ call: LLMToolCall; ok: boolean; ms: number; output: string; error?: string; error_code?: string; retryable?: boolean; code?: string; reason?: string; guard?: string; blocked?: RungBlockedOutcome; taint: 'external' | null; parallel_batches: 0 | 1 }>;

export const toolDefinitions = (handlers: DispatchToolOptions<ToolDispatcherContext>['handlers']): LLMTool[] =>
  handlers.map((handler) => ({
    name: handler.name,
    description: handler.description,
    parameters: toolParameters(handler.schema),
  }));

// The model judges progress within hard round/shared budgets and run-scope fences. It hears about the budget only near
// the end: in the last rounds, or once under a typical round's time is left before tools are withdrawn.
export const WARN_WINDOW_ROUNDS = 3;
const TOOL_TIME_WARN_MS = 15_000;
// A successful read may run again once any other call ran after it, or once this long has passed; an identical read
// back to back is a loop. A write never runs twice, and the browse tools keep their own session rule.
export const READ_REPEAT_AFTER_MS = MODEL_CALL_TIMEOUT_MS;

// Reads one model response may dispatch together. Each was checked to change nothing a later call can observe: no store
// write that spans an await, no send, no session, no tool-menu change. Running them at once leaves every effect where it
// was. The Google reads and read_drive stay out: their client stamps probe and health state across awaits and can send a
// reconnect link, so two at once could send it twice. read_thread can relay a message, and read_tool_output reads a store
// that sibling calls evict from. Anything not listed, and every write, approval or browse call, runs alone in model order.
export const CONCURRENT_READ_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  'get_context', 'get_health', 'read_owner_context', 'read_memory', 'search_episodes', 'web_search',
  'list_artifacts', 'read_artifact', 'list_reminders', 'list_responsibilities', 'list_health_logs',
  'list_standing_orders', 'workspace_list', 'workspace_read', 'workspace_search', 'skills_list',
]);
export const MAX_CONCURRENT_READS = 4;

// 'completed' means the model closed while resources remained. 'budget_exhausted'
// means the loop withdrew tools at its local/shared round cap, 'time_exhausted' that
// it withdrew them, or ended the turn, at the turn's deadline. Keep 'withdrawn' in the
// caller contract for existing child outcome consumers.
export type LoopExit = 'completed' | 'budget_exhausted' | 'time_exhausted' | 'withdrawn';

// The reply when a turn's budget ends and the model has no words of its own: what ran, and that the rest can continue.
export const unfinishedReply = (exit: Extract<LoopExit, 'budget_exhausted' | 'time_exhausted'>, done: readonly string[]): string => {
  const steps = [...new Set(done)].map((name) => name.replaceAll('_', ' '));
  return [
    exit === 'time_exhausted' ? 'I ran out of time before finishing this.' : 'I reached the most steps I take in one go before finishing this.',
    steps.length > 0 ? `Done so far: ${steps.join(', ')}.` : 'I had not finished a step yet.',
    'The rest is still open; say "continue" and I will pick it up from here.',
  ].join(' ');
};
const CLOSING = 'answer now with what you found or did, what is left, and offer to continue';
export const BROWSING_UNAVAILABLE = 'Browsing is unavailable on this Waldo for the rest of this turn; use what you have or say what you could not read.';
// For the browse tools, auth_failed is a configuration fact that cannot clear within a turn (no browser binding, the
// provider unavailable, a rejected key), so after one both are withheld until the turn ends. Keyed on the typed code.
const BROWSE_TOOLS: ReadonlySet<string> = new Set(['browse_page', 'browse_act']);
const TIME_UP_NOTE = `\n[budget: turn time is up - no more tool calls; ${CLOSING}]`;

// Every round resends the turn's tool results. Past this many characters of result text the oldest results are cleared
// (the call stays, its result becomes a short note), down to half of it at once, so a long turn stays inside the model's
// input and the cleared prefix stays byte-stable for the rounds after. The newest round is never cleared.
export const TOOL_RESULTS_KEEP_CHARS = 160_000;
// Once every provider that served the turn has let its prompt cache expire, the next request re-bills the whole prefix
// anyway, so results older than this many latest rounds are cleared then, as Anthropic's tool result clearing keeps the
// latest three tool uses by default. While any cache may be warm, clearing would re-bill everything after the cleared
// result, so nothing is cleared for time.
export const COLD_CACHE_KEEP_ROUNDS = 3;
// A cleared result stays one call away: the note keeps whether it worked and any receipt link, and names the stored
// copy read_tool_output reads back. Without a store, a read can run again; a browse or a write cannot be repeated.
export type ClearedResult = Readonly<{ ok: boolean; receipt: string | null; stored?: StoredPut; repeatable: boolean }>;
export const clearedToolResult = (name: string, result: ClearedResult): string => {
  const head = `[cleared: this ${name.replaceAll('_', ' ')} result from earlier in this turn (${result.ok ? 'it succeeded' : 'it failed'}) is no longer shown.`;
  const receipt = result.receipt ? ` Its link: ${result.receipt}.` : '';
  const back = result.stored
    ? ` Its full output is stored as ${result.stored.id}${result.stored.truncated ? ` (first ${result.stored.stored_chars} of ${result.stored.original_chars} characters)` : ''}; call read_tool_output with this id to read it again.`
    : result.repeatable ? ' Run it again if you still need it.' : ' Do not repeat the call; answer from what you know of it.';
  return `${head}${receipt}${back}]`;
};

// Set once by the first loop of a turn, from the run it serves, and shared with its child loops through the budget.
const turnDeadline = (budget: { deadline?: number } | undefined, scope: RunEffectScope | undefined): number => {
  const deadline = budget?.deadline ?? turnDeadlineFor(scope);
  if (budget !== undefined) budget.deadline = deadline;
  return deadline;
};


export async function runToolLoop(input: Readonly<{
  step: ToolLoopStep;
  handlers: DispatchToolOptions<ToolDispatcherContext>['handlers'];
  ctx: ToolDispatcherContext;
  maxSteps: number;
  offload?: ToolOutputStore;
  onTool?: (event: ToolLoopEvent) => void;
  // Fired once, just before the loop returns, with the truthful exit classification.
  onSettle?: (exit: LoopExit) => void;
  // Shared tool-round budget across a parent turn and its children (subagent orchestration
  // spec): when present, every offered round in EVERY loop holding the same object decrements
  // it, so a turn's stated round cap is absolute - children can never dispatch past it. The
  // first loop also stamps the turn's deadline on it, so a child spends the same time.
  budget?: { remaining: number; deadline?: number };
  // S4 (CONNECT_FLOW_DESIGN 4.4): a tool's typed auth intent is acted on by the responder via
  // the channel's offerConnect seam. Fired at most once per (service, reason) per turn. It answers
  // true when a connect button reached the owner, or the words the model gets instead.
  onConnect?: (intent: ConnectIntent) => Promise<boolean | string>;
  // Offer the same tool list every round: the list leads the provider's cache prefix, so a change mid-turn re-bills the
  // rest of the turn. propose_action refuses an untainted call and dispatch refuses withheld browsing instead.
  stableMenu?: boolean;
}>): Promise<string> {
  const tools = toolDefinitions(input.handlers);
  const turns: LLMToolTurn[] = [];
  const seen = new Map<string, Awaited<ReturnType<typeof dispatch>>>();
  const offered = new Map<string, string>();
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
  // The scope the turn handed in, which its model step also carries. Read once: a tool hook writes a copy of the
  // context back over input.ctx, so its runScope is a different object after the first dispatch.
  const runScope = input.ctx.runScope;
  const deadline = turnDeadline(input.budget, runScope);
  // Tools that ran this loop and succeeded, for the reply when the budget ends with no words from the model.
  const done: string[] = [];
  let dispatched = 0;
  const readRuns = new Map<string, Readonly<{ dispatched: number; at: number }>>();
  // A request replays at most LLM_TOOL_TURNS_MAX results. A longer turn sends its latest whole rounds, so each round's
  // reasoning items still precede its calls, and names what it set aside.
  const roundStarts: number[] = [];
  const shownTurns = (): readonly LLMToolTurn[] => {
    clearOldResults();
    if (cacheCold(Date.now())) clearThrough(roundStarts.length > COLD_CACHE_KEEP_ROUNDS ? roundStarts[roundStarts.length - COLD_CACHE_KEEP_ROUNDS]! : 0);
    if (turns.length <= LLM_TOOL_TURNS_MAX) return turns;
    const start = roundStarts.find((index) => turns.length - index <= LLM_TOOL_TURNS_MAX) ?? roundStarts.at(-1)!;
    const [first, ...rest] = turns.slice(start);
    const names = [...new Set(turns.slice(0, start).map((turn) => turn.call.name))].join(', ');
    return [{ ...first!, output: `${first!.output}\n[earlier in this turn: ${start} older tool results are no longer shown (${names}); run a read again if you still need its result]` }, ...rest];
  };
  // Results cleared so far, oldest first; clearing only moves forward, so what was sent stays as it was sent.
  let cleared = 0;
  // Per turn entry: the whole result as it came back, and what its cleared note needs.
  const results: Readonly<{ full: string; ok: boolean; receipt: string | null; key: string; repeatable: boolean }>[] = [];
  const clearNext = () => {
    const turn = turns[cleared]!, result = results[cleared]!;
    const stored = input.offload?.put(result.full, { call_id: turn.call.call_id });
    turns[cleared] = { ...turn, output: clearedToolResult(turn.call.name, { ok: result.ok, receipt: result.receipt, repeatable: result.repeatable, ...(stored ? { stored } : {}) }) };
    // A cleared read that can repeat runs for real next time, instead of answering from a result the model no longer sees.
    if (result.repeatable && seen.get(result.key)?.ok) seen.delete(result.key);
    cleared += 1;
  };
  const clearThrough = (end: number) => { while (cleared < end) clearNext(); };
  const clearOldResults = () => {
    const newest = roundStarts.at(-1) ?? 0;
    let total = turns.slice(cleared).reduce((sum, turn) => sum + turn.output.length, 0);
    if (total <= TOOL_RESULTS_KEEP_CHARS) return;
    while (cleared < newest && total > TOOL_RESULTS_KEEP_CHARS / 2) {
      total -= turns[cleared]!.output.length;
      clearNext();
    }
  };
  // When each provider that answered this loop last returned: its cache entry lives from the start of that request, so
  // the return is the latest it can have been refreshed.
  const answeredAt = new Map<Provider, number>();
  const cacheCold = (now: number): boolean => answeredAt.size > 0 && [...answeredAt].every(([provider, at]) => {
    const lifetime = PROMPT_CACHE_TTL_MS[provider];
    return lifetime !== undefined && now - at >= lifetime;
  });
  let browsingWithheld = false;
  let exit: LoopExit = 'completed';
  for (let round = 0; ; round += 1) {
    const timeLeft = deadline - Date.now();
    const roundsAvailable = round < input.maxSteps && (input.budget === undefined || input.budget.remaining > 0);
    // A tool round starts only while one full model call is left for the final answer.
    const timeAvailable = timeLeft >= FINAL_ANSWER_RESERVE_MS;
    // propose_action is the route for a privileged call whose arguments came from external content, so it is on the
    // menu exactly while the turn is tainted; the browse tools leave it once browsing is withheld.
    const tainted = (input.ctx as { toolArgSourceTaint?: unknown }).toolArgSourceTaint === 'external';
    const roundTools = input.stableMenu ? tools : tools.filter((tool) => (tool.name !== 'propose_action' || tainted) && !(browsingWithheld && BROWSE_TOOLS.has(tool.name)));
    const offer = roundTools.length > 0 && roundsAvailable && timeAvailable;
    // An initially empty authority ceiling can reject an illegal request once and
    // give the model a final closing step. This consumes a round and performs no I/O.
    const repairEmptyCeiling = tools.length === 0 && round === 0 && roundsAvailable && timeAvailable;
    if (exit === 'completed' && !roundsAvailable) exit = 'budget_exhausted';
    else if (exit === 'completed' && !timeAvailable) exit = 'time_exhausted';
    // With no time left even for the answer, say so instead of starting a model call that cannot finish.
    if (!offer && !repairEmptyCeiling && timeLeft <= 0) {
      input.onSettle?.('time_exhausted');
      return unfinishedReply('time_exhausted', done);
    }
    if ((offer || repairEmptyCeiling) && input.budget !== undefined) input.budget.remaining -= 1;
    input.ctx.runScope?.admit();
    let response: Awaited<ReturnType<ToolLoopStep>>;
    try {
      response = await withCallDeadline(runScope, deadline, () => input.step(offer ? roundTools : undefined, shownTurns()));
    } catch (error) {
      // A model step that fails once the turn's time is gone ends the turn plainly; a closed or stopped run never does.
      if (error instanceof ClosedRunError || runScope?.signal?.aborted || Date.now() < deadline) throw error;
      input.onSettle?.('time_exhausted');
      return unfinishedReply('time_exhausted', done);
    }
    input.ctx.runScope?.admit();
    if (response.model !== undefined) answeredAt.set(PROVIDER_OF[response.model], Date.now());
    // A hosted web search runs inside the model's own call, so its results arrive in the response rather than as a tool
    // result. They taint the rest of the turn the same way (ADR-0049), before this round's calls are dispatched.
    if (response.output_items?.some((item) => item.type === 'web_search_call')) {
      (input.ctx as { toolArgSourceTaint?: unknown }).toolArgSourceTaint = 'external';
    }
    if (response.tool_calls === undefined || (!offer && !repairEmptyCeiling)) {
      input.onSettle?.(exit);
      return guardArtifactLinks(response.text || (exit === 'budget_exhausted' || exit === 'time_exhausted'
        ? unfinishedReply(exit, done)
        : tools.length === 0 ? 'No tools are available this turn; no tool calls were executed.' : ''), receiptUrls);
    }
    let firstCall = true;
    roundStarts.push(turns.length);
    const calls = response.tool_calls;
    // Reads dispatched ahead of their turn in a batch, by call index. A batch starts at the first read of a run of
    // concurrent reads and is fully settled before any of its results is applied, so a hook's context write-back never
    // lands over a taint the loop applied. Results then apply strictly in model order, as if each had just run.
    const early = new Map<number, Promise<Readonly<{ result: LoopToolResult; ms: number }>>>();
    let batchLead = true;
    for (const [index, call] of calls.entries()) {
      input.ctx.runScope?.admit();
      if (!early.has(index)) {
        const batch = offer ? concurrentBatch(calls, index, mutationTools, seen) : [index];
        if (batch.length > 1) {
          for (const member of batch) {
            const startedAt = Date.now();
            early.set(member, dispatch(calls[member]!, input).then((result) => ({ result, ms: Date.now() - startedAt })));
          }
          await Promise.allSettled(batch.map((member) => early.get(member)!));
          input.ctx.runScope?.admit();
        }
        batchLead = true;
      }
      const started = Date.now();
      const key = `${call.name}\u0000${call.arguments}`;
      const cached = seen.get(key);
      // Only a completed host action in this exact retained session opens another
      // identical read. Reads and unrelated mutation successes are not action proof.
      const anchor = browserReads.get(key);
      const retainedRead = call.name === 'browse_page' && cached?.ok && anchor
        && sessionHandle(cached.data,'session_handle') === anchor.handle
        && (browserActions.get(anchor.handle) ?? 0) > anchor.epoch;
      const mutation = mutationTools.has(call.name as never);
      const lastRun = readRuns.get(key);
      const readMayRepeat = cached?.ok === true && !mutation && !BROWSE_TOOLS.has(call.name) && lastRun !== undefined
        && (dispatched > lastRun.dispatched || Date.now() - lastRun.at >= READ_REPEAT_AFTER_MS);
      const previous = retainedRead || readMayRepeat ? undefined : cached;
      const runs = !previous && offer && !(browsingWithheld && BROWSE_TOOLS.has(call.name));
      // Preserve settled nonretryable failures and mutation failures verbatim.
      // Replaying them performs no I/O; transient reads may retry within the budget.
      const settled = early.has(index) ? await early.get(index) : undefined;
      let result = previous
        ? previous.ok
          ? refusal(toolError('repeat_refusal'), 'repeat_refusal')
          : previous
        : !offer
          ? refusal(toolError('tools_withdrawn'), 'not_found', 'handler_unavailable')
          : !runs
            ? refusal(toolError('browsing_withheld', BROWSING_UNAVAILABLE), 'auth_failed', 'withheld_this_turn')
            : settled?.result ?? await dispatch(call, input);
      if (runs) {
        dispatched += 1;
        readRuns.set(key, { dispatched, at: Date.now() });
        if (result.ok) done.push(call.name);
      }
      input.ctx.runScope?.admit();
      const browsingNote = !browsingWithheld && !result.ok && result.code === 'auth_failed' && BROWSE_TOOLS.has(call.name)
        ? `\n[${BROWSING_UNAVAILABLE}]`
        : '';
      if (browsingNote) browsingWithheld = true;
      if (!previous && !result.ok && result.connect) {
        const offerKey = `${result.connect.service}:${result.connect.reason}`;
        let outcome = offered.get(offerKey);
        if (outcome === undefined) {
          let answer: boolean | string | undefined;
          // An offer failure must not break the turn; the model hears that nothing was sent.
          try { answer = await input.onConnect?.(result.connect); } catch { console.error(JSON.stringify({ hop: 'connect_offer', ok: false, code: 'offer_threw' })); }
          outcome = answer === true ? CONNECT_BUTTON_SENT : typeof answer === 'string' ? answer : CONNECT_BUTTON_UNSENT;
          offered.set(offerKey, outcome);
        }
        result = { ...result, error: `${result.error} ${outcome}` };
      }
      // The error shape alone decides recovery: only a typed adapter failure classified transient is retryable.
      // Validation, hook halts and unexpected handler throws are not evidence of retryability.
      const retryableRead = !result.ok && result.retryable === true;
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
      const toolTimeLeft = deadline - Date.now() - FINAL_ANSWER_RESERVE_MS;
      // Round notes only exist when the cap exceeds the window; tiny test caps that exercise the withdrawal mechanism
      // itself stay note-free. The roundsLeft 0 notice is the graceful close - the model is told the budget is exhausted
      // alongside its last tool result, so the final no-tools step comes back as words. The turn's deadline closes the
      // same way, whatever the round cap.
      const budgetNote = toolTimeLeft < 0
        ? TIME_UP_NOTE
        : input.maxSteps > WARN_WINDOW_ROUNDS && roundsLeft === 0
          ? `\n[budget: tool budget exhausted this turn - no more tool calls; ${CLOSING}]`
          : input.maxSteps > WARN_WINDOW_ROUNDS && roundsLeft > 0 && roundsLeft < WARN_WINDOW_ROUNDS
            ? `\n[budget: ${roundsLeft} tool round${roundsLeft === 1 ? '' : 's'} left this turn - finish the step you are on, then answer with what is done and what is left]`
            : toolTimeLeft < TOOL_TIME_WARN_MS
              ? '\n[budget: under 15 s of tool time left this turn - finish the step you are on, then answer with what is done and what is left]'
              : '';
      const replayNote = previous && !previous.ok
        ? '\n[repeat: cached failure from this turn; no new tool execution]'
        : '';
      const output = capToolOutput(JSON.stringify(result), input.offload, call.call_id) + replayNote + browsingNote + budgetNote;
      turns.push({ call, output, ...(firstCall && response.output_items?.length ? { prior_items: [...response.output_items] } : {}) });
      results.push({ full: JSON.stringify(result), ok: result.ok, receipt, key, repeatable: !mutation && !BROWSE_TOOLS.has(call.name) });
      firstCall = false;
      // The typed code/reason ride the span as their own fields so a failed hop stays
      // diagnosable from the trace or tail even when the capture switch gates free-form error
      // text off; error keeps the human-facing message for capture-on.
      const typed = result.ok ? undefined : (result as { code?: string; reason?: string; guard?: string; error_code?: string; retryable?: boolean; blocked?: RungBlockedOutcome });
      const failure = result.ok ? undefined : result.error ?? (typed?.code ? `${typed.code}${typed.reason ? `:${typed.reason}` : ''}` : undefined);
      input.onTool?.({
        call, ok: result.ok, ms: settled?.ms ?? Date.now() - started, output, parallel_batches: batchLead ? 1 : 0,
        taint: (input.ctx as { toolArgSourceTaint?: unknown }).toolArgSourceTaint === 'external' ? 'external' : null,
        ...(failure ? { error: failure } : {}),
        ...(typed?.code ? { code: typed.code } : {}),
        ...(typed?.error_code ? { error_code: typed.error_code } : {}),
        ...(typed?.retryable !== undefined ? { retryable: typed.retryable } : {}),
        ...(typed?.reason ? { reason: typed.reason } : {}),
        ...(typed?.guard ? { guard: typed.guard } : {}),
        ...(typed?.blocked ? { blocked: typed.blocked } : {}),
      });
      batchLead = false;
      if(call.name==='use_mac' && result.ok && result.data && typeof result.data==='object' && 'request_id' in result.data && typeof result.data.request_id==='string') {
       input.onSettle?.('completed');
       // The handler's status says whether the Mac took the request (and whether it asks for approval) or it is still queued.
       const status='status' in result.data && typeof result.data.status==='string' ? result.data.status : 'Sent to your Mac.';
       return `${status} Request: ${result.data.request_id}`;
      }
    }
  }
}

// The calls from `start` that may dispatch together: the run of concurrent reads beginning there, up to the cap, each a
// call the loop would dispatch now (no settled result for its exact arguments this turn) and none repeating an earlier
// call's arguments in the run, which then meets that call's settled result exactly as it would in order. A single call,
// a write, or a read that would not dispatch is a batch of one and runs in order.
const concurrentBatch = (calls: readonly LLMToolCall[], start: number, mutationTools: ReadonlySet<string>, seen: ReadonlyMap<string, unknown>): readonly number[] => {
  const batch: number[] = [];
  const keys = new Set<string>();
  for (let index = start; index < calls.length && batch.length < MAX_CONCURRENT_READS; index += 1) {
    const call = calls[index]!;
    const key = `${call.name}\u0000${call.arguments}`;
    if (!CONCURRENT_READ_TOOLS.has(call.name as ToolName) || mutationTools.has(call.name) || BROWSE_TOOLS.has(call.name)) break;
    if (seen.has(key) || keys.has(key)) break;
    keys.add(key);
    batch.push(index);
  }
  return batch.length > 1 ? batch : [start];
};

type LoopToolResult = Readonly<{ ok: boolean; data?: unknown; error?: string; error_code?: string; fix?: string; retryable?: boolean; code?: string; reason?: string; guard?: string; source_taint?: 'external' | null; connect?: ConnectIntent; blocked?: RungBlockedOutcome }>;

// A refusal the loop makes itself, in the dispatcher's error shape; code and reason keep their telemetry vocabulary.
const refusal = (error: ToolError, code: string, reason?: string): LoopToolResult =>
  ({ ok: false, error: error.cause, error_code: error.code, fix: error.fix, retryable: error.retryable, code, ...(reason ? { reason } : {}) });

async function dispatch(
  call: LLMToolCall,
  input: Readonly<{ handlers: DispatchToolOptions<ToolDispatcherContext>['handlers']; ctx: ToolDispatcherContext; offload?: ToolOutputStore }>,
): Promise<LoopToolResult> {
  const name = toolNameSchema.safeParse(call.name);
  if (!name.success) return refusal(toolError('unknown_tool', `Unknown tool ${call.name}.`), 'invalid_args', 'unknown_tool');
  let args: unknown;
  try {
    args = JSON.parse(call.arguments || '{}');
  } catch {
    return refusal(toolError('invalid_json_args'), 'invalid_args', 'invalid_args');
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
    error_code: result.error_code,
    fix: result.fix,
    retryable: result.retryable,
    ...(result.blocked ? { blocked: result.blocked } : {}),
    ...(typed.code ? { code: typed.code } : {}),
    ...(typed.reason ? { reason: typed.reason } : {}),
    // Enum-only guard stage:reason - the trace-visible diagnostic when capture is off.
    ...(result.guard ? { guard: `${result.guard.check}:${result.guard.reason}` } : {}),
    ...(result.source_taint ? { source_taint: result.source_taint } : {}),
    ...(result.connect ? { connect: result.connect } : {}),
  };
}
