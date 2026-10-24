import type { ToolName } from '@waldo/contracts';
import type { GoogleClient } from '../connectors/google';
import { machineResultText, UPDATE_SWEEP_JOB_TEXT } from '../prompt/machine-jobs';
import { SKIP_UPDATE, updateCardPrompt } from '../prompt/update-cards';
import { taskBrief, type JobBook, type JobRow } from '../tasks/jobs';
import { enqueueMachine, type MachineEnqueued, type MachineHandler, type MachineSpec } from '../tasks/machine';
import { OUTSIDE_TEXT_JOB_TOOLS } from './check-back';
import { localIso } from './reminders';
import { changeLines, readChanges, touchesDay, writeChanges, type Change, type UpdateBook } from './update-cards';

// The update sweep as a machine job. Each tick the brain reads what changed on the owner's calendar and inbox and records
// it for the next main card. When an update card could go out now and something changed, it writes a reader job in the
// same transaction as the record and the new watermarks; the worker judges the changes off the owner's alarm pass, and
// the brain's apply turn writes one update card, only when the worker found something.

// Why an update card cannot go out now: the owner turned follow-ups off, the day's last card went, volume is low, quiet
// hours, or the owner's surface would only hold it. The changes still wait for the next main card.
export type SweepGate = 'held_preference' | 'held_closed' | 'held_volume' | 'held_quiet' | 'held_window';
export type SweepCheck = 'unchanged' | 'held_open_job' | 'held_breaker' | SweepGate | MachineEnqueued['code'];

// An update card is worth reading only soon: one still waiting after half an hour is dropped, its changes left for the next card.
export const UPDATE_CARD_FRESH_MS = 30 * 60_000;
// A sweep job not applied within the hour is dropped silently; its changes are already recorded for the next main card.
const UPDATE_SWEEP_DEADLINE_MS = 60 * 60_000;

export type SweepCheckDeps = Readonly<{
  updates: UpdateBook; jobs: JobBook; google: Pick<GoogleClient, 'changedEvents' | 'newMail'>;
  now: number; day: string; timezone: string; surface: string; sourceFollowups: boolean;
  gate(): SweepGate | null;
  // Every provider the worker could be served by is down.
  providerDown(): boolean;
  // The record, the observed mail, the watermarks and the job commit together or not at all; no I/O runs inside.
  transaction<T>(work: () => T): T;
  // Runs inside that transaction for a job it wrote (the jobs lane's wake).
  enqueued(job: JobRow): void;
  // A change it read lands on the owner's today: asks for a health recompute, after the transaction.
  dayChanged(): Promise<void>;
}>;

// The job's key is the window it covers: the watermarks before this tick moved them.
type SweepChecked = Readonly<{ code: SweepCheck; changes: number; analysis: number; job?: JobRow }>;
export const updateSweepCheck = async (deps: SweepCheckDeps): Promise<SweepChecked> => {
  const { updates } = deps;
  // A sweep still open holds the window: nothing is read, so the next tick after it settles reads everything since.
  if (deps.jobs.openMachine('update_sweep', 'owner')) return { code: 'held_open_job', changes: 0, analysis: 0 };
  const gate = deps.gate();
  if (gate === null && deps.providerDown()) return { code: 'held_breaker', changes: 0, analysis: 0 };
  const key = `machine:update_sweep:${updates.since('mail_since')}:${updates.since('calendar_since')}`;
  const read = await readChanges(updates, deps.google, deps.now, deps.sourceFollowups);
  const checked = deps.transaction((): SweepChecked => {
    writeChanges(updates, read);
    let recordId = read.changes.length ? updates.record(deps.day, deps.now, read.changes, null) : null;
    updates.pruneMail(deps.now);
    const pending = deps.sourceFollowups ? updates.pendingMail() : [];
    const analysis = deps.sourceFollowups ? [...read.changes.filter(change => change.source !== 'mail'), ...pending] : read.changes;
    const counts = { changes: read.changes.length, analysis: analysis.length };
    if (gate !== null) return { code: gate, ...counts };
    if (!analysis.length) return { code: 'unchanged', ...counts };
    recordId ??= updates.record(deps.day, deps.now, [], null);
    const made = enqueueMachine(deps.jobs, updateSweepSpec(analysis, { key, recordId, surface: deps.surface, timezone: deps.timezone, now: deps.now }));
    if (made.code === 'enqueued') deps.enqueued(made.job);
    return { code: made.code, ...counts, job: made.job };
  });
  // Weight follows the day, whatever the card does: a change on the owner's today asks for a recompute once the changes are
  // recorded. A failed ask never costs the update.
  if (read.changes.some(change => touchesDay(change, deps.day, deps.timezone))) await deps.dayChanged().catch(() => undefined);
  return checked;
};

const updateSweepSpec = (analysis: readonly Change[], job: Readonly<{ key: string; recordId: number; surface: string; timezone: string; now: number }>): MachineSpec => ({
  job: 'update_sweep', scope: 'owner', key: job.key, surface: job.surface, text: UPDATE_SWEEP_JOB_TEXT,
  // Mail with a source is named by its thread ref, which the apply turn's own prompt already carries; the rest by the event
  // or message a reader opens it by, and a change recorded before those were kept by position.
  items: analysis.map((change, index) => ({ ref: change.source_ref ?? change.ref ?? `${change.source}-${index + 1}`, detail: `${change.source} ${change.kind}: ${change.detail}` })),
  timezone: job.timezone, now: job.now, deadlineAt: job.now + UPDATE_SWEEP_DEADLINE_MS, recordId: job.recordId,
});

// The apply turn's tools: with source follow-ups it may open a source-bound loop (a card, since the turn is tainted);
// otherwise it reads, and asks the owner on a card for any change.
export const updateSweepTools = (sourceFollowups: boolean): readonly ToolName[] =>
  sourceFollowups ? ['get_context', 'read_owner_context', 'search_episodes', 'open_loop'] : OUTSIDE_TEXT_JOB_TOOLS;

export const updateSweepApplyText = (localNow: string, changes: readonly Change[], context: Readonly<{ ledger: string; feedback: string; volume: 'normal' | 'high'; sourceFollowups: boolean }>,
  result: Parameters<typeof machineResultText>[0], withheld: readonly string[] = []): string =>
  `${updateCardPrompt(localNow, { changes: changeLines(changes), ...context })}\n\n${machineResultText(result, withheld)}`;

export type UpdateSweepApplyDeps = Readonly<{
  updates: UpdateBook; timezone: string; now(): number; sourceFollowups(): boolean;
  gate(): SweepGate | null;
  transaction(work: () => void): void;
  context(): Promise<Readonly<{ ledger: string; feedback: string; volume: 'normal' | 'high' }>>;
  // The update-card turn on the owner's chain, with updateSweepTools and the job's taint: its raw reply.
  turn(trace: string, text: string, current: () => Promise<void>): Promise<string>;
  // Queues the card under its key for the update record, `commit` in the same transaction; a key already queued only commits.
  deliver(id: string, trace: string, text: string, recordId: number, commit: () => void): Promise<void>;
}>;

// The sweep job's apply. The gate runs again here, since quiet hours or the day's last card can come while the worker
// reads. Only the job's own changes reach the turn, and only they are judged.
export const updateSweepApplier = (deps: UpdateSweepApplyDeps): MachineHandler => {
  const judged = (row: JobRow, settle: () => void) => deps.transaction(() => {
    const { record_id: recordId, refs } = taskBrief(row).machine!;
    deps.updates.judgedJob(recordId!, refs);
    settle();
  });
  return {
    apply: async (row, result, io) => {
      const gate = deps.gate();
      if (gate) { deps.transaction(io.settle); return { held: gate }; }
      const { record_id: recordId, refs, withheld } = taskBrief(row).machine!;
      const changes = deps.updates.jobChanges(recordId!, refs);
      if (!changes.length) { deps.transaction(io.settle); return { held: 'held_stale' }; }
      const sourceFollowups = deps.sourceFollowups();
      const text = updateSweepApplyText(localIso(deps.now(), deps.timezone), changes, { ...await deps.context(), sourceFollowups }, result, withheld);
      const reply = (await deps.turn(io.trace, text, io.current)).trim();
      if (!reply || reply === SKIP_UPDATE) { judged(row, io.settle); return 'skipped'; }
      await deps.deliver(`update:${row.id}`, io.trace, reply, recordId!, () => { deps.updates.judgedJob(recordId!, refs); io.settle(); });
      return 'delivered';
    },
    noNews: judged,
  };
};
