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

  it.each([
    ['a meeting link without a scheme', 'Call moved, zoom.us/j/8812345678?pwd=Xy12ab'],
    ['a bare meeting host', 'Sync moved to 17:00, join meet.google.com/abc-defg-hij'],
    ['a short link', 'Urgent: verify your account at bit.ly/3abcDEF now'],
    ['a link with its scheme', 'Sync moved to 17:00 https://meet.example/abc?pwd=s3cr3t'],
    ['an email address', 'Sync with krati@example.com moved to 17:00'],
  ])('falls back to the fixed line for %s, rather than cutting it out', (_case, line) => {
    expect(check(line)).toBe(PUSHES.update.body);
  });

  it('keeps times, initials and abbreviations that only look dotted', () => {
    for (const line of ['Sync moved to 3.30pm', 'Dr. Rao moved your 10:00 to 11:30', 'Lunch with A.K. moved to 1pm']) expect(check(line)).toBe(line);
  });

  it('cuts a long line', () => {
    const long = check(`The sync ${'moved again '.repeat(30)}`);
    expect(long.length).toBeLessThanOrEqual(UPDATE_PUSH_CHARS);
  });
});
