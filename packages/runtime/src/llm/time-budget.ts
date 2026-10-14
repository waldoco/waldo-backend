import type { RunEffectScope } from '../channels/run-effect-scope';

// How long a turn may spend, in one place.

// One model request's own limit. A live model call typically takes about 6 s, so a request still open at 30 s is
// treated as lost.
export const MODEL_CALL_TIMEOUT_MS = 30_000;
// A turn's tool rounds and answer, counted from the tool loop's start. With the answer reserve, tool rounds stop 90 s in,
// past the slowest live turns measured (73 to 90 s end to end). A Telegram run is closed 150 s after it is claimed, so
// one model call's time (30 s) is left after the budget. That margin covers the work before the loop and any tool still
// running at the deadline, since started tools are never cut: a tool round that starts at the last moment has 60 s,
// less the work before the loop, before the run is closed without its reply.
export const TURN_TIME_BUDGET_MS = 120_000;
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

// Infinity when no loop has set a deadline for this scope.
export const callTimeLeftMs = (scope: RunEffectScope | undefined, now = Date.now()): number => {
  const deadline = scope === undefined ? undefined : callDeadlines.get(scope);
  return deadline === undefined ? Infinity : deadline - now;
};
