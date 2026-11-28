import { describe, expect, it } from 'vitest';
import { appHomeCardV1Schema, HOME_CARD_MAX_CHARS } from './home-card';
import { writeHomeCardArgsSchema } from '../tools/schemas/home-card';

describe('the Home card contract', () => {
  it('reads as unavailable, none, or a written card for a day', () => {
    expect(appHomeCardV1Schema.safeParse({ state: 'unavailable' }).success).toBe(true);
    expect(appHomeCardV1Schema.safeParse({ state: 'none' }).success).toBe(true);
    expect(appHomeCardV1Schema.safeParse({ state: 'written', card_id: 'home:1', text: 'Board prep moved to 4; your deep work block is safe.', written_at: 1, day: '2026-11-28' }).success).toBe(true);
  });

  it('refuses a written card with no text, an unknown field, a bad day, or a text over the cap', () => {
    const card = { state: 'written', card_id: 'home:1', text: 'A line.', written_at: 1, day: '2026-11-28' };
    expect(appHomeCardV1Schema.safeParse({ ...card, text: '' }).success).toBe(false);
    expect(appHomeCardV1Schema.safeParse({ ...card, did: [] }).success).toBe(false);
    expect(appHomeCardV1Schema.safeParse({ ...card, day: '28 Nov' }).success).toBe(false);
    expect(appHomeCardV1Schema.safeParse({ ...card, text: 'a'.repeat(HOME_CARD_MAX_CHARS + 1) }).success).toBe(false);
    expect(appHomeCardV1Schema.safeParse({ state: 'none', text: 'x' }).success).toBe(false);
  });

  it('write_home_card takes trimmed text within the cap and nothing else', () => {
    expect(writeHomeCardArgsSchema.parse({ text: '  A line.  ' })).toEqual({ text: 'A line.' });
    expect(writeHomeCardArgsSchema.safeParse({ text: '   ' }).success).toBe(false);
    expect(writeHomeCardArgsSchema.safeParse({ text: 'a'.repeat(HOME_CARD_MAX_CHARS + 1) }).success).toBe(false);
    expect(writeHomeCardArgsSchema.safeParse({ text: 'A line.', day: '2026-11-28' }).success).toBe(false);
  });
});
