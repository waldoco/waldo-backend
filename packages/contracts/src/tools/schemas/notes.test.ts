import { describe, expect, it } from 'vitest';
import { readNotesArgsSchema, rewriteNotesArgsSchema, WALDO_NOTES_MAX_CHARS, waldoNotesSchema } from './notes';

describe('Waldo\'s own notes tool contract', () => {
  it('read_notes takes no arguments', () => {
    expect(readNotesArgsSchema.safeParse({}).success).toBe(true);
    expect(readNotesArgsSchema.safeParse({ revision: 1 }).success).toBe(false);
  });

  it('rewrite_notes takes the whole page and the revision it read; empty clears', () => {
    expect(rewriteNotesArgsSchema.parse({ text: '  Watching: the deck.  ', revision: 0 })).toEqual({ text: 'Watching: the deck.', revision: 0 });
    expect(rewriteNotesArgsSchema.safeParse({ text: '', revision: 3 }).success).toBe(true);
  });

  it('rewrite_notes refuses a page over the cap, a missing or negative revision, and extra fields', () => {
    expect(rewriteNotesArgsSchema.safeParse({ text: 'a'.repeat(WALDO_NOTES_MAX_CHARS + 1), revision: 0 }).success).toBe(false);
    expect(rewriteNotesArgsSchema.safeParse({ text: 'Watching.' }).success).toBe(false);
    expect(rewriteNotesArgsSchema.safeParse({ text: 'Watching.', revision: -1 }).success).toBe(false);
    expect(rewriteNotesArgsSchema.safeParse({ text: 'Watching.', revision: 1.5 }).success).toBe(false);
    expect(rewriteNotesArgsSchema.safeParse({ text: 'Watching.', revision: 0, written_by: 'owner' }).success).toBe(false);
  });

  it('the page names who wrote it from a closed list', () => {
    const page = { text: 'Watching.', revision: 1, written_by: 'waldo', written_at: '2026-11-28T10:00', outside: true };
    expect(waldoNotesSchema.safeParse(page).success).toBe(true);
    expect(waldoNotesSchema.safeParse({ ...page, written_by: 'someone' }).success).toBe(false);
  });
});
