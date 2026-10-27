import { describe, expect, it } from 'vitest';
import { ENERGY_WINDOWS_VERSION, energyWindows, type EnergyWindowsInput } from '../src/health/scores/energy-windows';
import { localDayWindow } from '../src/health/scores/time';
import type { DayRecord, HourlyBucket } from '../src/health/scores/types';

// energy-windows.v1 golden vectors. Every value is synthetic, and each curve is built so its trend line is flat and its
// residuals are exactly zero outside the runs under test: two equal peaks placed symmetrically about the middle of the
// usable hours, and one centred dip whose total depth cancels them.
const HOUR = 3_600_000;
const TARGET = '2026-03-20';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const instant = (day: string, hhmm: string) => `${day}T${hhmm}:00.000Z`;

// Hours since waking, 1 being the first. Peaks at 3-5 and 13-15, a dip at 8-10.
const TWO_PEAKS = (h: number): number => 70 + ((h >= 3 && h <= 5) || (h >= 13 && h <= 15) ? 6 : 0) - (h >= 8 && h <= 10 ? 12 : 0);
const INVERTED = (h: number): number => 140 - TWO_PEAKS(h);
const FLAT = (): number => 70;

type DayShape = Readonly<{ wake?: string; curve?: (h: number) => number; movement?: (h: number) => number | null; workouts?: readonly Readonly<{ from: number; to: number }>[]; hours?: number; zone?: string; sleepStart?: string | null; bed?: string }>;
// One day whose waking hours start at `wake` UTC, each hour a bucket on the whole hour.
const dayAt = (day: string, shape: DayShape = {}): DayRecord => {
  const wake = shape.wake ?? '07:00';
  const wakeMs = Date.parse(instant(day, wake));
  const curve = shape.curve ?? TWO_PEAKS;
  const movement = shape.movement ?? (() => 2);
  const hourly: HourlyBucket[] = Array.from({ length: shape.hours ?? 16 }, (_, k) => ({
    startAt: new Date(wakeMs + k * HOUR).toISOString(), heartRate: curve(k + 1), hrv: null, hrvMethod: null,
    daylightMinutes: null, movementMinutes: movement(k + 1), activeEnergyKcal: null,
  }));
  const asleepFrom = shape.sleepStart === undefined ? (shape.bed ? instant(addDays(day, -1), shape.bed) : new Date(wakeMs - 8 * HOUR).toISOString()) : shape.sleepStart;
  return {
    day, timezone: shape.zone ?? 'UTC',
    sleep: asleepFrom === null ? null : { startAt: asleepFrom, endAt: new Date(wakeMs).toISOString(), asleepMinutes: 450, midpointMinute: 180 },
    overnightHrv: [], restingHeartRate: [], hourly,
    workouts: (shape.workouts ?? []).map(w => ({ startAt: new Date(wakeMs + w.from * HOUR).toISOString(), endAt: new Date(wakeMs + w.to * HOUR).toISOString() })),
    demand: null,
  };
};

// The next day's sleep starts eight hours before its wake, so a day's last hours are known to end before bed.
const run = (prior: number, shape: (i: number) => DayShape = () => ({}), today: DayShape = {}): DayRecord[] => [
  dayAt(TARGET, { curve: FLAT, ...today }),
  ...Array.from({ length: prior }, (_, k) => dayAt(addDays(TARGET, -(k + 1)), shape(k + 1))),
];
const windowsOf = (days: DayRecord[], over: Partial<EnergyWindowsInput> = {}) =>
  energyWindows({ targetDay: TARGET, days, recoveryZone: 'excellent', sleepTrend: 'steady', ...over });

const CLEAN = [
  { start: '09:00', end: '12:00', kind: 'peak' },
  { start: '14:00', end: '17:00', kind: 'dip' },
  { start: '19:00', end: '22:00', kind: 'peak' },
];

describe('energy windows: the golden vector', () => {
  it('is versioned', () => expect(ENERGY_WINDOWS_VERSION).toBe('energy-windows.v1'));

  it('finds the two largest peaks and the largest dip, as clock times from today\'s wake, in order', () => {
    expect(windowsOf(run(10))).toEqual(CLEAN);
  });

  // With no Recovery today the peaks are not trimmed: an unknown zone is a day not known to be poor, never a poor one.
  it('is the same for any recovery zone that leaves peaks alone, and when the zone is unknown', () => {
    expect(windowsOf(run(10), { recoveryZone: 'solid' })).toEqual(CLEAN);
    expect(windowsOf(run(10), { recoveryZone: null })).toEqual(CLEAN);
  });

  it('gives nothing when today has no sleep to wake from', () => {
    expect(windowsOf(run(10, () => ({}), { sleepStart: null }))).toEqual([]);
  });
});

describe('energy windows: waking alignment', () => {
  it('moves every window by the same 90 minutes when today\'s wake is 90 minutes later', () => {
    const later = windowsOf(run(10, () => ({}), { wake: '08:30' }));
    expect(later).toEqual([
      { start: '10:30', end: '13:30', kind: 'peak' },
      { start: '15:30', end: '18:30', kind: 'dip' },
      { start: '20:30', end: '23:30', kind: 'peak' },
    ]);
  });

  it('reads the owner\'s days by hours since waking, not by the clock', () => {
    const waking = (i: number) => ({ wake: ['06:00', '07:00', '08:00'][i % 3]!, bed: '23:00' });
    expect(windowsOf(run(12, waking))).toEqual(CLEAN);
  });
});

describe('energy windows: unusual wake days', () => {
  const wild = (wake: string) => (i: number): DayShape => (i <= 3 ? { wake, curve: i === 1 ? INVERTED : (h: number) => 70 + (INVERTED(h) - 70) * 9 } : {});
  it('leaves out days whose wake is more than 2 hours from the usual', () => {
    expect(windowsOf(run(13, wild('11:00')))).toEqual(CLEAN);
  });
  it('keeps a day whose wake is within 2 hours of the usual, so the same days change the answer', () => {
    expect(windowsOf(run(13, wild('08:30')))).not.toEqual(CLEAN);
  });
});

describe('energy windows: recovery zone and sleep debt scale the peaks', () => {
  it('halves the peaks when recovery is compromised, centred where they were, and leaves the dip', () => {
    expect(windowsOf(run(10), { recoveryZone: 'compromised' })).toEqual([
      { start: '10:00', end: '11:30', kind: 'peak' },
      { start: '14:00', end: '17:00', kind: 'dip' },
      { start: '20:00', end: '21:30', kind: 'peak' },
    ]);
  });
  it('trims them to two thirds when it is mixed', () => {
    expect(windowsOf(run(10), { recoveryZone: 'mixed' })).toEqual([
      { start: '09:30', end: '11:30', kind: 'peak' },
      { start: '14:00', end: '17:00', kind: 'dip' },
      { start: '19:30', end: '21:30', kind: 'peak' },
    ]);
  });
  it('trims one step further when sleep debt is building', () => {
    expect(windowsOf(run(10), { recoveryZone: 'solid', sleepTrend: 'building' }).filter(w => w.kind === 'peak')).toEqual(
      windowsOf(run(10), { recoveryZone: 'mixed' }).filter(w => w.kind === 'peak'));
    const compromised = windowsOf(run(10), { recoveryZone: 'compromised' }).filter(w => w.kind === 'peak');
    const worst = windowsOf(run(10), { recoveryZone: 'compromised', sleepTrend: 'building' }).filter(w => w.kind === 'peak');
    expect(worst).toEqual([{ start: '10:00', end: '11:00', kind: 'peak' }, { start: '20:00', end: '21:00', kind: 'peak' }]);
    expect(worst.length).toBe(compromised.length);
  });
  it('never trims for easing or steady debt', () => {
    expect(windowsOf(run(10), { sleepTrend: 'easing' })).toEqual(CLEAN);
  });
});

describe('energy windows: three peaks', () => {
  // Three runs above the line, the middle one the smallest: only the two largest are kept, beside the one dip.
  const THREE = (h: number): number => 70 + ((h >= 2 && h <= 4) || (h >= 12 && h <= 14) ? 9 : 0) + (h >= 7 && h <= 8 ? 3 : 0) - (h >= 9 && h <= 11 ? 16 : 0);
  it('keeps the two largest and drops the third', () => {
    expect(windowsOf(run(10, () => ({ curve: THREE })))).toEqual([
      { start: '08:00', end: '11:00', kind: 'peak' },
      { start: '15:00', end: '18:00', kind: 'dip' },
      { start: '18:00', end: '22:00', kind: 'peak' },
    ]);
  });
});

describe('energy windows: not enough to say', () => {
  it('gives none with fewer than 7 days of readings, and some with 7', () => {
    expect(windowsOf(run(6))).toEqual([]);
    expect(windowsOf(run(7))).toEqual(CLEAN);
  });
  it('gives none when a flat curve has no peak or dip', () => {
    expect(windowsOf(run(10, () => ({ curve: FLAT })))).toEqual([]);
  });
  it('gives none when fewer than 8 hours of the day survive', () => {
    expect(windowsOf(run(10, () => ({ hours: 8 })))).toEqual([]);
    expect(windowsOf(run(10, () => ({ hours: 10 }))).length).toBeGreaterThan(0);
  });
  it('gives none when no hour carries a movement reading', () => {
    expect(windowsOf(run(10, () => ({ movement: () => null })))).toEqual([]);
  });
});

describe('energy windows: resting hours only', () => {
  // Hours 6 and 11 sit either side of the middle of the usable hours (2 to 15), so leaving both out keeps the trend line flat.
  const loud = (hours: readonly number[]) => (h: number) => (hours.includes(h) ? 200 : TWO_PEAKS(h));
  it('ignores the first waking hour and the last hour before bed', () => {
    expect(windowsOf(run(10, () => ({ curve: loud([1, 16]) })))).toEqual(CLEAN);
  });
  it('ignores hours with movement of 10 minutes or more', () => {
    expect(windowsOf(run(10, () => ({ curve: loud([6, 11]), movement: (h: number) => (h === 6 || h === 11 ? 10 : 9) })))).toEqual(CLEAN);
  });
  it('ignores hours that overlap a workout', () => {
    expect(windowsOf(run(10, () => ({ curve: loud([6, 11]), workouts: [{ from: 5, to: 6 }, { from: 10.2, to: 10.8 }] })))).toEqual(CLEAN);
  });
});

describe('energy windows: the day\'s end', () => {
  const NOON = { wake: '12:00' };
  // Peaks at hours 2-4 and 10-12, a dip across 5-9: the usable hours of a noon waker end at midnight.
  const LATE = (h: number): number => 70 + ((h >= 2 && h <= 4) || (h >= 10 && h <= 12) ? 6 : 0) - (h >= 5 && h <= 9 ? 7.2 : 0);
  it('cuts a window that would cross midnight at 23:30', () => {
    expect(windowsOf(run(10, () => ({ ...NOON, curve: LATE, hours: 12 }), NOON))).toEqual([
      { start: '13:00', end: '16:00', kind: 'peak' },
      { start: '16:00', end: '21:00', kind: 'dip' },
      { start: '21:00', end: '23:30', kind: 'peak' },
    ]);
  });
});

describe('energy windows: a 23-hour day', () => {
  // Clocks in New York spring forward at 02:00 local on 8 March 2026. The owner wakes at 01:00 EST, an hour before.
  const zone = 'America/New_York';
  const SPRING = '2026-03-08';
  it('keeps the transition out of the day\'s own length', () => {
    const { start, end } = localDayWindow(SPRING, zone);
    expect((end - start) / HOUR).toBe(23);
  });
  it('counts hours since waking as elapsed hours and reads them back as wall-clock time', () => {
    const prior = Array.from({ length: 10 }, (_, k) => dayAt(addDays(SPRING, -(k + 1)), { zone, wake: '06:00' }));
    const target = dayAt(SPRING, { zone, wake: '06:00', curve: FLAT });
    const out = energyWindows({ targetDay: SPRING, days: [target, ...prior], recoveryZone: 'excellent', sleepTrend: 'steady' });
    expect(out).toEqual([
      { start: '04:00', end: '07:00', kind: 'peak' },
      { start: '09:00', end: '12:00', kind: 'dip' },
      { start: '14:00', end: '17:00', kind: 'peak' },
    ]);
  });
});
