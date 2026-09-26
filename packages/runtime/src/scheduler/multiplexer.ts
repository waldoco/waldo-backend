import {
  nextWakeBound,
  scheduleEntrySchema,
  scheduleKindCanQuarantine,
  scheduleKindPriority,
  type ScheduleEntry,
  type ScheduleKind,
  type SchedulePayloadRefs,
  nextCronOccurrence,
  parseCronExpression,
  type ScheduleRecurrence,
} from '@waldo/contracts';
import type { Deps } from '../seams/deps';
import { armAlarm } from './alarm-slot';

const MAX_MISSED_CHAIN = 64;
// Minimum spacing for an immediate re-arm (next row already due). Live turns are unaffected
// (due work still fires within DUE_LOOKAHEAD_MS); the pacing lets a long missed-run drain
// yield the isolate between deliveries instead of starving sibling work back-to-back.
const MIN_REARM_DELAY_MS = 250;
const DUE_LOOKAHEAD_MS = 1_000;
const MAX_DUE_PER_ALARM = 8;
const PRODUCT_RETRY_DELAY_MS = 30_000;
const DURABILITY_RETRY_CAP_MS = 15 * 60_000;
const QUARANTINE_AFTER_ATTEMPTS = 3;
const QUARANTINE_MS = 24 * 60 * 60_000;

type ScheduleSqlRow = {
  id: string;
  kind: string;
  occurrence_at: number;
  due_at: number;
  recurrence_json: string | null;
  payload_json: string;
  status: string;
  attempts: number;
  last_fired_at: number | null;
  quarantined_until: number | null;
  created_at: number;
  updated_at: number;
};

export type ScheduleInput = {
  id: string;
  kind: ScheduleKind;
  occurrenceAt: number;
  dueAt: number;
  payloadRefs: SchedulePayloadRefs;
  recurrence?: ScheduleRecurrence | null;
};

export type ScheduleExecutor = (entry: ScheduleEntry) => Promise<void>;
export type ScheduleExecutors = Partial<Record<ScheduleKind, ScheduleExecutor>>;

export class Scheduler {
  constructor(
    private readonly sql: SqlStorage,
    private readonly storage: DurableObjectStorage,
    private readonly deps: Deps,
  ) {}

  async schedule(input: ScheduleInput): Promise<ScheduleEntry> {
    const at = this.deps.now();
    const parsed = scheduleEntrySchema.parse({
      id: input.id,
      kind: input.kind,
      occurrence_at: input.occurrenceAt,
      due_at: input.dueAt,
      recurrence: input.recurrence ?? null,
      payload_refs: input.payloadRefs,
      status: 'armed',
      attempts: 0,
      last_fired_at: null,
      quarantined_until: null,
      created_at: at,
      updated_at: at,
    });
    // Codex #229 hold: a cron expression must fail BEFORE anything is armed. The charset screen
    // in the schema only bounds characters; parsing happened first at post-fire reschedule, so
    // an invalid recurrence fired once (an effect) and then threw. Validate at schedule time:
    // parse + prove at least one occurrence inside the scan bound, before the row exists.
    if (parsed.recurrence?.type === 'cron') {
      const cron = parseCronExpression(parsed.recurrence.expression);
      if (cron === null) throw new Error(`invalid cron recurrence: ${parsed.recurrence.expression}`);
      if (nextCronOccurrence(cron, parsed.recurrence.timezone, at) === null) {
        throw new Error(`cron recurrence has no occurrence within scan bound: ${parsed.recurrence.expression}`);
      }
    }
    this.sql.exec(
      `INSERT INTO schedule
         (id, kind, occurrence_at, due_at, recurrence_json, payload_json, status, attempts,
          last_fired_at, quarantined_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'armed', 0, NULL, NULL, ?, ?)
       ON CONFLICT(id)
         DO UPDATE SET
           kind = excluded.kind,
           occurrence_at = excluded.occurrence_at,
           due_at = excluded.due_at,
           recurrence_json = excluded.recurrence_json,
           payload_json = excluded.payload_json,
           status = 'armed',
           attempts = 0,
           last_fired_at = NULL,
           quarantined_until = NULL,
           updated_at = excluded.updated_at`,
      parsed.id,
      parsed.kind,
      parsed.occurrence_at,
      parsed.due_at,
      parsed.recurrence === null ? null : JSON.stringify(parsed.recurrence),
      JSON.stringify(parsed.payload_refs),
      parsed.created_at,
      parsed.updated_at,
    );
    await this.rearm();
    const scheduled = this.read(parsed.id);
    if (scheduled === null) throw new Error(`schedule: no schedule ${parsed.id}`);
    return scheduled;
  }

  async cancel(id: string): Promise<void> {
    this.sql.exec('DELETE FROM schedule WHERE id = ?', id);
    await this.rearm();
  }

  read(id: string): ScheduleEntry | null {
    const row = this.sql
      .exec<ScheduleSqlRow>('SELECT * FROM schedule WHERE id = ?', id)
      .toArray()[0];
    return row ? toEntry(row) : null;
  }

  async dispatchDue(executors: ScheduleExecutors): Promise<readonly ScheduleEntry[]> {
    const now = this.deps.now();
    this.reapQuarantine(now);
    const due = this.dueEntries(now).slice(0, MAX_DUE_PER_ALARM);
    const dispatched: ScheduleEntry[] = [];

    try {
      for (const entry of due) {
        let fresh = this.read(entry.id);
        if (fresh === null || fresh.status !== 'armed' || fresh.due_at > now + DUE_LOOKAHEAD_MS) {
          continue;
        }
        // C3 dedupe: an occurrence still running (or crashed-and-unsettled) blocks this fire.
        // The skip is recorded as a missed row, then the schedule advances past it.
        if (this.hasRunningRun(fresh.id, fresh.occurrence_at)) {
          this.recordMissed(fresh, fresh.occurrence_at, now);
          this.advanceWithoutFiring(fresh, now);
          continue;
        }
        // C3 missed-run policy: after a gap, fire only the latest elapsed occurrence once and
        // record every skipped intermediate occurrence as 'missed' - never a catch-up burst.
        const { occurrences, gapRemaining } = this.occurrenceChain(fresh, now);
        if (gapRemaining) {
          // Gap larger than one delivery's budget: record the whole walked chunk as missed
          // (the last walked occurrence stays unfired), advance the cursor, and let the
          // immediate rearm drain the rest over the next deliveries. Firing here would be a
          // catch-up burst: occurrences[last] is not the latest elapsed occurrence (C3
          // no-burst invariant), and the repeat fire retries were wedging the isolate.
          for (const missedAt of occurrences) {
            this.recordMissed(fresh, missedAt, now);
          }
          this.pinOccurrence(fresh, occurrences[occurrences.length - 1]!, now);
          continue;
        }
        if (occurrences.length > 1) {
          for (const missedAt of occurrences.slice(0, -1)) {
            this.recordMissed(fresh, missedAt, now);
          }
          this.pinOccurrence(fresh, occurrences[occurrences.length - 1]!, now);
          const repinned = this.read(fresh.id);
          if (repinned === null) continue;
          fresh = repinned;
        }
        const bumped = this.bumpAttempt(fresh.id, now);
        const runId = this.recordRunStart(bumped, now);
        try {
          const executor = executors[bumped.kind];
          if (executor === undefined) {
            // Scheduler-handoff failure: the run never reached the executor.
            this.settleRun(runId, 'failed', 'scheduler_handoff', now);
            throw new Error(`no scheduler executor for ${bumped.kind}`);
          }
          await executor(bumped);
          this.complete(bumped, now);
          this.settleRun(runId, 'ok', null, now);
          dispatched.push(bumped);
        } catch (err) {
          if (isCrashInjectionError(err)) {
            // No settle: a row stuck in 'running' is the crashed-run evidence.
            throw err;
          }
          const disposition = this.applyFailurePolicy(bumped, now);
          if (this.runOutcome(runId) === 'running') {
            this.settleRun(runId, disposition === 'quarantined' ? 'quarantined' : 'failed', 'run', now);
          }
          if (shouldPropagateDurabilityInvariant(bumped.kind, err)) {
            throw err;
          }
        }
      }
      return dispatched;
    } finally {
      await this.rearm();
    }
  }

  private dueEntries(now: number): ScheduleEntry[] {
    return this.sql
      .exec<ScheduleSqlRow>(
        `SELECT *
           FROM schedule
          WHERE status = 'armed' AND due_at <= ?`,
        now + DUE_LOOKAHEAD_MS,
      )
      .toArray()
      .map(toEntry)
      .sort(compareScheduleEntries);
  }

  private bumpAttempt(id: string, now: number): ScheduleEntry {
    this.sql.exec(
      `UPDATE schedule
          SET attempts = attempts + 1,
              last_fired_at = ?,
              updated_at = ?
        WHERE id = ? AND status = 'armed'`,
      now,
      now,
      id,
    );
    const entry = this.read(id);
    if (entry === null) throw new Error(`bumpAttempt: no schedule ${id}`);
    return entry;
  }

  private complete(entry: ScheduleEntry, now: number): void {
    if (entry.recurrence === null) {
      this.sql.exec(
        'DELETE FROM schedule WHERE id = ? AND updated_at = ?',
        entry.id,
        entry.updated_at,
      );
      return;
    }
    const next = nextOccurrence(entry.recurrence, now);
    this.sql.exec(
      `UPDATE schedule
          SET occurrence_at = ?,
              due_at = ?,
              attempts = 0,
              last_fired_at = ?,
              status = 'armed',
              quarantined_until = NULL,
              updated_at = ?
        WHERE id = ? AND updated_at = ?`,
      next,
      next,
      now,
      now,
      entry.id,
      entry.updated_at,
    );
  }

  private applyFailurePolicy(entry: ScheduleEntry, now: number): 'quarantined' | 'retry' {
    if (scheduleKindCanQuarantine(entry.kind) && entry.attempts >= QUARANTINE_AFTER_ATTEMPTS) {
      this.sql.exec(
        `UPDATE schedule
            SET status = 'quarantined',
                quarantined_until = ?,
                updated_at = ?
          WHERE id = ? AND updated_at = ?`,
        now + QUARANTINE_MS,
        now,
        entry.id,
        entry.updated_at,
      );
      return 'quarantined';
    }
    const delay = scheduleKindCanQuarantine(entry.kind)
      ? PRODUCT_RETRY_DELAY_MS * entry.attempts
      : Math.min(PRODUCT_RETRY_DELAY_MS * entry.attempts, DURABILITY_RETRY_CAP_MS);
    this.sql.exec(
      `UPDATE schedule
          SET due_at = ?,
              updated_at = ?
        WHERE id = ? AND updated_at = ?`,
      now + delay,
      now,
      entry.id,
      entry.updated_at,
    );
    return 'retry';
  }

  // C4 run history: one row per fire, inserted before dispatch (recordRunStart) and settled
  // exactly once (settleRun no-ops on an already-settled row, so the no-executor path can
  // settle before rethrowing). Crash-injection rethrows leave the row 'running' on purpose.
  private recordRunStart(entry: ScheduleEntry, now: number): string {
    // The id's run ordinal comes from the append-only history, not schedule.attempts:
    // policy state resets (schedule upsert, quarantine reap) but history never does, so
    // a retry after a reset can never collide with a crashed run's row.
    const [lower, upper] = occurrenceIdRange(entry.id, entry.occurrence_at);
    const prior = this.sql
      .exec<{ n: number }>(
        'SELECT count(*) AS n FROM schedule_runs WHERE schedule_id = ? AND id >= ? AND id < ?',
        entry.id,
        lower,
        upper,
      )
      .one().n;
    const ordinal = prior + 1;
    const runId = `${entry.id}:${entry.occurrence_at}:${ordinal}`;
    this.sql.exec(
      `INSERT INTO schedule_runs (id, schedule_id, kind, fired_at, attempt) VALUES (?, ?, ?, ?, ?)`,
      runId,
      entry.id,
      entry.kind,
      now,
      ordinal,
    );
    return runId;
  }

  // Heartbeat decision + delivery lifecycle (C2/H1): the tick executor records WHAT it
  // decided (quiet vs acted) and how the SEND went, on its own running row, separately
  // from the run outcome. delivery 'pending' means decided-but-unconfirmed: a crash there
  // leaves outcome 'running' + delivery 'pending', which recovery must re-deliver - never
  // treat a pending tick as delivered.
  runningRunId(scheduleId: string, occurrenceAt: number): string | null {
    const [lower, upper] = occurrenceIdRange(scheduleId, occurrenceAt);
    const row = this.sql
      .exec<{ id: string }>(
        `SELECT id FROM schedule_runs WHERE schedule_id = ? AND id >= ? AND id < ? AND outcome = 'running' ORDER BY id DESC LIMIT 1`,
        scheduleId,
        lower,
        upper,
      )
      .toArray()[0];
    return row?.id ?? null;
  }

  // Terminal delivery state already recorded for this occurrence by an earlier attempt.
  // DO alarms are at-least-once: 'sent'/'failed' are never re-sent; only a row stuck at
  // 'pending' (crashed mid-delivery) is recovered by acting again.
  occurrenceDelivery(scheduleId: string, occurrenceAt: number): 'sent' | 'failed' | null {
    const [lower, upper] = occurrenceIdRange(scheduleId, occurrenceAt);
    const row = this.sql
      .exec<{ delivery: string }>(
        `SELECT delivery FROM schedule_runs WHERE schedule_id = ? AND id >= ? AND id < ? AND delivery IN ('sent', 'failed') ORDER BY id LIMIT 1`,
        scheduleId,
        lower,
        upper,
      )
      .toArray()[0];
    return (row?.delivery as 'sent' | 'failed' | undefined) ?? null;
  }

  markHeartbeatDecision(runId: string, result: 'quiet' | 'acted'): void {
    this.sql.exec(
      `UPDATE schedule_runs SET heartbeat_result = ? WHERE id = ? AND outcome = 'running'`,
      result,
      runId,
    );
  }

  markDelivery(runId: string, delivery: 'pending' | 'sent' | 'failed'): void {
    this.sql.exec(
      `UPDATE schedule_runs SET delivery = ? WHERE id = ? AND outcome = 'running'`,
      delivery,
      runId,
    );
  }

  private settleRun(runId: string, outcome: 'ok' | 'failed' | 'quarantined' | 'missed', errorClass: 'run' | 'scheduler_handoff' | 'delivery' | null, now: number): void {
    this.sql.exec(
      `UPDATE schedule_runs
          SET outcome = ?, error_class = ?, settled_at = ?, duration_ms = ? - fired_at
        WHERE id = ? AND outcome = 'running'`,
      outcome,
      errorClass,
      now,
      now,
      runId,
    );
  }

  private hasRunningRun(scheduleId: string, occurrenceAt: number): boolean {
    const [lower, upper] = occurrenceIdRange(scheduleId, occurrenceAt);
    return (
      this.sql
        .exec(
          `SELECT 1 FROM schedule_runs
            WHERE schedule_id = ? AND outcome = 'running' AND NOT (id >= ? AND id < ?)
            LIMIT 1`,
          scheduleId,
          lower,
          upper,
        )
        .toArray().length > 0
    );
  }

  // Missed rows use attempt 0: real fires start at attempt 1, so the skip record never
  // collides with the run row of an occurrence that did fire. ON CONFLICT keeps a retried
  // alarm (at-least-once) from double-recording the same skip.
  private recordMissed(entry: ScheduleEntry, occurrenceAt: number, now: number): void {
    this.sql.exec(
      `INSERT INTO schedule_runs (id, schedule_id, kind, fired_at, attempt, outcome, settled_at, duration_ms)
       SELECT ?, ?, ?, ?, 0, 'missed', ?, 0
       WHERE NOT EXISTS (
         SELECT 1 FROM schedule_runs WHERE schedule_id = ? AND id >= ? AND id < ?
       )`,
      `${entry.id}:${occurrenceAt}:0`,
      entry.id,
      entry.kind,
      occurrenceAt,
      now,
      entry.id,
      ...occurrenceIdRange(entry.id, occurrenceAt),
    );
  }

  // Bounded walk: a fire records at most MAX_MISSED_CHAIN skipped occurrences. Gaps beyond
  // the cap fire the last walked occurrence - the walk stays O(cap) no matter how stale the
  // stored occurrence is (an unbounded walk over a years-old occurrence kills the isolate).
  private occurrenceChain(entry: ScheduleEntry, now: number): { occurrences: number[]; gapRemaining: boolean } {
    if (entry.recurrence === null) return { occurrences: [entry.occurrence_at], gapRemaining: false };
    const occurrences = [entry.occurrence_at];
    let cursor = entry.occurrence_at;
    while (cursor <= now && occurrences.length < MAX_MISSED_CHAIN) {
      const next = nextOccurrence(entry.recurrence, cursor);
      if (next <= cursor || next > now) break;
      occurrences.push(next);
      cursor = next;
    }
    // gapRemaining: the walk hit the per-delivery cap AND at least one more elapsed
    // occurrence exists beyond it. The caller must NOT fire in this state -
    // occurrences[last] is mid-gap, not the latest. One extra look-ahead keeps the exact
    // cap-boundary case (gap exactly cap-1 long) on the fire path.
    let gapRemaining = false;
    if (cursor <= now && occurrences.length >= MAX_MISSED_CHAIN) {
      const next = nextOccurrence(entry.recurrence, cursor);
      gapRemaining = next > cursor && next <= now;
    }
    return { occurrences, gapRemaining };
  }

  private pinOccurrence(entry: ScheduleEntry, occurrenceAt: number, now: number): void {
    this.sql.exec(
      `UPDATE schedule
          SET occurrence_at = ?,
              due_at = ?,
              updated_at = ?
        WHERE id = ? AND updated_at = ?`,
      occurrenceAt,
      occurrenceAt,
      now,
      entry.id,
      entry.updated_at,
    );
  }

  private advanceWithoutFiring(entry: ScheduleEntry, now: number): void {
    if (entry.recurrence === null) {
      // One-shot: the missed row is the record; the entry is done.
      this.sql.exec('DELETE FROM schedule WHERE id = ? AND updated_at = ?', entry.id, entry.updated_at);
      return;
    }
    const next = nextOccurrence(entry.recurrence, now);
    this.sql.exec(
      `UPDATE schedule
          SET occurrence_at = ?,
              due_at = ?,
              attempts = 0,
              updated_at = ?
        WHERE id = ? AND updated_at = ?`,
      next,
      next,
      now,
      entry.id,
      entry.updated_at,
    );
  }

  private runOutcome(runId: string): string | null {
    const row = this.sql
      .exec<{ outcome: string }>('SELECT outcome FROM schedule_runs WHERE id = ?', runId)
      .toArray()[0];
    return row?.outcome ?? null;
  }

  private reapQuarantine(now: number): void {
    this.sql.exec(
      `UPDATE schedule
          SET status = 'armed',
              attempts = 0,
              due_at = quarantined_until,
              occurrence_at = quarantined_until,
              quarantined_until = NULL,
              updated_at = ?
        WHERE status = 'quarantined'
          AND quarantined_until IS NOT NULL
          AND quarantined_until <= ?`,
      now,
      now,
    );
  }

  private async rearm(): Promise<void> {
    const bound = nextWakeBound(
      this.sql.exec<ScheduleSqlRow>('SELECT * FROM schedule').toArray().map(toEntry),
    );
    if (bound === null) {
      await this.storage.deleteAlarm();
      return;
    }
    await armAlarm(this.storage, Math.max(bound, this.deps.now() + MIN_REARM_DELAY_MS));
  }
}

// workerd SQLite enforces a ~50-byte LIKE/GLOB pattern limit
// (SQLITE_LIMIT_LIKE_PATTERN_LENGTH), and a real schedule id alone exceeds it
// ("handoff:<uuid>" plus the occurrence suffix), so occurrence-prefix matching cannot
// use LIKE. Every run id for an occurrence starts with "<scheduleId>:<occurrenceAt>:"
// and the next ASCII byte after ':' (0x3A) is ';' (0x3B), so the half-open range
// [lower, upper) matches exactly that prefix and stays index-friendly.
function occurrenceIdRange(scheduleId: string, occurrenceAt: number): readonly [string, string] {
  return [`${scheduleId}:${occurrenceAt}:`, `${scheduleId}:${occurrenceAt};`];
}

function isCrashInjectionError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('crash-injection:');
}

function shouldPropagateDurabilityInvariant(kind: ScheduleKind, err: unknown): boolean {
  if (scheduleKindCanQuarantine(kind) || !(err instanceof Error)) return false;
  return /invalid option|no outbox row|journal\/outbox delivery state mismatch/i.test(
    err.message,
  );
}

function toEntry(row: ScheduleSqlRow): ScheduleEntry {
  return scheduleEntrySchema.parse({
    id: row.id,
    kind: row.kind,
    occurrence_at: row.occurrence_at,
    due_at: row.due_at,
    recurrence: row.recurrence_json === null ? null : JSON.parse(row.recurrence_json),
    payload_refs: JSON.parse(row.payload_json),
    status: row.status,
    attempts: row.attempts,
    last_fired_at: row.last_fired_at,
    quarantined_until: row.quarantined_until,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}

function compareScheduleEntries(a: ScheduleEntry, b: ScheduleEntry): number {
  return (
    scheduleKindPriority[a.kind] - scheduleKindPriority[b.kind] ||
    a.due_at - b.due_at ||
    a.id.localeCompare(b.id)
  );
}

function nextOccurrence(recurrence: ScheduleRecurrence, now: number): number {
  if (recurrence.type === 'interval') {
    const phase = recurrence.phase_ms % recurrence.every_ms;
    const next =
      Math.floor((Math.max(now, 0) - phase) / recurrence.every_ms + 1) *
        recurrence.every_ms +
      phase;
    return next > now ? next : next + recurrence.every_ms;
  }
  if (recurrence.type === 'cron') {
    const schedule = parseCronExpression(recurrence.expression);
    if (schedule === null) throw new Error(`invalid cron recurrence: ${recurrence.expression}`);
    const next = nextCronOccurrence(schedule, recurrence.timezone, now);
    if (next === null) throw new Error(`cron recurrence has no occurrence within scan bound: ${recurrence.expression}`);
    return next;
  }
  return nextDailyLocalOccurrence(recurrence.time, recurrence.timezone, now);
}

function nextDailyLocalOccurrence(time: string, timezone: string, now: number): number {
  const [hourText, minuteText] = time.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const local = localParts(now, timezone);
  const targetMinutes = hour * 60 + minute;
  const localMinutes = local.hour * 60 + local.minute;
  const targetDate =
    localMinutes < targetMinutes ? localDate(local) : addLocalDays(localDate(local), 1);
  return findLocalOccurrence(targetDate, hour, minute, timezone, now);
}

type LocalDate = { year: number; month: number; day: number };

function localParts(at: number, timezone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = localFormatter(timezone).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function localDate(parts: LocalDate): LocalDate {
  return { year: parts.year, month: parts.month, day: parts.day };
}

function addLocalDays(date: LocalDate, days: number): LocalDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

// Formatter construction dominates localParts; cache one per timezone (immutable, safe to share).
const LOCAL_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function localFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = LOCAL_FORMATTERS.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    });
    LOCAL_FORMATTERS.set(timezone, formatter);
  }
  return formatter;
}

function findLocalOccurrence(
  date: LocalDate,
  hour: number,
  minute: number,
  timezone: string,
  after: number,
): number {
  const targetMinutes = hour * 60 + minute;
  const searchStart = Date.UTC(date.year, date.month - 1, date.day) - 24 * 60 * 60_000;
  const searchEnd = Date.UTC(date.year, date.month - 1, date.day + 1) + 24 * 60 * 60_000;
  let fallback: number | null = null;

  // Hour-step to the bracketing hour first, then refine by minute: a flat minute scan over
  // the 3-day window costs up to 4320 tz computations per call, and the missed-run walk
  // calls this up to MAX_MISSED_CHAIN times per delivery (isolate-killing CPU). Semantics
  // are unchanged: same first-match-wins, same first-later-time fallback, same next-day
  // recursion - only the scan order is coarsened before refinement.
  for (let hourStart = searchStart; hourStart <= searchEnd; hourStart += 3_600_000) {
    const hourEnd = Math.min(hourStart + 3_600_000 - 60_000, searchEnd);
    const first = localParts(hourStart, timezone);
    const last = localParts(hourEnd, timezone);
    const spanCoversDate = sameLocalDate(first, date) || sameLocalDate(last, date) ||
      (new Date(Date.UTC(first.year, first.month - 1, first.day)) < new Date(Date.UTC(date.year, date.month - 1, date.day)) &&
       new Date(Date.UTC(last.year, last.month - 1, last.day)) > new Date(Date.UTC(date.year, date.month - 1, date.day)));
    if (!spanCoversDate) continue;
    for (let at = hourStart; at <= hourEnd; at += 60_000) {
      if (at <= after) continue;
      const parts = localParts(at, timezone);
      if (!sameLocalDate(parts, date)) continue;
      const localMinutes = parts.hour * 60 + parts.minute;
      if (localMinutes === targetMinutes) return at;
      if (localMinutes > targetMinutes && fallback === null) fallback = at;
    }
  }

  return fallback ?? findLocalOccurrence(addLocalDays(date, 1), hour, minute, timezone, after);
}

function sameLocalDate(parts: LocalDate, date: LocalDate): boolean {
  return parts.year === date.year && parts.month === date.month && parts.day === date.day;
}
