import { APP_RUN_FAILURE_CODES_V1 } from '../../../contracts/src/app/controls';
import { ModelUnavailableError } from '../llm/provider';
import { OwnerAdmissionError } from '../identity/owner-message-admission';
import { ClosedRunError } from './run-effect-scope';
import { turnFailureCode } from './turn-failure-code';
import type { ScheduleExecutors } from '../scheduler/multiplexer';

// Why a scheduled job's run failed, as a closed code with no error text. The scheduler pauses a job after
// QUARANTINE_AFTER_ATTEMPTS failed runs in a row; the code of the latest one says why on the paused card (with one fixed line),
// in the job's trace, and in the count an operator reads from the Worker's logs (hop schedule_paused). Only error shapes this
// code throws itself classify; anything else is unknown, and nothing of the error's text is kept.
export const RUN_FAILURE_CODES = APP_RUN_FAILURE_CODES_V1;
export type RunFailureCode = (typeof RUN_FAILURE_CODES)[number];

export const runFailureCode = (error: unknown): RunFailureCode => {
  if (error instanceof ModelUnavailableError) return 'model_unavailable';
  if (error instanceof OwnerAdmissionError || error instanceof ClosedRunError) return 'owner_check';
  if (!(error instanceof Error)) return 'unknown';
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'timed_out';
  const turn = turnFailureCode(error);
  if (turn === 'turn_timeout') return 'timed_out';
  if (turn === 'sql_binding_mismatch' || turn === 'journal_transition') return 'storage';
  if (turn === 'owner_mismatch') return 'owner_check';
  if (turn === 'model_empty') return 'model_failed';
  // owner-turn's model call, failed for a reason other than an outage (a refused request, a safety halt, or a call the turn's
  // deadline cut off, which this message cannot tell apart): fixed text, so its shape is matched and nothing after it is kept.
  if (/^live model failed: [a-z_]+ /.test(error.message)) return 'model_failed';
  // owner-do's sentOrThrow and the outbox's own refusals.
  if (error.message === 'telegram send blocked' || error.message === 'send held for the owner, not delivered') return 'not_delivered';
  if (error.message === 'owner_unbound') return 'owner_check';
  if (error.message === 'final outbox capacity') return 'outbox_full';
  return 'unknown';
};

// The line a paused card shows, after the pause itself: what the owner can understand, never the error.
const LINES: Readonly<Record<RunFailureCode, string>> = {
  model_unavailable: "Waldo couldn't reach its model",
  model_failed: "Waldo's model couldn't answer it",
  timed_out: 'it took too long and was stopped',
  not_delivered: 'it was written but could not be delivered',
  owner_check: "Waldo couldn't confirm your account",
  outbox_full: 'too many messages were waiting to go out',
  storage: 'something went wrong saving it',
  unknown: 'something went wrong inside Waldo',
};
export const pausedLine = (code: RunFailureCode, tries: number): string => `Paused after ${tries} failed tries in a row: ${LINES[code]}`;

type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void; delete(key: string): unknown }>;
const KEY = 'schedule_failure_v1:';
export type RunFailure = Readonly<{ code: RunFailureCode; at: number }>;
const CODES: ReadonlySet<string> = new Set(RUN_FAILURE_CODES);
// A stored code outside the closed set (written by another version) reads as none, so it never reaches the card.
export const lastRunFailure = (kv: Pick<Kv, 'get'>, scheduleId: string): RunFailure | null => {
  const stored = kv.get<RunFailure>(`${KEY}${scheduleId}`);
  return stored && CODES.has(stored.code) && Number.isFinite(stored.at) ? stored : null;
};

// Wraps the jobs the scheduler runs. Each run starts by forgetting the last one's reason, so a run cut off without a throw (an
// eviction, which the scheduler still counts) leaves none rather than a stale one; a run that throws keeps its code under the
// job's id and rethrows the same error, so the scheduler's own retry and pause stand as they are.
export const recordingFailures = (executors: ScheduleExecutors, kv: Kv, now: () => number): ScheduleExecutors =>
  Object.fromEntries(Object.entries(executors).map(([kind, executor]) => [kind, async (entry: Parameters<NonNullable<ScheduleExecutors[keyof ScheduleExecutors]>>[0]) => {
    kv.delete(`${KEY}${entry.id}`);
    try { return await executor!(entry); } catch (error) { kv.put(`${KEY}${entry.id}`, { code: runFailureCode(error), at: now() } satisfies RunFailure); throw error; }
  }])) as ScheduleExecutors;
