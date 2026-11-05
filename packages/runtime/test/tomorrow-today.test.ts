import { describe, expect, it } from 'vitest';
import { cardWindow } from '../src/channels/day-cards';
import { CAPACITY_LINES } from '../src/prompt/capacity';
import { DAY_CARDS, dayCardPrompt, TOMORROW_TODAY_INSTRUCTION } from '../src/prompt/day-cards';

const card = (id: string) => DAY_CARDS.find(entry => entry.id === id)!;
const hours = (window: Readonly<{ from: number; to: number }>) => (window.to - window.from) / 3_600_000;

describe('the window a card reads', () => {
  it('the Close reads all of a 25-hour tomorrow, and nothing of the day after', () => {
    // Saturday 24 October 2026, 21:30 in London: the clocks go back in the night.
    const window = cardWindow(card('card:close'), Date.parse('2026-10-24T20:30:00Z'), 'Europe/London');
    expect(window).toEqual({ from: Date.parse('2026-10-24T23:00:00Z'), to: Date.parse('2026-10-26T00:00:00Z') });
    expect(hours(window)).toBe(25);
  });

  it('the Close reads a 23-hour tomorrow from its midnight, not an hour into it', () => {
    // Saturday 27 March 2027, 21:30 in London: the clocks go forward in the night.
    const window = cardWindow(card('card:close'), Date.parse('2027-03-27T21:30:00Z'), 'Europe/London');
    expect(window).toEqual({ from: Date.parse('2027-03-28T00:00:00Z'), to: Date.parse('2027-03-28T23:00:00Z') });
  });

  it('the Brief on the long day reads it whole; the Check-in reads from now to its end', () => {
    expect(hours(cardWindow(card('card:brief'), Date.parse('2026-10-25T08:00:00Z'), 'Europe/London'))).toBe(25);
    expect(cardWindow(card('card:midday'), Date.parse('2026-10-25T14:00:00Z'), 'Europe/London')).toEqual({ from: Date.parse('2026-10-25T14:00:00Z'), to: Date.parse('2026-10-26T00:00:00Z') });
  });

  it('in a zone without clock changes, a day is the owner\'s local day', () => {
    expect(cardWindow(card('card:close'), Date.parse('2026-11-05T16:00:00Z'), 'Asia/Kolkata')).toEqual({ from: Date.parse('2026-11-05T18:30:00Z'), to: Date.parse('2026-11-06T18:30:00Z') });
  });
});

describe('the Close with TOMORROW_TODAY', () => {
  const context = { calendar: '(none)', ledger: '', today: '', updates: '' };
  const prompt = (id: string, capacity: boolean, tomorrow: boolean) => dayCardPrompt(card(id), '2026-11-05T21:30', context, false, false, capacity, tomorrow);

  it('reads tomorrow\'s best hours and may raise cards, in place of the spoken shape', () => {
    expect(prompt('card:close', true, true)).toContain(TOMORROW_TODAY_INSTRUCTION);
    expect(prompt('card:close', true, true)).not.toContain(CAPACITY_LINES.close);
    expect(prompt('card:close', false, true)).toContain(TOMORROW_TODAY_INSTRUCTION);
  });

  it('leaves the Brief and the Check-in as they are, and the Close as before with the switch off', () => {
    expect(prompt('card:brief', true, true)).toBe(prompt('card:brief', true, false));
    expect(prompt('card:midday', false, true)).toBe(prompt('card:midday', false, false));
    expect(prompt('card:close', false, false)).toBe(dayCardPrompt(card('card:close'), '2026-11-05T21:30', context));
  });
});
