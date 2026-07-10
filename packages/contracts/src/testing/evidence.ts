import { z } from 'zod';

export const evidenceLaneSchema = z.enum(['scenario', 'property', 'mutation', 'live_dogfood']);
export type EvidenceLane = z.infer<typeof evidenceLaneSchema>;

export const evidenceStatusSchema = z.enum(['pass', 'fail', 'skipped']);
export type EvidenceStatus = z.infer<typeof evidenceStatusSchema>;

export const evidenceMetadataSchema = z.strictObject({
  environment: z.enum(['local', 'ci', 'dogfood']).optional(),
  runner: z.enum(['vitest', 'fast-check', 'stryker', 'manual']).optional(),
  seed: z.int().nonnegative().optional(),
});
export type EvidenceMetadata = z.infer<typeof evidenceMetadataSchema>;

export const evidenceRunSchema = z
  .strictObject({
    lane: evidenceLaneSchema,
    status: evidenceStatusSchema,
    hermetic: z.boolean(),
    live_provider: z.boolean(),
    opt_in: z.boolean(),
    artifact_uri: z
      .string()
      .min(1)
      .max(512)
      .regex(/^artifacts\/[A-Za-z0-9._/-]+$/)
      .optional(),
    metadata: evidenceMetadataSchema.default({}),
  })
  .refine((run) => run.lane === 'live_dogfood' || (run.hermetic && !run.live_provider && !run.opt_in), {
    error: 'scenario, property, and mutation evidence must be hermetic by default',
    path: ['hermetic'],
  })
  .refine((run) => run.lane !== 'live_dogfood' || (!run.hermetic && run.live_provider && run.opt_in), {
    error: 'live dogfood evidence must be explicit opt-in provider evidence',
    path: ['opt_in'],
  });
export type EvidenceRun = z.infer<typeof evidenceRunSchema>;

export const HERMETIC_EVIDENCE_LANES = ['scenario', 'property', 'mutation'] as const satisfies readonly EvidenceLane[];
