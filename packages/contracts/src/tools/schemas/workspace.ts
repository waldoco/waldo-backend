import { z } from 'zod';

// Files slice (docs/planning/FILES_ARTIFACTS_FIRST_SLICE_2026-10-02.md): agent access to the
// owner-private workspace store. The model never supplies operation_id: the runtime derives it
// from the dispatcher context, so a retry of the same call is idempotent and a model cannot
// replay or collide with another operation. Schemas are strict; unknown keys are rejected.
// 32,000 bytes: the argument sanitiser admits strings only up to about this size (50,000 chars is denied),
// so a larger schema cap would advertise sizes the dispatcher refuses.
export const WORKSPACE_TEXT_MAX_BYTES = 32_000;

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
export const workspaceSearchArgsSchema = z.strictObject({
  query: z.string().min(1).max(200),
  path_prefix: z.string().min(1).max(200).optional(),
  limit: z.int().min(1).max(20).optional(),
});
export type WorkspaceSearchArgs = z.infer<typeof workspaceSearchArgsSchema>;

export type WorkspaceReadArgs = z.infer<typeof workspaceReadArgsSchema>;

// UTF-8 byte length without TextEncoder (this package has no DOM/node lib).
function utf8Bytes(v: string): number {
  let n = 0;
  for (const ch of v) {
    const c = ch.codePointAt(0) as number;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

// Compare-and-swap like revise_artifact: expected_revision 0 creates, N replaces revision N.
export const workspaceWriteArgsSchema = z.strictObject({
  path: z.string().min(1).max(300),
  // The cap is in UTF-8 bytes (the store's unit), not characters.
  text: z.string().min(1).refine((v) => utf8Bytes(v) <= WORKSPACE_TEXT_MAX_BYTES, { message: 'text exceeds the byte cap' }).optional(),
  edits: z.array(z.strictObject({ before:z.string().min(1), after:z.string() })).min(1).max(20)
    .refine(edits => edits.reduce((bytes,edit) => bytes + utf8Bytes(edit.before) + utf8Bytes(edit.after),0) <= WORKSPACE_TEXT_MAX_BYTES, { message:'edits exceed the byte cap' }).optional(),
  mime: z.enum(['text/plain', 'text/markdown']),
  expected_revision: z.int().nonnegative(),
}).refine(value => (value.text === undefined) !== (value.edits === undefined), {message:'provide exactly one of text or edits'})
 .refine(value => value.edits === undefined || value.expected_revision > 0, {message:'edits require an existing revision'});
export type WorkspaceWriteArgs = z.infer<typeof workspaceWriteArgsSchema>;

// Render bounded saved text to genuine document bytes; binary data never enters model arguments.
export const workspaceRenderArgsSchema = z.strictObject({
  source_file_id: z.string().min(1).max(100),
  source_revision: z.int().positive(),
  path: z.string().min(1).max(300),
  expected_revision: z.int().nonnegative(),
  format: z.enum(['pdf', 'docx']),
});
export type WorkspaceRenderArgs = z.infer<typeof workspaceRenderArgsSchema>;
