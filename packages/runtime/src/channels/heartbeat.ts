import type { ScheduleEntry } from '@waldo/contracts';
import type { Scheduler, ScheduleExecutor } from '../scheduler/multiplexer';
import type { DayPlanBook } from './day-cards';
import { isQuiet, type Loop, type LoopBook } from './loops';
import { localIso } from './reminders';

// H1 of the heartbeat/cron plan: a periodic check-in tick that scans due work, stays silent when
// nothing needs attention, and records every tick in schedule_runs. The tick is deterministic -
// no LLM turn - so it needs no LoopPolicy entry and cannot spend tokens.
//
// Run history is the scheduler-owned schedule_runs table (the one run-history record): the
// Scheduler writes the row before dispatch, and the tick records its DECISION
// (heartbeat_result: quiet vs acted) and the SEND (delivery: pending -> sent/failed) on it.
// A crash between acting and confirming leaves delivery 'pending' - recoverable, never treated
// as delivered. Terminal delivery states ('sent'/'failed') are never re-sent on retry.
//
// H1+H1b scope: past-due open loops, plus release of quiet-hours-held day cards (H1b). A card
// held at its planned time (day_plan sent=2) is re-armed here once quiet ends; the real send
// happens in the normal cards pipeline (the tick stays deterministic - no LLM turn) and marks
// the card sent there. Due reminders need no heartbeat path: the C3 missed-run policy fires
// the latest elapsed occurrence once, so a heartbeat copy would double-fire.
export const HEARTBEAT_ID = 'heartbeat-tick';
export const HEARTBEAT_EVERY_MS = 30 * 60_000;
const MAX_LISTED_LOOPS = 3;
const DUE_SCAN_LIMIT = 20;
// Cross-tick flood control: a loop is re-notified only after this cooldown, and only while it is
// still past due. The notified-occurrence key is (loop_id, due), so editing the due time starts a
// fresh occurrence that notifies again immediately.
const RENOTIFY_COOLDOWN_MS = 4 * 60 * 60_000;

export const armHeartbeat = async (scheduler: Scheduler, now: number): Promise<void> => {
  if (scheduler.read(HEARTBEAT_ID)) return;
  await scheduler.schedule({
    id: HEARTBEAT_ID, kind: 'heartbeat', payloadRefs: { id: HEARTBEAT_ID },
    occurrenceAt: now + HEARTBEAT_EVERY_MS, dueAt: now + HEARTBEAT_EVERY_MS,
    recurrence: { type: 'interval', every_ms: HEARTBEAT_EVERY_MS, phase_ms: 0 },
  });
};

type Sql = Pick<SqlStorage, 'exec'>;

export type HeartbeatDeps = Readonly<{
  scheduler: Scheduler;
  sql: Sql;
  loops: LoopBook;
  plans: Pick<DayPlanBook, 'heldToday'>;
  timezone: string;
  now: () => number;
  send: (text: string) => Promise<void>;
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
      return;
    }
    // H1b release: quiet-hours-held day cards from TODAY re-arm to fire immediately. The upsert
    // resets the entry to armed, so a crashed release retry re-arms idempotently; yesterday's
    // held cards are stale and stay as the historical record of the hold.
    const today = localIso(firedAt, deps.timezone).slice(0, 10);
    const heldCards = deps.plans.heldToday(today);
    for (const card of heldCards) {
      await deps.scheduler.schedule({
        id: card, kind: 'brief', payloadRefs: { id: card },
        occurrenceAt: firedAt, dueAt: firedAt, recurrence: null,
      });
    }
    const localNow = localIso(firedAt, deps.timezone).slice(0, 16);
    // The cooldown filter lives in SQL BEFORE the LIMIT: paging the 20 earliest-due loops and
    // filtering in JS would starve a 21st notifiable loop forever while the front page sits in
    // cooldown. The bounded scan stays index-backed; only notifiable occurrences fill the page.
    const notify = deps.sql
      .exec<Loop>(
        `SELECT l.* FROM loops l
         WHERE l.status = 'open' AND l.due IS NOT NULL AND l.due <= ?
           AND NOT EXISTS (
             SELECT 1 FROM heartbeat_notified n
             WHERE n.loop_id = l.id AND n.due = l.due AND n.notified_at >= ?)
         ORDER BY l.due LIMIT ?`,
        localNow,
        firedAt - RENOTIFY_COOLDOWN_MS,
        DUE_SCAN_LIMIT,
      )
      .toArray();
    if (notify.length === 0) {
      // A release-only tick acted (its effect is the re-arm) but sent nothing itself - the
      // released card's own run row carries that send's delivery truth.
      deps.scheduler.markHeartbeatDecision(runId, heldCards.length > 0 ? 'acted' : 'quiet');
      return;
    }
    deps.scheduler.markHeartbeatDecision(runId, 'acted');
    deps.scheduler.markDelivery(runId, 'pending');
    const listed = notify.slice(0, MAX_LISTED_LOOPS);
    const lines = listed.map((loop) => `- ${loop.title}${loop.due ? ` (due ${loop.due.replace('T', ' ')})` : ''}`);
    const more = notify.length > listed.length ? `\n…and ${notify.length - listed.length} more on your list.` : '';
    try {
      await deps.send(`From your list, past due:\n${lines.join('\n')}${more}`);
    } catch (error) {
      deps.scheduler.markDelivery(runId, 'failed');
      throw error;
    }
    for (const loop of notify) {
      deps.sql.exec(
        'INSERT INTO heartbeat_notified (loop_id, due, notified_at) VALUES (?, ?, ?) ON CONFLICT (loop_id, due) DO UPDATE SET notified_at = excluded.notified_at',
        loop.id, loop.due, firedAt,
      );
    }
    deps.scheduler.markDelivery(runId, 'sent');
  };
};
