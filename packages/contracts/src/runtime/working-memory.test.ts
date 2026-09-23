import { describe, expect, it } from 'vitest';
import {
  CARRYOVER_BUCKET_CAPS,
  EMPTY_WORKING_MEMORY,
  appendWorkingMemoryEntry,
  carryoverBucketSchema,
  compactAttachmentSchema,
  workingMemoryEntrySchema,
  workingMemorySnapshotSchema,
} from './working-memory';

function entry(n: number) {
  return {
    entry_id: `entry-${n}`,
    summary: `synthetic summary ${n}`,
    source_ref: `journal:${n}`,
    updated_at: n,
    source_taint: null,
  };
}

describe('workingMemory buckets', () => {
  it('pins the ADR-0057 buckets and caps', () => {
    expect(carryoverBucketSchema.options).toEqual([
      'recent_work_log',
      'recent_verified_work',
      'read_file_state',
      'async_agent_state',
    ]);
    expect(CARRYOVER_BUCKET_CAPS).toEqual({
      recent_work_log: 10,
      recent_verified_work: 10,
      read_file_state: 6,
      async_agent_state: 8,
    });
  });

  it('accepts the empty snapshot and rejects over-cap buckets', () => {
    expect(workingMemorySnapshotSchema.safeParse(EMPTY_WORKING_MEMORY).success).toBe(true);
    expect(
      workingMemorySnapshotSchema.safeParse({
        ...EMPTY_WORKING_MEMORY,
        read_file_state: Array.from({ length: 7 }, (_, i) => entry(i)),
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate entry ids inside a bucket', () => {
    expect(
      workingMemorySnapshotSchema.safeParse({
        ...EMPTY_WORKING_MEMORY,
        recent_work_log: [entry(1), entry(1)],
      }).success,
    ).toBe(false);
  });
});

describe('workingMemory entries', () => {
  it('accepts bounded summaries and source refs', () => {
    expect(workingMemoryEntrySchema.safeParse(entry(1)).success).toBe(true);
  });

  it('rejects raw-health fields and unknown drift fields', () => {
    expect(workingMemoryEntrySchema.safeParse({ ...entry(1), hrv_ms: 42 }).success).toBe(false);
    expect(workingMemoryEntrySchema.safeParse({ ...entry(1), raw: 'sleep: 5h' }).success).toBe(
      false,
    );
  });

  it('keeps external taint explicit without letting it become a field soup', () => {
    expect(workingMemoryEntrySchema.safeParse({ ...entry(1), source_taint: 'external' }).success).toBe(
      true,
    );
    expect(workingMemoryEntrySchema.safeParse({ ...entry(1), source_taint: 'trusted' }).success).toBe(
      false,
    );
  });
});

describe('appendWorkingMemoryEntry', () => {
  it('prepends the newest entry and enforces the bucket cap', () => {
    const full = {
      ...EMPTY_WORKING_MEMORY,
      recent_work_log: Array.from({ length: 10 }, (_, i) => entry(i)),
    };

    const next = appendWorkingMemoryEntry(full, 'recent_work_log', entry(99));

    expect(next.recent_work_log).toHaveLength(10);
    expect(next.recent_work_log[0]?.entry_id).toBe('entry-99');
    expect(next.recent_work_log.some((item) => item.entry_id === 'entry-9')).toBe(false);
  });

  it('dedupes by entry id before applying the cap', () => {
    const first = appendWorkingMemoryEntry(EMPTY_WORKING_MEMORY, 'recent_verified_work', entry(1));
    const second = appendWorkingMemoryEntry(first, 'recent_verified_work', {
      ...entry(1),
      summary: 'updated synthetic summary',
      updated_at: 2,
    });

    expect(second.recent_verified_work).toHaveLength(1);
    expect(second.recent_verified_work[0]?.summary).toBe('updated synthetic summary');
  });
});

describe('compactAttachment', () => {
  it('wraps the snapshot as a working-memory compaction attachment', () => {
    expect(
      compactAttachmentSchema.safeParse({
        kind: 'working_memory',
        snapshot: EMPTY_WORKING_MEMORY,
      }).success,
    ).toBe(true);
  });

  it('rejects the wrong attachment kind', () => {
    expect(
      compactAttachmentSchema.safeParse({
        kind: 'memory_block',
        snapshot: EMPTY_WORKING_MEMORY,
      }).success,
    ).toBe(false);
  });
});
