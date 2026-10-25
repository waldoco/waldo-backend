import { buildSessionState, toolError, type LLMToolCall, type LLMToolTurn, type TaskResult, type TurnOutcome } from '@waldo/contracts';
import { ClosedRunError, type RunEffectScope } from '../channels/run-effect-scope';
import type { TurnLogEntry } from '../channels/owner-turn-types';
import { PAID_RUNG_TOOLS, spendHold } from '../channels/owner-turn';
import { dispatchLoopTool, leadingNote, toolDefinitions, UNKEPT_EFFECT, type LoopToolResult } from '../conversation/tool-loop';
import { carriesTopic, hidesTopic, holdsIn } from '../memory/forget-guard';
import { numericHealthIn } from '../scribe/sanitiser';
import type { InMemoryCircuitBreaker } from '../llm/provider';
import type { DispatchToolOptions, ToolDispatcherContext } from '../tools/dispatcher';
import { eligibleHandlers } from '../tools/eligibility';
import { md5Hex } from '../channels/md5';
import { inMemoryToolOutputStore, type ToolOutputStore } from '../conversation/tool-output-store';
import { readToolOutputHandler } from '../tools/read-tool-output';
import { isMachine, jobCheckpoint, jobResult, replayBrief, retryBrief, taskBrief, type JobBook, type JobRow, type ReplayBrief, type ReplayOutcome, type TaskTicket } from './jobs';
import { BROWSER_TOOLS, FINISH_TASK, jobTools, unreplayable } from './profiles';
import { type ProviderOutcome, type TaskClaim, type TaskOutcome, type TaskSpend } from './worker-loop';

// The brain's side of the job protocol. Workers call in through four methods (claim, tool, checkpoint, report); each one
// checks the attempt's ticket against the job book first, so a fenced attempt can neither read nor write. The jobs lane,
// run in the owner's alarm pass, is the single retry owner: it starts attempts, restarts lapsed ones, applies results once,
// runs retried turns and sends progress notes.

type Handlers = DispatchToolOptions<ToolDispatcherContext>['handlers'];
export type TaskHostDeps = Readonly<{
  book: JobBook;
  now(): number;
  // The owner's tool handlers on the surface the job started from, and the dispatch context they run under.
  handlers(surface: string): Handlers;
  context(surface: string): Readonly<Pick<ToolDispatcherContext, 'authenticatedUserId' | 'sanitise' | 'egressAllowlist'>>;
  // Browser calls run in the brain's serial lane with the job's scope as the active run, because the owner's browser host
  // serves one active scope at a time.
  serialBrowser<T>(scope: RunEffectScope, work: () => Promise<T>): Promise<T>;
  releaseBrowser(scope: RunEffectScope): void;
  log(entry: TurnLogEntry): void;
  // The owner's month spend against their ceiling, when this object keeps one. It throws when it cannot be read.
  spend?(): Readonly<{ spentUsd: number; ceilingUsd: number }> | undefined;
  // Arms the jobs lane's wake.
  wake(due: number): Promise<void>;
  // Runs an approved card's frozen call once, on the surface whose desk froze it, under the given scope. The host checks
  // the card is still the one approved; the outcome claims only what the replay established.
  replayApproval(surface: string, brief: ReplayBrief, scope: RunEffectScope): Promise<ReplayOutcome>;
  // Ends the approval cards a run raised and the owner has not decided, for a job that was cancelled or forgotten.
  withdrawCards?(runRef: string): void;
  // Topics the owner asked to forget whose purge has not settled. A running task keeps them held (jobs.forget), and a
  // checkpoint that carries one cancels its job rather than write it back.
  heldTopics?(): readonly string[];
  // Whether the directory still admits the owner, asked before each worker call as an owner job asks before each effect.
  // Without it (no directory on this deploy) the owner stands.
  admitted?(): Promise<'admitted' | 'dormant' | 'retry'>;
  // The owner's provider breaker. A claim carries its state to the worker, and the outcomes a worker sends back are replayed
  // into it, so a provider down for a worker is down for the owner's turns and the other workers too.
  providerHealth?: Pick<InMemoryCircuitBreaker, 'snapshot' | 'recordSuccess' | 'recordFailure'>;
}>;

// After a provider outage a task waits before its next attempt: 2, 5, 10, then every 20 minutes until its deadline.
export const TASK_DEFER_MS = [2, 5, 10, 20].map((minutes) => minutes * 60_000);
export const deferDelay = (deferrals: number): number => TASK_DEFER_MS[Math.min(deferrals, TASK_DEFER_MS.length - 1)]!;

const traceOf = (ticket: TaskTicket) => `task:${ticket.jobId}:${ticket.attempt}`;
export const TURN_OUTCOME = { done: 'completed', partial: 'answered', blocked: 'blocked', failed: 'failed' } as const satisfies Record<TaskResult['status'], TurnOutcome>;
const REPLAY_TURN_OUTCOME = { done: 'completed', rejected: 'blocked', failed: 'failed', uncertain: 'failed' } as const satisfies Record<ReplayOutcome['status'], TurnOutcome>;
const failedResult = (code: string): TaskResult => ({ status: 'failed', summary: `The worker stopped with an error (${code}).`, findings: [], proposals: [], left: [] });
// The worker is asked to put readings in words before it finishes; a result that still carries one (a plain closing reply)
// is not stored.
const storableResult = (result: TaskResult): TaskResult => numericHealthIn(JSON.stringify(result))
  ? { status: result.status === 'done' ? 'partial' : result.status, summary: 'The worker\'s result named health readings with their numbers, which a task never stores, so it was not kept.', findings: [], proposals: [], left: ['The findings themselves: the owner can ask again, and Waldo can read their mail or files directly.'] }
  : result;

// A checkpoint persists in the owner object's storage, where health readings are not stored. What an owner-connected MCP
// server returns is not known to be free of them (a wearable's server, say), so its output is left out, and so is any other
// call or output the shared health floor (numericHealthIn) finds a reading in. A reading that check does not recognise (many
// lab values) stays in the checkpoint until the job settles or is cancelled. A resumed
// attempt reads it again if it still needs it, which a read allows; a step that cannot be replayed is told it already ran.
const UNKEPT_OUTPUT_TOOLS: ReadonlySet<string> = new Set(['read_mcp_tool']);
export const UNKEPT_OUTPUT = 'Not kept across a restart. Call the tool again if you still need this.';
export { UNKEPT_EFFECT };
// The note on dropped steps rides on the first kept turn's output, so it survives when that output is not kept.
// The provider items opening a round (reasoning summaries, interim words, every call of the round with its arguments) are
// emptied when any of them carries a reading: both adapters rebuild that round from its kept records, and an empty list
// still marks where the round starts.
const keptTurn = (turn: LLMToolTurn): LLMToolTurn => {
  const readingInCall = numericHealthIn(turn.call.arguments);
  const readingInItems = turn.prior_items !== undefined && numericHealthIn(JSON.stringify(turn.prior_items));
  const unkeptOutput = UNKEPT_OUTPUT_TOOLS.has(turn.call.name) || readingInCall || numericHealthIn(turn.output);
  if (!unkeptOutput && !readingInItems) return turn;
  return {
    ...turn, call: readingInCall ? { ...turn.call, arguments: '{}' } : turn.call,
    ...(readingInItems ? { prior_items: [] } : {}),
    ...(unkeptOutput ? { output: `${leadingNote(turn.output)}${unreplayable(turn.call.name) ? UNKEPT_EFFECT : UNKEPT_OUTPUT}` } : {}),
  };
};

// A step the taint gate holds for the owner's approval. A worker cannot raise a card (no profile holds propose_action) and
// never approves, so the task stops at the step and hands it back as a proposal: the report's apply turn asks the owner. A
// browser step cannot be replayed from an approval, so Waldo asks in words; a final form submit keeps the browser card.
const OWNER_STEP = {
  error: 'This step needs the owner\'s approval, which a task cannot ask for, so it did not run.',
  fix: `Do not try it again. Call ${FINISH_TASK} now with status blocked, this exact step (the tool and its arguments) in proposals, and what you found so far: Waldo asks the owner.`,
} as const;

// A spend that cannot be read holds the worker at the ceiling (the cheap route, no paid tools): read as no ceiling, a worker's
// spend would have no bound at all.
const UNREAD_SPEND = { spentUsd: 0, ceilingUsd: 0 } as const;

// A worker's read too large for one result (a web page, a long thread) is stored for its attempt and paged back with
// read_tool_output, as an owner turn's is. The store lives in this object's memory beside the attempt's run scope, never in
// its storage: it is emptied when the attempt is fenced (cancel, report, park, a new attempt, the owner suspended) and on an
// owner forget, and a lost store is a cache miss the worker answers by reading again. Its ids carry the job and attempt, so
// a worker resolves only what its own attempt stored, never an owner turn's output or another attempt's. Workers hold no
// health tool, so no health reading is stored here.
export const TASK_STORED_OUTPUTS_MAX = 16;

export const taskHost = (deps: TaskHostDeps) => {
  // Warned once per run of failed reads, so a lasting fault is visible without a line per worker call.
  let spendUnread = false;
  const ownerSpend = (): Readonly<{ spentUsd: number; ceilingUsd: number }> | undefined => {
    try {
      const spend = deps.spend?.();
      spendUnread = false;
      return spend;
    } catch {
      if (!spendUnread) deps.log({ trace: 'task', hop: 'task_spend_unread', ms: 0, ok: false, code: 'spend_unreadable' });
      spendUnread = true;
      return UNREAD_SPEND;
    }
  };
  // One run scope per live attempt, so a cancel aborts the attempt's in-flight I/O and every later admit fails.
  const scopes = new Map<string, Readonly<{ attempt: number; scope: RunEffectScope; abort: AbortController; outputs: ToolOutputStore }>>();
  const attemptFor = (ticket: TaskTicket, row: JobRow) => {
    const held = scopes.get(ticket.jobId);
    if (held && held.attempt === ticket.attempt) return held;
    if (held) fence(ticket.jobId);
    const abort = new AbortController();
    const admit = () => {
      if (abort.signal.aborted || deps.book.get(ticket.jobId)?.lease_token !== ticket.token) { abort.abort(); throw new ClosedRunError(); }
    };
    const scope: RunEffectScope = { runId: `task:${ticket.jobId}`, attempt: String(ticket.attempt), deadline: row.deadline_at, signal: abort.signal, admit, commit: (work) => { admit(); return work(); } };
    const attempt = { attempt: ticket.attempt, scope, abort, outputs: inMemoryToolOutputStore({ idPrefix: `${ticket.jobId}.${ticket.attempt}.`, maxItems: TASK_STORED_OUTPUTS_MAX }) };
    scopes.set(ticket.jobId, attempt);
    return attempt;
  };
  // Aborts the attempt's I/O and lets the browser host drop the job's session.
  const fence = (jobId: string) => {
    const held = scopes.get(jobId);
    if (!held) return;
    scopes.delete(jobId);
    held.outputs.clear();
    held.abort.abort();
    deps.releaseBrowser(held.scope);
  };
  // Tool calls running here now, by attempt. The attempt's worker is waiting on them, so its lease cannot have lapsed. An
  // earlier attempt's call still finishing says nothing about the attempt that replaced it.
  const busy = new Map<string, number>();
  const attemptKey = (ticket: Pick<TaskTicket, 'jobId' | 'attempt'>) => `${ticket.jobId}:${ticket.attempt}`;
  const logEvents = (events: readonly TurnLogEntry[]) => { for (const event of events) deps.log(event); };
  // Called only once the book has accepted the call's ticket: a fenced or stale call's outcomes are not replayed.
  const replay = (outcomes: readonly ProviderOutcome[]) => {
    for (const { provider, ok } of outcomes) {
      if (ok) deps.providerHealth?.recordSuccess(provider); else deps.providerHealth?.recordFailure(provider);
    }
  };
  const hop = (row: Pick<JobRow, 'id' | 'profile'>, hopName: string, fields: Partial<TurnLogEntry> = {}) =>
    deps.log({ trace: `task:${row.id}`, hop: hopName, ms: 0, ok: true, job_id: row.id, ...(row.profile ? { job_profile: row.profile } : {}), ...fields });
  // The owner's handlers, with read_tool_output bound to the attempt's own store in place of any the owner holds.
  const profileHandlers = async (row: JobRow, outputs: ToolOutputStore) => {
    const tools = jobTools(row);
    const allowed = deps.handlers(row.surface).filter((handler) => tools.includes(handler.name as never) && handler.name !== 'read_tool_output');
    const own: Handlers = tools.includes('read_tool_output') ? [...allowed, readToolOutputHandler(outputs)] : allowed;
    return (await eligibleHandlers(own)).handlers;
  };

  // One worker tool call's work, once the call holds its attempt busy.
  const serve = async (ticket: TaskTicket, row: JobRow, call: LLMToolCall, canaries: readonly string[]): Promise<LoopToolResult | 'fenced'> => {
    const started = deps.now();
    const allowed = jobTools(row).includes(call.name as never);
    const { scope, outputs } = attemptFor(ticket, row);
    // Asked fresh for every call: no worker acts for an owner the directory no longer admits.
    const admission = allowed && deps.admitted ? await deps.admitted().catch(() => 'retry' as const) : 'admitted';
    if (admission === 'dormant') {
      deps.book.suspend(row.id);
      fence(row.id);
      hop(row, 'task_suspended', { ok: false, code: 'owner_not_admitted' });
      return 'fenced';
    }
    let result: LoopToolResult;
    if (!allowed) {
      const error = toolError('acl_denied', `${call.name} is not a tool this task can use.`);
      result = { ok: false, error: error.cause, error_code: error.code, fix: error.fix, retryable: false, code: 'rejected' };
    } else if (admission === 'retry') {
      const unchecked = toolError('transient', 'The owner\'s access could not be checked just now, so nothing ran.');
      result = { ok: false, error: unchecked.cause, error_code: unchecked.code, fix: unchecked.fix, retryable: true, code: 'transient' };
    } else {
      const handlers = await profileHandlers(row, outputs);
      const spend = ownerSpend();
      const ctx: ToolDispatcherContext = {
        ...deps.context(row.surface), trigger: 'user_message', canaryTokens: [...canaries], sourceTaint: null, toolArgSourceTaint: 'external',
        hasApproval: () => false, runScope: scope, turnId: traceOf(ticket), toolCallId: call.call_id,
        // Past the ceiling a worker's paid tools are held the way an owner turn's are; the cost ledger counts each hold.
        heldTool: (tool: string) => {
          if (!spend || spend.spentUsd < spend.ceilingUsd || !PAID_RUNG_TOOLS.has(tool)) return null;
          deps.log({ trace: traceOf(ticket), hop: 'spend_hold', ms: 0, ok: false, code: `spend_ceiling_reached:${tool}`, error_code: 'spend_ceiling_reached', cost_kind: 'worker', job_id: row.id, job_profile: row.profile! });
          return spendHold(new Date(deps.now()));
        },
        session: buildSessionState({ trigger: 'user_message', canary_tokens: [...canaries], started_at: started }),
      };
      const effect = unreplayable(call.name);
      // Whether the step's handler was reached: the dispatcher can refuse a call before it (the taint gate, a hook, its schema).
      let entered = false;
      const reached = effect ? handlers.map(handler => handler.name !== call.name ? handler
        : { ...handler, handle: (...args: Parameters<typeof handler.handle>) => { entered = true; return handler.handle(...args); } }) : handlers;
      // The intent is written once the call can start, after any wait for the serial lane, with a fresh lease: a job that
      // waited behind a long turn did nothing yet and must not look like an interrupted effect.
      const run = async () => {
        scope.admit();
        if (!deps.book.touch(ticket, null) || (effect && !deps.book.beginEffect(ticket, { tool: call.name, call_id: call.call_id }))) throw new ClosedRunError();
        return dispatchLoopTool(call, { handlers: reached, ctx, offload: outputs });
      };
      try {
        result = BROWSER_TOOLS.has(call.name as never) ? await deps.serialBrowser(scope, run) : await run();
      } catch (error) {
        if (error instanceof ClosedRunError) return 'fenced';
        const failed = toolError('handler_failed');
        result = { ok: false, error: failed.cause, error_code: failed.code, fix: failed.fix, retryable: false, code: 'transient' };
      }
      // A handler that threw may have crossed its side-effect boundary first, so the effect is uncertain whatever the
      // worker would do next: the job parks rather than hand the worker a failure it might retry.
      if (effect && result.error_code === 'handler_failed') {
        deps.book.park(row.id, 'uncertain_effect');
        fence(row.id);
        hop(row, 'task_parked', { ok: false, code: 'uncertain_effect', detail: call.name });
        return 'fenced';
      }
      if (effect && !entered && !deps.book.endEffect(ticket)) return 'fenced';
      if (result.error_code === 'taint_needs_approval') result = { ...result, ...OWNER_STEP, retryable: false };
    }
    if (!deps.book.touch(ticket, result.source_taint === 'external' ? 'external' : null)) return 'fenced';
    deps.log({
      trace: traceOf(ticket), hop: `task_tool_${call.name}`, ms: deps.now() - started, ok: result.ok, job_id: row.id, job_profile: row.profile!, cost_kind: 'worker',
      ...(result.error_code ? { error_code: result.error_code } : {}), ...(result.error ? { error: result.error } : {}),
      text: { input: call.arguments, output: JSON.stringify(result) },
    });
    return result;
  };

  // A job the owner cancelled or forgot: its attempt is fenced, and a card its errand raised is withdrawn, since it asks
  // the owner to finish work they stopped. A job that reported keeps its cards: the report tells the owner about them.
  const cancelled = (jobId: string): void => { fence(jobId); deps.withdrawCards?.(`task:${jobId}`); };

  return {
    fence,
    cancelled,
    // An owner forget empties every attempt's stored outputs, as it empties an owner turn's: they are re-read if needed.
    forgetOutputs: (): void => { for (const held of scopes.values()) held.outputs.clear(); },
    // Jobs whose live attempt has a call running here.
    busy: (): ReadonlySet<string> => new Set([...busy.keys()].flatMap((key) => {
      const split = key.lastIndexOf(':');
      const jobId = key.slice(0, split);
      const row = deps.book.get(jobId);
      return row?.status === 'running' && String(row.attempt) === key.slice(split + 1) ? [jobId] : [];
    })),
    // The worker keeps its lease while a model call runs.
    heartbeat: async (ticket: TaskTicket): Promise<boolean> => deps.book.touch(ticket, null),
    async claim(ticket: TaskTicket): Promise<TaskClaim | 'fenced'> {
      // The same attempt rejoining while the brain still serves a call of its earlier invocation (a worker alarm that fired
      // again): that call may still be waiting for the serial lane, with no intent written yet. Both are fenced, so neither
      // invocation runs a step the other may also run; the lease then lapses and a new attempt resumes from the checkpoint.
      if (busy.has(attemptKey(ticket))) {
        const ended = deps.book.abandon(ticket);
        // A stale ticket whose own call is still finishing: the job has moved past that attempt, which is only fenced.
        if (ended === 'fenced') return 'fenced';
        fence(ticket.jobId);
        const row = deps.book.get(ticket.jobId);
        if (row) hop(row, 'task_rejoin_fenced', { ok: false, ...(row.park_reason ? { code: row.park_reason } : {}) });
        return 'fenced';
      }
      const row = deps.book.claim(ticket);
      if (row === 'parked') {
        fence(ticket.jobId);
        const parked = deps.book.get(ticket.jobId)!;
        hop(parked, 'task_parked', { ok: false, code: parked.park_reason ?? 'uncertain_effect' });
        return 'fenced';
      }
      if (row === 'fenced' || row.kind !== 'task' || row.profile === null) return 'fenced';
      // Frozen intent: a brief that changed after the job started is not run.
      if (md5Hex(row.brief_json) !== row.brief_digest) {
        deps.book.park(row.id, 'brief_changed');
        fence(row.id);
        hop(row, 'task_parked', { ok: false, code: 'brief_changed' });
        return 'fenced';
      }
      const handlers = await profileHandlers(row, attemptFor(ticket, row).outputs);
      const spend = ownerSpend();
      const { conversation_ref: _replyChain, ...brief } = taskBrief(row);
      return {
        jobId: row.id, profile: row.profile, brief, tools: toolDefinitions(handlers),
        mutations: handlers.filter((handler) => handler.mutates_state || handler.autonomy_gated).map((handler) => handler.name),
        turns: jobCheckpoint(row).turns, seq: row.checkpoint_seq, deadlineAt: row.deadline_at, roundsUsed: row.rounds,
        ownerRef: deps.context(row.surface).authenticatedUserId,
        ...(spend ? { spend } : {}),
        ...(deps.providerHealth ? { providerHealth: deps.providerHealth.snapshot() } : {}),
      };
    },
    // One worker tool call, run by the brain with the job's own scope. The profile's allowlist is enforced here, not trusted
    // from the worker. A job cancelled while the call ran gets nothing back.
    async tool(ticket: TaskTicket, call: LLMToolCall, canaries: readonly string[]): Promise<LoopToolResult | 'fenced'> {
      const row = deps.book.get(ticket.jobId);
      if (!row || !deps.book.touch(ticket, null)) return 'fenced';
      // Busy from here, before any wait (the directory, the serial lane), so a re-fired alarm rejoining this attempt in that
      // window is fenced by claim instead of dispatching the same step again.
      const key = attemptKey(ticket);
      busy.set(key, (busy.get(key) ?? 0) + 1);
      try {
        return await serve(ticket, row, call, canaries);
      } finally {
        const left = (busy.get(key) ?? 1) - 1;
        if (left > 0) busy.set(key, left); else busy.delete(key);
      }
    },
    // An approved action, run once by the brain itself: no worker holds it. The intent is on the job before the call can
    // start, so an attempt lost mid-call parks as an uncertain effect and is never run again blind. A browser step takes
    // the serial lane under the job's own scope, as a worker's does; this is called from outside that lane.
    async replay(ticket: TaskTicket): Promise<void> {
      const claimed = deps.book.claim(ticket);
      // Parked at its claim (past its deadline): the lane settles the card.
      if (claimed === 'parked') { fence(ticket.jobId); await deps.wake(deps.now()); return; }
      if (claimed === 'fenced' || claimed.kind !== 'approval_replay') return;
      const row = claimed, brief = replayBrief(row), started = deps.now();
      const { scope } = attemptFor(ticket, row);
      let outcome: ReplayOutcome;
      if (md5Hex(row.brief_json) !== row.brief_digest) {
        outcome = { status: 'failed', message: 'The stored action changed after you approved it, so nothing ran.' };
      } else {
        const run = async () => {
          if (!deps.book.beginEffect(ticket, { tool: brief.tool, call_id: row.idempotency_key })) throw new ClosedRunError();
          return deps.replayApproval(row.surface, brief, scope);
        };
        const key = attemptKey(ticket);
        busy.set(key, (busy.get(key) ?? 0) + 1);
        try {
          outcome = BROWSER_TOOLS.has(brief.tool as never) ? await deps.serialBrowser(scope, run) : await run();
        } catch (error) {
          // Fenced before the intent was written: nothing ran, and the cancel that fenced it settles the card.
          if (error instanceof ClosedRunError && deps.book.get(ticket.jobId)?.inflight_json == null) { fence(ticket.jobId); return; }
          outcome = { status: 'uncertain', message: 'The outcome of that action is unknown.' };
        } finally {
          const left = (busy.get(key) ?? 1) - 1;
          if (left > 0) busy.set(key, left); else busy.delete(key);
        }
      }
      const written = deps.book.reportReplay(ticket, outcome);
      fence(ticket.jobId);
      if (written !== 'accepted') return;
      hop(row, 'approval_replay_reported', { ok: outcome.status === 'done', ms: deps.now() - started, outcome: REPLAY_TURN_OUTCOME[outcome.status], code: outcome.status, detail: brief.tool });
      await deps.wake(deps.now());
    },
    async checkpoint(ticket: TaskTicket, seq: number, turns: readonly LLMToolTurn[], events: readonly TurnLogEntry[], spend: TaskSpend, outcomes: readonly ProviderOutcome[] = []): Promise<'ok' | 'stale' | 'fenced'> {
      logEvents(events);
      const kept = turns.map(keptTurn);
      const topics = deps.heldTopics?.() ?? [];
      if (topics.length && holdsIn(topics)(JSON.stringify(kept))) {
        if (!deps.book.touch(ticket, null) || !deps.book.cancel(ticket.jobId, 'forgotten')) { fence(ticket.jobId); return 'fenced'; }
        cancelled(ticket.jobId);
        hop(deps.book.get(ticket.jobId)!, 'task_cancelled', { code: 'forgotten' });
        return 'fenced';
      }
      const written = deps.book.checkpoint(ticket, seq, { turns: kept }, spend);
      if (written === 'fenced') { fence(ticket.jobId); return written; }
      if (written === 'ok') replay(outcomes);
      const row = deps.book.get(ticket.jobId)!;
      hop(row, 'task_checkpoint', { detail: `seq=${seq}:turns=${turns.length}` });
      const note = noteDue(row);
      if (note !== null && note <= deps.now()) await deps.wake(deps.now());
      return written;
    },
    async report(ticket: TaskTicket, outcome: TaskOutcome, events: readonly TurnLogEntry[], spend: TaskSpend, outcomes: readonly ProviderOutcome[] = []): Promise<'accepted' | 'duplicate' | 'fenced' | 'deferred' | 'parked'> {
      logEvents(events);
      const row = deps.book.get(ticket.jobId);
      if (!row) return 'fenced';
      const written = outcome.kind === 'unavailable'
        ? deps.book.defer(ticket, deps.now() + deferDelay(row.deferrals), spend)
        : deps.book.report(ticket, outcome.kind === 'result' ? storableResult(outcome.result) : failedResult(outcome.code), spend);
      if (written === 'fenced' || written === 'duplicate') { if (written === 'fenced') fence(ticket.jobId); return written; }
      replay(outcomes);
      fence(ticket.jobId);
      const after = deps.book.get(ticket.jobId)!;
      hop(after, written === 'deferred' ? 'task_deferred' : written === 'parked' ? 'task_parked' : 'task_reported', {
        ok: written !== 'parked', ms: deps.now() - after.created_at,
        ...(after.outcome ? { outcome: TURN_OUTCOME[after.outcome] } : {}),
        ...(after.park_reason ? { code: after.park_reason } : {}), ...(outcome.kind === 'failed' ? { error_code: outcome.code } : {}),
      });
      await deps.wake(written === 'deferred' ? after.due_at! : deps.now());
      return written;
    },
  };
};
export type TaskHost = ReturnType<typeof taskHost>;

// A long job tells the owner it is still running: first after two minutes, then ten minutes later. Each note interrupts the
// owner, and two already say the task is alive, so after them the owner hears only its report. A machine job never sends
// one: the owner did not start it.
export const TASK_NOTE_AFTER_MS = 2 * 60_000;
export const TASK_NOTE_EVERY_MS = 10 * 60_000;
export const TASK_NOTE_MAX = 2;
export const noteDue = (row: Pick<JobRow, 'status' | 'kind' | 'origin' | 'created_at' | 'last_note_at' | 'notes_sent'>): number | null =>
  row.status !== 'running' || row.kind !== 'task' || isMachine(row) || row.notes_sent >= TASK_NOTE_MAX ? null
    : row.last_note_at === null ? row.created_at + TASK_NOTE_AFTER_MS : row.last_note_at + TASK_NOTE_EVERY_MS;

export const heldTopicIn = (row: Pick<JobRow, 'brief_json' | 'result_json' | 'checkpoint_json'>, topics: readonly string[]): boolean =>
  topics.some((topic) => [row.brief_json, row.result_json, row.checkpoint_json].some((value) => value !== null && (carriesTopic(value, topic) || hidesTopic(value, topic))));

export { jobResult, retryBrief, taskBrief };
