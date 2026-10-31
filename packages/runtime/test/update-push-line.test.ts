import { describe, expect, it } from 'vitest';
import { PUSHES, PUSH_TITLE_CHARS } from '../src/channels/expo-push';
import { updatePushLine } from '../src/channels/update-sweep';
import type { Change, ChangeBefore } from '../src/channels/update-cards';

// The update push is written by code from the calendar change the turn chose: its title and its new time, nothing the model
// wrote. A title is the one outside text it carries, so a title shaped like a host or address, or carrying a health value,
// gives the fixed line, as does a mail, a change the job does not hold, and every change while names are off.
const NOW = Date.parse('2026-10-20T09:00:00Z');
const BEFORE: ChangeBefore = { start: '2026-10-20T10:00:00Z', end: '2026-10-20T10:30:00Z', all_day: false, title_changed: false };
const event = (over: Record<string, unknown> = {}, kind: Change['kind'] = 'changed', before: ChangeBefore | undefined = BEFORE): Change => ({
  source: 'calendar', kind, ref: `event:${String(over.id ?? 'e-sync')}`, ...(before ? { before } : {}),
  detail: JSON.stringify({ id: 'e-sync', title: 'Sync with Krati', start: '2026-10-20T15:00:00Z', end: '2026-10-20T15:30:00Z', all_day: false,
    description: 'Recovery is low today, keep it light', location: 'Krati\'s office', ...over }),
});
const MAIL: Change = { source: 'mail', kind: 'new', ref: 'message:m-1', detail: JSON.stringify({ from: 'Asha', subject: 'Quote signed', snippet: 'resting HR 48' }) };
const line = (changes: readonly Change[], id = 'e-sync', over: Partial<{ named: boolean; timezone: string; now: number }> = {}) =>
  updatePushLine(changes, id, { named: true, timezone: 'UTC', now: NOW, ...over });

describe('the update push line', () => {
  it('golden: names a moved meeting and its new local time', () => {
    expect(line([MAIL, event()])).toBe('Sync with Krati moved to 15:00');
  });

  it('names an added meeting, a cancelled one, and one that changed without moving', () => {
    expect(line([event({}, 'added', undefined)])).toBe('Sync with Krati added at 15:00');
    expect(line([event({}, 'cancelled')])).toBe('Sync with Krati cancelled');
    expect(line([event({ start: '2026-10-20T10:00:00Z', end: '2026-10-20T11:00:00Z' })])).toBe('Sync with Krati at 10:00 changed');
  });

  it('names the date when the meeting is not today, and no time for an all-day one', () => {
    expect(line([event({ start: '2026-10-22T15:00:00Z', end: '2026-10-22T15:30:00Z' })])).toBe('Sync with Krati moved to Thu 22 Oct 15:00');
    expect(line([event({ start: '2026-10-20', end: '2026-10-21', all_day: true }, 'added', undefined)])).toBe('Sync with Krati added today');
    expect(line([event({ start: '2026-10-21', end: '2026-10-22', all_day: true })])).toBe('Sync with Krati moved to Wed 21 Oct');
  });

  it('reads the time on the owner\'s clock, across a zone change and a DST end', () => {
    expect(line([event()], 'e-sync', { timezone: 'Asia/Kolkata' })).toBe('Sync with Krati moved to 20:30');
    expect(line([event()], 'e-sync', { timezone: 'America/New_York' })).toBe('Sync with Krati moved to 11:00');
    // London leaves summer time at 01:00 UTC on 25 October 2026: the same UTC hour reads an hour earlier after it.
    const london = (start: string) => line([event({ start, end: start })], 'e-sync', { timezone: 'Europe/London', now: Date.parse(start) - 3_600_000 });
    expect(london('2026-10-24T15:00:00Z')).toBe('Sync with Krati moved to 16:00');
    expect(london('2026-10-25T15:00:00Z')).toBe('Sync with Krati moved to 15:00');
  });

  it('is the fixed line while names are off, for a mail, for a change the job does not hold, and for one without a title', () => {
    expect(line([event()], 'e-sync', { named: false })).toBe(PUSHES.update.body);
    expect(line([MAIL], 'm-1')).toBe(PUSHES.update.body);
    expect(line([MAIL, event()], 'e-other')).toBe(PUSHES.update.body);
    expect(line([event({ title: '' }, 'cancelled')])).toBe(PUSHES.update.body);
    expect(line([event({ start: 'soon' })])).toBe(PUSHES.update.body);
  });

  it.each([
    ['a health value', 'Cardiology follow-up: BP 150/95 last time'],
    ['a meeting link without a scheme', 'Call zoom.us/j/8812345678?pwd=Xy12ab'],
    ['a short link', 'Urgent: verify your account at bit.ly/3abcDEF'],
    ['a link with its scheme', 'Sync https://meet.example/abc?pwd=s3cr3t'],
    ['an email address', 'Sync with krati@example.com'],
    ['a zero-width space before the dot', 'Verify at evil\u200b.co/x'],
    ['a fullwidth full stop', 'Verify at evil\uff0eco/login'],
    ['an ideographic full stop', 'Verify at evil\u3002co'],
    ['a halfwidth ideographic full stop', 'Verify at evil\uff61co'],
    ['a one dot leader', 'Login at evil\u2024co'],
    ['a bracketed dot', 'Verify evil[.]co/login'],
    ['a space before the dot', 'Verify at evil .co/x'],
    ['a right-to-left override before the dot', 'Pay at evil\u202e.co'],
    ['a fullwidth at sign', 'Mail krati\uff20gmail'],
    ['a health value in fullwidth digits', 'Review HRV \uff14\uff12 ms'],
  ])('a stranger\'s title carrying %s gives the fixed line, rather than cutting it out', (_case, title) => {
    expect(line([event({ title })])).toBe(PUSHES.update.body);
  });

  it('shows a title without the invisible characters it carried', () => {
    expect(line([event({ title: 'Sync\u200b with\u2060 Krati' })])).toBe('Sync with Krati moved to 15:00');
  });

  it('keeps titles that only look dotted, and caps a long one', () => {
    for (const title of ['Dr. Rao', 'Lunch with A.K.', 'Q3.5 planning', 'St. James sync', '3.30 sync']) expect(line([event({ title })])).toBe(`${title} moved to 15:00`);
    expect(line([event({ title: `Planning ${'and more '.repeat(20)}` })]).length).toBeLessThanOrEqual(PUSH_TITLE_CHARS + ' moved to Thu 22 Oct 15:00'.length);
  });

  it('never carries the event\'s description or location, whatever they say', () => {
    expect(line([event()])).not.toMatch(/Recovery|office/);
  });
});
