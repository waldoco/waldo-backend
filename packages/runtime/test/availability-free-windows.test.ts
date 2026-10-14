import { describe, expect, it } from 'vitest';
import { googleHandlers } from '../src/tools/live/google';

// The free windows the model offers come straight from this tool, in the owner's zone with their length, so the
// model never subtracts busy blocks or converts zones itself.
const desk = { propose: async () => { throw new Error('no mutation'); }, proposeSendEmail: async () => { throw new Error('no mutation'); }, record: () => { throw new Error('no mutation'); } };
type Window = { start: string; end: string; minutes: number };
const freeWindows = async (timezone: string, from: string, to: string, busy: readonly { start: string; end: string }[], duration: number) => {
  const handler = googleHandlers({ client: async () => ({ freeBusy: async () => ({ from, to, calendars: { primary: { busy } } }) }) as never }, desk, { timezone, now: () => new Date(from) })
    .find((h) => h.name === 'query_availability')!;
  const result = await handler.handle({ date_range: { from, to }, calendar_ids: ['primary'], duration_minutes: duration, work_windows: [] } as never) as { ok: boolean; data: { free_windows: Window[] } };
  expect(result.ok).toBe(true);
  return result.data.free_windows;
};
const IST = 'Asia/Kolkata';
const day = (hm: string) => `2026-10-14T${hm}:00+05:30`;
const block = (a: string, b: string) => ({ start: day(a), end: day(b) });

describe('query_availability free windows', () => {
  it('offers only the gaps that fit, in the owner\'s zone with their length, for a day shaped like the S2 ask', async () => {
    const busy = [block('10:00', '11:00'), block('12:30', '13:30'), block('14:00', '14:25'), block('15:00', '16:00')];
    const windows = await freeWindows(IST, day('09:00'), day('18:00'), busy, 60);
    expect(windows).toEqual([
      { start: day('09:00'), end: day('10:00'), minutes: 60 },
      { start: day('11:00'), end: day('12:30'), minutes: 90 },
      { start: day('16:00'), end: day('18:00'), minutes: 120 },
    ]);
    for (const w of windows) for (const b of busy) expect(Date.parse(w.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(w.end)).toBe(false);
  });

  it('merges overlapping and back-to-back blocks', async () => {
    expect(await freeWindows(IST, day('09:00'), day('18:00'), [block('10:00', '11:00'), block('10:30', '11:30'), block('11:30', '12:00')], 30))
      .toEqual([{ start: day('09:00'), end: day('10:00'), minutes: 60 }, { start: day('12:00'), end: day('18:00'), minutes: 360 }]);
  });

  it('treats an all-day block as busy all day', async () => {
    expect(await freeWindows(IST, day('09:00'), day('18:00'), [{ start: '2026-10-14T00:00:00+05:30', end: '2026-10-15T00:00:00+05:30' }], 30)).toEqual([]);
  });

  it('gives an empty day as one window and a fully booked day as none', async () => {
    expect(await freeWindows(IST, day('09:00'), day('18:00'), [], 60)).toEqual([{ start: day('09:00'), end: day('18:00'), minutes: 540 }]);
    expect(await freeWindows(IST, day('09:00'), day('18:00'), [block('08:00', '12:00'), block('12:00', '18:30')], 15)).toEqual([]);
  });

  it('keeps each window in the owner\'s zone across midnight and a daylight-saving change', async () => {
    // New York falls back at 02:00 local on 1 Nov 2026: -04:00 before, -05:00 after.
    const windows = await freeWindows('America/New_York', '2026-10-31T22:00:00-04:00', '2026-11-01T03:00:00-05:00',
      [{ start: '2026-11-01T00:30:00-04:00', end: '2026-11-01T01:30:00-04:00' }], 60);
    expect(windows).toEqual([
      { start: '2026-10-31T22:00:00-04:00', end: '2026-11-01T00:30:00-04:00', minutes: 150 },
      { start: '2026-11-01T01:30:00-04:00', end: '2026-11-01T03:00:00-05:00', minutes: 150 },
    ]);
  });
});
