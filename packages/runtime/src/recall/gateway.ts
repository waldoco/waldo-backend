import {
  buildRecallQuery,
  episodeHitSchema,
  episodeSearchArgsSchema,
  formZoneSchema,
  RECALL_CONFIG,
  recallKeySchema,
  recallMemoryHitSchema,
  recallResultSchema,
  retrieveArgsSchema,
  retrieveHitSchema,
  sourceTaintSchema,
  taintStampSchema,
  type CanaryTokens,
  type EpisodeHit,
  type EpisodeSearchArgs,
  type NarrativeContext,
  type RecallGateway,
  type RecallKey,
  type RecallMemoryHit,
  type RecallStatus,
  type RetrieveArgs,
  type SourceTaint,
} from '@waldo/contracts';
import { prepareWithScribe } from '../scribe/prepare';

const MEMORY_LIMIT = 5;
const EPISODE_LIMIT = 3;
const DAY_MS = 86_400_000;
const ECMASCRIPT_DATE_MAX_MS = 8_640_000_000_000_000;
const UNMAPPED_QUERY = 'recall unavailable';

type SourceClass = 'memory' | 'episode';

type CapturedSource =
  | Readonly<{ ok: true; rows: unknown }>
  | Readonly<{ ok: false }>;

type RecallEnvelope = Readonly<{
  hit: unknown;
  source_taint: SourceTaint;
}>;

type RowAdmission<T> = Readonly<{
  rows: readonly T[];
  rejected: number;
}>;

export type RecallTelemetryEvent = Readonly<{
  recall_status: RecallStatus;
  source_class: SourceClass;
  count: number;
  error_class: 'source_unavailable' | 'row_rejected' | 'canary_leak';
}>;

export type RecallTelemetry = Readonly<{
  record(event: RecallTelemetryEvent): void | Promise<void>;
}>;

export class RecallSecurityHalt extends Error {
  readonly code = 'canary_leak' as const;

  constructor(readonly sourceClass: SourceClass) {
    super('recall security halt');
    this.name = 'RecallSecurityHalt';
  }
}

export type RuntimeRecallContext = Readonly<{
  recallKey: RecallKey | undefined;
  zone: NarrativeContext['zone'];
  canaryTokens: CanaryTokens;
}>;

export type OwnerBoundRecallReads = Readonly<{
  retrieve(args: RetrieveArgs): Promise<readonly unknown[]>;
  searchEpisodes(args: EpisodeSearchArgs): Promise<readonly unknown[]>;
}>;

export type RuntimeRecallGatewayDeps = Readonly<{
  reads: OwnerBoundRecallReads;
  now?: () => number;
  telemetry?: RecallTelemetry;
}>;

export function createRuntimeRecallGateway(
  deps: RuntimeRecallGatewayDeps,
): RecallGateway<RuntimeRecallContext> {
  return async (ctx, hint) => {
    const key = recallKeySchema.safeParse(ctx.recallKey);
    if (!key.success) return empty(UNMAPPED_QUERY, 0);

    const zone = formZoneSchema.safeParse(ctx.zone);
    const query = buildRecallQuery(
      key.data,
      zone.success ? zone.data : '',
      typeof hint === 'string' ? hint : undefined,
    );
    const config = RECALL_CONFIG[key.data];
    if (config.skip) return empty(query, 0);

    const startedAt = now(deps);
    const retrieveArgs = retrieveArgsSchema.parse({
      query,
      halls: config.halls,
      limit: MEMORY_LIMIT,
    });
    const episodeArgs = episodeSearchArgsSchema.parse({
      query,
      limit: EPISODE_LIMIT,
      time_range: {
        from: new Date(startedAt - config.episodes_days * DAY_MS).toISOString(),
        to: new Date(startedAt).toISOString(),
      },
    });
    const [memorySource, episodeSource] = await Promise.all([
      captureSource(() => deps.reads.retrieve(retrieveArgs)),
      captureSource(() => deps.reads.searchEpisodes(episodeArgs)),
    ]);

    if (!memorySource.ok) {
      emit(deps, {
        recall_status: 'failed',
        source_class: 'memory',
        count: 0,
        error_class: 'source_unavailable',
      });
      return empty(query, duration(deps, startedAt));
    }
    if (!episodeSource.ok) {
      emit(deps, {
        recall_status: 'failed',
        source_class: 'episode',
        count: 0,
        error_class: 'source_unavailable',
      });
      return empty(query, duration(deps, startedAt));
    }
    if (!Array.isArray(memorySource.rows) || memorySource.rows.length > MEMORY_LIMIT) {
      emit(deps, {
        recall_status: 'failed',
        source_class: 'memory',
        count: 0,
        error_class: 'source_unavailable',
      });
      return empty(query, duration(deps, startedAt));
    }
    if (!Array.isArray(episodeSource.rows) || episodeSource.rows.length > EPISODE_LIMIT) {
      emit(deps, {
        recall_status: 'failed',
        source_class: 'episode',
        count: 0,
        error_class: 'source_unavailable',
      });
      return empty(query, duration(deps, startedAt));
    }

    try {
      const memory = admitMemoryRows(memorySource.rows, ctx.canaryTokens);
      if (memory.rejected > 0) {
        emit(deps, {
          recall_status: 'partial',
          source_class: 'memory',
          count: memory.rejected,
          error_class: 'row_rejected',
        });
      }
      const episodes = admitEpisodeRows(episodeSource.rows, ctx.canaryTokens);
      if (episodes.rejected > 0) {
        emit(deps, {
          recall_status: 'partial',
          source_class: 'episode',
          count: episodes.rejected,
          error_class: 'row_rejected',
        });
      }
      return recallResultSchema.parse({
        memory_hits: memory.rows,
        episode_hits: episodes.rows,
        evolution_hits: [],
        query_used: query,
        duration_ms: duration(deps, startedAt),
      });
    } catch (error) {
      if (error instanceof RecallSecurityHalt) {
        emit(deps, {
          recall_status: 'failed',
          source_class: error.sourceClass,
          count: 1,
          error_class: 'canary_leak',
        });
      }
      throw error;
    }
  };
}

async function captureSource(source: () => Promise<unknown>): Promise<CapturedSource> {
  try {
    return { ok: true, rows: await source() };
  } catch {
    return { ok: false };
  }
}

function admitMemoryRows(
  rows: readonly unknown[],
  canaries: CanaryTokens,
): RowAdmission<RecallMemoryHit> {
  const admitted: RecallMemoryHit[] = [];
  let rejected = 0;
  for (const row of rows) {
    const memory = admitMemoryRow(row, canaries);
    if (memory === null) {
      rejected += 1;
    } else {
      admitted.push(memory);
    }
  }
  return { rows: admitted, rejected };
}

function admitMemoryRow(value: unknown, canaries: CanaryTokens): RecallMemoryHit | null {
  try {
    const envelope = memoryEnvelope(value);
    if (envelope === null) return null;

    const hit = retrieveHitSchema.safeParse(envelope.hit);
    if (!hit.success || hit.data.source_trust === 'memory_provisional') return null;
    if (
      !taintStampSchema.safeParse({
        source_trust: hit.data.source_trust,
        source_taint: envelope.source_taint,
      }).success
    ) {
      return null;
    }

    const prepared = prepareWithScribe(
      hit.data.content,
      retrieveHitSchema.shape.content,
      'system_prompt',
      envelope.source_taint,
      canaries,
    );
    if (!prepared.ok) {
      if (prepared.reason === 'canary_leak') throw new RecallSecurityHalt('memory');
      return null;
    }

    const { bm25_rank: _bm25Rank, temporal_rank: _temporalRank, rrf_score: _rrfScore, ...memoryHit } =
      hit.data;
    const result = recallMemoryHitSchema.safeParse({ ...memoryHit, content: prepared.value });
    return result.success ? result.data : null;
  } catch (error) {
    if (error instanceof RecallSecurityHalt) throw error;
    return null;
  }
}

function admitEpisodeRows(rows: readonly unknown[], canaries: CanaryTokens): RowAdmission<EpisodeHit> {
  const admitted: EpisodeHit[] = [];
  let rejected = 0;
  for (const row of rows) {
    const episode = admitEpisodeRow(row, canaries);
    if (episode === null) {
      rejected += 1;
    } else {
      admitted.push(episode);
    }
  }
  return { rows: admitted, rejected };
}

function admitEpisodeRow(value: unknown, canaries: CanaryTokens): EpisodeHit | null {
  try {
    const envelope = episodeEnvelope(value);
    if (envelope === null) return null;

    const hit = episodeHitSchema.safeParse(envelope.hit);
    if (!hit.success) return null;

    const prepared = prepareWithScribe(
      hit.data.summary,
      episodeHitSchema.shape.summary,
      'system_prompt',
      envelope.source_taint,
      canaries,
    );
    if (!prepared.ok) {
      if (prepared.reason === 'canary_leak') throw new RecallSecurityHalt('episode');
      return null;
    }

    const result = episodeHitSchema.safeParse({ ...hit.data, summary: prepared.value });
    return result.success ? result.data : null;
  } catch (error) {
    if (error instanceof RecallSecurityHalt) throw error;
    return null;
  }
}

function memoryEnvelope(value: unknown): RecallEnvelope | null {
  return recallEnvelope(value);
}

function episodeEnvelope(value: unknown): RecallEnvelope | null {
  return recallEnvelope(value);
}

function recallEnvelope(value: unknown): RecallEnvelope | null {
  const envelope = plainDataRecord(value);
  if (envelope === null) return null;

  const keys = Object.getOwnPropertyNames(envelope);
  if (keys.length !== 2 || !keys.includes('hit') || !keys.includes('source_taint')) return null;

  const descriptors = Object.getOwnPropertyDescriptors(envelope);
  const hit = descriptors.hit?.value;
  const sourceTaint = sourceTaintSchema.safeParse(descriptors.source_taint?.value);
  if (!sourceTaint.success || plainDataRecord(hit) === null) return null;

  return { hit, source_taint: sourceTaint.data };
}

function plainDataRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    if (Object.getOwnPropertySymbols(value).length > 0) return null;
    if (
      Object.values(Object.getOwnPropertyDescriptors(value)).some(
        (descriptor) => descriptor.get !== undefined || descriptor.set !== undefined,
      )
    ) {
      return null;
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function emit(deps: RuntimeRecallGatewayDeps, event: RecallTelemetryEvent): void {
  if (deps.telemetry === undefined) return;

  const closedEvent: RecallTelemetryEvent = Object.freeze({
    recall_status: event.recall_status,
    source_class: event.source_class,
    count: event.count,
    error_class: event.error_class,
  });
  try {
    void Promise.resolve(deps.telemetry.record(closedEvent)).catch(() => undefined);
  } catch {
    // Telemetry is observational and cannot alter recall admission.
  }
}

function empty(query: string, duration_ms: number) {
  return recallResultSchema.parse({
    memory_hits: [],
    episode_hits: [],
    evolution_hits: [],
    query_used: query,
    duration_ms,
  });
}

function now(deps: RuntimeRecallGatewayDeps): number {
  const value = (deps.now ?? Date.now)();
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > ECMASCRIPT_DATE_MAX_MS
  ) {
    throw new Error('recall clock must be a non-negative safe integer within the ECMAScript Date range');
  }
  return value;
}

function duration(deps: RuntimeRecallGatewayDeps, startedAt: number): number {
  return Math.max(0, now(deps) - startedAt);
}
