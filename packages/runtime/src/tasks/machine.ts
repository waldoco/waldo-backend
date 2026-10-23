import type { TaskResult } from '@waldo/contracts';
import { ClosedRunError } from '../channels/run-effect-scope';
import type { TurnLogEntry } from '../channels/owner-turn-types';
import { md5Hex } from '../channels/md5';
import { fenced } from '../prompt/turn-prompt';
import { numericHealthIn } from '../scribe/sanitiser';
import { deferDelay, TURN_OUTCOME } from './brain';
import { jobResult, MACHINE_ORIGIN, taskBrief, type JobBook, type JobRow, type MachineBrief, type MachineJob, type TaskBrief } from './jobs';

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
  source?: MachineBrief['source']; runId?: string;
}>;
export type MachineEnqueued = Readonly<{ code: 'enqueued' | 'existing' | 'held_open_job'; job: JobRow }>;

// Writes the job, or names the one that stands in its place: the same key returns the job it made, settled or not, and
// a job and scope with a job still open waits for it, so a burst of ticks coalesces into the open job. Synchronous, so the
// caller writes it in the same transaction as the check that read its data.
export const enqueueMachine = (book: JobBook, spec: MachineSpec): MachineEnqueued => {
  const open = book.openMachine(spec.job, spec.scope);
  if (open) return { code: open.idempotency_key === spec.key ? 'existing' : 'held_open_job', job: open };
  const items = spec.items.map(keptItem);
  const brief: TaskBrief = {
    ...spec.text,
    context: fenced('Data fetched for this job', items.map(({ ref, detail }) => `- [${ref}] ${detail}`).join('\n')).trim(),
    effort: 'standard', timezone: spec.timezone, started_at: spec.now,
    // A change detector over the data the job was started on, not a guard against an adversary, so MD5 is enough.
    machine: { job: spec.job, input_digest: md5Hex(JSON.stringify(items)), scope: spec.scope, ...(spec.source ? { source: spec.source } : {}), ...(spec.runId ? { run_id: spec.runId } : {}) },
  };
  const { job, created } = book.create({
    kind: 'task', profile: 'reader', idempotencyKey: spec.key, origin: `${MACHINE_ORIGIN}${spec.job}`, surface: spec.surface,
    brief, dueAt: spec.now, deadlineAt: spec.deadlineAt, taint: 'external',
  });
  return { code: created ? 'enqueued' : 'existing', job };
};

// Why a machine job with news still told the owner nothing: its gate closed between the check and the apply.
export type MachineHeld = 'held_quiet' | 'held_volume' | 'held_preference' | 'held_stale' | 'no_source';
export type MachineApplied = 'delivered' | 'skipped' | Readonly<{ held: MachineHeld }>;
// A job's apply: rechecks its gates, runs its apply turn and delivers. It calls `settle` exactly once, as the commit of its
// delivery or alone when nothing goes out; `settle` throws ClosedRunError for a job cancelled or forgotten meanwhile. A
// throw of anything else is an apply that could not run (no model), retried like a task report.
export type MachineApplier = (row: JobRow, result: TaskResult, io: Readonly<{ trace: string; current(): Promise<void>; settle(): void }>) => Promise<MachineApplied>;
export type MachineAppliers = Readonly<Partial<Record<MachineJob, MachineApplier>>>;

// A report that no model could apply is retried for an hour.
export const APPLY_RETRY_MS = 60 * 60_000;

// The jobs lane's apply step for a machine job. The owner never asked for this work, so nothing here tells them about it
// unless the job found something: a parked job, an empty result and an apply that never got a model all settle silently.
export const applyMachineJob = async (row: JobRow, deps: Readonly<{
  book: JobBook; now(): number; appliers: MachineAppliers; hop(row: JobRow, name: string, fields?: Partial<TurnLogEntry>): void;
}>): Promise<void> => {
  const { book } = deps;
  const settle = () => { if (!book.settle(row.id)) throw new ClosedRunError(); };
  const done = (name: string, fields: Partial<TurnLogEntry> = {}) => {
    const after = book.get(row.id) ?? row;
    deps.hop(after, name, {
      ms: deps.now() - after.created_at, ...(after.outcome ? { outcome: TURN_OUTCOME[after.outcome] } : {}),
      detail: `rounds=${after.rounds}:cost_usd=${after.cost_usd.toFixed(4)}:attempts=${after.attempt}`, ...fields,
    });
  };
  const quietly = (name: string, fields: Partial<TurnLogEntry> = {}) => {
    try { settle(); } catch (error) { if (!(error instanceof ClosedRunError)) throw error; return; }
    done(name, fields);
  };
  if (row.park_reason) return quietly('machine_parked', { ok: false, code: row.park_reason });
  const result = jobResult(row)!;
  // The worker made the judgment; an empty result is how it says nothing here is worth the owner's attention.
  if (!result.findings.length && !result.proposals.length) return quietly('machine_no_news');
  const applier = deps.appliers[taskBrief(row).machine!.job];
  if (!applier) return quietly('machine_held', { code: 'no_applier' });
  const current = async () => { if (book.get(row.id)?.status !== 'reported') throw new ClosedRunError(); };
  let applied: MachineApplied;
  try {
    applied = await applier(row, result, { trace: `task:${row.id}:apply`, current, settle });
  } catch (error) {
    if (error instanceof ClosedRunError) return deps.hop(row, 'machine_apply_dropped', { ok: false, code: book.get(row.id)?.cancel_reason ?? 'settled' });
    if (deps.now() - row.updated_at < APPLY_RETRY_MS && book.postpone(row.id, deps.now() + deferDelay(row.deferrals))) return deps.hop(row, 'machine_apply_deferred', { ok: false });
    return quietly('machine_dropped', { ok: false, code: 'apply_unavailable' });
  }
  if (applied === 'delivered') done('machine_applied');
  else if (applied === 'skipped') done('machine_skipped');
  else done('machine_held', { code: applied.held });
};
