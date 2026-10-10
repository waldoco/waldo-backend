import type { HealthSource, GetHealthArgs } from '@waldo/contracts';
import type { ContextFragment } from '../context-composer/types';
import type { HealthClock, HealthProduction, HealthResult } from './production';

export type HealthModelFence = Readonly<{
  source: HealthSource;
  storage_epoch: number;
  model_epoch: number;
}>;
export type HealthModelContext = Readonly<{
  state: 'present' | 'absent';
  fragments: readonly ContextFragment[];
  fence: HealthModelFence;
}>;
export type HealthModelContextBook = Readonly<{
  read(snapshotAt: number): Promise<HealthResult<HealthModelContext>>;
  recheck(fence: HealthModelFence): Promise<boolean>;
}>;
const dayBefore = (day: string, offset: number) => new Date(Date.parse(`${day}T00:00:00Z`) - offset * 86400000).toISOString().slice(0, 10);

// Feed these fragments directly to the volatile ContextComposer materials source.
// They must never enter a transcript, tool ledger/checkpoint, R2, observer or job.
// The source-current callback rechecks this fence immediately before provider I/O
// and again after await/resume; provider calls retain store:false.
export const createHealthModelContext = (
  service: HealthProduction, source: HealthSource, clock: HealthClock = { now: () => new Date() },
): HealthModelContextBook => {
  const activeFence = async (): Promise<HealthResult<HealthModelFence>> => {
    const result = await service.consents();
    if (!result.ok) return result;
    const storage = result.data.consents.find(row => row.source === source && row.purpose === 'storage_compute' && row.status === 'granted');
    const model = result.data.consents.find(row => row.source === source && row.purpose === 'model_processing' && row.status === 'granted');
    if (!storage || !model) return { ok: false, error: 'consent_required' };
    return { ok: true, data: { source, storage_epoch: storage.epoch, model_epoch: model.epoch } };
  };
  const recheck = async (fence: HealthModelFence): Promise<boolean> => {
    if (fence.source !== source) return false;
    const current = await activeFence();
    return current.ok && current.data.storage_epoch === fence.storage_epoch && current.data.model_epoch === fence.model_epoch;
  };
  return {
    recheck,
    async read(snapshotAt) {
      if (!Number.isFinite(snapshotAt) || snapshotAt > clock.now().getTime()) return { ok: false, error: 'invalid_request' };
      const current = await activeFence();
      if (!current.ok) return current;
      const fence = current.data;
      const summary = await service.today(source);
      if (!summary.ok) return summary;
      if (summary.data === null) {
        if (!await recheck(fence)) return { ok: false, error: 'consent_withdrawn' };
        return { ok: true, data: { state: 'absent', fragments: [], fence } };
      }
      if (summary.data.consent_epoch !== fence.storage_epoch || Date.parse(summary.data.compiled_at) > snapshotAt) return { ok: false, error: 'epoch_conflict' };
      const readings = await service.readings({ source, from: dayBefore(summary.data.day, 2), to: summary.data.day, consent_epoch: fence.storage_epoch }, 'model');
      if (!readings.ok) return readings;
      if (!await recheck(fence)) return { ok: false, error: 'consent_withdrawn' };
      const eligible = readings.data.samples.filter(sample => Date.parse(sample.end_at) <= snapshotAt);
      const currentDay = eligible.filter(sample => sample.day === summary.data!.day);
      // The compact turn context is the latest observed day's source assertions.
      // The bounded readings API remains available for an explicitly needed series.
      const selected = currentDay.slice(0, 32);
      const payload = {
        context_kind: 'owner_health', source, source_taint: null, day: summary.data.day,
        timezone: summary.data.timezone, observed_at: summary.data.compiled_at,
        freshness: summary.data.freshness, coverage: summary.data.coverage,
        recovery: summary.data.recovery, form: summary.data.form, weight: summary.data.weight,
        ...(summary.data.sleep_debt ? { sleep_debt: summary.data.sleep_debt } : {}),
        readings: selected,
        readings_coverage: selected.length < currentDay.length || readings.data.has_more ? 'partial' : 'complete_current_day',
        clinical_validation: 'not_established',
      };
      return { ok: true, data: { state: 'present', fence, fragments: [{
        text: JSON.stringify(payload),
        source: { source_key: `health:${source}:${summary.data.day}:${fence.storage_epoch}:${fence.model_epoch}`, source_kind: 'derived_health_view', scope: 'principal', source_taint: null, produced_at: Date.parse(summary.data.compiled_at) },
      }] } };
    },
  };
};


export type OwnerHealthTurnSources = Readonly<{
  read(snapshotAt?: number): Promise<readonly ContextFragment[]>;
  readCurrent(snapshotAt?: number): Promise<readonly ContextFragment[]>;
  readings(args: GetHealthArgs): Promise<HealthResult<unknown>>;
  assertCurrent(): Promise<void>;
}>;

// One factory instance per admitted turn, bound to that owner's signed service.
// The host joins these materials with context.withOwnerHealthSources(). No values
// or fences are cached in durable storage, and a regrant cannot revive old input.
export const createOwnerHealthTurnSources = (
  service: HealthProduction, clock: HealthClock = { now: () => new Date() },
): OwnerHealthTurnSources => {
  const fences = new Map<HealthSource, { book: HealthModelContextBook; fence: HealthModelFence }>();
  const assertCurrent = async () => {
    for (const { book, fence } of fences.values()) if (!await book.recheck(fence)) throw new Error('Owner health processing authority changed.');
  };
  const readCurrent = async (snapshotAt = clock.now().getTime()): Promise<readonly ContextFragment[]> => {
      await assertCurrent();
      const grants = await service.consents();
      // Missing/declined/unavailable health never prevents the owner's general work
      // before health bytes have been admitted. Existing fences fail closed above.
      if (!grants.ok) return [];
      const enabled = grants.data.consents.filter(row => row.purpose === 'model_processing' && row.status === 'granted'
        && grants.data.consents.some(storage => storage.source === row.source && storage.purpose === 'storage_compute' && storage.status === 'granted'));
      const fragments: ContextFragment[] = [];
      for (const grant of enabled) {
        const book = createHealthModelContext(service, grant.source, clock);
        const result = await book.read(snapshotAt);
        if (!result.ok) {
          if (fences.has(grant.source)) throw new Error('Owner health processing authority changed.');
          continue;
        }
        if (result.data.state === 'present') {
          const previous = fences.get(grant.source);
          if (previous && (previous.fence.storage_epoch !== result.data.fence.storage_epoch || previous.fence.model_epoch !== result.data.fence.model_epoch)) throw new Error('Owner health processing authority changed.');
          fences.set(grant.source, { book, fence: result.data.fence });
          fragments.push(...result.data.fragments);
        }
      }
      await assertCurrent();
      if (!fragments.length) return [];
      // One compact material preserves all producer/vendor/method provenance in
      // its source objects without consuming the external workspace fragment budget.
      return [{ text: JSON.stringify({ context_kind: 'owner_health_sources', sources: fragments.map(fragment => ({ source: fragment.source, health: JSON.parse(fragment.text) })) }),
        source: { source_key: `health:owner:${[...fences.values()].map(({ fence }) => `${fence.source}:${fence.storage_epoch}:${fence.model_epoch}`).join(':')}`,
          source_kind: 'derived_health_view', scope: 'principal', source_taint: null, produced_at: Math.max(...fragments.map(fragment => fragment.source.produced_at)) } }];
  };
  return {
    assertCurrent,
    // Numeric health is explicitly selected by get_health. Consent alone does not
    // inject protected bytes into an unrelated general task or its public tools.
    read: async () => { await assertCurrent(); return []; },
    readCurrent,
    async readings(args) {
      const fragments = await readCurrent();
      if (!fragments.length) return { ok: false, error: 'consent_required' };
      const sources = JSON.parse(fragments[0]!.text).sources as { health: { source: HealthSource; day: string; timezone: string; [key: string]: unknown } }[];
      const chosen = sources.filter(({ health }) => !args.source || health.source === args.source);
      if (!chosen.length) return { ok: false, error: 'consent_required' };
      const out: unknown[] = [];
      const names: Record<string, string[]> = { hrv: ['overnight_hrv'], hr: ['resting_heart_rate', 'movement_hr'], sleep: ['sleep_duration', 'sleep_efficiency'], spo2: [], strain: ['physical_load'], recovery: [], form: [], weight: [], sleep_debt: [] };
      for (const { health } of chosen) {
        const captured = fences.get(health.source)!;
        const parts = args.date ? new Intl.DateTimeFormat('en-US', { timeZone: health.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(args.date)) : null;
        const part = (type: string) => parts?.find(p => p.type === type)?.value;
        const to = parts ? `${part('year')}-${part('month')}-${part('day')}` : health.day;
        const from = dayBefore(to, args.range_days - 1);
        const result = await service.readings({ source: health.source, from, to, consent_epoch: captured.fence.storage_epoch }, 'model');
        if (!result.ok) return result;
        await assertCurrent();
        const metrics = args.metrics?.flatMap(metric => names[metric] ?? []);
        const eligible = result.data.samples.filter(sample => Date.parse(sample.end_at) <= clock.now().getTime() && (!metrics || metrics.includes(sample.metric)));
        const selected = eligible.slice(0, args.max_samples);
        const summary = Object.fromEntries(Object.entries(health).filter(([key]) => !['readings', 'readings_coverage'].includes(key) && (!['recovery', 'form', 'weight', 'sleep_debt'].includes(key) || !args.metrics || args.metrics.includes(key as never))));
        out.push({ summary, from, to, samples: selected, coverage: result.data.has_more || selected.length < eligible.length ? 'partial_narrow_request' : 'complete', returned_samples: selected.length, clinical_validation: 'not_established' });
      }
      await assertCurrent();
      return { ok: true, data: { context_kind: 'owner_health_sources', sources: out, custody: 'volatile_owner_health' } };
    },
  };
};
