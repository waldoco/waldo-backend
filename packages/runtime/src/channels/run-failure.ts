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
  if (turn === 'model_empty') return 'model_unavailable';
  // owner-turn's model call, failed for a reason other than an outage (a refused request, a safety halt): fixed text, so its
  // shape is matched and nothing after the prefix is kept.
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
export const lastRunFailure = (kv: Pick<Kv, 'get'>, scheduleId: string): RunFailure | null => kv.get<RunFailure>(`${KEY}${scheduleId}`) ?? null;

// Wraps the jobs the scheduler runs: a run that throws keeps its code under the job's id and rethrows the same error, so the
// scheduler's own retry and pause stand as they are; a run that goes well forgets it. Waiting for the model is no failure.
export const recordingFailures = (executors: ScheduleExecutors, kv: Kv, now: () => number): ScheduleExecutors =>
  Object.fromEntries(Object.entries(executors).map(([kind, executor]) => [kind, async (entry: Parameters<NonNullable<ScheduleExecutors[keyof ScheduleExecutors]>>[0]) => {
    let result: Awaited<ReturnType<NonNullable<typeof executor>>>;
    try { result = await executor!(entry); } catch (error) { kv.put(`${KEY}${entry.id}`, { code: runFailureCode(error), at: now() } satisfies RunFailure); throw error; }
    if (result !== 'waiting_on_model') kv.delete(`${KEY}${entry.id}`);
    return result;
  }])) as ScheduleExecutors;
