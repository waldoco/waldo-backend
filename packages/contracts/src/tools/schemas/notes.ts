import { z } from 'zod';

// Waldo's own notes: one short page per owner of what Waldo is watching, what it concluded and what it expects next. Every
// general wake reads it first and rewrites it last; the owner reads and corrects it in chat. Words only: the host refuses a page
// that carries a health reading. revision is the page's count; a rewrite names the revision it read, so a write made since (the
// owner's correction, another run's rewrite) is never overwritten unseen.
export const WALDO_NOTES_MAX_CHARS = 2_000;

export const readNotesArgsSchema = z.strictObject({});
export type ReadNotesArgs = z.infer<typeof readNotesArgsSchema>;

export const rewriteNotesArgsSchema = z.strictObject({
  text: z.string().trim().max(WALDO_NOTES_MAX_CHARS).describe('The whole page as it should now read, in plain words: what you are watching, what you concluded, what you expect next. Empty clears it. Never a reading or a number about the body.'),
  revision: z.int().min(0).describe('The revision of the page you read (0 when there was none).'),
});
export type RewriteNotesArgs = z.infer<typeof rewriteNotesArgsSchema>;

export const waldoNotesWriterSchema = z.enum(['waldo', 'owner', 'forget']);
export const waldoNotesSchema = z.strictObject({
  text: z.string().max(WALDO_NOTES_MAX_CHARS),
  revision: z.int().min(0),
  // Who wrote the current page: Waldo on its own, Waldo in a turn the owner's own message started (owner), or a forget that cleared it.
  written_by: waldoNotesWriterSchema,
  written_at: z.string().nullable(),
  // The run that wrote it had read someone else's words (mail, invites, pages).
  outside: z.boolean(),
});
export type WaldoNotes = z.infer<typeof waldoNotesSchema>;
