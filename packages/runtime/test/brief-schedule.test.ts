import { describe, expect, it } from 'vitest';
import { sanitise } from '../src/scribe/sanitiser';
import { DAY_CARDS, dayCardPrompt, PROSE_RULE, SCHEDULE_HEADING, SCHEDULE_RULE } from '../src/prompt/day-cards';

const card = (id: string) => DAY_CARDS.find((entry) => entry.id === id)!;
const context = { calendar: '{"title":"Investor call","start":"2026-11-04T15:00:00+05:30","end":"2026-11-04T15:45:00+05:30"}', ledger: '', today: '', updates: '' };
const CANARIES = ['1111111111111111', '2222222222222222', '3333333333333333'];

// A Brief as the model is asked to write it: the spoken paragraph, then the time-blocked plan.
const BRIEF = [
  'The Brief',
  'A focused day with one big moment: the investor call at three. Your Form reads a little low this morning, so I have kept the afternoon light and put the deck work in your best stretch. A short walk after lunch will help.',
  '',
  SCHEDULE_HEADING,
  '07:30–08:00 Breakfast and inbox',
  '08:00–10:30 Deep work: finish the Q3 deck',
  '10:30–10:45 Break',
  '10:45–12:00 Replies and the supplier follow-up',
  '12:30–13:15 Lunch and a walk',
  '13:15–14:30 Light admin',
  '14:30–15:00 Buffer before the call',
  '15:00–15:45 Investor call',
  '16:00–17:30 Notes and next steps from the call',
].join('\n');

describe('the Brief lays out the day', () => {
  it('asks for a time-blocked plan after the spoken paragraph, only on the Brief', () => {
    const brief = dayCardPrompt(card('card:brief'), '2026-11-04T07:20', context);
    expect(brief).toContain(SCHEDULE_RULE);
    expect(brief.indexOf(PROSE_RULE)).toBeLessThan(brief.indexOf(SCHEDULE_RULE));
    expect(SCHEDULE_RULE).toContain('Keep every event from the calendar at its own time');
    expect(SCHEDULE_RULE).toContain('never say a block is booked or on their calendar');
    expect(SCHEDULE_RULE).toContain('never a bare warning');
    for (const id of ['card:midday', 'card:close']) expect(dayCardPrompt(card(id), '2026-11-04T14:00', context)).not.toContain(SCHEDULE_RULE);
  });

  it('passes the owner-reply and outbox policies, so the times in a plan are not taken for readings', () => {
    for (const destination of ['owner_reply', 'outbox'] as const) {
      const result = sanitise({ payload: [{ role: 'assistant', content: BRIEF }], destination, source_taint: null, canary_tokens: CANARIES });
      expect([destination, result.ok]).toEqual([destination, true]);
    }
  });
});
