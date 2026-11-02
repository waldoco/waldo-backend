import { describe, expect, it } from 'vitest';
import { healthPartKeysV1, healthPartsV1Schema, healthUsualListV1Schema, healthUsualSignalV1Schema, healthUsualV1Schema } from '../../contracts/src/app/health-ingest';
import { computeDailyScores } from '../src/health/scores';
import { PART_ORDER } from '../src/health/scores/parts';
import { USUAL_SIGNALS } from '../src/health/scores/usual';
import type { DailyScores, DailyScoresInput, DayRecord, PartRow, UsualRow } from '../src/health/scores/types';
import { goldenScoreInputs, SYNTHETIC_TARGET, syntheticAddDays, syntheticDay, syntheticInput, syntheticRun, syntheticWobble } from './support/health-golden';

// The parts of each score and the owner's usual bands, from synthetic owners only. They describe the scores and change none.
const provisional = (input: DailyScoresInput, over: Partial<DailyScoresInput> = {}): DailyScores => computeDailyScores({ ...input, provisional: true, ...over });
const withParts = (input: DailyScoresInput, over: Partial<DailyScoresInput> = {}): DailyScores => provisional(input, { parts: true, usual: true, ...over });
const inputs = Object.entries(goldenScoreInputs()).filter(([name]) => name !== 'no_access');
const PILLARS = ['recovery', 'form', 'weight'] as const;
const available = (rows: readonly PartRow[] | undefined) => (rows ?? []).filter((row): row is Extract<PartRow, { state: 'available' }> => row.state === 'available');
const partOf = (scores: DailyScores, pillar: (typeof PILLARS)[number], key: string) => scores.components?.[pillar]?.find(row => row.key === key);
const usualOf = (scores: DailyScores, signal: string): UsualRow | undefined => scores.usual?.find(row => row.signal === signal);

describe('parts and usual change no score', () => {
  it.each(inputs)('%s: every pillar, driver, window and the sleep debt are the same with and without them', (_name, input) => {
    const plain = provisional(input);
    for (const over of [{ parts: true }, { usual: true }, { parts: true, usual: true }]) {
      const { components: _components, usual: _usual, ...rest } = provisional(input, over);
      expect(JSON.stringify(rest), JSON.stringify(over)).toBe(JSON.stringify(plain));
    }
  });
  it.each(inputs)('%s: asks for nothing, answers with nothing, and the earlier engine ignores the ask', (_name, input) => {
    expect(Object.keys(provisional(input))).not.toContain('components');
    expect(Object.keys(provisional(input))).not.toContain('usual');
    expect(JSON.stringify(computeDailyScores({ ...input, parts: true, usual: true }))).toBe(JSON.stringify(computeDailyScores(input)));
    expect(JSON.stringify(computeDailyScores({ ...input, provisional: false, parts: true, usual: true }))).toBe(JSON.stringify(computeDailyScores(input)));
  });
  it('sets the parts and bands beside the pillars, never inside one', () => {
    const scores = withParts(goldenScoreInputs().mature_own_average_need!);
    for (const pillar of PILLARS) expect(Object.keys(scores[pillar])).not.toEqual(expect.arrayContaining(['parts']));
    expect(JSON.stringify(scores.form)).not.toContain('"parts"');
    expect(JSON.stringify(scores.weight)).not.toContain('"usual"');
  });
});

describe('parts add up', () => {
  it.each(inputs)('%s: shares add up to one and points to the pillar\'s score once rounded', (_name, input) => {
    const scores = withParts(input);
    for (const pillar of PILLARS) {
      const result = scores[pillar];
      const rows = available(scores.components?.[pillar]);
      if (result.state !== 'available') { expect(scores.components?.[pillar], pillar).toBeUndefined(); continue; }
      expect(rows.length, pillar).toBeGreaterThan(0);
      expect(rows.reduce((sum, row) => sum + row.share, 0), pillar).toBeCloseTo(1, 4);
      expect(Math.round(rows.reduce((sum, row) => sum + row.points, 0)), pillar).toBe(result.score);
      for (const row of rows) expect(row.points).toBeCloseTo(row.score * row.share, 4);
    }
  });
  it('gives Form\'s night share as Recovery\'s own unrounded basis at 0.4 of Form when every part is there', () => {
    const scores = withParts(goldenScoreInputs().mature_confirmed_need!);
    const recovery = available(scores.components!.recovery);
    const night = partOf(scores, 'form', 'from_the_night') as Extract<PartRow, { state: 'available' }>;
    expect(recovery.reduce((sum, row) => sum + row.points, 0)).toBeCloseTo(night.score, 4);
    expect(night.share).toBeCloseTo(0.4, 6);
    expect(night.direction).toBeNull();
  });
  it('gives the night share its real weight when a Recovery part is missing, not a flat 0.4', () => {
    const days = syntheticRun(25, i => (i === 0 ? { restingHeartRate: [] } : {}));
    const scores = withParts(syntheticInput(days));
    expect(partOf(scores, 'recovery', 'resting_heart_rate')).toEqual({ key: 'resting_heart_rate', state: 'unavailable', reason: 'no_reading' });
    const night = partOf(scores, 'form', 'from_the_night') as Extract<PartRow, { state: 'available' }>;
    const form = available(scores.components!.form);
    const recovery = available(scores.components!.recovery);
    expect(night.share).toBeLessThan(0.4);
    expect(night.share).toBeCloseTo(0.4 * 0.8 / (0.4 * 0.8 + 0.6), 4);
    expect(recovery.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 4);
    expect(Math.round(form.reduce((sum, row) => sum + row.points, 0))).toBe((scores.form as { score: number }).score);
    expect(recovery.reduce((sum, row) => sum + row.points, 0)).toBeCloseTo(night.score, 4);
  });
});

describe('parts: which parts there are, and why one is not', () => {
  it('lists each pillar\'s parts in the contract\'s order, and every key is one the contract names', () => {
    expect(PART_ORDER).toEqual(healthPartKeysV1);
    expect([...USUAL_SIGNALS]).toEqual([...healthUsualSignalV1Schema.options]);
    for (const [, input] of inputs) {
      const scores = withParts(input);
      for (const pillar of PILLARS) {
        const keys = (scores.components?.[pillar] ?? []).map(row => row.key);
        expect(keys).toEqual(PART_ORDER[pillar].filter(key => keys.includes(key)));
      }
    }
  });
  it('validates every part list and band list against the contract', () => {
    for (const [name, input] of inputs) {
      const scores = withParts(input);
      expect(healthPartsV1Schema.safeParse(scores.components ?? {}).success, name).toBe(true);
      expect(healthUsualListV1Schema.safeParse(scores.usual ?? []).success, name).toBe(true);
    }
  });
  it('says no_reading for a part the night or day did not read, and never a zero score', () => {
    const noHrv = withParts(syntheticInput(syntheticRun(25, i => (i === 0 ? { overnightHrv: [] } : {}))));
    expect(partOf(noHrv, 'recovery', 'hrv')).toEqual({ key: 'hrv', state: 'unavailable', reason: 'no_reading' });
    const noDaylight = withParts(syntheticInput(syntheticRun(25, i => (i === 0 ? { hourly: syntheticDay(0).hourly.map(bucket => ({ ...bucket, daylightMinutes: null })) } : {}))));
    expect(partOf(noDaylight, 'form', 'daylight')).toEqual({ key: 'daylight', state: 'unavailable', reason: 'no_reading' });
    const noCalendar = withParts(syntheticInput(syntheticRun(25, i => (i === 0 ? { demand: { meetingMinutes: null, messageCount: null, openTaskMinutes: null, physicalLoad: null } } : {}))));
    expect(partOf(noCalendar, 'weight', 'calendar')).toEqual({ key: 'calendar', state: 'unavailable', reason: 'no_reading' });
    for (const scores of [noHrv, noDaylight, noCalendar]) for (const pillar of PILLARS) for (const row of scores.components?.[pillar] ?? []) if (row.state === 'unavailable') expect(Object.keys(row).sort()).toEqual(['key', 'reason', 'state']);
  });
  it('says baseline_immature for a reading with no baseline to stand on yet', () => {
    // SDNN has no prior, so five earlier days give it none; four earlier midpoints are under the seven a part without a prior needs.
    const days = syntheticRun(25, i => ({
      ...(i >= 6 ? { overnightHrv: [] } : { overnightHrv: [{ value: 40 + syntheticWobble(i, 5), method: 'sdnn' as const }] }),
      ...(i >= 1 && i <= 20 ? { sleep: null } : {}),
    }));
    const scores = withParts(syntheticInput(days, { sleepNeedMinutes: 480 }));
    expect(partOf(scores, 'recovery', 'hrv')).toEqual({ key: 'hrv', state: 'unavailable', reason: 'baseline_immature' });
    expect(partOf(scores, 'form', 'sleep_midpoint')).toEqual({ key: 'sleep_midpoint', state: 'unavailable', reason: 'baseline_immature' });
    expect(usualOf(scores, 'sleep_midpoint')).toBeUndefined();
    expect(usualOf(scores, 'overnight_hrv')).toBeUndefined();
  });
  it('keeps tasks and messages out unless they have a reading', () => {
    const scores = withParts(goldenScoreInputs().no_calendar!);
    expect((scores.components?.weight ?? []).map(row => row.key)).not.toContain('tasks');
    expect((scores.components?.weight ?? []).map(row => row.key)).not.toContain('messages');
  });
  it('gives a pillar that is not available no parts at all', () => {
    const scores = withParts(goldenScoreInputs().missing_target_sleep!);
    expect(scores.recovery.state).toBe('unavailable');
    expect(scores.components?.recovery).toBeUndefined();
  });
});

describe('parts: direction describes the reading against the owner\'s usual', () => {
  const heavyDay = (daylight: number, movement: number) => syntheticRun(25, i => (i === 0
    ? { hourly: syntheticDay(0).hourly.map(bucket => ({ ...bucket, daylightMinutes: daylight, movementMinutes: movement })) } : {}));
  it('takes the sign from the reading, not from the score: far above and far below usual score the same', () => {
    const high = withParts(syntheticInput(heavyDay(55, 40))), low = withParts(syntheticInput(heavyDay(0.5, 1)));
    for (const key of ['daylight', 'movement']) {
      const [up, down] = [partOf(high, 'form', key), partOf(low, 'form', key)] as [Extract<PartRow, { state: 'available' }>, Extract<PartRow, { state: 'available' }>];
      expect(up.direction, key).toBe('above_usual');
      expect(down.direction, key).toBe('below_usual');
      expect(up.score, key).toBeCloseTo(down.score, 6);
    }
  });
  it('reads a higher-is-better part and a lower-is-better part the same way: the reading against usual', () => {
    const base = syntheticRun(25);
    const high = (over: Partial<DayRecord>) => withParts(syntheticInput(base.map((day, i) => (i === 0 ? { ...day, ...over } : day))));
    const slept = high({ overnightHrv: [{ value: 200, method: 'rmssd' }], restingHeartRate: [{ value: 90, method: 'provider_resting_daily' }] });
    expect((partOf(slept, 'recovery', 'hrv') as { direction: string }).direction).toBe('above_usual');
    expect((partOf(slept, 'recovery', 'resting_heart_rate') as { direction: string }).direction).toBe('above_usual');
    const rested = high({ overnightHrv: [{ value: 20, method: 'rmssd' }], restingHeartRate: [{ value: 40, method: 'provider_resting_daily' }] });
    expect((partOf(rested, 'recovery', 'hrv') as { direction: string }).direction).toBe('below_usual');
    expect((partOf(rested, 'recovery', 'resting_heart_rate') as { direction: string }).direction).toBe('below_usual');
  });
  it('gives no direction to the sleep part, which is read against a need, nor to the night share', () => {
    const scores = withParts(goldenScoreInputs().mature_confirmed_need!);
    expect((partOf(scores, 'recovery', 'sleep') as { direction: unknown }).direction).toBeNull();
    expect((partOf(scores, 'form', 'from_the_night') as { direction: unknown }).direction).toBeNull();
  });
  it('gives stress the heart-rate reading\'s direction, matching the stress heart rate band', () => {
    const hot = syntheticRun(25, i => (i === 0 ? { hourly: syntheticDay(0).hourly.map(bucket => ({ ...bucket, heartRate: 110 })) } : {}));
    const scores = withParts(syntheticInput(hot));
    expect(partOf(scores, 'form', 'stress')).toMatchObject({ direction: 'above_usual', signals: ['stress_heart_rate'] });
    expect(usualOf(scores, 'stress_heart_rate')?.centre).toBeLessThan(110);
  });
});

describe('parts: what each stands on', () => {
  it('carries the stated sleep need as owner_confirmed with no baseline under it', () => {
    const part = partOf(withParts(goldenScoreInputs().mature_confirmed_need!), 'recovery', 'sleep');
    expect(part).toMatchObject({ need_minutes: 480, need_basis: 'owner_confirmed', baseline: null, direction: null, signals: [] });
  });
  it('carries a need taken from the owner\'s nights as blended_average, standing on the nights it has', () => {
    const part = partOf(withParts(goldenScoreInputs().mature_own_average_need!), 'recovery', 'sleep') as Extract<PartRow, { state: 'available' }>;
    expect(part.need_basis).toBe('blended_average');
    expect(part.need_minutes).toBeGreaterThanOrEqual(360);
    expect(part.need_minutes).toBeLessThanOrEqual(600);
    expect(part.baseline).toEqual({ state: 'personal', own_days: 29, own_share: expect.closeTo(29 / (14 + 29), 5) });
  });
  it('is personal from fourteen own days and provisional before, by the count and not by how much a prior carries', () => {
    const at = (nights: number) => withParts(syntheticInput(syntheticRun(nights), { sleepNeedMinutes: null }));
    const thirteen = partOf(at(14), 'recovery', 'hrv') as Extract<PartRow, { state: 'available' }>;
    const fourteen = partOf(at(15), 'recovery', 'hrv') as Extract<PartRow, { state: 'available' }>;
    expect(thirteen.baseline).toMatchObject({ state: 'provisional', own_days: 13 });
    expect(fourteen.baseline).toMatchObject({ state: 'personal', own_days: 14 });
    const band = (nights: number) => usualOf(at(nights), 'overnight_hrv')!;
    expect(band(14)).toMatchObject({ state: 'provisional', own_days: 13 });
    expect(band(15)).toMatchObject({ state: 'personal', own_days: 14 });
    // A part with no prior is all the owner's from its seventh day, and is still not personal until its fourteenth.
    const movement = usualOf(at(10), 'movement')!;
    expect(movement).toMatchObject({ state: 'provisional', own_days: 9, own_share: 1 });
  });
});

describe('usual: bands', () => {
  const scores = withParts(goldenScoreInputs().mature_own_average_need!);
  it('is one band per signal in the contract\'s order, the owner\'s own days at the contract\'s window', () => {
    const order = scores.usual!.map(band => band.signal);
    expect(order).toEqual(USUAL_SIGNALS.filter(signal => order.includes(signal)));
    expect(new Set(order).size).toBe(order.length);
    for (const band of scores.usual!) {
      expect(healthUsualV1Schema.safeParse(band).success, band.signal).toBe(true);
      expect(band.window_days).toBe(30);
    }
  });
  it('backs the score components with the estimate that scored them and every other signal with the plain mean and spread', () => {
    const shrunk = ['overnight_hrv', 'resting_heart_rate', 'sleep_midpoint', 'daylight', 'movement', 'stress_heart_rate'];
    for (const band of scores.usual!) expect(band.estimator, band.signal).toBe(shrunk.includes(band.signal) ? 'shrunk_predictive' : 'own_mean_sd');
    expect(scores.usual!.map(band => band.signal)).toEqual(expect.arrayContaining([...shrunk, 'breathing_rate', 'spo2', 'wrist_temperature', 'awake_time', 'walking_heart_rate', 'active_energy']));
  });
  it('does not emit what no producer read gives it: steps and VO2 max', () => {
    expect(scores.usual!.map(band => band.signal)).not.toContain('steps');
    expect(scores.usual!.map(band => band.signal)).not.toContain('vo2_max');
  });
  it('back-transforms the natural-log band, so it is not symmetric about its centre', () => {
    const hrv = usualOf(scores, 'overnight_hrv')!;
    expect(hrv.centre - hrv.low).toBeLessThan(hrv.high - hrv.centre);
    expect(hrv.low).toBeGreaterThan(0);
  });
  it('keeps one method\'s band on its own days: SDNN gets an SDNN band, with no population prior behind it', () => {
    const sdnn = withParts(goldenScoreInputs().sdnn_only!);
    expect(usualOf(sdnn, 'overnight_hrv')).toMatchObject({ method: 'sdnn', own_share: 1, estimator: 'shrunk_predictive' });
    expect(usualOf(scores, 'overnight_hrv')).toMatchObject({ method: 'rmssd' });
    expect(usualOf(scores, 'overnight_hrv')!.own_share).toBeLessThan(1);
  });
  it('shows a band for a reading the day took and none for one it did not', () => {
    const none = withParts(syntheticInput(syntheticRun(25, i => (i === 0 ? { overnightHrv: [], vitals: { breathingRate: null, bloodOxygen: null, wristTemperature: [], awakeMinutes: null, walkingHeartRate: null } } : {}))));
    for (const signal of ['overnight_hrv', 'breathing_rate', 'spo2', 'wrist_temperature', 'awake_time', 'walking_heart_rate']) expect(usualOf(none, signal), signal).toBeUndefined();
    expect(usualOf(none, 'resting_heart_rate')).toBeDefined();
  });
  it('gives a band no lower than nothing to a reading that cannot be less', () => {
    const quiet = withParts(syntheticInput(syntheticRun(25, i => ({ hourly: syntheticDay(i).hourly.map((bucket, h) => ({ ...bucket, movementMinutes: h % 2 ? 0.5 : 40, daylightMinutes: h % 2 ? 0 : 55 })) }))));
    for (const signal of ['movement', 'daylight']) expect(usualOf(quiet, signal)!.low, signal).toBeGreaterThanOrEqual(0);
  });
  it('writes whole-looking numbers: at most four decimals', () => {
    for (const band of scores.usual!) for (const value of [band.low, band.centre, band.high]) expect(Math.abs(value * 10_000 - Math.round(value * 10_000)), band.signal).toBeLessThan(1e-6);
  });
  it('is the same band on yesterday\'s row as it would have been computed on that day', () => {
    const days = syntheticRun(30);
    const yesterday = syntheticAddDays(SYNTHETIC_TARGET, -1);
    const direct = withParts(syntheticInput(days.filter(day => day.day <= yesterday), { targetDay: yesterday }));
    const viaToday = withParts(syntheticInput(days, { targetDay: yesterday }));
    expect(viaToday.usual).toEqual(direct.usual);
  });
});

describe('usual: the sleep midpoint band', () => {
  const nights = (centre: number, spread: number) => syntheticRun(25, i => ({
    sleep: { ...syntheticDay(i).sleep!, midpointMinute: (centre + syntheticWobble(i, spread) + 1440) % 1440 },
  }));
  it('crosses midnight when the owner sleeps around it, with the centre inside the band', () => {
    const scores = withParts(syntheticInput(nights(1438, 25).map((day, i) => (i === 0 ? { ...day, sleep: { ...day.sleep!, midpointMinute: 1436 } } : day))));
    const band = usualOf(scores, 'sleep_midpoint')!;
    expect(band.low).toBeGreaterThan(band.high);
    expect(band.centre >= band.low || band.centre <= band.high).toBe(true);
    expect(healthUsualV1Schema.safeParse(band).success).toBe(true);
    for (const value of [band.low, band.centre, band.high]) expect(value).toBeLessThan(1440);
  });
  it('stays in order when the owner sleeps in the middle of the night, with nothing wrapped', () => {
    const band = usualOf(withParts(syntheticInput(nights(180, 15))), 'sleep_midpoint')!;
    expect(band.low).toBeLessThanOrEqual(band.centre);
    expect(band.centre).toBeLessThanOrEqual(band.high);
  });
  it('gives no band when the owner\'s midpoints point nowhere: opposite sides of the clock', () => {
    const opposed = syntheticRun(25, i => ({ sleep: { ...syntheticDay(i).sleep!, midpointMinute: i % 2 ? 0 : 720 } }));
    const scores = withParts(syntheticInput(opposed));
    expect(usualOf(scores, 'sleep_midpoint')).toBeUndefined();
    expect(partOf(scores, 'form', 'sleep_midpoint')).toEqual({ key: 'sleep_midpoint', state: 'unavailable', reason: 'baseline_immature' });
  });
});

describe('usual: a band and a driver phrase for one signal never disagree', () => {
  const SUBJECT = { breathing_rate: 'breathing rate', spo2: 'blood oxygen', awake_time: 'awake time in the night', walking_heart_rate: 'walking heart rate', wrist_temperature: 'wrist temperature' } as const;
  type Field = 'breathingRate' | 'bloodOxygen' | 'awakeMinutes' | 'walkingHeartRate';
  const FIELD: Readonly<Record<string, Field>> = { breathing_rate: 'breathingRate', spo2: 'bloodOxygen', awake_time: 'awakeMinutes', walking_heart_rate: 'walkingHeartRate' };
  // History alternating a low and a high value gives a mean and a population spread that are exact, so the band edges are exact.
  const ownerWith = (signal: keyof typeof SUBJECT, past: (i: number) => number, today: number) => syntheticInput(syntheticRun(31, i => {
    const base = syntheticDay(i).vitals!;
    const value = i === 0 ? today : past(i);
    return { vitals: signal === 'wrist_temperature' ? { ...base, wristTemperature: [{ value, method: 'absolute' as const }] } : { ...base, [FIELD[signal]!]: value } };
  }));
  const phrases = (scores: DailyScores, signal: keyof typeof SUBJECT) => scores.drivers.filter(driver => driver.startsWith(SUBJECT[signal]));
  it.each(Object.keys(SUBJECT) as (keyof typeof SUBJECT)[])('%s: a value inside the band has no phrase; at either edge or beyond it has one', signal => {
    const past = (i: number) => (i % 2 ? 9 : 11);
    const at = (today: number) => withParts(ownerWith(signal, past, today));
    const band = usualOf(at(10), signal)!;
    expect(band).toMatchObject({ low: 9, centre: 10, high: 11, estimator: 'own_mean_sd', state: 'personal' });
    for (const inside of [9.001, 9.5, 10, 10.5, 10.999]) expect(phrases(at(inside), signal), `${signal} ${inside}`).toEqual([]);
    for (const outside of [8.999, 9, 11, 11.001, 14, 5]) expect(phrases(at(outside), signal).length, `${signal} ${outside}`).toBe(1);
  });
  it('agrees across many histories: inside the band exactly when no phrase is raised', () => {
    let seed = 7;
    const next = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
    let inside = 0, outside = 0;
    for (let trial = 0; trial < 80; trial++) {
      const spread = 0.5 + next() * 3, centre = 50 + next() * 40;
      const past = Array.from({ length: 30 }, () => centre + (next() - 0.5) * 2 * spread);
      const today = centre + (next() * 5 - 2.5) * spread;
      const scores = withParts(ownerWith('breathing_rate', i => past[i - 1]!, today));
      const band = usualOf(scores, 'breathing_rate')!;
      expect(band, `trial ${trial}`).toBeDefined();
      // The band is rounded to four decimals: a value that close to an edge is the boundary test's, not this one's.
      if (Math.min(Math.abs(today - band.low), Math.abs(today - band.high)) < 1e-3) continue;
      const within = band.low < today && today < band.high;
      expect(phrases(scores, 'breathing_rate').length === 0, `trial ${trial}`).toBe(within);
      if (within) inside++; else outside++;
    }
    expect(inside).toBeGreaterThan(10);
    expect(outside).toBeGreaterThan(10);
  });
  it('gives wrist temperature the method that has a range, absolute first, and its band the same method', () => {
    const delta = syntheticInput(syntheticRun(31, i => ({ vitals: { ...syntheticDay(i).vitals!, wristTemperature: [{ value: i % 2 ? -0.3 : 0.3, method: 'baseline_delta' as const }] } })));
    const band = usualOf(withParts(delta), 'wrist_temperature')!;
    expect(band.method).toBe('baseline_delta');
    const both = syntheticInput(syntheticRun(31, i => ({ vitals: { ...syntheticDay(i).vitals!, wristTemperature: [{ value: i % 2 ? 33.5 : 34.5, method: 'absolute' as const }, { value: i % 2 ? -0.3 : 0.3, method: 'baseline_delta' as const }] } })));
    expect(usualOf(withParts(both), 'wrist_temperature')!.method).toBe('absolute');
  });
  it('has no band, as no phrase, when the days never varied or fewer than fourteen of them are the owner\'s', () => {
    const flat = withParts(ownerWith('breathing_rate', () => 14, 14));
    expect(usualOf(flat, 'breathing_rate')).toBeUndefined();
    expect(phrases(flat, 'breathing_rate')).toEqual([]);
    const young = withParts(syntheticInput(syntheticRun(14, i => ({ vitals: { ...syntheticDay(i).vitals!, breathingRate: 12 + (i % 3) } }))));
    expect(usualOf(young, 'breathing_rate')).toBeUndefined();
    expect(young.drivers.filter(driver => driver.startsWith('breathing'))).toEqual([]);
  });
});

describe('a part and the band it links to say the same thing', () => {
  const inside = (value: number, band: UsualRow, wrapping = false): boolean => (wrapping && band.low > band.high ? value > band.low || value < band.high : band.low < value && value < band.high);
  const near = (value: number, band: UsualRow) => [band.low, band.high].some(edge => Math.abs(value - edge) < 1e-3 * Math.max(1, Math.abs(edge)));
  const todayOf = (input: DailyScoresInput): DayRecord => input.days.find(entry => entry.day === input.targetDay)!;
  const readings = (input: DailyScoresInput, scores: DailyScores): { part: string; value: number; band: UsualRow; wrapping: boolean }[] => {
    const record = todayOf(input);
    const hrv = usualOf(scores, 'overnight_hrv'), resting = usualOf(scores, 'resting_heart_rate'), midpoint = usualOf(scores, 'sleep_midpoint');
    return [
      ...(hrv ? [{ part: 'hrv', value: record.overnightHrv.find(entry => entry.method === hrv.method)!.value, band: hrv, wrapping: false }] : []),
      ...(resting ? [{ part: 'resting_heart_rate', value: record.restingHeartRate.find(entry => entry.method === resting.method)!.value, band: resting, wrapping: false }] : []),
      ...(midpoint && record.sleep ? [{ part: 'sleep_midpoint', value: record.sleep.midpointMinute, band: midpoint, wrapping: true }] : []),
    ];
  };
  const variants: [string, DailyScoresInput][] = [
    ...inputs,
    ['hrv far above', syntheticInput(syntheticRun(25, i => (i === 0 ? { overnightHrv: [{ value: 200, method: 'rmssd' }] } : {})))],
    ['hrv far below', syntheticInput(syntheticRun(25, i => (i === 0 ? { overnightHrv: [{ value: 15, method: 'rmssd' }] } : {})))],
    ['resting far above', syntheticInput(syntheticRun(25, i => (i === 0 ? { restingHeartRate: [{ value: 95, method: 'provider_resting_daily' }] } : {})))],
    ['midpoint late', syntheticInput(syntheticRun(25, i => (i === 0 ? { sleep: { ...syntheticDay(0).sleep!, midpointMinute: 400 } } : {})))],
  ];
  it.each(variants)('%s: a reading inside the band has the direction usual, and one outside has one away from it', (_name, input) => {
    const scores = withParts(input);
    for (const { part, value, band, wrapping } of readings(input, scores)) {
      if (near(value, band)) continue;
      const row = (part === 'sleep_midpoint' ? partOf(scores, 'form', part) : partOf(scores, 'recovery', part)) as Extract<PartRow, { state: 'available' }> | undefined;
      if (!row) continue;
      expect(row.direction === 'usual', `${part} ${value} in ${band.low}..${band.high}`).toBe(inside(value, band, wrapping));
    }
  });
  it.each(variants)('%s: a part links only to bands of the same statistic as its own direction', (_name, input) => {
    const scores = withParts(input);
    for (const pillar of PILLARS) for (const part of available(scores.components?.[pillar])) for (const signal of part.signals) {
      expect(usualOf(scores, signal), `${pillar}.${part.key} -> ${signal}`).toBeDefined();
      expect(usualOf(scores, signal)!.estimator, `${pillar}.${part.key} -> ${signal}`).toBe('shrunk_predictive');
    }
  });
  it('gives the physical-load part no link, since its band is the plain mean and spread and its direction is not', () => {
    const load = partOf(withParts(goldenScoreInputs().mature_own_average_need!), 'weight', 'physical_load') as Extract<PartRow, { state: 'available' }>;
    expect(load.signals).toEqual([]);
  });
});

// The parts and bands as the engine wrote them for synthetic owners, pinned so a drift in any number shows as a diff.
describe('parts and usual: golden vectors', async () => {
  const golden = (await import('./fixtures/health-parts-golden.json')).default as { scores: Record<string, string> };
  it.each(Object.keys(golden.scores))('%s is written exactly as pinned', name => {
    const scores = withParts(goldenScoreInputs()[name]!);
    expect(JSON.stringify({ components: scores.components, usual: scores.usual })).toBe(golden.scores[name]);
  });
});
