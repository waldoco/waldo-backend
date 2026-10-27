import {
  healthApiErrorV1Schema, healthDayV1Schema, healthScoresHistoryQueryV1Schema, healthScoresHistoryResponseV1Schema, healthScoresHistoryUnavailableV1Schema,
} from '../../../contracts/src/app/health-ingest';

// The view behind GET /app/v1/health/scores/history: what the signed database read answered, as the contract's body or a closed
// error. The route glue, the signing and the revision gate stay with the other health routes in app-health.ts, which hands this
// module the two things it shares with the scores view so the pillar words are one reading.
type ErrorCode = (typeof healthApiErrorV1Schema.shape.error.options)[number];
type View = { body: object } | { error: ErrorCode };
type Pillar = 'recovery' | 'form' | 'weight';
export type HistoryReaders = Readonly<{
  pillar: (pillar: Pillar, stored: unknown) => object | null;
  failure: (result: unknown) => ErrorCode | null;
}>;

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);

// Exactly one `days`, one of the three windows, and nothing else on the query.
export const historyWindowOf = (url: URL): 7 | 30 | 90 | null => {
  if ([...url.searchParams.keys()].some(key => key !== 'days') || url.searchParams.getAll('days').length !== 1) return null;
  const query = healthScoresHistoryQueryV1Schema.safeParse({ days: url.searchParams.get('days') });
  return query.success ? Number(query.data.days) as 7 | 30 | 90 : null;
};

export const healthHistoryView = (result: unknown, windowDays: 7 | 30 | 90, readers: HistoryReaders): View => {
  const nothing = (reason: unknown): View => {
    const body = healthScoresHistoryUnavailableV1Schema.safeParse({ state: 'unavailable', day: null, reason });
    if (body.success) return { body: body.data };
    console.error('app health scores history reason');
    return { error: 'unavailable' };
  };
  const answered = record(result);
  if (answered?.error === 'not_linked') return nothing('not_linked');
  const failed = readers.failure(answered);
  if (failed) return { error: failed };
  if (typeof answered?.unavailable === 'string') return nothing(answered.unavailable);
  const history = record(answered?.history);
  const rows = history?.days;
  if (!history || !Array.isArray(rows)) {
    console.error('app health scores history shape');
    return { error: 'unavailable' };
  }
  // A row that does not read costs the owner that day, not the chart: it is left out and only the count is logged.
  const days: object[] = [];
  for (const stored of rows) {
    const row = record(stored);
    const day = healthDayV1Schema.safeParse(row?.day);
    const recovery = row && readers.pillar('recovery', row.recovery), form = row && readers.pillar('form', row.form), weight = row && readers.pillar('weight', row.weight);
    if (!row || !day.success || !recovery || !form || !weight) continue;
    days.push({ day: day.data, recovery, form, weight, ...(row.backfilled === true ? { backfilled: true } : {}) });
  }
  if (days.length < rows.length) console.error('app health scores history rows skipped', rows.length - days.length);
  if (rows.length > 0 && days.length === 0) return nothing('no_readings');
  const body = healthScoresHistoryResponseV1Schema.safeParse({ state: 'available', window_days: windowDays, from: history.from, to: history.to, days });
  if (body.success) return { body: body.data };
  console.error('app health scores history shape');
  return { error: 'unavailable' };
};
