import { describe, expect, it } from 'vitest';
import { PUSHES } from '../src/channels/expo-push';
import { UPDATE_PUSH_CHARS, updatePushLine } from '../src/channels/update-sweep';

// The update push may name what changed: a meeting's title, its times, the people in it. It never carries a health value,
// an email address, or text from a mail Waldo read, whatever the model wrote. This is a destination rule, held at the send.
const MAIL = 'Hi Priya, the lab results came back and your cholesterol is fine, see attached report for the details';
const HEALTH = 'Health logs:\n- 2026-10-20 07:10 slept 5 hours, resting heart rate 61';
const check = (line: string, named = true) => updatePushLine(line, { named, forbidden: [MAIL, HEALTH] });

describe('the update push line', () => {
  it('golden: names the change when the owner turned named updates on', () => {
    expect(check('Your 15:00 with Krati moved to 17:00')).toBe('Your 15:00 with Krati moved to 17:00');
  });

  it('is the fixed line while named updates are off', () => {
    expect(check('Your 15:00 with Krati moved to 17:00', false)).toBe(PUSHES.update.body);
  });

  it.each([
    ['a health reading', 'You slept 5 hours, so the 08:00 moved'],
    ['a resting heart rate', 'HR 61 bpm before your 15:00'],
    ['a span of a mail Waldo read', 'Priya: the lab results came back and your cholesterol is fine'],
    ['a span of the health log', 'resting heart rate 61 and the sync moved'],
    ['an empty line', '   '],
  ])('falls back to the fixed line for %s', (_case, line) => {
    expect(check(line)).toBe(PUSHES.update.body);
  });

  it('drops email addresses and cuts a long line', () => {
    expect(check('Sync with krati@example.com moved to 17:00')).toBe('Sync with moved to 17:00');
    const long = check(`The sync ${'moved again '.repeat(30)}`);
    expect(long.length).toBeLessThanOrEqual(UPDATE_PUSH_CHARS);
  });
});
