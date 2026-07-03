import { z } from 'zod';
import { sourceTaintSchema } from '../memory/sanitise';

export const carryoverBucketSchema = z.enum([
  'recent_work_log',
  'recent_verified_work',
  'read_file_state',
  'async_agent_state',
]);
export type CarryoverBucket = z.infer<typeof carryoverBucketSchema>;

export const CARRYOVER_BUCKET_CAPS = {
  recent_work_log: 10,
  recent_verified_work: 10,
  read_file_state: 6,
  async_agent_state: 8,
} as const satisfies Record<CarryoverBucket, number>;

export const workingMemoryEntrySchema = z.strictObject({
  entry_id: z.string().min(1),
  summary: z.string().min(1).max(1_000),
  source_ref: z.string().min(1).max(500),
  updated_at: z.int().nonnegative(),
  source_taint: sourceTaintSchema,
});
export type WorkingMemoryEntry = z.infer<typeof workingMemoryEntrySchema>;

export const workingMemorySnapshotSchema = z
  .strictObject({
    recent_work_log: z
      .array(workingMemoryEntrySchema)
      .max(CARRYOVER_BUCKET_CAPS.recent_work_log),
    recent_verified_work: z
      .array(workingMemoryEntrySchema)
      .max(CARRYOVER_BUCKET_CAPS.recent_verified_work),
    read_file_state: z
      .array(workingMemoryEntrySchema)
      .max(CARRYOVER_BUCKET_CAPS.read_file_state),
    async_agent_state: z
      .array(workingMemoryEntrySchema)
      .max(CARRYOVER_BUCKET_CAPS.async_agent_state),
  })
  .superRefine((snapshot, ctx) => {
    for (const bucket of carryoverBucketSchema.options) {
      const ids = snapshot[bucket].map((entry) => entry.entry_id);
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({
          code: 'custom',
          message: 'entry_id values must be unique within a carryover bucket',
          path: [bucket],
        });
      }
    }
  });
export type WorkingMemorySnapshot = z.infer<typeof workingMemorySnapshotSchema>;

export const EMPTY_WORKING_MEMORY: WorkingMemorySnapshot = {
  recent_work_log: [],
  recent_verified_work: [],
  read_file_state: [],
  async_agent_state: [],
};

export const compactAttachmentSchema = z.strictObject({
  kind: z.literal('working_memory'),
  snapshot: workingMemorySnapshotSchema,
});
export type CompactAttachment = z.infer<typeof compactAttachmentSchema>;

export function appendWorkingMemoryEntry(
  snapshot: WorkingMemorySnapshot,
  bucket: CarryoverBucket,
  entry: WorkingMemoryEntry,
): WorkingMemorySnapshot {
  const parsedSnapshot = workingMemorySnapshotSchema.parse(snapshot);
  const parsedBucket = carryoverBucketSchema.parse(bucket);
  const parsedEntry = workingMemoryEntrySchema.parse(entry);
  const withoutDuplicate = parsedSnapshot[parsedBucket].filter(
    (existing) => existing.entry_id !== parsedEntry.entry_id,
  );

  return workingMemorySnapshotSchema.parse({
    ...parsedSnapshot,
    [parsedBucket]: [parsedEntry, ...withoutDuplicate].slice(
      0,
      CARRYOVER_BUCKET_CAPS[parsedBucket],
    ),
  });
}
