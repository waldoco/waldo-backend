import { labelOf } from './baseline';
import { driverRanges, driversOf, SUBJECT_SIGNALS } from './drivers';
import { formScore } from './form';
import { ALGORITHM, PROVISIONAL_ALGORITHM, provisionalRecoveryBasis, recoveryBasis } from './recovery';
import { energyWindows } from './energy-windows';
import { PART_ORDER, groupRows, partRows } from './parts';
import { inUsualOrder, usualOfRange } from './usual';
import { priorDays, sleepDebt } from './sleep-debt';
import { combine } from './stats';
import { isTimeZone, localDayWindow } from './time';
import { recoveryZone } from './zones';
import { activeEnergy, weightScore } from './weight';
import { ownRange } from './drivers';
import type { DailyScores, DailyScoresInput, DayRecord, PartsByPillar, RecoveryResult, Unavailable, UnavailableReason, UsualRow } from './types';

export type { DailyScores, DailyScoresInput, DayRecord, DayVitals, HourlyBucket, PartRow, UnavailableReason, UsualRow } from './types';

const everywhere = (reason: UnavailableReason): DailyScores => {
  const unavailable: Unavailable = { state: 'unavailable', reason };
  return { recovery: unavailable, drivers: [], sleep_debt: unavailable, form: unavailable, weight: unavailable };
};

// A day owns only the hourly readings inside its own local day, in the zone it was read in. That
// is 23 or 25 hours across a clock change, and a day read while travelling keeps its own zone.
const withinLocalDay = (record: DayRecord): DayRecord => {
  const { start, end } = localDayWindow(record.day, record.timezone);
  return { ...record, hourly: record.hourly.filter(bucket => { const at = Date.parse(bucket.startAt); return at >= start && at < end; }) };
};

// One owner, one target day. Pure: no clock, no I/O, same input gives the same output.
export const computeDailyScores = (input: DailyScoresInput): DailyScores => {
  if (input.access !== 'granted') return everywhere(input.access);
  if (input.days.length === 0) return everywhere('no_readings');

  if (input.days.some(record => !isTimeZone(record.timezone))) return everywhere('conflicting_inputs');
  const byDay = new Map<string, DayRecord>();
  for (const raw of input.days) {
    const record = withinLocalDay(raw);
    const existing = byDay.get(record.day);
    if (existing && JSON.stringify(existing) !== JSON.stringify(record)) return everywhere('conflicting_inputs');
    byDay.set(record.day, record);
  }
  const target: DayRecord = byDay.get(input.targetDay)
    ?? { day: input.targetDay, timezone: input.days[0]?.timezone ?? 'UTC', sleep: null, overnightHrv: [], restingHeartRate: [], hourly: [], workouts: [], demand: null };
  const prior = priorDays(input.targetDay, byDay);

  const provisional = input.provisional === true;
  const basis = provisional ? provisionalRecoveryBasis(target, prior, input.sleepNeedMinutes) : recoveryBasis(target, prior, input.sleepNeedMinutes);
  let recovery: RecoveryResult;
  if ('reason' in basis) recovery = { state: 'unavailable', reason: basis.reason };
  else {
    const { score, coverage } = combine(basis.components);
    const used = { signals: basis.signals, days: basis.days };
    recovery = provisional
      ? { state: 'available', score, zone: recoveryZone(score), algorithm_version: PROVISIONAL_ALGORITHM.recovery, activation: 'accepted', coverage, hrv_method: basis.hrvMethod, used, baseline: labelOf(basis.own ?? [], basis.usedPrior === true) }
      : { state: 'available', score, zone: recoveryZone(score), algorithm_version: ALGORITHM.recovery, activation: 'candidate_unaccepted', coverage, hrv_method: basis.hrvMethod, used };
  }
  const debt = sleepDebt(input.targetDay, byDay, prior, input.sleepNeedMinutes, provisional);
  // Asked for, a provisional computation also keeps what each score was made of; none of it changes a score.
  const detail = provisional && (input.parts === true || input.usual === true);
  const form = formScore(target, prior, input.sleepNeedMinutes, input.asOf, provisional, detail);
  const weight = weightScore(target, prior, provisional, detail);
  const scores: DailyScores = {
    recovery,
    drivers: driversOf(target, prior),
    sleep_debt: debt,
    form,
    weight,
    ...(provisional ? { windows: energyWindows({ targetDay: input.targetDay, days: [...byDay.values()], recoveryZone: recovery.state === 'available' ? recovery.zone : null, sleepTrend: debt.state === 'unavailable' ? 'steady' : debt.trend ?? 'steady' }) } : {}),
  };
  if (!detail) return scores;

  // The parts and bands are set beside the pillars, not inside them, so a pillar is the same object with or without them.
  const recoveryRead = 'reason' in basis ? null : basis;
  const components: PartsByPillar = {
    ...(recoveryRead ? { recovery: partRows(PART_ORDER.recovery, recoveryRead.components, recoveryRead.absent ?? new Map()) } : {}),
    ...(form.state === 'available' && form.parts ? { form: form.parts } : {}),
    ...(weight.state === 'available' && weight.parts ? { weight: weight.parts } : {}),
  };
  const groups = groupRows({ ...(components.recovery ? { recovery: components.recovery } : {}), ...(components.form ? { form: components.form } : {}) });
  const componentsWithGroups: PartsByPillar = groups.length ? { ...components, groups } : components;
  const energy = ownRange(target, prior, activeEnergy);
  const usual: UsualRow[] = inUsualOrder([
    ...(recoveryRead?.components.flatMap(component => (component.usual ? [component.usual] : [])) ?? []),
    ...(form.state === 'available' ? form.usual ?? [] : []),
    ...driverRanges(target, prior).map(({ subject, method, range }) => usualOfRange(SUBJECT_SIGNALS[subject], method, range)),
    ...(energy ? [usualOfRange('active_energy', null, energy)] : []),
  ]);
  return {
    ...scores,
    form: withoutDetail(form), weight: withoutDetail(weight),
    ...(input.parts === true && Object.keys(components).length ? { components: componentsWithGroups } : {}),
    ...(input.usual === true && usual.length ? { usual } : {}),
  };
};

const withoutDetail = <P extends DailyScores['form'] | DailyScores['weight']>(pillar: P): P => {
  if (pillar.state !== 'available') return pillar;
  const { parts: _parts, usual: _usual, ...rest } = pillar;
  return rest as P;
};

// The engine the owner's recompute runs, chosen by the HEALTH_PROVISIONAL_SCORES variable: only the exact value "1" turns
// provisional scores on, and anything else is the earlier engine itself.
export const dailyScoresFor = (flag: string | undefined): ((input: DailyScoresInput) => DailyScores) =>
  (flag === '1' ? input => computeDailyScores({ ...input, provisional: true }) : computeDailyScores);
