import { describe, expect, it } from 'vitest';
import { END_RUN_MESSAGE_MAX_CHARS, END_RUN_REASON_MAX_CHARS, endRunArgsSchema, endRunResultSchema } from './end-run';

describe('end_run arguments', () => {
  it('takes each way a run can end, with its reason, and the words only where the owner hears them', () => {
    expect(endRunArgsSchema.safeParse({ outcome: 'send', reason: 'the meeting moved', message: 'Your 3pm moved to 4.' }).success).toBe(true);
    expect(endRunArgsSchema.safeParse({ outcome: 'ask_owner', reason: 'two slots fit', message: 'Gym at 6 or 7?' }).success).toBe(true);
    expect(endRunArgsSchema.safeParse({ outcome: 'nothing_to_send', reason: 'already done' }).success).toBe(true);
    expect(endRunArgsSchema.safeParse({ outcome: 'follow_up', reason: 'reply not in yet; reminder set for 5pm' }).success).toBe(true);
    expect(endRunArgsSchema.safeParse({ outcome: 'send', reason: 'r'.repeat(END_RUN_REASON_MAX_CHARS), message: 'm'.repeat(END_RUN_MESSAGE_MAX_CHARS) }).success).toBe(true);
  });

  it('refuses a send or question without words, words on a silent end, a blank or long reason, and anything else', () => {
    expect(endRunArgsSchema.safeParse({ outcome: 'send', reason: 'x' }).success).toBe(false);
    expect(endRunArgsSchema.safeParse({ outcome: 'ask_owner', reason: 'x', message: '  ' }).success).toBe(false);
    expect(endRunArgsSchema.safeParse({ outcome: 'nothing_to_send', reason: 'x', message: 'hi' }).success).toBe(false);
    expect(endRunArgsSchema.safeParse({ outcome: 'follow_up', reason: 'x', message: 'hi' }).success).toBe(false);
    expect(endRunArgsSchema.safeParse({ outcome: 'nothing_to_send', reason: '   ' }).success).toBe(false);
    expect(endRunArgsSchema.safeParse({ outcome: 'nothing_to_send', reason: 'r'.repeat(END_RUN_REASON_MAX_CHARS + 1) }).success).toBe(false);
    expect(endRunArgsSchema.safeParse({ outcome: 'skip', reason: 'x' }).success).toBe(false);
    expect(endRunArgsSchema.safeParse({ outcome: 'nothing_to_send', reason: 'x', at: '17:00' }).success).toBe(false);
  });
});

describe('end_run result', () => {
  it('names the end the run took', () => {
    expect(endRunResultSchema.safeParse({ ended: true, outcome: 'follow_up' }).success).toBe(true);
    expect(endRunResultSchema.safeParse({ ended: false, outcome: 'follow_up' }).success).toBe(false);
  });
});
