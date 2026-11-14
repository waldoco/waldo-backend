import { describe, expect, it } from 'vitest';
import { DAY_CARDS, dayCardPrompt, PLANNING_BRIEF_INSTRUCTION, SKIP_CARD } from '../src/prompt/day-cards';

// PROACTIVE_ACT_AHEAD's day shape: the Check-in goes only when the plan slipped, and the Close ends Waldo's day. The prompts
// change; whether the plan slipped is the model's reading. These check which instruction a card carries, never its words.
const context = { calendar: '(none)', ledger: '', today: '', updates: '' };
const card = (id: string) => DAY_CARDS.find(entry => entry.id === id)!;
const prompt = (id: string, dayShape: boolean, planning = false) => dayCardPrompt(card(id), '2026-11-05T14:00', context, planning, dayShape);

describe('the day shape', () => {
  it('the Check-in reads the plan against the day and may skip, in place of its old instruction', () => {
    expect(prompt('card:midday', true)).not.toContain(card('card:midday').instruction);
    expect(prompt('card:midday', true)).toContain(SKIP_CARD);
  });

  it('the Close keeps its wrap and adds the end of Waldo\'s day', () => {
    expect(prompt('card:close', true)).toContain(card('card:close').instruction);
    expect(prompt('card:close', true).length).toBeGreaterThan(prompt('card:close', false).length);
  });

  it('the Brief is untouched, recap or planning', () => {
    expect(prompt('card:brief', true)).toBe(prompt('card:brief', false));
    expect(prompt('card:brief', true, true)).toContain(PLANNING_BRIEF_INSTRUCTION);
  });

  it('with the switch off every card is as before', () => {
    for (const entry of DAY_CARDS) expect(prompt(entry.id, false)).toContain(entry.instruction);
  });
});
