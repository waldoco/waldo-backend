import { RECALL_CONFIG, recallResultSchema, type CanaryTokens } from '@waldo/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeRecallGateway,
  type OwnerBoundRecallReads,
  type RuntimeRecallContext,
} from '../src/recall/gateway';

const CANARIES: CanaryTokens = [
  '1111111111111111',
  '2222222222222222',
  '3333333333333333',
];
const FIXED_NOW = Date.parse('2026-07-13T12:00:00.000Z');

function context(recallKey: RuntimeRecallContext['recallKey']): RuntimeRecallContext {
  return { recallKey, zone: 'steady', canaryTokens: CANARIES };
}

function reads(memory: readonly unknown[] = [], episodes: readonly unknown[] = []): OwnerBoundRecallReads {
  return {
    retrieve: vi.fn(async () => memory),
    searchEpisodes: vi.fn(async () => episodes),
  };
}

describe('RuntimeRecallGateway — ADR-0031 fan-out', () => {
  it.each(Object.keys(RECALL_CONFIG) as RuntimeRecallContext['recallKey'][])(
    'uses the exact published config for %s',
    async (recallKey) => {
      const source = reads();
      const recall = createRuntimeRecallGateway({ reads: source, now: () => FIXED_NOW });
      const result = await recall(context(recallKey));
      const config = RECALL_CONFIG[recallKey!];

      expect(recallResultSchema.safeParse(result).success).toBe(true);
      if (config.skip) {
        expect(source.retrieve).not.toHaveBeenCalled();
        expect(source.searchEpisodes).not.toHaveBeenCalled();
        expect(result.duration_ms).toBe(0);
      } else {
        expect(source.retrieve).toHaveBeenCalledWith(
          expect.objectContaining({ halls: config.halls, limit: 5 }),
        );
        expect(source.searchEpisodes).toHaveBeenCalledWith(
          expect.objectContaining({ limit: 3 }),
        );
      }
    },
  );

  it('keeps owner selection outside the gateway inputs', async () => {
    const ownerA = reads();
    const ownerB = reads();
    const recallA = createRuntimeRecallGateway({ reads: ownerA, now: () => FIXED_NOW });
    const recallB = createRuntimeRecallGateway({ reads: ownerB, now: () => FIXED_NOW });

    await expect(recallA(context('user_message'))).resolves.toMatchObject({ memory_hits: [] });
    await expect(recallB(context('user_message'))).resolves.toMatchObject({ memory_hits: [] });
    expect((ownerA.retrieve as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).not.toHaveProperty(
      'user_id',
    );
    expect((ownerB.retrieve as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).not.toHaveProperty(
      'user_id',
    );
  });

  it('launches both enabled source reads before either resolves', async () => {
    let releaseMemory!: () => void;
    let releaseEpisodes!: () => void;
    const memoryReady = new Promise<void>((resolve) => {
      releaseMemory = resolve;
    });
    const episodesReady = new Promise<void>((resolve) => {
      releaseEpisodes = resolve;
    });
    const source: OwnerBoundRecallReads = {
      retrieve: vi.fn(async () => {
        await memoryReady;
        return [];
      }),
      searchEpisodes: vi.fn(async () => {
        await episodesReady;
        return [];
      }),
    };
    const pending = createRuntimeRecallGateway({ reads: source, now: () => FIXED_NOW })(
      context('user_message'),
    );

    expect(source.retrieve).toHaveBeenCalledOnce();
    expect(source.searchEpisodes).toHaveBeenCalledOnce();
    releaseMemory();
    releaseEpisodes();
    await expect(pending).resolves.toMatchObject({
      memory_hits: [],
      episode_hits: [],
      evolution_hits: [],
    });
  });
});
