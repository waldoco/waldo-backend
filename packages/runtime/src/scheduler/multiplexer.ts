import {
  nextWakeBound,
  scheduleEntrySchema,
  scheduleKindCanQuarantine,
  scheduleKindPriority,
  type ScheduleEntry,
  type ScheduleKind,
  type SchedulePayloadRefs,
  type ScheduleRecurrence,
} from '@waldo/contracts';
import type { Deps } from '../seams/deps';
import { armAlarm } from './alarm-slot';

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
        const fresh = this.read(entry.id);
        if (fresh === null || fresh.status !== 'armed' || fresh.due_at > now + DUE_LOOKAHEAD_MS) {
          continue;
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
    const runId = `${entry.id}:${entry.occurrence_at}:${entry.attempts}`;
    this.sql.exec(
      `INSERT INTO schedule_runs (id, schedule_id, kind, fired_at, attempt) VALUES (?, ?, ?, ?, ?)`,
      runId,
      entry.id,
      entry.kind,
      now,
      entry.attempts,
    );
    return runId;
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
    await armAlarm(this.storage, Math.max(bound, this.deps.now() + 1));
  }
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
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
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

  for (let at = searchStart; at <= searchEnd; at += 60_000) {
    if (at <= after) continue;
    const parts = localParts(at, timezone);
    if (!sameLocalDate(parts, date)) continue;
    const localMinutes = parts.hour * 60 + parts.minute;
    if (localMinutes === targetMinutes) return at;
    if (localMinutes > targetMinutes && fallback === null) fallback = at;
  }

  return fallback ?? findLocalOccurrence(addLocalDays(date, 1), hour, minute, timezone, after);
}

function sameLocalDate(parts: LocalDate, date: LocalDate): boolean {
  return parts.year === date.year && parts.month === date.month && parts.day === date.day;
}
