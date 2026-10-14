import type { RunEffectScope } from '../channels/run-effect-scope';

// How long a turn may spend, in one place.

// One model request's own limit. A live model call typically takes about 6 s, so a request still open at 30 s is
// treated as lost.
export const MODEL_CALL_TIMEOUT_MS = 30_000;
// An owner turn's reply and subagent calls may reason far longer than an auxiliary call; the turn's deadline still
// bounds each one.
export const OWNER_TURN_CALL_TIMEOUT_MS = 120_000;
// A turn's tool rounds and answer end this long before its run is closed without its reply. The margin covers the work
// before the loop and any tool still running at the deadline, since started tools are never cut. A Telegram run is
// closed 14 minutes after it is claimed, so its turn has 13.5; an app or iMessage run has 15 minutes, so its turn has 14.5.
export const RUN_CLOSE_MARGIN_MS = 30_000;
// Cloudflare stops an alarm handler at 15 minutes of wall time. Every run the owner object's alarm claims closes within
// this budget, counted from the alarm's start; the minute left covers closing the last run.
export const ALARM_TURN_BUDGET_MS = 14 * 60_000;
// A run starts inside an alarm only with this much of the budget left: its close margin, one tool round's model call and
// the answer reserve. Otherwise its row waits, admitted, for a fresh alarm.
export const ALARM_TURN_MIN_MS = RUN_CLOSE_MARGIN_MS + MODEL_CALL_TIMEOUT_MS + MODEL_CALL_TIMEOUT_MS;
// The deadline to claim a run with: its own window, cut to the alarm's budget when an alarm runs it. Null when too
// little of that budget is left to start it.
export const runClaimDeadline = (windowMs: number, alarmEnd: number | undefined, now = Date.now()): number | null => {
  const deadline = Math.min(now + windowMs, alarmEnd ?? Infinity);
  return deadline - now >= ALARM_TURN_MIN_MS ? deadline : null;
};
// The turn's time when no run bounds it, counted from the tool loop's start.
export const TURN_TIME_BUDGET_MS = 120_000;
// A scheduled job's turn has no run, so it gets TURN_TIME_BUDGET_MS from its loop's start. An alarm starts one only with
// that much of its budget left, plus the close margin; otherwise the job stays due for a fresh alarm.
export const ALARM_JOB_MIN_MS = TURN_TIME_BUDGET_MS + RUN_CLOSE_MARGIN_MS;
// Tool rounds follow the time a turn has: 25 for two minutes, never fewer, and never past a ceiling that stops a model
// stuck in a loop from spending a long run's whole deadline one tool call at a time.
export const TOOL_ROUNDS_PER_TURN_BUDGET = 25;
export const TOOL_ROUNDS_CEILING = 150;
// Naming a thread runs in the owner object's serial queue after the app drain, so one slow title call would hold back
// every surface's next turn. It gets one live call's typical time with room to spare, then the thread stays untitled.
export const THREAD_TITLE_BUDGET_MS = 15_000;
// No tool round starts unless one full model call is left for the final answer.
export const FINAL_ANSWER_RESERVE_MS = MODEL_CALL_TIMEOUT_MS;
// The longest wait a provider may ask for before a failed call is sent again; the OpenAI SDK honours a retry-after
// only below 60 s. A longer one fails the call at once.
export const PROVIDER_WAIT_MAX_MS = 60_000;
// The wait before resending a rate-limited call that named none: the OpenAI SDK's first backoff, less up to 25% jitter.
export const RATE_LIMIT_BACKOFF_MS = 500;

// The tool loop is the only writer: it sets the turn's deadline on the run's scope for each model step, and the
// provider and the model adapter read it, so a retry or a late call never runs past the turn. Keyed by the scope
// object the turn passes to both the loop and its model step; one loop drives a scope at a time, and a nested loop
// only tightens it.
const callDeadlines = new WeakMap<RunEffectScope, number>();

export async function withCallDeadline<T>(scope: RunEffectScope | undefined, deadline: number, work: () => Promise<T>): Promise<T> {
  if (scope === undefined) return work();
  const outer = callDeadlines.get(scope);
  callDeadlines.set(scope, outer === undefined ? deadline : Math.min(outer, deadline));
  try {
    return await work();
  } finally {
    if (outer === undefined) callDeadlines.delete(scope);
    else callDeadlines.set(scope, outer);
  }
}

export const turnDeadlineFor = (scope: RunEffectScope | undefined, now = Date.now()): number =>
  scope === undefined ? now + TURN_TIME_BUDGET_MS : scope.deadline - RUN_CLOSE_MARGIN_MS;

export const toolRoundsFor = (timeMs: number): number =>
  Math.min(TOOL_ROUNDS_CEILING, Math.max(TOOL_ROUNDS_PER_TURN_BUDGET, Math.floor((timeMs * TOOL_ROUNDS_PER_TURN_BUDGET) / TURN_TIME_BUDGET_MS)));

// Infinity when no loop has set a deadline for this scope.
export const callTimeLeftMs = (scope: RunEffectScope | undefined, now = Date.now()): number => {
  const deadline = scope === undefined ? undefined : callDeadlines.get(scope);
  return deadline === undefined ? Infinity : deadline - now;
};
