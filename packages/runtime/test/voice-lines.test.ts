import { describe, expect, it } from 'vitest';
import { INTERRUPTED_NOTICES } from '../src/prompt/fixed-lines';
import { updateCardPrompt } from '../src/prompt/update-cards';

// The update cards and interrupted-turn notices, held to the voice: an update that leads with the change, and a stop said in
// plain words with what to check.

describe('an update leads with the change, never a header', () => {
  const context = { changes: '- calendar changed', ledger: '', feedback: '', volume: 'normal' as const };

  it('the update card', () => {
    const prompt = updateCardPrompt('2026-10-31T10:00', context);
    expect(prompt).not.toContain('"Update"');
  });
});

describe('a turn that stopped partway is said plainly, with what to check', () => {
  const check = 'anything I was changing for you, such as your calendar, sent mail or reminders';

  it('keeps each notice\'s meaning, in the words fixed-lines uses for its own uncertain stop', () => {
    expect(INTERRUPTED_NOTICES).toEqual({
      unfinished: `I was interrupted partway through your message, so I can't tell what I'd already done about it, and a change I'd started may still go through. Check ${check} before you send it again.`,
      stopped: `Stopped. A change I'd already started may still go through, so check ${check}.`,
      uncertain: `I was interrupted partway through your message, so I can't tell what I'd already done about it, and some of it may already have gone through. Check ${check} before you send it again.`,
      unconfirmed: 'The task ran out of time before I could confirm its result reached you. The result may already be saved privately, so I didn\'t send it unconfirmed or run the work again. Check for that saved result before you ask again.',
      steer: `I used the message you added, but I was interrupted before I finished, so I can't tell what I'd already done about it, and a change I'd started may still go through. Check ${check} before you send it again.`,
    });
  });

  it('none of them speaks in machinery or pleads', () => {
    for (const line of Object.values(INTERRUPTED_NOTICES)) expect(line).not.toMatch(/\brun\b(?! the work)|in-flight|\bfinal\b|verified|delivery|retrying|Please/i);
  });
});
