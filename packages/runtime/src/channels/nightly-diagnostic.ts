// Owner-console diagnostic for one fixed scheduler entry. Do not accept a schedule id or
// include payload/episode text: this is state evidence, not a general DO SQL endpoint.
export const nightlyDiagnostic = async (storage: DurableObjectStorage) => {
  const schedule = storage.sql.exec<{
    id: string; kind: string; status: string; occurrence_at: number; due_at: number;
    recurrence_json: string | null; attempts: number; last_fired_at: number | null;
    quarantined_until: number | null;
  }>(`SELECT id, kind, status, occurrence_at, due_at, recurrence_json, attempts,
            last_fired_at, quarantined_until FROM schedule WHERE id = 'nightly-memory'`).toArray()[0] ?? null;
  const runs = storage.sql.exec<{
    id: string; schedule_id: string; kind: string; fired_at: number; attempt: number;
    outcome: string; error_class: string | null; settled_at: number | null; duration_ms: number | null;
  }>(`SELECT id, schedule_id, kind, fired_at, attempt, outcome, error_class,
            settled_at, duration_ms FROM schedule_runs
       WHERE schedule_id = 'nightly-memory' ORDER BY fired_at DESC, id DESC LIMIT 10`).toArray();
  return { schedule, runs, alarm_at: await storage.getAlarm() };
};
