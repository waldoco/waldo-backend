import { z } from 'zod';

// A5 (BUILD_PLAN_2026-09-25; the adaptation audit's typed-workspace proposal): the agent's
// own working artifacts - half-built documents, research briefs, shortlists, extracted data.
// Metadata lives in the owner DO (name, kind, provenance, revision), bodies in R2, reads are
// ranged and on demand. Nothing is ever auto-injected into a turn: the model lists and reads
// what it needs, so an artifact can never become a covert always-on context channel.
export const artifactKindSchema = z.enum(['document', 'research', 'data', 'shortlist']);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

// Body cap at write: one artifact holds a working document, not a dump - larger outputs belong
// in the tool-output store (re-derivable) or split across artifacts.
export const ARTIFACT_BODY_MAX_CHARS = 100_000;

export const createArtifactArgsSchema = z.strictObject({
  name: z.string().min(1).max(120),
  kind: artifactKindSchema,
  body_markdown: z.string().min(1).max(ARTIFACT_BODY_MAX_CHARS),
});
export type CreateArtifactArgs = z.infer<typeof createArtifactArgsSchema>;

// Compare-and-swap: the model revises against the revision it last saw; a mismatch means
// another turn wrote first and the handler returns a typed conflict, never a silent clobber.
export const reviseArtifactArgsSchema = z.strictObject({
  artifact_id: z.string().min(1),
  expected_revision: z.int().positive(),
  body_markdown: z.string().min(1).max(ARTIFACT_BODY_MAX_CHARS),
});
export type ReviseArtifactArgs = z.infer<typeof reviseArtifactArgsSchema>;

// Metadata only - bodies never ride the list.
export const listArtifactsArgsSchema = z.strictObject({
  kind: artifactKindSchema.optional(),
});
export type ListArtifactsArgs = z.infer<typeof listArtifactsArgsSchema>;

export const readArtifactArgsSchema = z.strictObject({
  artifact_id: z.string().min(1),
  offset: z.int().nonnegative().default(0),
  length: z.int().min(1).max(8000).default(4000),
});
export type ReadArtifactArgs = z.infer<typeof readArtifactArgsSchema>;
