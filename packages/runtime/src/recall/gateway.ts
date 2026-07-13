import {
  buildRecallQuery,
  episodeHitSchema,
  episodeSearchArgsSchema,
  formZoneSchema,
  RECALL_QUERY_MAX_CHARS,
  RECALL_CONFIG,
  recallKeySchema,
  recallMemoryHitSchema,
  recallResultSchema,
  retrieveArgsSchema,
  retrieveHitSchema,
  skillSchema,
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
const ISO8601_4_DIGIT_MAX_MS = 253_402_300_799_999;
const UNMAPPED_QUERY = 'recall unavailable';

type SourceClass = 'memory' | 'episode';
type RecallAdmissionClass = SourceClass | 'hint';

const sourceUnavailableErrors = new WeakSet<object>();
const recallSecurityHalts = new WeakSet<object>();

class RecallSourceUnavailable extends Error {
  constructor(
    readonly sourceClass: SourceClass,
    cause?: unknown,
  ) {
    super('recall source unavailable', { cause });
    sourceUnavailableErrors.add(this);
  }
}

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
  source_class: RecallAdmissionClass;
  count: number;
  error_class: 'source_unavailable' | 'row_rejected' | 'canary_leak';
}>;

export type RecallTelemetry = Readonly<{
  record(event: RecallTelemetryEvent): void | Promise<void>;
}>;

export class RecallSecurityHalt extends Error {
  readonly code = 'canary_leak' as const;

  constructor(readonly sourceClass: RecallAdmissionClass) {
    super('recall security halt');
    this.name = 'RecallSecurityHalt';
    recallSecurityHalts.add(this);
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
    let admittedHint: string | undefined;
    try {
      admittedHint = admitRecallHint(hint, ctx.canaryTokens);
    } catch (error) {
      rethrowWithSecurityTelemetry(deps, error);
    }
    const query = buildRecallQuery(
      key.data,
      zone.success ? zone.data : '',
      admittedHint,
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
    let memoryRows: readonly unknown[];
    let episodeRows: readonly unknown[];
    try {
      [memoryRows, episodeRows] = await Promise.all([
        readSource('memory', MEMORY_LIMIT, () => deps.reads.retrieve(retrieveArgs)),
        readSource('episode', EPISODE_LIMIT, () => deps.reads.searchEpisodes(episodeArgs)),
      ]);
    } catch (error) {
      if (isRecallSourceUnavailable(error)) {
        // The private error retains its cause; only this closed classification crosses telemetry's interface.
        const result = empty(query, duration(deps, startedAt));
        emit(deps, {
          recall_status: 'failed',
          source_class: error.sourceClass,
          count: 0,
          error_class: 'source_unavailable',
        });
        return result;
      }
      throw error;
    }

    try {
      const telemetryEvents: RecallTelemetryEvent[] = [];
      const memory = admitMemoryRows(memoryRows, ctx.canaryTokens);
      if (memory.rejected > 0) {
        telemetryEvents.push({
          recall_status: 'partial',
          source_class: 'memory',
          count: memory.rejected,
          error_class: 'row_rejected',
        });
      }
      const episodes = admitEpisodeRows(episodeRows, ctx.canaryTokens);
      if (episodes.rejected > 0) {
        telemetryEvents.push({
          recall_status: 'partial',
          source_class: 'episode',
          count: episodes.rejected,
          error_class: 'row_rejected',
        });
      }
      const result = recallResultSchema.parse({
        memory_hits: memory.rows,
        episode_hits: episodes.rows,
        evolution_hits: [],
        query_used: query,
        duration_ms: duration(deps, startedAt),
      });
      for (const event of telemetryEvents) emit(deps, event);
      return result;
    } catch (error) {
      rethrowWithSecurityTelemetry(deps, error);
    }
  };
}

function admitRecallHint(hint: unknown, canaries: CanaryTokens): string | undefined {
  if (typeof hint !== 'string' || hint.length === 0) return undefined;

  const prepared = prepareWithScribe(
    hint.slice(0, RECALL_QUERY_MAX_CHARS),
    skillSchema.shape.trigger_condition,
    'system_prompt',
    'external',
    canaries,
  );
  if (prepared.ok) return prepared.value;
  if (prepared.reason === 'canary_leak') throw new RecallSecurityHalt('hint');
  return undefined;
}

function isRecallSourceUnavailable(error: unknown): error is RecallSourceUnavailable {
  return typeof error === 'object' && error !== null && sourceUnavailableErrors.has(error);
}

function isRecallSecurityHalt(error: unknown): error is RecallSecurityHalt {
  return typeof error === 'object' && error !== null && recallSecurityHalts.has(error);
}

function rethrowWithSecurityTelemetry(deps: RuntimeRecallGatewayDeps, error: unknown): never {
  if (isRecallSecurityHalt(error)) {
    emit(deps, {
      recall_status: 'failed',
      source_class: error.sourceClass,
      count: 1,
      error_class: 'canary_leak',
    });
  }
  throw error;
}

async function readSource(
  sourceClass: SourceClass,
  limit: number,
  source: () => Promise<unknown>,
): Promise<readonly unknown[]> {
  let response: unknown;
  try {
    response = await source();
  } catch (error) {
    throw new RecallSourceUnavailable(sourceClass, error);
  }

  let snapshot: readonly unknown[] | null;
  try {
    snapshot = boundedRowSnapshot(response, limit);
  } catch (error) {
    throw new RecallSourceUnavailable(sourceClass, error);
  }

  if (snapshot === null) throw new RecallSourceUnavailable(sourceClass);
  return snapshot;
}

function boundedRowSnapshot(value: unknown, limit: number): readonly unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor?.value;
  if (
    lengthDescriptor === undefined ||
    !('value' in lengthDescriptor) ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > limit
  ) {
    return null;
  }

  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) return null;
    snapshot[index] = descriptor.value;
  }
  return snapshot;
}

function admitMemoryRows(
  rows: readonly unknown[],
  canaries: CanaryTokens,
): RowAdmission<RecallMemoryHit> {
  const admitted: RecallMemoryHit[] = [];
  let rejected = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
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
    if (isRecallSecurityHalt(error)) throw error;
    return null;
  }
}

function admitEpisodeRows(rows: readonly unknown[], canaries: CanaryTokens): RowAdmission<EpisodeHit> {
  const admitted: EpisodeHit[] = [];
  let rejected = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
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
    if (isRecallSecurityHalt(error)) throw error;
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
    value > ISO8601_4_DIGIT_MAX_MS
  ) {
    throw new Error('recall clock must be a non-negative safe integer within the four-digit ISO range');
  }
  return value;
}

function duration(deps: RuntimeRecallGatewayDeps, startedAt: number): number {
  return Math.max(0, now(deps) - startedAt);
}
