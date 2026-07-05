import { z } from 'zod';
import { MEMORY_BLOCK_CONTENT_MAX } from '../memory/sanitise';

export const workingMemoryBucketNameSchema = z.enum([
  'recent_work_log',
  'recent_verified_work',
  'read_file_state',
  'async_agent_state',
]);
export type WorkingMemoryBucketName = z.infer<typeof workingMemoryBucketNameSchema>;

// ADR-0057 bounded carryover buckets. These are prompt-carryover summaries, not long-term
// memory, sandbox scratch, raw health data, or pending approval state.
export const WORKING_MEMORY_BUCKET_CAPS: Readonly<Record<WorkingMemoryBucketName, number>> = {
  recent_work_log: 10,
  recent_verified_work: 10,
  read_file_state: 6,
  async_agent_state: 8,
};

export const workingMemoryEntrySchema = z.strictObject({
  id: z.string().min(1),
  source_run_id: z.string().min(1),
  content: z.string().min(1).max(MEMORY_BLOCK_CONTENT_MAX),
  updated_at: z.int().nonnegative(),
});
export type WorkingMemoryEntry = z.infer<typeof workingMemoryEntrySchema>;

export const workingMemorySnapshotSchema = z
  .strictObject({
    recent_work_log: z.array(workingMemoryEntrySchema),
    recent_verified_work: z.array(workingMemoryEntrySchema),
    read_file_state: z.array(workingMemoryEntrySchema),
    async_agent_state: z.array(workingMemoryEntrySchema),
  })
  .refine(
    (snapshot) =>
      Object.entries(WORKING_MEMORY_BUCKET_CAPS).every(
        ([bucket, cap]) =>
          snapshot[bucket as WorkingMemoryBucketName].length <= cap,
      ),
    {
      error: 'working-memory bucket exceeds its ADR-0057 cap',
    },
  );
export type WorkingMemorySnapshot = z.infer<typeof workingMemorySnapshotSchema>;

function trimBucket(
  entries: readonly WorkingMemoryEntry[],
  cap: number,
): WorkingMemoryEntry[] {
  return [...entries]
    .sort((a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id))
    .slice(0, cap);
}

export function trimWorkingMemorySnapshot(snapshot: WorkingMemorySnapshot): WorkingMemorySnapshot {
  return {
    recent_work_log: trimBucket(
      snapshot.recent_work_log,
      WORKING_MEMORY_BUCKET_CAPS.recent_work_log,
    ),
    recent_verified_work: trimBucket(
      snapshot.recent_verified_work,
      WORKING_MEMORY_BUCKET_CAPS.recent_verified_work,
    ),
    read_file_state: trimBucket(
      snapshot.read_file_state,
      WORKING_MEMORY_BUCKET_CAPS.read_file_state,
    ),
    async_agent_state: trimBucket(
      snapshot.async_agent_state,
      WORKING_MEMORY_BUCKET_CAPS.async_agent_state,
    ),
  };
}
