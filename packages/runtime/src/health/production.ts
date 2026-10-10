import {
  healthApiErrorSchema, healthConsentGrantSchema, healthConsentStateSchema,
  healthConsentWithdrawSchema, healthDailySummarySchema, healthHistoryQuerySchema,
  healthIngestReceiptSchema, healthIngestSchema, healthReadingsSchema, healthReadingsQuerySchema,
  healthConsentListSchema, healthConsentChangeSchema, healthProducerTodaySchema,
  healthProducerHistorySchema, healthRetentionReceiptSchema, healthPurgeReceiptSchema,
} from '../../../contracts/src/health/ingest';
import type {
  HealthApiErrorCode, HealthConsentGrant, HealthConsentState, HealthConsentWithdraw,
  HealthDailySummary, HealthHistoryQuery, HealthIngest, HealthIngestReceipt,
  HealthReadings, HealthReadingsQuery, HealthSample, HealthProducerDay, HealthConsentList, HealthConsentChange, HealthPurgeReceipt,
} from '../../../contracts/src/health/ingest';
import { healthSourceSchema, type HealthSource } from '@waldo/contracts';
import { md5Hex } from '../channels/md5';
import { produceReviewedHealthSummary, type HealthCalculationActivation } from './producer';

export type HealthSignedCall = (fn: string, message: string, args: Record<string, string | number>) => Promise<unknown>;
export type HealthResult<T> = { ok: true; data: T } | { ok: false; error: HealthApiErrorCode };
export type HealthClock = Readonly<{ now(): Date }>;
const fail = (error: HealthApiErrorCode): HealthResult<never> => ({ ok: false, error });
type HealthValidator<T> = Readonly<{ safeParse(input: unknown): { success: true; data: T } | { success: false; error: unknown } }>;

const localDay = (at: string, timezone: string): string => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at));
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};

const mergedIntervals = (sample: HealthSample, kind: 'asleep' | 'in_bed'): [number, number][] => {
  const intervals = sample.sleep_context?.intervals.filter(interval => interval.kind === kind).map(interval => [Date.parse(interval.start_at), Date.parse(interval.end_at)] as [number, number]).sort(([left], [right]) => left - right) ?? [];
  const result: [number, number][] = [];
  for (const interval of intervals) {
    const previous = result.at(-1);
    if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1]); else result.push([...interval]);
  }
  return result;
};
const intervalMinutes = (intervals: readonly [number, number][]) => intervals.reduce((sum, [start, end]) => sum + (end - start) / 60000, 0);
const attributableSample = (sample: HealthSample, timezone: string, now: number): boolean => {
  const origin = sample.origin, sleep = sample.sleep_context;
  if (origin?.read_api === 'healthkit' && !origin.source_bundle_id || origin?.read_api === 'health_connect' && !origin.source_package_name) return false;
  if (!sleep) return !(origin && (sample.metric === 'overnight_hrv' || (sample.metric === 'sleep_duration' && sample.method === 'asleep_duration') || (sample.metric === 'resting_heart_rate' && sample.method === 'overnight_resting') || sample.metric === 'sleep_efficiency'));
  if (!origin || sleep.waking_day !== sample.day || (origin.read_api === 'healthkit' && sleep.source_ref !== origin.source_bundle_id) || (origin.read_api === 'health_connect' && sleep.source_ref !== origin.source_package_name)) return false;
  if (sleep.intervals.some(interval => Date.parse(interval.end_at) > now + 300000 || Date.parse(interval.end_at) - Date.parse(interval.start_at) > 36 * 3600000)) return false;
  const asleep = mergedIntervals(sample, 'asleep'), inBed = mergedIntervals(sample, 'in_bed');
  const end = asleep.at(-1)?.[1];
  if (end !== undefined && localDay(new Date(end).toISOString(), timezone) !== sleep.waking_day) return false;
  if (sample.metric === 'sleep_duration' && sample.method === 'asleep_duration') return Math.abs(sample.value - intervalMinutes(asleep)) <= .001;
  if (sample.metric === 'sleep_efficiency') {
    const denominator = intervalMinutes(inBed);
    return denominator > 0 && asleep.every(([start, finish]) => inBed.some(([bedStart, bedEnd]) => start >= bedStart && finish <= bedEnd)) && Math.abs(sample.value - intervalMinutes(asleep) / denominator) <= .000001;
  }
  if (sample.metric === 'overnight_hrv' || sample.metric === 'resting_heart_rate' && sample.method === 'overnight_resting') {
    const start = Date.parse(sample.start_at), finish = Date.parse(sample.end_at);
    return asleep.some(([sleepStart, sleepEnd]) => start >= sleepStart && finish <= sleepEnd);
  }
  return true;
};

// Current accepted source provides the recovery.v1 view vocabulary but no accepted
// numeric component normalizers. Coverage is real; the score stays unavailable until
// the reviewed algorithm registry and golden vectors exist. No population fallback.
export const produceHealthDailySummary = (input: HealthProducerDay, clock: HealthClock): HealthDailySummary => {
  const daySamples = input.samples.filter(sample => sample.day === input.day);
  const metrics = new Map<string, HealthSample[]>();
  for (const sample of daySamples) metrics.set(sample.metric, [...(metrics.get(sample.metric) ?? []), sample]);
  const rawConflicts = [...metrics].filter(([, samples]) => {
    const signatures = new Set(samples.map(sample => `${sample.value}:${sample.metric === 'overnight_hrv' ? sample.method : ''}`));
    return signatures.size > 1;
  }).map(([metric]) => metric);
  const aggregate = input.aggregates.find(day => day.day === input.day);
  const conflicts = [...new Set([...rawConflicts, ...(aggregate?.conflicting_metrics ?? [])])];
  const currentMethod = daySamples.find(sample => sample.metric === 'overnight_hrv');
  const method = currentMethod?.metric === 'overnight_hrv' ? currentMethod.method : aggregate?.methods.length === 1 ? aggregate.methods[0]! : null;
  const past = input.samples.filter(sample => sample.day < input.day && Date.parse(input.day) - Date.parse(sample.day) <= 30 * 86400000);
  const days = new Map<string, Set<string>>();
  for (const sample of past) {
    if (input.aggregates.some(day => day.day === sample.day && day.conflicting_metrics.length > 0)) continue;
    // Mixing RMSSD and SDNN would silently change the baseline's measurement.
    if (sample.metric === 'overnight_hrv' && sample.method !== method) continue;
    const coverage = days.get(sample.day) ?? new Set<string>();
    coverage.add(sample.metric); days.set(sample.day, coverage);
  }
  for (const day of input.aggregates) {
    if (day.day >= input.day || Date.parse(input.day) - Date.parse(day.day) > 30 * 86400000 || day.conflicting_metrics.length > 0) continue;
    const coverage = days.get(day.day) ?? new Set<string>();
    for (const metric of day.metrics) {
      if (metric === 'overnight_hrv' && (day.methods.length !== 1 || day.methods[0] !== method)) continue;
      coverage.add(metric);
    }
    days.set(day.day, coverage);
  }
  const distinctDays = [...days.values()].filter(coverage => coverage.has('sleep_duration') && (coverage.has('overnight_hrv') || coverage.has('resting_heart_rate'))).length;
  const age = clock.now().getTime() - Date.parse(input.compiled_at);
  const freshness = age <= 36 * 3600000 ? 'fresh' : age <= 72 * 3600000 ? 'stale' : 'expired';
  const hasMetric = (metric: string) => metrics.has(metric) || aggregate?.metrics.some(value => value === metric) === true;
  const hasSleep = hasMetric('sleep_duration');
  const hasRest = hasMetric('overnight_hrv') || hasMetric('resting_heart_rate');
  const reason = conflicts.length > 0 ? 'conflicting_inputs' : !hasSleep ? 'missing_sleep' : !hasRest ? 'missing_resting_signal' : freshness === 'expired' ? 'stale_inputs' : 'algorithm_not_accepted';
  return healthDailySummarySchema.parse({
    day: input.day, source: input.source, timezone: input.timezone,
    consent_epoch: input.consent_epoch, compiled_at: input.compiled_at, freshness,
    coverage: { sleep: hasSleep, hrv: hasMetric('overnight_hrv'), resting_heart_rate: hasMetric('resting_heart_rate'), conflicting_metrics: conflicts },
    baseline: { state: 'not_computed', distinct_days: distinctDays, required_days: null, method },
    recovery: { state: 'unavailable', reason },
    form: { state: 'unavailable', reason: 'intraday_inputs_unavailable' },
    weight: { state: 'unavailable', reason: 'calendar_demand_unavailable' },
  });
};

export type HealthProduction = Readonly<{
  linked(): boolean;
  consents(): Promise<HealthResult<HealthConsentList>>;
  grant(input: HealthConsentGrant): Promise<HealthResult<HealthConsentChange>>;
  withdraw(input: HealthConsentWithdraw): Promise<HealthResult<HealthConsentChange>>;
  ingest(input: HealthIngest): Promise<HealthResult<HealthIngestReceipt>>;
  today(source: HealthSource): Promise<HealthResult<HealthDailySummary | null>>;
  history(query: HealthHistoryQuery): Promise<HealthResult<{ days: HealthDailySummary[] }>>;
  readings(query: HealthReadingsQuery, audience: 'owner' | 'model'): Promise<HealthResult<HealthReadings>>;
  retention(): Promise<HealthResult<{ raw_deleted: number; aggregates_deleted: number }>>;
  purge(): Promise<HealthResult<HealthPurgeReceipt>>;
}>;

// Construct per admitted request/turn using the authenticated server owner. The
// signed RPC maps doName to the existing Auth/public user identity and rechecks
// consent in the same transaction as every mutation/read. Volatile owner-turn
// processing may use this service; health payloads must never enter durable DO
// storage/checkpoints/transcripts. This object holds no health cache.
export const createHealthProduction = (call: HealthSignedCall | null, doName: string | null, clock: HealthClock = { now: () => new Date() }, calculations?: HealthCalculationActivation): HealthProduction => {
  const invoke = async <T>(operation: string, payload: unknown, schema: HealthValidator<T>): Promise<HealthResult<T>> => {
    if (!call || !doName) return fail('not_linked');
    const body = JSON.stringify(payload);
    let result: unknown;
    try { result = await call('health_plane', `healthplane.${doName}.${operation}.${md5Hex(body)}`, { p_do_name: doName, p_operation: operation, p_payload: body }); }
    catch { return fail('unavailable'); } // Provider errors may contain physiological values.
    const error = healthApiErrorSchema.safeParse(result);
    if (error.success) return fail(error.data.error);
    const parsed = schema.safeParse(result);
    return parsed.success ? { ok: true, data: parsed.data } : fail('unavailable');
  };
  return {
    linked: () => call !== null && doName !== null,
    consents: () => invoke('consents', {}, healthConsentListSchema),
    grant: input => {
      const parsed = healthConsentGrantSchema.safeParse(input);
      return parsed.success ? invoke('grant', parsed.data, healthConsentChangeSchema) : Promise.resolve(fail('invalid_request'));
    },
    withdraw: input => {
      const parsed = healthConsentWithdrawSchema.safeParse(input);
      return parsed.success ? invoke('withdraw', parsed.data, healthConsentChangeSchema) : Promise.resolve(fail('invalid_request'));
    },
    ingest: input => {
      const parsed = healthIngestSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(fail('invalid_request'));
      const now = clock.now().getTime();
      const identities = new Set<string>();
      for (const sample of parsed.data.samples) {
        const identity = `${sample.metric}:${sample.sample_id}`;
        if (identities.has(identity) || Date.parse(sample.end_at) > now + 300000 || !attributableSample(sample, parsed.data.timezone, now) || (sample.sleep_context ? sample.sleep_context.waking_day !== sample.day : localDay(sample.end_at, parsed.data.timezone) !== sample.day)) return Promise.resolve(fail('invalid_request'));
        identities.add(identity);
      }
      for (const deletion of parsed.data.deletions) {
        const identity = `${deletion.metric}:${deletion.sample_id}`;
        if (identities.has(identity)) return Promise.resolve(fail('invalid_request'));
        identities.add(identity);
      }
      return invoke('ingest', parsed.data, healthIngestReceiptSchema).then(result => result.ok && (
        result.data.request_id !== parsed.data.request_id || result.data.source !== parsed.data.source || result.data.consent_epoch !== parsed.data.consent_epoch
        || result.data.anchor_after !== parsed.data.anchor_after || result.data.accepted + result.data.deleted + result.data.ignored !== parsed.data.samples.length + parsed.data.deletions.length
      ) ? fail('unavailable') : result);
    },
    async today(source) {
      if (!healthSourceSchema.safeParse(source).success) return fail('invalid_request');
      const result = await invoke('today', { source }, healthProducerTodaySchema);
      if (!result.ok) return result;
      if (result.data === null) return { ok: true, data: null };
      if (result.data.source !== source) return fail('unavailable');
      try {
        if (Date.parse(result.data.compiled_at) > clock.now().getTime() + 300000) return fail('unavailable');
        const basic = produceHealthDailySummary(result.data, clock);
        const enriched = calculations && doName ? await produceReviewedHealthSummary(result.data, basic, doName, clock.now().toISOString(), calculations) : basic;
        // An asynchronous intraday/source supplier must not return results after
        // withdrawal or regrant changed this source's current storage epoch.
        if (calculations) {
          const current = await invoke('consents', {}, healthConsentListSchema);
          if (!current.ok) return current;
          if (!current.data.consents.some(consent => consent.source === source && consent.purpose === 'storage_compute' && consent.status === 'granted' && consent.epoch === result.data!.consent_epoch)) return fail('consent_withdrawn');
        }
        const parsed = healthDailySummarySchema.safeParse(enriched);
        return parsed.success ? { ok: true, data: parsed.data } : fail('unavailable');
      } catch { return fail('unavailable'); } // Never expose malformed provider data.
    },
    async history(query) {
      const parsed = healthHistoryQuerySchema.safeParse(query);
      if (!parsed.success) return fail('invalid_request');
      const result = await invoke('history', parsed.data, healthProducerHistorySchema);
      if (!result.ok) return result;
      try {
        const days: HealthDailySummary[] = [];
        for (const day of result.data.days) {
          if (day.source !== parsed.data.source || day.consent_epoch !== parsed.data.consent_epoch || day.day < parsed.data.from || day.day > parsed.data.to) return fail('unavailable');
          const basic = produceHealthDailySummary(day, clock);
          days.push(calculations && doName ? await produceReviewedHealthSummary(day, basic, doName, day.compiled_at, calculations) : basic);
        }
        if (calculations) {
          const current = await invoke('consents', {}, healthConsentListSchema);
          if (!current.ok) return current;
          if (!current.data.consents.some(consent => consent.source === parsed.data.source && consent.purpose === 'storage_compute' && consent.status === 'granted' && consent.epoch === parsed.data.consent_epoch)) return fail('consent_withdrawn');
        }
        return { ok: true, data: { days } };
      }
      catch { return fail('unavailable'); }
    },
    readings(query, audience) {
      const parsed = healthReadingsQuerySchema.safeParse(query);
      if (!parsed.success || (audience !== 'owner' && audience !== 'model')) return Promise.resolve(fail('invalid_request'));
      return invoke('readings', { ...parsed.data, audience }, healthReadingsSchema).then(result => result.ok && (
        result.data.source !== parsed.data.source || result.data.consent_epoch !== parsed.data.consent_epoch || (result.data.has_more && !result.data.next_cursor)
        || result.data.samples.some(sample => sample.day < parsed.data.from || sample.day > parsed.data.to || Date.parse(sample.start_at) > Date.parse(sample.end_at) || Date.parse(sample.end_at) > clock.now().getTime() + 300000)
      ) ? fail('unavailable') : result);
    },
    retention: () => invoke('retention', {}, healthRetentionReceiptSchema),
    purge: () => invoke('purge', {}, healthPurgeReceiptSchema),
  };
};

const statusOf = (error: HealthApiErrorCode): number => error === 'invalid_request' ? 400 : error.endsWith('_conflict') ? 409 : error === 'unavailable' ? 503 : 403;
const reply = <T>(result: HealthResult<T>): Response => Response.json(result.ok ? result.data : { error: result.error }, { status: result.ok ? 200 : statusOf(result.error), headers: { 'cache-control': 'no-store' } });
const BODY_BYTES = 98304;
export const healthProductionRequest = async (request: Request, service: HealthProduction): Promise<Response | null> => {
  const url = new URL(request.url);
  const prefix = '/app/v1/health';
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null;
  // The serving adapter authenticates and rate-limits before invoking this handler.
  const method = request.method;
  const path = url.pathname.slice(prefix.length);
  if (method === 'GET' && path === '/consents') return reply(await service.consents());
  if (method === 'GET' && path === '/today') {
    const source = healthSourceSchema.safeParse(url.searchParams.get('source') ?? 'apple');
    return source.success ? reply(await service.today(source.data)) : reply(fail('invalid_request'));
  }
  if (method === 'GET' && (path === '/history' || path === '/readings')) {
    const query = (path === '/readings' ? healthReadingsQuerySchema : healthHistoryQuerySchema).safeParse({ source: url.searchParams.get('source'), from: url.searchParams.get('from'), to: url.searchParams.get('to'), consent_epoch: Number(url.searchParams.get('consent_epoch')), ...(path === '/readings' && url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor') } : {}) });
    if (!query.success || url.searchParams.get('consent_epoch') === null) return reply(fail('invalid_request'));
    return path === '/history' ? reply(await service.history(query.data)) : reply(await service.readings(query.data, 'owner'));
  }
  if (method === 'POST' && (path === '/consents' || path === '/consents/withdraw' || path === '/ingest')) {
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return reply(fail('invalid_request'));
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > BODY_BYTES) return new Response(null, { status: 413, headers: { 'cache-control': 'no-store' } });
    const reader = request.body?.getReader();
    if (!reader) return reply(fail('invalid_request'));
    const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > BODY_BYTES) { await reader.cancel(); return new Response(null, { status: 413, headers: { 'cache-control': 'no-store' } }); }
      chunks.push(chunk.value);
    }
    const buffer = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer)); }
    catch { return reply(fail('invalid_request')); }
    const schema = path === '/consents' ? healthConsentGrantSchema : path === '/ingest' ? healthIngestSchema : healthConsentWithdrawSchema;
    const parsed = schema.safeParse(payload);
    if (!parsed.success) return reply(fail('invalid_request'));
    if (request.headers.get('idempotency-key') !== parsed.data.request_id) return reply(fail('invalid_request'));
    if (path === '/consents') return reply(await service.grant(parsed.data as HealthConsentGrant));
    if (path === '/consents/withdraw') return reply(await service.withdraw(parsed.data as HealthConsentWithdraw));
    return reply(await service.ingest(parsed.data as HealthIngest));
  }
  return new Response(null, { status: method === 'GET' || method === 'POST' ? 404 : 405, headers: { 'cache-control': 'no-store' } });
};
