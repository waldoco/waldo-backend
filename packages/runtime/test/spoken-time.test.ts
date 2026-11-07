import { describe, expect, it } from 'vitest';
import { clockWords, ownerTime } from '../src/prompt/fixed-lines';

// Times in the words Waldo writes say them as people do (the voice guide's mechanics): lowercase am/pm with no space, minutes
// only when not on the hour. A line sent with no other context keeps am/pm on a time with minutes, so 10:30 at night is never
// read as the morning.
describe('clockWords', () => {
  it.each([
    ['09:00', '9am'], ['14:00', '2pm'], ['10:30', '10:30am'], ['22:30', '10:30pm'], ['00:00', '12am'], ['12:00', '12pm'], ['12:05', '12:05pm'], ['00:45', '12:45am'], ['23:59', '11:59pm'],
  ])('%s is %s', (clock, spoken) => {
    expect(clockWords(clock)).toBe(spoken);
  });

  it('refuses what is not a 24-hour clock time rather than guessing', () => {
    for (const bad of ['24:00', '9:00', '12:60', 'noon', '']) expect(() => clockWords(bad), bad).toThrow();
  });
});

describe('ownerTime', () => {
  it('says the owner\'s local time in their zone', () => {
    expect(ownerTime(Date.parse('2026-11-06T03:30:00Z'), 'Asia/Kolkata')).toBe('9am');
    expect(ownerTime(Date.parse('2026-11-06T17:00:00Z'), 'Asia/Kolkata')).toBe('10:30pm');
    expect(ownerTime(Date.parse('2026-11-06T13:00:00Z'), 'Europe/London')).toBe('1pm');
  });
});
