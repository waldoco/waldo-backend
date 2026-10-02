import { z } from 'zod';

// Files slice (docs/planning/FILES_ARTIFACTS_FIRST_SLICE_2026-10-02.md): agent access to the
// owner-private workspace store. The model never supplies operation_id: the runtime derives it
// from the dispatcher context, so a retry of the same call is idempotent and a model cannot
// replay or collide with another operation. Schemas are strict; unknown keys are rejected.
export const WORKSPACE_TEXT_MAX_BYTES = 64 * 1024;

export const workspaceListArgsSchema = z.strictObject({
  prefix: z.string().min(1).max(200).optional(),
  cursor: z.string().min(1).max(500).optional(),
  limit: z.int().min(1).max(50).optional(),
});
export type WorkspaceListArgs = z.infer<typeof workspaceListArgsSchema>;

export const workspaceReadArgsSchema = z.strictObject({
  file_id: z.string().min(1).max(100),
  revision: z.int().positive(),
  offset: z.int().nonnegative().optional(),
  length: z.int().min(1).max(8000).optional(),
});
export type WorkspaceReadArgs = z.infer<typeof workspaceReadArgsSchema>;

// Compare-and-swap like revise_artifact: expected_revision 0 creates, N replaces revision N.
export const workspaceWriteArgsSchema = z.strictObject({
  path: z.string().min(1).max(300),
  text: z.string().min(1),
  mime: z.enum(['text/plain', 'text/markdown']),
  expected_revision: z.int().nonnegative(),
});
export type WorkspaceWriteArgs = z.infer<typeof workspaceWriteArgsSchema>;
