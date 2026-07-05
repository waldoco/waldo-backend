import { z } from 'zod';

export const evidenceLaneSchema = z.enum(['scenario', 'property', 'mutation', 'live_dogfood']);
export type EvidenceLane = z.infer<typeof evidenceLaneSchema>;

export const evidenceStatusSchema = z.enum(['pass', 'fail', 'skipped']);
export type EvidenceStatus = z.infer<typeof evidenceStatusSchema>;

export const evidenceRunSchema = z
  .strictObject({
    lane: evidenceLaneSchema,
    status: evidenceStatusSchema,
    hermetic: z.boolean(),
    live_provider: z.boolean(),
    opt_in: z.boolean(),
    artifact_uri: z.string().min(1).optional(),
    metadata: z.record(z.string().min(1), z.string().min(1)).default({}),
  })
  .refine((run) => run.lane === 'live_dogfood' || (run.hermetic && !run.live_provider && !run.opt_in), {
    error: 'scenario, property, and mutation evidence must be hermetic by default',
    path: ['hermetic'],
  })
  .refine((run) => run.lane !== 'live_dogfood' || (!run.hermetic && run.live_provider && run.opt_in), {
    error: 'live dogfood evidence must be explicit opt-in provider evidence',
    path: ['opt_in'],
  })
  .refine(
    (run) =>
      Object.keys(run.metadata).every(
        (key) => !['user_id', 'run_id', 'trace_id', 'payload_hash', 'sql', 'table', 'raw_health'].includes(key),
      ),
    { error: 'evidence metadata must stay redacted and low-cardinality', path: ['metadata'] },
  );
export type EvidenceRun = z.infer<typeof evidenceRunSchema>;

export const HERMETIC_EVIDENCE_LANES = ['scenario', 'property', 'mutation'] as const satisfies readonly EvidenceLane[];
