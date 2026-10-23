import type { ScheduleEntry } from '@waldo/contracts';
import type { Scheduler, ScheduleExecutor } from '../scheduler/multiplexer';
import { HEARTBEAT_JOB_TEXT, machineResultText } from '../prompt/machine-jobs';
import { taskBrief } from '../tasks/jobs';
import type { MachineEnqueued, MachineHandler, MachineSpec } from '../tasks/machine';
import { checkBackReply, loopCheckBackText } from './check-back';
import type { DayPlanBook } from './day-cards';
import { isQuiet, type Loop, type LoopBook } from './loops';
import { localIso } from './reminders';
import type { FinalRecord, HeartbeatReceipt } from './telegram-final-outbox';

// H1 of the heartbeat/cron plan: a periodic check-in tick that scans due work, stays silent when
// nothing needs attention, and records every tick in schedule_runs. The scan is deterministic; only
// past-due loops Waldo took on start the check-back: a reader job, written with the scan, whose worker
// reads the current state off the owner's alarm pass. The brain's apply turn writes the message, only
// when the worker found something, or stays silent.
//
// Run history is the scheduler-owned schedule_runs table (the one run-history record): the
// Scheduler writes the row before dispatch, and the tick records its DECISION on it (heartbeat_result:
// quiet, or acted when it wrote a job or released a card). The job owns the check-back from there.
// Frozen outbox intent owns delivery once the apply turn wrote it. Ambiguous attempts are
// quarantined; only a validated provider ACK settles delivery and the loop cooldown.
//
// H1+H1b scope: past-due open loops, plus release of quiet-hours-held day cards (H1b). A card
// held at its planned time (day_plan sent=2) is re-armed here once quiet ends; the real send
// happens in the normal cards pipeline and marks the card sent there. Due reminders need no
// heartbeat path: the C3 missed-run policy fires the latest elapsed occurrence once, so a
// heartbeat copy would double-fire.
export const HEARTBEAT_ID = 'heartbeat-tick';
export const HEARTBEAT_EVERY_MS = 30 * 60_000;
const DUE_SCAN_LIMIT = 20;
// Cross-tick flood control: a loop is re-notified only after this cooldown, and only while it is
// still past due. The notified-occurrence key is (loop_id, due), so editing the due time starts a
// fresh occurrence that notifies again immediately. A check that found nothing to say holds it too.
const RENOTIFY_COOLDOWN_MS = 4 * 60 * 60_000;
// A check-back job not done by the next tick is dropped; its loops are not marked, so that tick asks again.
const HEARTBEAT_JOB_DEADLINE_MS = HEARTBEAT_EVERY_MS;

export const armHeartbeat = async (scheduler: Scheduler, now: number): Promise<void> => {
  if (scheduler.lookup(HEARTBEAT_ID).state !== 'absent') return;
  await scheduler.schedule({
    id: HEARTBEAT_ID, kind: 'heartbeat', payloadRefs: { id: HEARTBEAT_ID },
    occurrenceAt: now + HEARTBEAT_EVERY_MS, dueAt: now + HEARTBEAT_EVERY_MS,
    recurrence: { type: 'interval', every_ms: HEARTBEAT_EVERY_MS, phase_ms: 0 },
  });
};

type Sql = Pick<SqlStorage, 'exec'>;

// The past-due loops a check-back may name: open, past due, not from a mail source (those have their own review), and not
// told about within the cooldown. The cooldown filter lives in SQL BEFORE the LIMIT: paging the earliest-due loops and
// filtering in JS would starve a 21st notifiable loop forever while the front page sits in cooldown. `only` narrows the
// scan to the loops a job was given.
export const dueLoops = (sql: Sql, now: number, timezone: string, only?: readonly string[]): Loop[] => {
  const ids = only ?? [];
  if (only && !ids.length) return [];
  return sql.exec<Loop>(
    `SELECT l.* FROM loops l
     WHERE l.status = 'open' AND l.due IS NOT NULL AND l.due <= ?
       AND NOT EXISTS (SELECT 1 FROM loop_mail_sources s WHERE s.loop_id = l.id)
       AND NOT EXISTS (
         SELECT 1 FROM heartbeat_notified n
         WHERE n.loop_id = l.id AND n.due = l.due AND n.notified_at >= ?)
       ${only ? `AND l.id IN (${ids.map(() => '?').join(', ')})` : ''}
     ORDER BY l.due LIMIT ?`,
    localIso(now, timezone).slice(0, 16), now - RENOTIFY_COOLDOWN_MS, ...ids, DUE_SCAN_LIMIT,
  ).toArray();
};

// What one tick did about past-due loops: why no job was written, or the job that holds them (written now, written by an
// earlier fire of this occurrence, or still open from an earlier tick).
export type HeartbeatCheck = 'held_quiet' | 'held_volume' | 'unchanged' | 'held_breaker' | MachineEnqueued['code'];

export type HeartbeatDeps = Readonly<{
  releaseHeldCards?: boolean;
  scheduler: Scheduler;
  sql: Sql;
  loops: LoopBook;
  plans: Pick<DayPlanBook, 'heldToday'>;
  timezone: string;
  now: () => number;
  // The scan and the job it writes commit together or not at all; no I/O runs inside.
  transaction<T>(work: () => T): T;
  // Every provider the worker could use is down: a job written now could only wait, so the next tick asks again.
  providerDown(): boolean;
  // Writes the check-back job for these loops, synchronously, inside the scan's transaction.
  enqueue(loops: readonly Loop[], tick: Readonly<{ entryId: string; occurrence: number; runId: string; now: number }>): MachineEnqueued['code'];
  checked(code: HeartbeatCheck, detail: string): void;
}>;

// One tick: quiet hours suppress sends entirely. Due work comes from a bounded index-backed scan
// (DUE_SCAN_LIMIT rows), never an unbounded SELECT *. A past-due loop notifies at most once per
// occurrence per RENOTIFY_COOLDOWN_MS; unchanged loops do not re-message on every tick.
export const heartbeatTick = (deps: HeartbeatDeps): ScheduleExecutor => {
  return async (entry: ScheduleEntry) => {
    const firedAt = deps.now();
    const runId = deps.scheduler.runningRunId(entry.id, entry.occurrence_at);
    if (runId === null) throw new Error(`no running schedule_runs row for ${entry.id}:${entry.occurrence_at}`);

    // At-least-once retry of an occurrence whose delivery already reached a terminal state:
    // observe it truthfully on this attempt's row and never re-send.
    const delivered = deps.scheduler.occurrenceDelivery(entry.id, entry.occurrence_at);
    if (delivered !== null) {
      deps.scheduler.markHeartbeatDecision(runId, 'acted');
      deps.scheduler.markDelivery(runId, delivered);
      return;
    }

    if (isQuiet(deps.loops.proactivity(), firedAt, deps.timezone)) {
      deps.scheduler.markHeartbeatDecision(runId, 'quiet');
      deps.checked('held_quiet', 'loops=0');
      return;
    }
    // H1b release: quiet-hours-held day cards from TODAY re-arm to fire immediately. The upsert
    // resets the entry to armed, so a crashed release retry re-arms idempotently; yesterday's
    // held cards are stale and stay as the historical record of the hold.
    const today = localIso(firedAt, deps.timezone).slice(0, 10);
    // A held card whose row this version cannot read is left for the version that wrote it.
    const heldCards = (deps.releaseHeldCards === false ? [] : deps.plans.heldToday(today)).filter(card => deps.scheduler.lookup(card).state !== 'unreadable');
    for (const card of heldCards) {
      await deps.scheduler.schedule({
        id: card, kind: 'brief', payloadRefs: { id: card },
        occurrenceAt: firedAt, dueAt: firedAt, recurrence: null,
      });
    }
    // Volume low: no unrequested nudges. Quiet-hours card release above and owner-set reminders
    // (C3 policy, not this tick) are unchanged.
    if (deps.loops.proactivity().volume === 'low') {
      deps.scheduler.markHeartbeatDecision(runId, heldCards.length > 0 ? 'acted' : 'quiet');
      deps.checked('held_volume', 'loops=0');
      return;
    }
    const { code, count } = deps.transaction(() => {
      const notify = dueLoops(deps.sql, firedAt, deps.timezone);
      if (notify.length === 0) return { code: 'unchanged' as const, count: 0 };
      if (deps.providerDown()) return { code: 'held_breaker' as const, count: notify.length };
      const made = deps.enqueue(notify, { entryId: entry.id, occurrence: entry.occurrence_at, runId, now: firedAt });
      // The decision commits with the job, so a crash in between leaves neither.
      if (made === 'enqueued' || made === 'existing') deps.scheduler.markHeartbeatDecision(runId, 'acted');
      return { code: made, count: notify.length };
    });
    // A release-only tick acted (its effect is the re-arm) but sent nothing itself - the
    // released card's own run row carries that send's delivery truth.
    if (code !== 'enqueued' && code !== 'existing') deps.scheduler.markHeartbeatDecision(runId, heldCards.length > 0 ? 'acted' : 'quiet');
    deps.checked(code, `loops=${count}`);
  };
};

// The check-back job for one tick's past-due loops. Keyed by the tick's occurrence, not by the loops: a key on the loop set
// would return the settled job of the same loops and block the re-notify after the cooldown.
export const heartbeatJobSpec = (loops: readonly Loop[], tick: Readonly<{ entryId: string; occurrence: number; runId: string; now: number; surface: string; timezone: string }>): MachineSpec => ({
  job: 'heartbeat', scope: 'owner', key: `machine:heartbeat:${tick.entryId}:${tick.occurrence}`, surface: tick.surface, text: HEARTBEAT_JOB_TEXT,
  items: loops.map(loop => ({ ref: loop.id, detail: `${loop.title}${loop.due ? ` (due ${loop.due.replace('T', ' ')})` : ''}` })),
  timezone: tick.timezone, now: tick.now, deadlineAt: tick.now + HEARTBEAT_JOB_DEADLINE_MS, runId: tick.runId,
});

export type HeartbeatApplyDeps = Readonly<{
  sql: Sql;
  loops: LoopBook;
  timezone: string;
  now(): number;
  // The owner's heartbeat preference, read at apply.
  enabled(): boolean;
  transaction(work: () => void): void;
  // The check-back turn on the owner's chain, for exactly these loops (close_loop may close only them): its raw reply.
  turn(trace: string, loops: readonly Loop[], text: string, current: () => Promise<void>): Promise<string>;
  // Queues the message under its key with its receipt, `commit` in the same transaction; a key already queued only commits.
  deliver(id: string, trace: string, text: string, receipt: HeartbeatReceipt, commit: () => void): Promise<void>;
}>;

// The loops of a job as the check left them: the ones still open hold their cooldown from `at`.
const holdCooldown = (deps: Pick<HeartbeatApplyDeps, 'sql'>, loops: readonly Readonly<{ id: string; due: string | null; status?: string }>[], at: number) => {
  for (const { id, due, status } of loops) if (due !== null && (status ?? 'open') === 'open') markNotified(deps.sql, { id, due }, at);
};

// The heartbeat job's apply. Its gates run again here, since quiet hours or the owner's preference can change while the
// worker reads, and only the loops the worker was given and that still need a check-back reach the turn.
export const heartbeatApplier = (deps: HeartbeatApplyDeps): MachineHandler => ({
  apply: async (row, result, io) => {
    const now = deps.now();
    const proactivity = deps.loops.proactivity();
    const held = !deps.enabled() ? 'held_preference' : isQuiet(proactivity, now, deps.timezone) ? 'held_quiet' : proactivity.volume === 'low' ? 'held_volume' : null;
    const machine = taskBrief(row).machine!;
    const due = held ? [] : dueLoops(deps.sql, now, deps.timezone, machine.refs);
    const code = held ?? (due.length ? null : 'held_stale');
    if (code) { deps.transaction(io.settle); return { held: code }; }
    const reply = checkBackReply(await deps.turn(io.trace, due, `${loopCheckBackText(due)}\n\n${machineResultText(result)}`, io.current));
    // The receipt freezes each loop as the turn left it, so a loop the owner closes or moves before the send stops it.
    const after = due.flatMap(loop => {
      const current = deps.sql.exec<{ status: string; due: string | null }>('SELECT status, due FROM loops WHERE id = ?', loop.id).toArray()[0];
      return current?.due ? [{ id: loop.id, due: current.due, status: current.status }] : [];
    });
    if (reply === null) {
      deps.transaction(() => { holdCooldown(deps, after, now); io.settle(); });
      return 'skipped';
    }
    // The receipt names the tick that started the job; that tick's own run settled when it wrote the job.
    await deps.deliver(`heartbeat:${row.id}`, io.trace, reply, { id: HEARTBEAT_ID, occurrence: taskBrief(row).started_at, schedulerRunId: machine.run_id ?? '', loops: after }, io.settle);
    return 'delivered';
  },
  // Checked and nothing to say: the cooldown holds these loops as if told, so the next tick does not ask again.
  noNews: (row, settle) => deps.transaction(() => {
    holdCooldown(deps, dueLoops(deps.sql, deps.now(), deps.timezone, taskBrief(row).machine!.refs), deps.now());
    settle();
  }),
});

export const heartbeatEligible = (record: FinalRecord, sql: Sql, loops: LoopBook, timezone: string, now: number): boolean => {
  if (!record.heartbeat) return true;
  if (isQuiet(loops.proactivity(), now, timezone) || loops.proactivity().volume === 'low') return false;
  const localNow = localIso(now, timezone).slice(0, 16);
  // A receipt from before check-back turns names open loops only, so a missing status reads as open.
  return record.heartbeat.loops.length > 0 && record.heartbeat.loops.every(loop => (loop.status ?? 'open') === 'open'
    ? sql.exec(
      `SELECT 1 FROM loops l WHERE l.id = ? AND l.status = 'open' AND l.due = ? AND l.due <= ?
        AND NOT EXISTS (SELECT 1 FROM heartbeat_notified n WHERE n.loop_id = l.id AND n.due = l.due AND n.notified_at >= ?)`,
      loop.id, loop.due, localNow, now - RENOTIFY_COOLDOWN_MS,
    ).toArray().length > 0
    : sql.exec('SELECT 1 FROM loops WHERE id = ? AND status = ? AND due = ?', loop.id, loop.status, loop.due).toArray().length > 0);
};

export const settleHeartbeat = (record: FinalRecord, sql: Sql, scheduler: Scheduler): void => {
  if (!record.heartbeat || record.status === 'pending') return;
  if (record.status === 'delivered') {
    if (record.deliveredAt === undefined) throw new Error('heartbeat ACK timestamp missing');
    for (const loop of record.heartbeat.loops) markNotified(sql, loop, record.deliveredAt);
  }
  // A check-back the owner's forget cancelled, or whose window never reopened, was never sent and never failed.
  if (record.reason === 'owner_forget' || (record.status === 'blocked' && record.reason === 'lapsed')) scheduler.settleCancelled(record.heartbeat.schedulerRunId);
  else scheduler.settleDelivery(record.heartbeat.schedulerRunId, record.status === 'delivered');
};

const markNotified = (sql: Sql, loop: Readonly<{ id: string; due: string }>, at: number): void => {
  sql.exec(
    'INSERT INTO heartbeat_notified (loop_id, due, notified_at) VALUES (?, ?, ?) ON CONFLICT (loop_id, due) DO UPDATE SET notified_at = max(heartbeat_notified.notified_at, excluded.notified_at)',
    loop.id, loop.due, at,
  );
};
