import {
  HEALTH_SERIES_SIGNALS_V1, healthApiErrorV1Schema, healthSignalsQueryV1Schema, healthSignalsResponseV1Schema, healthSignalsUnavailableV1Schema, healthUsualV1Schema,
} from '../../../contracts/src/app/health-ingest';
import { seriesOf } from '../health/signals';

// The view behind GET /app/v1/health/signals: what the signed read answered, reduced by the producer's own code to the contract's
// body or a closed error. The route glue, the signing and the revision gate stay with the other health routes in app-health.ts.
type ErrorCode = (typeof healthApiErrorV1Schema.shape.error.options)[number];
type View = { body: object } | { error: ErrorCode };
type Query = NonNullable<ReturnType<typeof signalsQueryOf>>;

// Exactly one `signal` and one `days`, and nothing else on the query.
export const signalsQueryOf = (url: URL) => {
  if ([...url.searchParams.keys()].some(key => key !== 'signal' && key !== 'days') || url.searchParams.getAll('signal').length !== 1 || url.searchParams.getAll('days').length !== 1) return null;
  const query = healthSignalsQueryV1Schema.safeParse({ signal: url.searchParams.get('signal'), days: url.searchParams.get('days') });
  return query.success ? { signal: query.data.signal, days: Number(query.data.days) as 7 | 30 | 90 } : null;
};

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);

// The owner's usual for the signal as of the newest stored row, when the caller read it: a band that does not read as the
// contract's is left out, never passed on.
const usualOf = (stored: unknown, signal: string): object | undefined => {
  const bands = record(record(stored)?.scores)?.usual;
  const entry = Array.isArray(bands) ? bands.find(band => record(band)?.signal === signal) : undefined;
  const parsed = entry === undefined ? null : healthUsualV1Schema.safeParse(entry);
  return parsed?.success ? parsed.data : undefined;
};

export const healthSignalsView = (result: unknown, query: Query, failure: (result: unknown) => ErrorCode | null, storedScores?: unknown): View => {
  const nothing = (reason: unknown): View => {
    const body = healthSignalsUnavailableV1Schema.safeParse({ state: 'unavailable', signal: query.signal, reason });
    if (body.success) return { body: body.data };
    console.error('app health signals reason');
    return { error: 'unavailable' };
  };
  // The database's own error codes pass as the other health reads pass them; an owner not linked is an answer, as in the history.
  const failed = record(result)?.error === 'not_linked' ? null : failure(result);
  if (failed) return { error: failed };
  const series = seriesOf(result, query.signal);
  if (series.kind === 'failed') {
    console.error('app health signals shape');
    return { error: 'unavailable' };
  }
  if (series.kind === 'unavailable') return nothing(series.reason);
  const usual = usualOf(storedScores, query.signal);
  const body = healthSignalsResponseV1Schema.safeParse({
    state: 'available', signal: query.signal, unit: HEALTH_SERIES_SIGNALS_V1[query.signal].unit, used_in: HEALTH_SERIES_SIGNALS_V1[query.signal].used_in,
    window_days: query.days, from: series.from, to: series.to, days: series.days,
    ...(series.hours.length ? { hours: series.hours } : {}), ...(usual ? { usual } : {}),
  });
  if (body.success) return { body: body.data };
  console.error('app health signals shape');
  return { error: 'unavailable' };
};
