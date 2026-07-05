import { describe, expect, it } from 'vitest';
import { MEMORY_BLOCK_CONTENT_MAX } from '../memory/sanitise';
import {
  trimWorkingMemorySnapshot,
  WORKING_MEMORY_BUCKET_CAPS,
  workingMemoryBucketNameSchema,
  workingMemoryEntrySchema,
  workingMemorySnapshotSchema,
} from './working-memory';

function entry(id: string, updated_at: number) {
  return {
    id,
    source_run_id: `run-${id}`,
    content: `summary-${id}`,
    updated_at,
  };
}

const emptySnapshot = {
  recent_work_log: [],
  recent_verified_work: [],
  read_file_state: [],
  async_agent_state: [],
};

describe('workingMemoryBucketName', () => {
  it('pins the ADR-0057 carryover buckets', () => {
    expect(workingMemoryBucketNameSchema.options).toEqual([
      'recent_work_log',
      'recent_verified_work',
      'read_file_state',
      'async_agent_state',
    ]);
  });
});

describe('WORKING_MEMORY_BUCKET_CAPS', () => {
  it('pins the ADR-0057 per-bucket caps', () => {
    expect(WORKING_MEMORY_BUCKET_CAPS).toEqual({
      recent_work_log: 10,
      recent_verified_work: 10,
      read_file_state: 6,
      async_agent_state: 8,
    });
  });
});

describe('workingMemoryEntry', () => {
  it('accepts a bounded carryover summary', () => {
    expect(workingMemoryEntrySchema.safeParse(entry('1', 1_000)).success).toBe(true);
  });

  it('rejects blank ids and oversize content', () => {
    expect(
      workingMemoryEntrySchema.safeParse({
        ...entry('', 1_000),
        source_run_id: 'run-1',
      }).success,
    ).toBe(false);
    expect(
      workingMemoryEntrySchema.safeParse({
        ...entry('1', 1_000),
        content: 'x'.repeat(MEMORY_BLOCK_CONTENT_MAX + 1),
      }).success,
    ).toBe(false);
  });
});

describe('workingMemorySnapshot', () => {
  it('accepts each bucket at its cap', () => {
    expect(
      workingMemorySnapshotSchema.safeParse({
        recent_work_log: Array.from({ length: 10 }, (_, i) => entry(`work-${i}`, i)),
        recent_verified_work: Array.from({ length: 10 }, (_, i) => entry(`verified-${i}`, i)),
        read_file_state: Array.from({ length: 6 }, (_, i) => entry(`file-${i}`, i)),
        async_agent_state: Array.from({ length: 8 }, (_, i) => entry(`async-${i}`, i)),
      }).success,
    ).toBe(true);
  });

  it('rejects bucket overflow', () => {
    expect(
      workingMemorySnapshotSchema.safeParse({
        ...emptySnapshot,
        read_file_state: Array.from({ length: 7 }, (_, i) => entry(`file-${i}`, i)),
      }).success,
    ).toBe(false);
  });

  it('rejects unknown buckets', () => {
    expect(
      workingMemorySnapshotSchema.safeParse({
        ...emptySnapshot,
        extra_bucket: [],
      }).success,
    ).toBe(false);
  });
});

describe('trimWorkingMemorySnapshot', () => {
  it('keeps newest entries inside each cap', () => {
    const trimmed = trimWorkingMemorySnapshot({
      recent_work_log: Array.from({ length: 12 }, (_, i) => entry(`work-${i}`, i)),
      recent_verified_work: [],
      read_file_state: [],
      async_agent_state: [],
    });

    expect(trimmed.recent_work_log).toHaveLength(10);
    expect(trimmed.recent_work_log.map((e) => e.id)).toEqual([
      'work-11',
      'work-10',
      'work-9',
      'work-8',
      'work-7',
      'work-6',
      'work-5',
      'work-4',
      'work-3',
      'work-2',
    ]);
  });

  it('uses id order as a stable tie-breaker', () => {
    const trimmed = trimWorkingMemorySnapshot({
      ...emptySnapshot,
      async_agent_state: [entry('b', 1_000), entry('a', 1_000)],
    });

    expect(trimmed.async_agent_state.map((e) => e.id)).toEqual(['a', 'b']);
  });
});
