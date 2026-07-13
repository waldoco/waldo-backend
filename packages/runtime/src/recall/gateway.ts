import {
  RECALL_CONFIG,
  buildRecallQuery,
  episodeSearchArgsSchema,
  formZoneSchema,
  recallKeySchema,
  recallResultSchema,
  retrieveArgsSchema,
  type CanaryTokens,
  type EpisodeSearchArgs,
  type NarrativeContext,
  type RecallGateway,
  type RecallKey,
  type RetrieveArgs,
} from '@waldo/contracts';

const MEMORY_LIMIT = 5;
const EPISODE_LIMIT = 3;
const DAY_MS = 86_400_000;
const UNMAPPED_QUERY = 'recall unavailable';

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
    const [memoryRows, episodeRows] = await Promise.all([
      deps.reads.retrieve(retrieveArgs),
      deps.reads.searchEpisodes(episodeArgs),
    ]);

    return recallResultSchema.parse({
      memory_hits: admitMemoryRows(memoryRows),
      episode_hits: admitEpisodeRows(episodeRows),
      evolution_hits: [],
      query_used: query,
      duration_ms: duration(deps, startedAt),
    });
  };
}

function admitMemoryRows(_rows: readonly unknown[]): [] {
  return [];
}

function admitEpisodeRows(_rows: readonly unknown[]): [] {
  return [];
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
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('recall clock must be a non-negative safe integer');
  }
  return value;
}

function duration(deps: RuntimeRecallGatewayDeps, startedAt: number): number {
  return Math.max(0, now(deps) - startedAt);
}
