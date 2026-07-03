import { scheduleEntrySchema, type ScheduleEntry } from '@waldo/contracts';
import type { Deps } from '../seams/deps';
import { armAlarm } from '../scheduler/alarm-slot';

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

function toEntry(r: ScheduleSqlRow): ScheduleEntry {
  return scheduleEntrySchema.parse({
    id: r.id,
    kind: r.kind,
    occurrence_at: r.occurrence_at,
    due_at: r.due_at,
    recurrence: r.recurrence_json === null ? null : JSON.parse(r.recurrence_json),
    payload_refs: JSON.parse(r.payload_json),
    status: r.status,
    attempts: r.attempts,
    last_fired_at: r.last_fired_at,
    quarantined_until: r.quarantined_until,
    created_at: r.created_at,
    updated_at: r.updated_at,
  });
}

// Persists the single one-shot tracer schedule entry and arms the DO alarm for it. Arming flows
// through the sole armAlarm() seam — this module owns no raw setAlarm. The 7-schedule multiplexer
// (priority-pop, recurrence-advance, quarantine, DST/jitter) is Phase D.
export class Scheduler {
  constructor(
    private readonly sql: SqlStorage,
    private readonly storage: DurableObjectStorage,
    private readonly deps: Deps,
  ) {}

  async arm(input: { id: string; occurrenceAt: number }): Promise<ScheduleEntry> {
    const at = this.deps.now();
    // occurrence_at is the intended instant; due_at is when the alarm fires. For the one-shot
    // tracer they coincide (no jitter or priority window). Phase D introduces the divergence.
    const dueAt = input.occurrenceAt;
    const scheduleId = `handoff:${input.id}`;
    this.sql.exec(
      `INSERT INTO schedule
         (id, kind, occurrence_at, due_at, recurrence_json, payload_json, status, attempts,
          last_fired_at, quarantined_until, created_at, updated_at)
       VALUES (?, 'handoff', ?, ?, NULL, ?, 'armed', 0, NULL, NULL, ?, ?)`,
      scheduleId,
      input.occurrenceAt,
      dueAt,
      JSON.stringify({ run_id: input.id, cursor: 'tracer' }),
      at,
      at,
    );
    await armAlarm(this.storage, dueAt);
    return this.read(scheduleId) as ScheduleEntry;
  }

  read(id: string): ScheduleEntry | null {
    const rows = this.sql
      .exec<ScheduleSqlRow>('SELECT * FROM schedule WHERE id = ?', id)
      .toArray();
    const row = rows[0];
    return row ? toEntry(row) : null;
  }
}
