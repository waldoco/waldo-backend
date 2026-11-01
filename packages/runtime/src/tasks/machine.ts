import type { TaskResult } from '@waldo/contracts';
import { ClosedRunError } from '../channels/run-effect-scope';
import type { TurnLogEntry } from '../channels/owner-turn-types';
import { md5Hex } from '../channels/md5';
import { ownerModels, ownerRoutePolicy, type OwnerModelAccess } from '../llm/owner-routes';
import { fenced } from '../prompt/turn-prompt';
import { numericHealthIn } from '../scribe/sanitiser';
import { deferDelay, TURN_OUTCOME } from './brain';
import { applyInterrupted, carriesForgotten, jobResult, MACHINE_ORIGIN, taskBrief, type JobBook, type JobRow, type MachineBrief, type MachineJob, type TaskBrief } from './jobs';

// Machine jobs: reader tasks the brain starts on its own schedule, so the reading runs on a worker and not in the owner's
// alarm pass. The brain decides deterministically that the data changed before it writes one; the worker judges whether
// any of it is worth the owner's attention; the brain's own apply turn writes the message, only when there is news.

// One piece of data a job was started on: a ref the brain and the worker can both name (a loop id, a message id) and the
// words that go with it.
export type MachineItem = Readonly<{ ref: string; detail: string }>;
// A brief persists with its job, and the owner's health values are never stored: an item that carries one keeps its ref,
// so the worker can still look it up, and drops its words.
export const HEALTH_DETAIL_DROPPED = '(detail not kept: it carries health values; read it by its ref if you need it)';
const keptItem = (item: MachineItem): MachineItem => numericHealthIn(item.detail) ? { ref: item.ref, detail: HEALTH_DETAIL_DROPPED } : item;

export type MachineSpec = Readonly<{
  job: MachineJob; scope: string; key: string; surface: string;
  text: Readonly<{ title: string; goal: string; done_when: string }>;
  items: readonly MachineItem[]; timezone: string; now: number; deadlineAt: number;
  source?: MachineBrief['source']; runId?: string; recordId?: number;
  // The job's own digest of its inputs, where it already has one its apply compares against (meeting prep's event digest).
  inputDigest?: string;
  // When the worker may start, if later than now; and the tool rounds its whole run gets, if fewer than a task's.
  dueAt?: number; maxRounds?: number;
}>;
export type MachineEnqueued = Readonly<{ code: 'enqueued' | 'existing' | 'held_open_job'; job: JobRow }> | Readonly<{ code: 'held_topic' }>;

// Writes the job, or names the one that stands in its place: the same key returns the job it made, settled or not, and
// a job and scope with a job still open waits for it, so a burst of ticks coalesces into the open job. Synchronous, so the
// caller writes it in the same transaction as the check that read its data. held: the topics the owner is forgetting whose
// purge has not settled (heldTopicsOf). A job whose inputs carry one (its brief, machine block included, or the source text
// it was given, a detail the brief drops too) is not written, so the forget wins; the next tick asks again.
export const enqueueMachine = (book: JobBook, spec: MachineSpec, held: readonly string[]): MachineEnqueued => {
  const open = book.openMachine(spec.job, spec.scope);
  if (open) return { code: open.idempotency_key === spec.key ? 'existing' : 'held_open_job', job: open };
  const items = spec.items.map(keptItem);
  const withheld = items.flatMap(item => item.detail === HEALTH_DETAIL_DROPPED ? [item.ref] : []);
  const brief: TaskBrief = {
    ...spec.text,
    context: fenced('Data fetched for this job', items.map(({ ref, detail }) => `- [${ref}] ${detail}`).join('\n')).trim(),
    effort: 'standard', timezone: spec.timezone, started_at: spec.now,
    // A change detector over the data the job was started on, not a guard against an adversary, so MD5 is enough.
    machine: {
      job: spec.job, input_digest: spec.inputDigest ?? md5Hex(JSON.stringify(items)), scope: spec.scope, refs: items.map(item => item.ref),
      ...(spec.source ? { source: spec.source } : {}), ...(spec.runId ? { run_id: spec.runId } : {}), ...(spec.recordId === undefined ? {} : { record_id: spec.recordId }),
      ...(withheld.length ? { withheld } : {}), ...(spec.maxRounds === undefined ? {} : { max_rounds: spec.maxRounds }),
    },
  };
  if (carriesForgotten(held, [JSON.stringify(brief), ...spec.items.flatMap(({ ref, detail }) => [ref, detail])])) return { code: 'held_topic' };
  const { job, created } = book.create({
    kind: 'task', profile: 'reader', idempotencyKey: spec.key, origin: `${MACHINE_ORIGIN}${spec.job}`, surface: spec.surface,
    brief, dueAt: spec.dueAt ?? spec.now, deadlineAt: spec.deadlineAt, taint: 'external',
  });
  return { code: created ? 'enqueued' : 'existing', job };
};

// Every provider a machine job's worker could be served by (its auxiliary route, `effort: 'standard'`) is open on the
// owner's breaker. A job written now could only wait out the outage, so the brain writes none and its next tick asks again.
export const workerRouteDown = (access: OwnerModelAccess): boolean => {
  const { health } = access;
  if (!health) return false;
  const { chat, auxiliary } = ownerModels(access);
  const route = ownerRoutePolicy(auxiliary, chat, access).routes[0]!;
  return [route.primary, ...route.fallback].every((step) => health.isOpen(step.provider));
};

// Why a machine job with news still told the owner nothing: its gate closed between the check and the apply.
export type MachineHeld = 'held_quiet' | 'held_volume' | 'held_preference' | 'held_stale' | 'held_closed' | 'held_window' | 'held_budget' | 'no_source' | 'malformed_reply';
export type MachineApplied = 'delivered' | 'skipped' | Readonly<{ held: MachineHeld }>;
// A job's apply: rechecks its gates, runs its apply turn and delivers. It calls `settle` exactly once, as the commit of its
// delivery or alone when nothing goes out; `settle` throws ClosedRunError for a job cancelled or forgotten meanwhile. A
// throw of anything else is an apply that could not run (no model), retried like a task report.
export type MachineApplier = (row: JobRow, result: TaskResult, io: Readonly<{ trace: string; current(): Promise<void>; settle(): void }>) => Promise<MachineApplied>;
export type MachineHandler = Readonly<{
  apply: MachineApplier;
  // The worker checked and found nothing: the job's own record that its data was checked, written in one transaction with
  // `settle`, so the same data does not start another job.
  noNews?(row: JobRow, settle: () => void): void | Promise<void>;
  // The apply runs on an empty result too: the job's judgment does not rest on the worker's findings alone.
  decidesOnEmpty?: boolean;
  // The job left the lane, however it ended (applied, parked, dropped): for work waiting on it, never for a message.
  ended?(row: JobRow): void;
}>;
export type MachineAppliers = Readonly<Partial<Record<MachineJob, MachineHandler>>>;

// A report that no model could apply is retried for an hour.
export const APPLY_RETRY_MS = 60 * 60_000;

// The jobs lane's apply step for a machine job. The owner never asked for this work, so nothing here tells them about it
// unless the job found something: a parked job, an empty result and an apply that never got a model all settle silently.
export const applyMachineJob = async (row: JobRow, deps: Readonly<{
  book: JobBook; now(): number; appliers: MachineAppliers; hop(row: JobRow, name: string, fields?: Partial<TurnLogEntry>): void;
}>): Promise<void> => {
  try { await applyOnce(row, deps); } finally {
    const after = deps.book.get(row.id);
    if (after && SETTLED.has(after.status)) deps.appliers[taskBrief(row).machine!.job]?.ended?.(after);
  }
};
const SETTLED: ReadonlySet<string> = new Set(['applied', 'parked', 'cancelled']);
const applyOnce = async (row: JobRow, deps: Parameters<typeof applyMachineJob>[1]): Promise<void> => {
  const { book } = deps;
  const job = taskBrief(row).machine!.job;
  const settle = () => { if (!book.settle(row.id)) throw new ClosedRunError(); };
  let applied = false;
  // Each trace the job wrote (its lane, its worker's last attempt, its apply turn) closes with a machine_turn root carrying
  // the job's last code, so the exporter flushes it.
  const roots = (after: JobRow, code: string, ok: boolean) => {
    const traces = [`task:${row.id}`, ...(after.attempt > 0 ? [`task:${row.id}:${after.attempt}`] : []), ...(applied ? [`task:${row.id}:apply`] : [])];
    for (const trace of traces) deps.hop(after, 'machine_turn', { trace, ms: deps.now() - after.created_at, ok, code, detail: job });
  };
  const done = (name: string, fields: Partial<TurnLogEntry> = {}) => {
    const after = book.get(row.id) ?? row;
    deps.hop(after, name, {
      ms: deps.now() - after.created_at, ...(after.outcome ? { outcome: TURN_OUTCOME[after.outcome] } : {}),
      detail: `rounds=${after.rounds}:cost_usd=${after.cost_usd.toFixed(4)}:attempts=${after.attempt}`, ...fields,
    });
    roots(after, fields.code ?? name, fields.ok ?? true);
  };
  const quietly = (name: string, fields: Partial<TurnLogEntry> = {}) => {
    try { settle(); } catch (error) { if (!(error instanceof ClosedRunError)) throw error; return; }
    done(name, fields);
  };
  // A hook that could not run (no model, a source that did not answer) is retried like a task report, then dropped silently,
  // so a row that keeps failing never holds up the rows behind it.
  const unavailable = (error: unknown) => {
    if (error instanceof ClosedRunError) {
      book.endApply(row.id);
      deps.hop(row, 'machine_apply_dropped', { ok: false, code: book.get(row.id)?.cancel_reason ?? 'settled' });
      return roots(book.get(row.id) ?? row, 'machine_apply_dropped', false);
    }
    if (deps.now() - row.updated_at < APPLY_RETRY_MS && book.postpone(row.id, deps.now() + deferDelay(row.deferrals))) return deps.hop(row, 'machine_apply_deferred', { ok: false });
    return quietly('machine_dropped', { ok: false, code: 'apply_unavailable' });
  };
  if (row.park_reason) return quietly('machine_parked', { ok: false, code: row.park_reason });
  // A pass lost inside the apply turn left its intent: the turn may have raised a card or opened a loop, so it is not run
  // again. The owner never asked for this work, so nothing names it; the trigger's next tick asks again.
  if (applyInterrupted(row)) return quietly('machine_apply_uncertain', { ok: false });
  const handler = deps.appliers[job];
  const result = jobResult(row)!;
  // The worker made the judgment; an empty result is how it says nothing here is worth the owner's attention. It says
  // nothing about an item it was not shown, so a job with one goes to the brain's apply, which can see it.
  if (!result.findings.length && !result.proposals.length && !taskBrief(row).machine!.withheld?.length && !handler?.decidesOnEmpty) {
    if (!handler?.noNews) return quietly('machine_no_news');
    try { await handler.noNews(row, settle); } catch (error) { return unavailable(error); }
    return done('machine_no_news');
  }
  if (!handler) return quietly('machine_held', { code: 'no_applier' });
  const current = async () => { if (book.get(row.id)?.status !== 'reported') throw new ClosedRunError(); };
  let outcome: MachineApplied;
  if (!book.beginApply(row.id)) return;
  applied = true;
  try {
    outcome = await handler.apply(row, result, { trace: `task:${row.id}:apply`, current, settle });
  } catch (error) { return unavailable(error); }
  if (outcome === 'delivered') done('machine_applied');
  else if (outcome === 'skipped') done('machine_skipped');
  else done('machine_held', { code: outcome.held });
};
