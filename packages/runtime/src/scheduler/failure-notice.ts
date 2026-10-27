import type { ScheduleKind } from '@waldo/contracts';
import { localIso } from '../channels/reminders';
import { QUARANTINE_AFTER_ATTEMPTS } from './multiplexer';

type Sql = Pick<SqlStorage, 'exec'>;
type Kv = Pick<DurableObjectStorage['kv'], 'get' | 'put'>;

// How the owner knows each job the scheduler can pause. A kind with no name here pauses without a notice. The day cards
// share one kind, so each is named by its card.
const DAY_CARD_NAMES: Readonly<Record<string, string>> = { 'card:brief': 'Your Brief', 'card:midday': 'Your Check-in', 'card:close': 'Your Close' };
const JOB_NAMES: Partial<Record<ScheduleKind, string>> = {
  brief: 'One of your day cards',
  reminder: 'One of your reminders',
  heartbeat: 'My check on your open items',
  standing_order: 'One of your standing orders',
  dreaming: 'My overnight memory pass',
  pre_activity_spot: 'My regular check of your calendar and mail',
  forget_purge: 'My cleanup of something you asked me to forget',
};
// Jobs that only keep Waldo's own house in order: the owner hears the first time one is paused, then nothing until it has
// run well again. The console's schedule section keeps showing the pause meanwhile.
const QUIET_AFTER_FIRST: ReadonlySet<ScheduleKind> = new Set(['dreaming']);
const QUIET_KEY = 'schedule_failure_told_v1';
const NOTICED_KEY = 'schedule_failure_noticed_v1';
// Outlives any pause and the longest local day one can start on.
const NOTICED_KEEP_MS = 2 * 24 * 60 * 60_000;
type Noticed = readonly Readonly<{ id: string; scheduleId: string; at: number }>[];

// text is null for a pause the daily cap, or a house-keeping job's earlier notice, keeps silent.
export type FailureNotice = Readonly<{ id: string; scheduleId: string; kind: ScheduleKind; until: number; text: string | null }>;

const jobName = (row: Readonly<{ id: string; kind: ScheduleKind }>) => (row.kind === 'brief' ? DAY_CARD_NAMES[row.id] : undefined) ?? JOB_NAMES[row.kind];
const pausedRows = (sql: Sql, now: number) => sql.exec<{ id: string; kind: ScheduleKind; until: number }>(
  `SELECT s.id, s.kind, s.quarantined_until AS until FROM schedule s
    WHERE s.status = 'quarantined' AND s.quarantined_until > ?
      AND (SELECT r.outcome || '/' || r.error_class FROM schedule_runs r WHERE r.schedule_id = s.id
            ORDER BY r.fired_at DESC, r.attempt DESC LIMIT 1) = 'quarantined/run'
    ORDER BY s.quarantined_until, s.id`,
  now,
).toArray();
const retryAt = (timezone: string) => new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// The pauses to tell the owner about: jobs the scheduler paused because their own runs failed QUARANTINE_AFTER_ATTEMPTS
// times in a row. A pause that came from a failed hand-off to an executor, or from a failed delivery, isn't the job's
// failure. Each pause is handled once, keyed by its end, and a job says so at most once per local day: a job re-armed
// and paused again the same day stays silent. A house-keeping job says so once, then stays silent until it has run well.
// The line is fixed per kind, with no job content and no error text, and it names the retry's local time, so it stays
// true while quiet hours hold it.
export function dueFailureNotices(sql: Sql, kv: Kv, now: number, timezone: string): FailureNotice[] {
  const noticed = kv.get<Noticed>(NOTICED_KEY) ?? [];
  const told = kv.get<Record<string, number>>(QUIET_KEY) ?? {};
  const today = localIso(now, timezone).slice(0, 10);
  const when = retryAt(timezone);
  return pausedRows(sql, now).flatMap(row => {
    const name = jobName(row), id = `schedule-failed:${row.id}:${row.until}`;
    if (!name || noticed.some(entry => entry.id === id)) return [];
    const lastOk = sql.exec<{ at: number | null }>("SELECT MAX(fired_at) AS at FROM schedule_runs WHERE schedule_id = ? AND outcome = 'ok'", row.id).one().at ?? 0;
    const quiet = QUIET_AFTER_FIRST.has(row.kind) && told[row.id] !== undefined && told[row.id]! > lastOk;
    const capped = quiet || noticed.some(entry => entry.scheduleId === row.id && localIso(entry.at, timezone).slice(0, 10) === today);
    return [{ id, scheduleId: row.id, kind: row.kind, until: row.until,
      text: capped ? null : `${name} failed ${QUARANTINE_AFTER_ATTEMPTS} times in a row, so I've paused it. I'll try again around ${when.format(row.until)}.` }];
  });
}

export function markFailureNoticed(kv: Kv, notice: FailureNotice, now: number): void {
  const kept = (kv.get<Noticed>(NOTICED_KEY) ?? []).filter(entry => now - entry.at < NOTICED_KEEP_MS && entry.id !== notice.id);
  kv.put(NOTICED_KEY, [...kept, { id: notice.id, scheduleId: notice.scheduleId, at: now }]);
  if (notice.text !== null && QUIET_AFTER_FIRST.has(notice.kind)) kv.put(QUIET_KEY, { ...(kv.get<Record<string, number>>(QUIET_KEY) ?? {}), [notice.scheduleId]: now });
}

// Every job the scheduler has paused for its own failures, named as the owner knows it, with the retry's local time.
export function pausedJobs(sql: Sql, now: number, timezone: string): readonly Readonly<{ id: string; name: string; until: string }>[] {
  const when = retryAt(timezone);
  return pausedRows(sql, now).flatMap(row => { const name = jobName(row); return name ? [{ id: row.id, name, until: when.format(row.until) }] : []; });
}

// Whether the pause a notice names still holds: a re-armed, rescheduled or deleted job makes its notice untrue.
export function failurePauseHolds(sql: Sql, pause: Readonly<{ scheduleId: string; until: number }>): boolean {
  return sql.exec("SELECT 1 FROM schedule WHERE id = ? AND status = 'quarantined' AND quarantined_until = ?", pause.scheduleId, pause.until).toArray().length > 0;
}
