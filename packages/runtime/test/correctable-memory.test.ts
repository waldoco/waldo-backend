import { describe, expect, it, vi } from 'vitest';
import { iso8601Schema, type RecallMemoryHit } from '@waldo/contracts';
import {
  createCorrectableMemory,
  memoryKey,
} from '../src/recall/correctable';
import type { OwnerBoundTemporalMemoryReads } from '../src/recall/gateway';

const VALID_FROM = iso8601Schema.parse('2026-07-12T00:00:00.000Z');
const OLD: RecallMemoryHit = {
  hall_type: 'facts',
  content: 'The user prefers morning meetings.',
  confidence: 0.8,
  valid_from: VALID_FROM,
  source_trust: 'memory_committed',
};
const REPLACEMENT: RecallMemoryHit = {
  ...OLD,
  content: 'The user prefers afternoon meetings.',
  source_trust: 'user_stated',
};
const OTHER: RecallMemoryHit = {
  ...OLD,
  content: 'The user prefers written agendas.',
};

function readsByOwner(map: Record<string, readonly RecallMemoryHit[]>): OwnerBoundTemporalMemoryReads {
  return {
    retrieveTemporal: vi.fn(async (args) => {
      const owner = args.query.includes('owner-a') ? 'owner-a' : 'owner-b';
      return map[owner] ?? [];
    }),
  };
}

describe('correctable memory wrapper', () => {
  it('isolates corrections by owner', async () => {
    const memory = createCorrectableMemory(readsByOwner({
      'owner-a': [OLD],
      'owner-b': [OLD],
    }));

    memory.correct({
      owner_id: 'owner-a',
      memory_key: memoryKey(OLD),
      replacement: REPLACEMENT,
      corrected_at: '2026-07-13T12:00:00.000Z',
    });

    await expect(memory.recall({ owner_id: 'owner-a' }, { query: 'owner-a meetings', halls: ['facts'], limit: 5, as_of: '2026-07-13T12:00:00.000Z' })).resolves.toMatchObject({
      hits: [{ hit: REPLACEMENT }],
    });
    await expect(memory.recall({ owner_id: 'owner-b' }, { query: 'owner-b meetings', halls: ['facts'], limit: 5, as_of: '2026-07-13T12:00:00.000Z' })).resolves.toMatchObject({
      hits: [{ hit: OLD }],
    });
  });

  it('returns only the replacement and preserves provenance', async () => {
    const memory = createCorrectableMemory(readsByOwner({
      'owner-a': [OLD, REPLACEMENT, REPLACEMENT, OTHER],
      'owner-b': [OLD],
    }));
    memory.correct({
      owner_id: 'owner-a',
      memory_key: memoryKey(OLD),
      replacement: REPLACEMENT,
      corrected_at: '2026-07-13T12:00:00.000Z',
    });

    const result = await memory.recall({ owner_id: 'owner-a' }, { query: 'owner-a meetings', halls: ['facts'], limit: 5, as_of: '2026-07-13T12:00:00.000Z' });

    expect(result.hits.map(({ hit }) => hit.content)).toEqual([
      REPLACEMENT.content,
      OTHER.content,
    ]);
    expect(result.hits[0]?.provenance).toEqual({
      owner_id: 'owner-a',
      memory_key: memoryKey(REPLACEMENT),
      source: 'owner_correction',
      supersedes_memory_key: memoryKey(OLD),
      corrected_at: '2026-07-13T12:00:00.000Z',
    });
    expect(Object.isFrozen(result.hits[0]?.provenance)).toBe(true);
    expect(result.health_summary).toEqual({
      lane: 'health_summary',
      aggregate_only: true,
      raw_wearable_streams: false,
      summary: 'aggregate-only health summary; raw wearable streams are excluded',
    });
  });

  it('forgets both stale and replacement material while keeping owner scoping', async () => {
    const memory = createCorrectableMemory(readsByOwner({
      'owner-a': [OLD, REPLACEMENT, OTHER],
      'owner-b': [OLD],
    }));
    memory.correct({
      owner_id: 'owner-a',
      memory_key: memoryKey(OLD),
      replacement: REPLACEMENT,
      corrected_at: '2026-07-13T12:00:00.000Z',
    });
    memory.forget({ owner_id: 'owner-a', memory_key: memoryKey(OLD) });

    const result = await memory.recall({ owner_id: 'owner-a' }, { query: 'owner-a meetings', halls: ['facts'], limit: 5, as_of: '2026-07-13T12:00:00.000Z' });

    expect(result.hits.map(({ hit }) => hit.content)).toEqual([OTHER.content]);
    expect(result.hits[0]?.provenance).toBeUndefined();

    const otherOwnerResult = await memory.recall({ owner_id: 'owner-b' }, { query: 'owner-b meetings', halls: ['facts'], limit: 5, as_of: '2026-07-13T12:00:00.000Z' });
    expect(otherOwnerResult.hits.map(({ hit }) => hit.content)).toEqual([OLD.content]);
  });

  it('deduplicates identical replacement entries and ranks replacement before non-superseded material', async () => {
    const memory = createCorrectableMemory(readsByOwner({
      'owner-a': [OLD, REPLACEMENT, REPLACEMENT, OTHER],
      'owner-b': [OLD],
    }));
    memory.correct({
      owner_id: 'owner-a',
      memory_key: memoryKey(OLD),
      replacement: REPLACEMENT,
      corrected_at: '2026-07-13T12:00:00.000Z',
    });

    const result = await memory.recall({ owner_id: 'owner-a' }, { query: 'owner-a meetings', halls: ['facts'], limit: 5, as_of: '2026-07-13T12:00:00.000Z' });

    expect(result.hits).toHaveLength(2);
    expect(result.hits[0]?.memory_key).toBe(memoryKey(REPLACEMENT));
    expect(result.hits[1]?.memory_key).toBe(memoryKey(OTHER));
  });

  it('keeps the full correction chain replaced and rejects a no-op correction', async () => {
    const memory = createCorrectableMemory(readsByOwner({
      'owner-a': [OLD, REPLACEMENT, OTHER],
      'owner-b': [OLD],
    }));
    const secondReplacement: RecallMemoryHit = {
      ...REPLACEMENT,
      content: 'The user prefers late afternoon meetings.',
    };

    memory.correct({
      owner_id: 'owner-a',
      memory_key: memoryKey(OLD),
      replacement: REPLACEMENT,
      corrected_at: '2026-07-13T12:00:00.000Z',
    });
    memory.correct({
      owner_id: 'owner-a',
      memory_key: memoryKey(REPLACEMENT),
      replacement: secondReplacement,
      corrected_at: '2026-07-14T12:00:00.000Z',
    });

    await expect(memory.recall({ owner_id: 'owner-a' }, { query: 'owner-a meetings', halls: ['facts'], limit: 5, as_of: '2026-07-14T12:00:00.000Z' })).resolves.toMatchObject({
      hits: [{ hit: secondReplacement }, { hit: OTHER }],
    });
    expect(() => memory.correct({
      owner_id: 'owner-a',
      memory_key: memoryKey(secondReplacement),
      replacement: secondReplacement,
      corrected_at: '2026-07-14T12:00:00.000Z',
    })).toThrow('correction replacement must differ from memory_key');
  });
});