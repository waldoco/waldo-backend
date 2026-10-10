import { healthApiErrorSchema } from '../../../contracts/src/health/ingest';
import { healthDemandQuerySchema, healthDemandReadSchema, healthDemandReceiptSchema, healthDemandRecordSchema, healthDemandRetentionSchema } from '../../../contracts/src/health/demand';
import type { HealthDemandQuery, HealthDemandRecord } from '../../../contracts/src/health/demand';
import type { HealthClock, HealthResult, HealthSignedCall } from './production';
import type { CandidateObservation, CandidateSeries } from './calculations';
import { md5Hex } from '../channels/md5';
import { healthDaySchema, healthTimezoneSchema } from '../../../contracts/src/health/ingest';

const localDay = (at: string, timezone: string) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at));
  return `${parts.find(part => part.type === 'year')!.value}-${parts.find(part => part.type === 'month')!.value}-${parts.find(part => part.type === 'day')!.value}`;
};
const shifted = (day: string, offset: number) => new Date(Date.parse(day) + offset * 86400000).toISOString().slice(0, 10);
type Validator<T> = { safeParse(v: unknown): { success: true; data: T } | { success: false } };

// Durable baseline observations stay in the consent-fenced Supabase health plane.
// A signed call never substitutes for the host's provider/source-current check.
export const createHealthDemandProduction = (call: HealthSignedCall | null, doName: string | null, clock: HealthClock = { now: () => new Date() }) => {
  const invoke = async <T>(operation: string, payload: unknown, schema: Validator<T>): Promise<HealthResult<T>> => {
    if (!call || !doName) return { ok: false, error: 'not_linked' };
    const body = JSON.stringify(payload);
    try {
      const result = await call('health_demand', `healthdemand.${doName}.${operation}.${md5Hex(body)}`, { p_do_name: doName, p_operation: operation, p_payload: body });
      const error = healthApiErrorSchema.safeParse(result);
      if (error.success) return { ok: false, error: error.data.error };
      const parsed = schema.safeParse(result);
      return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: 'unavailable' };
    } catch { return { ok: false, error: 'unavailable' }; } // Never echo provider or derived health payloads.
  };
  const read = async (query: HealthDemandQuery, audience: 'owner' | 'model' = 'owner') => {
    const parsed = healthDemandQuerySchema.safeParse(query);
    if (!parsed.success || !['owner', 'model'].includes(audience)) return { ok: false as const, error: 'invalid_request' as const };
    const result = await invoke('read', { ...parsed.data, audience }, healthDemandReadSchema);
    if (!result.ok) return result;
    if (result.data.source !== query.source || result.data.consent_epoch !== query.consent_epoch || result.data.observations.some(row => row.metric !== query.metric || row.source_ref !== query.source_ref || row.context_ref !== query.context_ref || row.day < query.from || row.day > query.to)) return { ok: false as const, error: 'unavailable' as const };
    return result;
  };
  return {
    async record(input: HealthDemandRecord) {
      const parsed = healthDemandRecordSchema.safeParse(input);
      if (!parsed.success) return { ok: false as const, error: 'invalid_request' as const };
      const identities = new Set<string>(), now = clock.now().getTime();
      for (const row of parsed.data.observations) {
        const identity = JSON.stringify([row.metric, row.source_ref, row.context_ref, row.day]);
        if (identities.has(identity) || Date.parse(row.queried_at) > now + 300000 || localDay(row.observed_at, row.timezone) !== row.day) return { ok: false as const, error: 'invalid_request' as const };
        identities.add(identity);
      }
      const result = await invoke('record', parsed.data, healthDemandReceiptSchema);
      if (result.ok && (result.data.request_id !== input.request_id || result.data.source !== input.source || result.data.consent_epoch !== input.consent_epoch || result.data.accepted + result.data.ignored !== input.observations.length)) return { ok: false as const, error: 'unavailable' as const };
      return result;
    },
    read,
    async series(query: Omit<HealthDemandQuery, 'from' | 'to'> & { day: string; timezone: string }, audience: 'owner' | 'model' = 'owner'): Promise<HealthResult<CandidateSeries>> {
      if (!healthDaySchema.safeParse(query.day).success || !healthTimezoneSchema.safeParse(query.timezone).success) return { ok: false, error: 'invalid_request' };
      const { day, timezone, ...scope } = query;
      const result = await read({ ...scope, from: shifted(day, -30), to: day }, audience);
      if (!result.ok) return result;
      if (result.data.observations.some(row => row.timezone !== timezone)) return { ok: false, error: 'unavailable' };
      const observations: CandidateObservation[] = result.data.observations.map(row => ({ owner_ref: doName!, consent_epoch: query.consent_epoch, source_ref: row.source_ref, context_ref: row.context_ref, metric: row.metric, method: row.method, unit: row.unit, day: row.day, timezone: row.timezone, observed_at: row.observed_at, revision: row.revision, value: row.value }));
      return { ok: true, data: { current: observations.find(row => row.day === day) ?? null, history: observations.filter(row => row.day < day) } };
    },
    retention: () => invoke('retention', {}, healthDemandRetentionSchema),
  };
};
export type HealthDemandProduction = ReturnType<typeof createHealthDemandProduction>;
