import { buildSessionState, toolError, type LLMToolCall, type LLMToolTurn, type TaskResult, type TurnOutcome } from '@waldo/contracts';
import { ClosedRunError, type RunEffectScope } from '../channels/run-effect-scope';
import type { TurnLogEntry } from '../channels/owner-turn-types';
import { dispatchLoopTool, toolDefinitions, type LoopToolResult } from '../conversation/tool-loop';
import { carriesTopic, hidesTopic } from '../memory/forget-guard';
import type { DispatchToolOptions, ToolDispatcherContext } from '../tools/dispatcher';
import { eligibleHandlers } from '../tools/eligibility';
import { md5Hex } from '../channels/md5';
import { jobCheckpoint, jobResult, retryBrief, taskBrief, type JobBook, type JobRow, type TaskTicket } from './jobs';
import { BROWSER_TOOLS, TASK_PROFILE_SPECS, unreplayable } from './profiles';
import type { TaskClaim, TaskOutcome, TaskSpend } from './worker-loop';

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
  context(): Readonly<Pick<ToolDispatcherContext, 'authenticatedUserId' | 'sanitise' | 'egressAllowlist'>>;
  // Browser calls run in the brain's serial lane with the job's scope as the active run, because the owner's browser host
  // serves one active scope at a time.
  serialBrowser<T>(scope: RunEffectScope, work: () => Promise<T>): Promise<T>;
  releaseBrowser(scope: RunEffectScope): void;
  log(entry: TurnLogEntry): void;
  // Arms the jobs lane's wake.
  wake(due: number): Promise<void>;
}>;

// After a provider outage a task waits before its next attempt: 2, 5, 10, then every 20 minutes until its deadline.
export const TASK_DEFER_MS = [2, 5, 10, 20].map((minutes) => minutes * 60_000);
export const deferDelay = (deferrals: number): number => TASK_DEFER_MS[Math.min(deferrals, TASK_DEFER_MS.length - 1)]!;

const traceOf = (ticket: TaskTicket) => `task:${ticket.jobId}:${ticket.attempt}`;
export const TURN_OUTCOME = { done: 'completed', partial: 'answered', blocked: 'blocked', failed: 'failed' } as const satisfies Record<TaskResult['status'], TurnOutcome>;
const failedResult = (code: string): TaskResult => ({ status: 'failed', summary: `The worker stopped with an error (${code}).`, findings: [], proposals: [], left: [] });

export const taskHost = (deps: TaskHostDeps) => {
  // One run scope per live attempt, so a cancel aborts the attempt's in-flight I/O and every later admit fails.
  const scopes = new Map<string, Readonly<{ attempt: number; scope: RunEffectScope; abort: AbortController }>>();
  const scopeFor = (ticket: TaskTicket, row: JobRow): RunEffectScope => {
    const held = scopes.get(ticket.jobId);
    if (held && held.attempt === ticket.attempt) return held.scope;
    if (held) fence(ticket.jobId);
    const abort = new AbortController();
    const admit = () => {
      if (abort.signal.aborted || deps.book.get(ticket.jobId)?.lease_token !== ticket.token) { abort.abort(); throw new ClosedRunError(); }
    };
    const scope: RunEffectScope = { runId: `task:${ticket.jobId}`, attempt: String(ticket.attempt), deadline: row.deadline_at, signal: abort.signal, admit, commit: (work) => { admit(); return work(); } };
    scopes.set(ticket.jobId, { attempt: ticket.attempt, scope, abort });
    return scope;
  };
  // Aborts the attempt's I/O and lets the browser host drop the job's session.
  const fence = (jobId: string) => {
    const held = scopes.get(jobId);
    if (!held) return;
    scopes.delete(jobId);
    held.abort.abort();
    deps.releaseBrowser(held.scope);
  };
  const logEvents = (events: readonly TurnLogEntry[]) => { for (const event of events) deps.log(event); };
  const hop = (row: Pick<JobRow, 'id' | 'profile'>, hopName: string, fields: Partial<TurnLogEntry> = {}) =>
    deps.log({ trace: `task:${row.id}`, hop: hopName, ms: 0, ok: true, job_id: row.id, ...(row.profile ? { job_profile: row.profile } : {}), ...fields });
  const profileHandlers = async (row: JobRow) => {
    const spec = TASK_PROFILE_SPECS[row.profile!];
    const allowed = deps.handlers(row.surface).filter((handler) => spec.tools.includes(handler.name as never));
    return (await eligibleHandlers(allowed)).handlers;
  };

  return {
    fence,
    async claim(ticket: TaskTicket): Promise<TaskClaim | 'fenced'> {
      const row = deps.book.claim(ticket);
      if (row === 'fenced' || row.kind !== 'task' || row.profile === null) return 'fenced';
      // Frozen intent: a brief that changed after the job started is not run.
      if (md5Hex(row.brief_json) !== row.brief_digest) {
        deps.book.park(row.id, 'uncertain_effect');
        fence(row.id);
        hop(row, 'task_parked', { ok: false, code: 'brief_changed' });
        return 'fenced';
      }
      scopeFor(ticket, row);
      const handlers = await profileHandlers(row);
      return {
        jobId: row.id, profile: row.profile, brief: taskBrief(row), tools: toolDefinitions(handlers),
        mutations: handlers.filter((handler) => handler.mutates_state || handler.autonomy_gated).map((handler) => handler.name),
        turns: jobCheckpoint(row).turns, seq: row.checkpoint_seq, deadlineAt: row.deadline_at, roundsUsed: row.rounds,
        ownerRef: deps.context().authenticatedUserId,
      };
    },
    // One worker tool call, run by the brain with the job's own scope. The profile's allowlist is enforced here, not trusted
    // from the worker. A job cancelled while the call ran gets nothing back.
    async tool(ticket: TaskTicket, call: LLMToolCall, canaries: readonly string[]): Promise<LoopToolResult | 'fenced'> {
      const row = deps.book.get(ticket.jobId);
      if (!row || !deps.book.touch(ticket, null)) return 'fenced';
      const started = deps.now();
      const allowed = row.profile !== null && TASK_PROFILE_SPECS[row.profile].tools.includes(call.name as never);
      const scope = scopeFor(ticket, row);
      let result: LoopToolResult;
      if (!allowed) {
        const error = toolError('acl_denied', `${call.name} is not a tool this task can use.`);
        result = { ok: false, error: error.cause, error_code: error.code, fix: error.fix, retryable: false, code: 'rejected' };
      } else {
        const handlers = await profileHandlers(row);
        const ctx: ToolDispatcherContext = {
          ...deps.context(), trigger: 'user_message', canaryTokens: [...canaries], sourceTaint: null, toolArgSourceTaint: 'external',
          hasApproval: () => false, runScope: scope, turnId: traceOf(ticket), toolCallId: call.call_id,
          session: buildSessionState({ trigger: 'user_message', canary_tokens: [...canaries], started_at: started }),
        };
        const effect = unreplayable(call.name);
        if (effect && !deps.book.beginEffect(ticket, { tool: call.name, call_id: call.call_id })) return 'fenced';
        const run = () => dispatchLoopTool(call, { handlers, ctx });
        try {
          result = BROWSER_TOOLS.has(call.name as never) ? await deps.serialBrowser(scope, run) : await run();
        } catch (error) {
          if (error instanceof ClosedRunError) return 'fenced';
          const failed = toolError('handler_failed');
          result = { ok: false, error: failed.cause, error_code: failed.code, fix: failed.fix, retryable: false, code: 'transient' };
        }
        if (effect) deps.book.endEffect(ticket);
      }
      if (!deps.book.touch(ticket, result.source_taint === 'external' ? 'external' : null)) return 'fenced';
      deps.log({
        trace: traceOf(ticket), hop: `task_tool_${call.name}`, ms: deps.now() - started, ok: result.ok, job_id: row.id, job_profile: row.profile!, cost_kind: 'worker',
        ...(result.error_code ? { error_code: result.error_code } : {}), ...(result.error ? { error: result.error } : {}),
        text: { input: call.arguments, output: JSON.stringify(result) },
      });
      return result;
    },
    async checkpoint(ticket: TaskTicket, seq: number, turns: readonly LLMToolTurn[], events: readonly TurnLogEntry[], spend: TaskSpend): Promise<'ok' | 'stale' | 'fenced'> {
      logEvents(events);
      const written = deps.book.checkpoint(ticket, seq, { turns }, spend);
      if (written === 'fenced') { fence(ticket.jobId); return written; }
      const row = deps.book.get(ticket.jobId)!;
      hop(row, 'task_checkpoint', { detail: `seq=${seq}:turns=${turns.length}` });
      const note = noteDue(row);
      if (note !== null && note <= deps.now()) await deps.wake(deps.now());
      return written;
    },
    async report(ticket: TaskTicket, outcome: TaskOutcome, events: readonly TurnLogEntry[], spend: TaskSpend): Promise<'accepted' | 'duplicate' | 'fenced' | 'deferred' | 'parked'> {
      logEvents(events);
      const row = deps.book.get(ticket.jobId);
      if (!row) return 'fenced';
      const written = outcome.kind === 'unavailable'
        ? deps.book.defer(ticket, deps.now() + deferDelay(row.deferrals), spend)
        : deps.book.report(ticket, outcome.kind === 'result' ? outcome.result : failedResult(outcome.code), spend);
      if (written === 'fenced' || written === 'duplicate') { if (written === 'fenced') fence(ticket.jobId); return written; }
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

// A long job tells the owner it is still running: first after two minutes, then every ten.
export const TASK_NOTE_AFTER_MS = 2 * 60_000;
export const TASK_NOTE_EVERY_MS = 10 * 60_000;
export const noteDue = (row: Pick<JobRow, 'status' | 'kind' | 'created_at' | 'last_note_at'>): number | null =>
  row.status !== 'running' || row.kind !== 'task' ? null : row.last_note_at === null ? row.created_at + TASK_NOTE_AFTER_MS : row.last_note_at + TASK_NOTE_EVERY_MS;

export const heldTopicIn = (row: Pick<JobRow, 'brief_json' | 'result_json' | 'checkpoint_json'>, topics: readonly string[]): boolean =>
  topics.some((topic) => [row.brief_json, row.result_json, row.checkpoint_json].some((value) => value !== null && (carriesTopic(value, topic) || hidesTopic(value, topic))));

export { jobResult, retryBrief, taskBrief };
