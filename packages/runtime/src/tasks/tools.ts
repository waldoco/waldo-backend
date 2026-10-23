import {
  cancelTaskArgsSchema, startTaskArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type CancelTaskArgs, type StartTaskArgs, type ToolHandler, type ToolName,
} from '@waldo/contracts';
import type { TurnLogEntry } from '../channels/owner-turn-types';
import { numericHealthIn } from '../scribe/sanitiser';
import type { ToolDispatcherContext } from '../tools/dispatcher';
import { isMachine, TASK_DEADLINE_MS, taskBrief, type JobBook, type TaskBrief } from './jobs';
import { TASK_PROFILE_SPECS } from './profiles';

// The brain's two task tools. Whether a piece of work becomes a task is the model's call: nothing here routes work by its
// size or kind. start_task writes the job and wakes the jobs lane, which starts the worker after the write commits.

const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));
const refusal = (error: string, code: 'rejected' | 'not_found' = 'rejected') => ({ ok: false as const, error, code, source_taint: null });

export type TaskToolDeps = Readonly<{
  book: JobBook;
  now(): number;
  timezone(): string;
  // The surface whose tools the worker borrows and whose chain the report goes to.
  surface: string;
  wake(due: number): Promise<void>;
  // Stops a cancelled job's worker and drops its browser session.
  fence(jobId: string): void;
  log(entry: TurnLogEntry): void;
}>;

export const taskToolHandlers = (deps: TaskToolDeps) => [
  {
    name: 'start_task',
    description: 'Background work while you keep talking: long backlogs, many sources, web errands. The worker sees this brief, never this conversation; it cannot message, change or approve, and reports once. Need the answer in this reply? Use delegate_task.',
    schema: startTaskArgsSchema,
    trigger_allowlist: allowlist('start_task'),
    autonomy_gated: false,
    mutates_state: true,
    async handle(args: StartTaskArgs, ctx: ToolDispatcherContext) {
      const unavailable = TASK_PROFILE_SPECS[args.profile].unavailable;
      if (unavailable) return refusal(unavailable);
      const now = deps.now();
      const brief: TaskBrief = {
        title: args.title, goal: args.goal, context: args.context,
        done_when: args.done_when, effort: args.effort ?? 'standard', timezone: deps.timezone(), started_at: now,
      };
      // A brief persists with the job, and the owner's health values are never stored: say it in zone words instead.
      if (numericHealthIn(JSON.stringify(brief))) return refusal('The brief contains health values, which a task never stores. Describe them in words (for example "a low-recovery morning") and call start_task again.');
      // The job is keyed by the turn and its tool call, so a replayed turn's same call returns the job it already made.
      if (!ctx.turnId || !ctx.toolCallId) return refusal('Task invocation identity is unavailable.');
      const key = `${ctx.turnId}:${ctx.toolCallId}`;
      const { job, created } = deps.book.create({
        kind: 'task', profile: args.profile, idempotencyKey: key, origin: ctx.turnId, surface: deps.surface,
        brief, dueAt: now, deadlineAt: now + TASK_DEADLINE_MS,
        // A brief written in a turn that read someone else's words may carry them, so the report is applied as tainted.
        taint: ctx.toolArgSourceTaint === 'external' ? 'external' : null,
      });
      if (created) {
        deps.log({ trace: `task:${job.id}`, hop: 'task_created', ms: 0, ok: true, job_id: job.id, job_profile: args.profile });
        await deps.wake(now);
      }
      const made = taskBrief(job);
      return { ok: true as const, data: { status: 'started', job_id: job.id, profile: job.profile, title: made.title }, source_taint: null };
    },
  } satisfies ToolHandler<StartTaskArgs, unknown, ToolDispatcherContext>,
  {
    name: 'cancel_task',
    description: 'Stop a background task. Its worker is stopped at once and anything it returns later is discarded.',
    schema: cancelTaskArgsSchema,
    trigger_allowlist: allowlist('cancel_task'),
    autonomy_gated: false,
    mutates_state: true,
    async handle({ job_id }: CancelTaskArgs) {
      // Only tasks the model started: a retried owner message is the brain's own promise, kept or noticed by the jobs lane,
      // and a machine job is the brain's own background check, which the owner turns off with its schedule preference.
      const row = deps.book.get(job_id);
      if (row?.kind !== 'task' || isMachine(row)) return refusal('No task has that id.', 'not_found');
      const { title } = taskBrief(row);
      if (!deps.book.cancel(job_id, 'owner')) return refusal(`"${title}" already ${deps.book.get(job_id)?.status === 'cancelled' ? 'was cancelled' : 'finished'}.`);
      deps.fence(job_id);
      deps.log({ trace: `task:${job_id}`, hop: 'task_cancelled', ms: 0, ok: true, job_id, code: 'owner' });
      return { ok: true as const, data: { job_id, title, cancelled: true }, source_taint: null };
    },
  } satisfies ToolHandler<CancelTaskArgs, unknown, ToolDispatcherContext>,
];

// The running tasks, as the owner's turn sees them beside its open loops.
export const runningTasksLine = (book: JobBook): string => {
  const open = book.open().filter((row) => row.kind === 'task' && !isMachine(row));
  if (!open.length) return '';
  return ['Background tasks you started that have not reported yet (ids for cancel_task):', ...open.map((row) => {
    const brief = taskBrief(row);
    return `- ${row.id}: "${brief.title}" (${row.profile}, ${row.status === 'reported' ? 'finished, report pending' : `${row.rounds} steps so far`})`;
  })].join('\n');
};
