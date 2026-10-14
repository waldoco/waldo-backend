import type { ScheduleEntry, ToolName } from '@waldo/contracts';
import { CHILD_TOOL_NAMES, type BackgroundStart, type DelegationDeps } from '../../conversation/subagent';
import type { Scheduler } from '../../scheduler/multiplexer';
import { watchEffects } from '../../tools/dispatch-watch';
import type { RunBook } from '../background-runs';
import type { TurnLogEntry } from '../owner-turn-types';
import { responsibilityHandlers, responsibilityBook, type TodoItem } from '../responsibilities';
import { ClosedRunError } from '../run-effect-scope';
import { attemptJournal, type Attempt, type TaskStep } from './attempts';

// A step runs one bounded attempt per wake. The runner is the one retry owner: it never throws a step's failure to the
// scheduler, so the scheduler's own retries, pauses and pause notices never apply to a step.
export const MAX_ATTEMPTS = 3;
export const STEP_DEADLINE_MS = 150_000;
export const STEP_RETRY_MS = 30_000;
const RESULT_MAX = 4000;
const PRIOR_RESULT_MAX = 600;

type Sql = Pick<SqlStorage, 'exec'>;
type Deps = Readonly<{ newId(): string; now(): number }>;
export type StepHost = Readonly<{
  runs: RunBook;
  // The owner-job machine turn: run as the owner the directory admits, with `current` checked before every model call,
  // effect and reply. toolNames narrows the turn to those tools; undefined offers the full set, gated as any turn's.
  prompt(trace: string, task: string, toolNames: readonly ToolName[] | undefined, current: () => Promise<void>): Promise<string>;
  log(entry: TurnLogEntry): void;
}>;

// Attempts in flight in this object instance, keyed by its storage so a reset object starts with none even where the
// isolate survives. A running row found by a later wake that is not in flight here, or is past its deadline, was cut off
// by a crash, an eviction or a deploy; one in flight settles itself.
const inFlight = new WeakMap<object, Set<string>>();
const scheduleIdFor = (itemId: string, revision: number, attempt: number) => `task:${itemId}:${revision}:${attempt}`;

const stepTask = (responsibility: Readonly<{ title: string; intent: string }>, item: TodoItem, prior: readonly TodoItem[]) => [
  'You are working through a task you took on for the owner, one step per run.',
  `Task: ${responsibility.title}`,
  `What the owner wants: ${responsibility.intent}`,
  ...(prior.length ? ['Done so far:', ...prior.map((dep) => `- ${dep.title}: ${(dep.result_ref ?? '').slice(0, PRIOR_RESULT_MAX)}`)] : []),
  `This step: ${item.title}`,
  'Do this step only. Anything that needs the owner\'s yes goes through a proposal, as in any turn. Answer with a short report of what you did or found; it is kept on the step, not sent to the owner.',
].join('\n');

export const ownerTasks = (sql: Sql, scheduler: Pick<Scheduler, 'schedule' | 'cancel'>, deps: Deps) => {
  const book = responsibilityBook(sql, deps);
  const journal = attemptJournal(sql, deps);
  const live = inFlight.get(sql) ?? new Set<string>();
  inFlight.set(sql, live);

  const schedule = async (step: Pick<TaskStep, 'item_id' | 'responsibility_id'>, scheduleId: string, dueAt: number) => {
    await scheduler.schedule({ id: scheduleId, kind: 'task_step', payloadRefs: { responsibility_id: step.responsibility_id, item_id: step.item_id }, occurrenceAt: dueAt, dueAt, recurrence: null });
  };
  // Freezes the step at the revision it started from, then arms its first attempt to run now.
  const arm = async (item: TodoItem, revision: number, task: string | null, tools: readonly ToolName[] | null) => {
    const scheduleId = scheduleIdFor(item.id, revision, 1);
    journal.arm({ item_id: item.id, responsibility_id: item.responsibility_id, revision, task, tools, schedule_id: scheduleId });
    await schedule({ item_id: item.id, responsibility_id: item.responsibility_id }, scheduleId, deps.now());
  };
  // Finishing a step arms each of Waldo's steps it was holding back.
  const armRunnable = async (responsibilityId: string) => {
    for (const item of book.runnable(responsibilityId)) {
      const started = book.start(item.id, 'worker:task_step');
      if (started) await arm(started.item, started.revision, null, null);
    }
  };
  const taskOf = (step: TaskStep): string | null => {
    if (step.task !== null) return step.task;
    const responsibility = book.get(step.responsibility_id), item = book.item(step.item_id);
    if (!responsibility || !item) return null;
    return stepTask(responsibility, item, item.depends_on.map((dep) => book.item(dep)).filter((dep): dep is TodoItem => dep !== null));
  };
  const unschedule = async (itemIds: readonly string[]) => {
    for (const itemId of itemIds) {
      const step = journal.step(itemId);
      if (step) await scheduler.cancel(step.schedule_id);
    }
  };

  const startBackground: BackgroundStart = async ({ task, itemId, revision, tools }) => {
    const item = book.item(itemId);
    if (!item || item.revision !== revision) return false;
    await arm(item, revision, task, tools ?? CHILD_TOOL_NAMES);
    return true;
  };
  const delegation: DelegationDeps = { book, startBackground, newWorkerId: deps.newId };

  // The owner's own changes to a step, or dropping the whole responsibility, take its pending attempt off the schedule;
  // the revision bump already fences an attempt that is running. A runner's step marked done by hand, by the owner or by
  // the step's own turn, still lets the steps waiting on it go.
  const [track, updateTodo, list, close] = responsibilityHandlers(book);
  const handlers = [
    track,
    { ...updateTodo, async handle(args: Parameters<typeof updateTodo.handle>[0]) {
      const result = await updateTodo.handle(args);
      if (!result.ok) return result;
      const step = journal.step(args.item_id);
      await unschedule([args.item_id]);
      if (step && args.status === 'done') await armRunnable(step.responsibility_id);
      return result;
    } },
    list,
    { ...close, async handle(args: Parameters<typeof close.handle>[0]) {
      const result = await close.handle(args);
      if (result.ok) await unschedule(journal.stepsOf(args.id).map((step) => step.item_id));
      return result;
    } },
  ] as const;

  const executor = (host: StepHost) => {
    const trace = (entry: TurnLogEntry) => host.log(entry);
    const hop = (attempt: Pick<Attempt, 'id' | 'item_id' | 'attempt'>, responsibilityId: string, ok: boolean, code: string, effects: boolean, ms: number) =>
      trace({ trace: `task:${attempt.id}`, hop: 'task_step', ms, ok, code, responsibility_id: responsibilityId, detail: `item=${attempt.item_id} attempt=${attempt.attempt} effects_dispatched=${effects ? 1 : 0}` });
    const fail = (step: TaskStep, result: string) => book.finishWorker(step.item_id, step.revision, { status: 'failed', result });
    const failUncertain = (step: TaskStep) => {
      const written = fail(step, 'Outcome uncertain: a step with effects was interrupted before it finished.');
      if (written === 'applied') book.markUncertain(step.responsibility_id);
    };

    const attempt = async (step: TaskStep, task: string, number: number) => {
      const fenced = () => {
        const current = book.item(step.item_id);
        return !current || current.revision !== step.revision || current.status !== 'running';
      };
      const run = host.runs.start('task_step', step.responsibility_id);
      const row = journal.begin(step.item_id, step.revision, number, run.id);
      const started = deps.now();
      const deadline = started + STEP_DEADLINE_MS;
      const turn = `task:${row.id}`;
      live.add(row.id);
      const unwatch = watchEffects(turn, () => journal.markEffects(row.id));
      let text: string | null = null;
      let failure: unknown = null;
      try {
        text = await host.prompt(turn, task, step.tools ?? undefined, async () => {
          if (fenced() || deps.now() > deadline) throw new ClosedRunError();
        });
      } catch (error) {
        failure = error;
      } finally {
        unwatch();
        live.delete(row.id);
      }
      const effects = journal.effectsDispatched(row.id);
      const ms = deps.now() - started;
      if (failure === null) {
        journal.settle(row.id, 'done', 'completed');
        const written = book.finishWorker(step.item_id, step.revision, { status: 'done', result: text!.trim().slice(0, RESULT_MAX) || 'Done, with nothing to report.' });
        host.runs.finish(run.id, written === 'applied' ? 'completed' : 'stopped', written === 'applied' ? 'step done' : 'step changed while it ran; result kept aside');
        hop(row, step.responsibility_id, true, written === 'applied' ? 'done' : 'superseded', effects, ms);
        if (written === 'applied') await armRunnable(step.responsibility_id);
        return;
      }
      if (fenced()) {
        journal.settle(row.id, effects ? 'uncertain' : 'failed', 'fenced');
        book.finishWorker(step.item_id, step.revision, { status: 'failed', result: 'Stopped: the step was changed or cancelled while it ran.' });
        host.runs.finish(run.id, 'stopped', 'step changed while it ran');
        hop(row, step.responsibility_id, false, 'fenced', effects, ms);
        return;
      }
      if (effects) {
        journal.settle(row.id, 'uncertain', 'failed after an effect was dispatched');
        failUncertain(step);
        host.runs.finish(run.id, 'failed', 'step outcome uncertain');
        hop(row, step.responsibility_id, false, 'uncertain', effects, ms);
        return;
      }
      journal.settle(row.id, 'failed', failure instanceof ClosedRunError ? 'not admitted or past its deadline' : 'failed');
      host.runs.finish(run.id, 'failed', 'step failed');
      hop(row, step.responsibility_id, false, 'failed', effects, ms);
      if (number >= MAX_ATTEMPTS) { fail(step, `Could not finish after ${MAX_ATTEMPTS} attempts.`); return; }
      const next = scheduleIdFor(step.item_id, step.revision, number + 1);
      journal.rearm(step.item_id, next);
      await schedule(step, next, deps.now() + STEP_RETRY_MS * number);
    };

    return async (entry: ScheduleEntry): Promise<void> => {
      const itemId = entry.payload_refs.item_id;
      const step = itemId ? journal.step(itemId) : null;
      // An entry the step has moved past, or a step cancelled, changed or finished since it was armed, runs nothing.
      if (!step || step.schedule_id !== entry.id) return;
      const item = book.item(step.item_id);
      if (!item || item.revision !== step.revision || item.status !== 'running') return;
      const prior = journal.attempts(step.item_id, step.revision);
      const last = prior.at(-1);
      if (last?.status === 'running') {
        if (live.has(last.id) && deps.now() <= last.started_at + STEP_DEADLINE_MS) return;
        journal.settle(last.id, 'interrupted', 'interrupted');
        hop(last, step.responsibility_id, false, 'interrupted', last.effects_dispatched === 1, deps.now() - last.started_at);
        if (last.effects_dispatched === 1) { failUncertain(step); return; }
      }
      if (prior.length >= MAX_ATTEMPTS) { fail(step, `Could not finish after ${MAX_ATTEMPTS} attempts.`); return; }
      const task = taskOf(step);
      if (task === null) return;
      await attempt(step, task, prior.length + 1);
    };
  };

  return { book, journal, handlers, delegation, executor };
};
export type OwnerTasks = ReturnType<typeof ownerTasks>;
