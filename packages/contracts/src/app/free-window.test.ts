import { describe, expect, it } from 'vitest';
import { APP_CHAT_FREE_WINDOW_REVISION, appMessagePartV1Schema } from './core';
import { replyFreeWindowPartV1Schema } from './parts';
import { proposeCalendarChangeArgsSchema } from '../tools/schemas/calendar';

// Synthetic offer: a made-up window and task.
const part = {
  type: 'free_window', approval_id: 'appr_1', line: 'Your 3pm moved. 45 minutes free: finish the deck?', title: 'Finish the deck',
  start: 1_794_236_400_000, end: 1_794_239_100_000,
  choices: [{ action: 'approve', label: 'Do it' }, { action: 'defer', label: 'Not now' }, { action: 'skip', label: 'Keep it free' }],
  fallback_text: 'Your 3pm moved. 45 minutes free: finish the deck? Do it / Not now / Keep it free',
};

describe('free-window offer (chat revision 9)', () => {
  it('is revision 9 and a message part', () => {
    expect(APP_CHAT_FREE_WINDOW_REVISION).toBe(9);
    expect(replyFreeWindowPartV1Schema.safeParse(part).success).toBe(true);
    expect(appMessagePartV1Schema.safeParse(part).success).toBe(true);
    expect(replyFreeWindowPartV1Schema.safeParse({ ...part, choices: part.choices.slice(0, 2) }).success).toBe(true);
  });

  it('refuses an offer it could not decide or show', () => {
    for (const bad of [
      { ...part, approval_id: 'has space' },
      { ...part, end: part.start },
      { ...part, start: 1_794_236_400 },
      { ...part, line: 'two\nlines' },
      { ...part, line: ' ' },
      { ...part, choices: [{ action: 'approve', label: 'Do it' }] },
      { ...part, choices: [...part.choices, { action: 'edit', label: 'Change' }] },
      { ...part, choices: [{ action: 'approve', label: 'Do it' }, { action: 'approve', label: 'Yes' }] },
      { ...part, choices: [{ action: 'undo', label: 'Undo' }, { action: 'skip', label: 'No' }] },
      { ...part, choices: [{ action: 'approve', label: 'Do it right away please now' }, { action: 'skip', label: 'No' }] },
      { ...part, fallback_text: undefined },
      { ...part, title: undefined },
      { ...part, title: ' ' },
      { ...part, review: 'extra' },
    ]) expect(replyFreeWindowPartV1Schema.safeParse(bad).success).toBe(false);
  });

  it('a calendar card marks a free-window offer only on a block it creates', () => {
    const block = { action: 'create', title: 'Finish the deck', start: '2026-11-09T15:00:00+05:30', end: '2026-11-09T15:45:00+05:30', reason: 'Your 3pm moved', block: 'deep_work' };
    expect(proposeCalendarChangeArgsSchema.safeParse({ ...block, offer: 'free_window' }).success).toBe(true);
    expect(proposeCalendarChangeArgsSchema.safeParse({ ...block, offer: 'later' }).success).toBe(false);
    expect(proposeCalendarChangeArgsSchema.safeParse({ ...block, block: undefined, offer: 'free_window' }).success).toBe(false);
    expect(proposeCalendarChangeArgsSchema.safeParse({ action: 'move', event_id: 'e1', start: block.start, end: block.end, reason: 'r', offer: 'free_window' }).success).toBe(false);
  });
});
