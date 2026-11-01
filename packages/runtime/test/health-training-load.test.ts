import { describe, expect, it } from 'vitest';
import { shiftDay } from '../src/health/scores/time';
import { TRAINING_LOAD_PHRASES, TRAINING_LOAD_VERSION, trainingLoad, type WorkoutLoad } from '../src/health/scores/training-load';

// training-load.candidate.v1 (ADR-0081 amendment of 31 Oct 2026, §2). Every value here is synthetic.
const TODAY = '2026-10-30';
const days = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => shiftDay(TODAY, -(from + i)));
const ALL = days(0, 27);
const ACUTE = days(0, 6);
const CHRONIC = days(7, 27);
const run = (day: string, minutes: number, extra: Partial<WorkoutLoad> = {}): WorkoutLoad => ({ day, minutes, zoneSeconds: null, effort: null, ...extra });
const zoned = (day: string, zoneSeconds: number[]): WorkoutLoad => run(day, zoneSeconds.reduce((a, b) => a + b, 0) / 60, { zoneSeconds });
// One workout every day of the window, the same each day, so acute equals chronic.
const steady = (make: (day: string) => WorkoutLoad): WorkoutLoad[] => ALL.map(make);

describe('training-load.candidate.v1', () => {
  it('reads an unchanged load as about usual, from the candidate version, with the method it used', () => {
    expect(trainingLoad({ throughDay: TODAY, observedDays: ALL, workouts: steady(day => run(day, 45)) }))
      .toEqual({ state: 'available', phrase: 'about usual', method: 'minutes', algorithm_version: TRAINING_LOAD_VERSION, activation: 'candidate_unaccepted' });
    expect(TRAINING_LOAD_VERSION).toBe('training-load.candidate.v1');
  });

  it('weighs a minute in zone n by n (Edwards), so a harder week at the same minutes reads heavier', () => {
    const easy = [600, 1200, 600, 0, 0], hard = [0, 600, 600, 600, 600];
    const workouts = [...CHRONIC.map(day => zoned(day, easy)), ...ACUTE.map(day => zoned(day, hard))];
    // Easy: 10*1 + 20*2 + 10*3 = 80 a day. Hard: 10*2 + 10*3 + 10*4 + 10*5 = 140 a day, 1.75 times usual, same 40 minutes.
    expect(trainingLoad({ throughDay: TODAY, observedDays: ALL, workouts })).toMatchObject({ method: 'hr_zones', phrase: 'much heavier than usual' });
    expect(trainingLoad({ throughDay: TODAY, observedDays: ALL, workouts: workouts.map(w => ({ ...w, zoneSeconds: null })) })).toMatchObject({ method: 'minutes', phrase: 'about usual' });
  });

  it('names zones built on an observed workout peak as their own method, counted the same way, so the model can call them approximate', () => {
    const easy = [600, 1200, 600, 0, 0], hard = [0, 600, 600, 600, 600];
    const measured = [...CHRONIC.map(day => zoned(day, easy)), ...ACUTE.map(day => zoned(day, hard))];
    const onePeak = measured.map((w, i) => (i === 3 ? { ...w, zonesFromObservedPeak: true } : w));
    expect(trainingLoad({ throughDay: TODAY, observedDays: ALL, workouts: measured })).toMatchObject({ method: 'hr_zones', phrase: 'much heavier than usual' });
    expect(trainingLoad({ throughDay: TODAY, observedDays: ALL, workouts: onePeak })).toMatchObject({ method: 'hr_zones_observed_peak', phrase: 'much heavier than usual' });
  });

  it('uses session RPE when every workout has an effort score of one kind, and never adds two methods together', () => {
    const rated = [...CHRONIC.map(day => run(day, 60, { effort: { score: 4, method: 'rated' } })), ...ACUTE.map(day => run(day, 60, { effort: { score: 6, method: 'rated' } }))];
    expect(trainingLoad({ throughDay: TODAY, observedDays: ALL, workouts: rated })).toMatchObject({ method: 'effort', phrase: 'heavier than usual' });
    // One workout without zones in the window drops the whole window below hr_zones; one estimated effort among rated
    // ones drops it below effort. Neither is added to the other.
    const mostlyZoned = [...steady(day => zoned(day, [0, 1800, 0, 0, 0])).slice(1), run(ALL[0]!, 30, { effort: { score: 5, method: 'rated' } })];
    expect(trainingLoad({ throughDay: TODAY, observedDays: ALL, workouts: mostlyZoned })).toMatchObject({ method: 'minutes' });
    const mixedEffort = rated.map((w, i) => (i === 0 ? { ...w, effort: { score: 4, method: 'estimated' as const } } : w));
    expect(trainingLoad({ throughDay: TODAY, observedDays: ALL, workouts: mixedEffort })).toMatchObject({ method: 'minutes' });
  });

  it('names each of the five phrases from the change against the owner\'s own usual', () => {
    const at = (acuteMinutes: number) => trainingLoad({ throughDay: TODAY, observedDays: ALL, workouts: [...CHRONIC.map(day => run(day, 100)), ...ACUTE.map(day => run(day, acuteMinutes))] });
    expect([50, 70, 100, 130, 160].map(minutes => (at(minutes) as { phrase: string }).phrase)).toEqual([...TRAINING_LOAD_PHRASES]);
    expect([59, 60, 84, 85, 115, 116, 150, 151].map(minutes => (at(minutes) as { phrase: string }).phrase)).toEqual([
      'much lighter than usual', 'lighter than usual', 'lighter than usual', 'about usual', 'about usual', 'heavier than usual', 'heavier than usual', 'much heavier than usual',
    ]);
  });

  it('compares the last seven days with the twenty-one before them, so this week is never part of its own usual', () => {
    // Coupled (28-day) usual would be (7*200 + 21*100)/28 = 125, a ratio of 1.6; uncoupled it is 2.0. Both read much heavier,
    // so the coupling shows at the band edge instead: acute 140 against 100 is heavier; coupled (110) it would read about usual.
    const workouts = [...CHRONIC.map(day => run(day, 100)), ...ACUTE.map(day => run(day, 140))];
    expect(trainingLoad({ throughDay: TODAY, observedDays: ALL, workouts })).toMatchObject({ phrase: 'heavier than usual' });
  });

  it('counts an observed day without a workout as rest, and leaves a day with no reading out', () => {
    // Workouts every other day in the usual, every day this week: twice usual on observed days.
    const workouts = [...CHRONIC.filter((_, i) => i % 2 === 0).map(day => run(day, 60)), ...ACUTE.map(day => run(day, 60))];
    expect(trainingLoad({ throughDay: TODAY, observedDays: ALL, workouts })).toMatchObject({ phrase: 'much heavier than usual' });
    // The same workouts, but the rest days were never observed (the watch was off): the usual is a workout every observed day.
    const observed = [...ACUTE, ...CHRONIC.filter((_, i) => i % 2 === 0), ...CHRONIC.filter((_, i) => i % 2 === 1).slice(0, 3)];
    expect(observed.length).toBeGreaterThanOrEqual(21);
    expect(trainingLoad({ throughDay: TODAY, observedDays: observed, workouts })).toMatchObject({ phrase: 'heavier than usual' });
  });

  it('is unavailable with fewer than 21 observed days in the window, or no workout in it', () => {
    const workouts = steady(day => run(day, 45));
    expect(trainingLoad({ throughDay: TODAY, observedDays: ALL.slice(0, 20), workouts: workouts.slice(0, 20) })).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
    expect(trainingLoad({ throughDay: TODAY, observedDays: ALL, workouts: [] })).toEqual({ state: 'unavailable', reason: 'no_readings' });
    expect(trainingLoad({ throughDay: TODAY, observedDays: ALL, workouts: [run(shiftDay(TODAY, -28), 45), run(shiftDay(TODAY, 1), 45)] })).toEqual({ state: 'unavailable', reason: 'no_readings' });
  });

  it('is unavailable, never a reading, when the last seven days hold no reading at all', () => {
    // Three ordinary weeks, then a week with the watch off: an empty week is not a change in load.
    expect(trainingLoad({ throughDay: TODAY, observedDays: CHRONIC, workouts: CHRONIC.map(day => run(day, 45)) })).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
  });

  it('counts a workout day as observed even when the caller did not list it', () => {
    const workouts = steady(day => run(day, 45));
    expect(trainingLoad({ throughDay: TODAY, observedDays: [], workouts })).toMatchObject({ state: 'available', phrase: 'about usual' });
  });

  it('reads a first load against a usual of rest as much heavier, and no load against rest as about usual', () => {
    expect(trainingLoad({ throughDay: TODAY, observedDays: ALL, workouts: [run(TODAY, 30)] })).toMatchObject({ phrase: 'much heavier than usual' });
    expect(trainingLoad({ throughDay: TODAY, observedDays: ALL, workouts: [run(CHRONIC[0]!, 0)] })).toMatchObject({ phrase: 'about usual' });
  });

  it('holds no digit and no load figure in what it returns', () => {
    const result = trainingLoad({ throughDay: TODAY, observedDays: ALL, workouts: steady(day => zoned(day, [300, 900, 1500, 600, 180])) });
    expect(JSON.stringify(result).replace(TRAINING_LOAD_VERSION, '')).not.toMatch(/[0-9]/);
  });
});
