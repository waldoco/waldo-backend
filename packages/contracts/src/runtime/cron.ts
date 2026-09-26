// 5-field cron recurrence: minute hour day-of-month month day-of-week, evaluated in the
// schedule's IANA timezone. Numeric fields only (no month/weekday names); supports *,
// lists (a,b), ranges (a-b), and steps (*/n, a-b/n, a/n). Day-of-month and day-of-week
// follow the standard cron rule: when both are restricted a day matches either; when one
// is * the other decides. Local times that do not exist (DST gap) advance to the next
// valid minute; repeated local times (DST overlap) fire at the first occurrence.

export type CronSchedule = Readonly<{
  minutes: readonly number[];
  hours: readonly number[];
  daysOfMonth: readonly number[] | null; // null = unrestricted
  months: readonly number[];
  daysOfWeek: readonly number[] | null; // null = unrestricted; 0 and 7 both mean Sunday
}>;

const FIELD_SPECS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
] as const;

function parseField(text: string, min: number, max: number): readonly number[] | null {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const stepSplit = part.split('/');
    if (stepSplit.length > 2) return null;
    const rangeText = stepSplit[0] ?? '';
    const stepText: string | undefined = stepSplit[1];
    let lo: number;
    let hi: number;
    if (rangeText === '*') {
      lo = min;
      hi = max;
    } else if (rangeText === '') {
      return null;
    } else {
      const rangeSplit = rangeText.split('-');
      if (rangeSplit.length > 2) return null;
      lo = Number(rangeSplit[0]);
      hi = rangeSplit.length === 2 ? Number(rangeSplit[1]) : stepText === undefined ? lo : max;
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
      if (lo < min || hi > max || lo > hi) return null;
    }
    let step = 1;
    if (stepText !== undefined) {
      step = Number(stepText);
      if (!Number.isInteger(step) || step <= 0) return null;
    }
    for (let value = lo; value <= hi; value += step) values.add(value);
  }
  if (values.size === 0) return null;
  return [...values].sort((a, b) => a - b);
}

export function parseCronExpression(expression: string): CronSchedule | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const parsed = fields.map((field, index) => {
    const spec = FIELD_SPECS[index];
    if (spec === undefined) return null;
    return parseField(field, spec.min, spec.max);
  });
  if (parsed.some((field) => field === null)) return null;
  const [minutes, hours, daysOfMonthRaw, months, daysOfWeekRaw] = parsed as [
    readonly number[],
    readonly number[],
    readonly number[],
    readonly number[],
    readonly number[],
  ];
  const fullDayOfMonth = daysOfMonthRaw.length === 32 - 1; // 1..31
  const daysOfWeek = daysOfWeekRaw.map((day) => (day === 7 ? 0 : day));
  const fullDayOfWeek = new Set(daysOfWeek).size === 7;
  return {
    minutes,
    hours,
    daysOfMonth: fullDayOfMonth ? null : daysOfMonthRaw,
    months,
    daysOfWeek: fullDayOfWeek ? null : [...new Set(daysOfWeek)].sort((a, b) => a - b),
  };
}

type LocalClock = Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}>;

function localParts(at: number, timezone: string): LocalClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

function dayOfWeek(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addDays(date: { year: number; month: number; day: number }, days: number) {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

// Resolve one local minute on one local date to an epoch ms strictly after `after`.
// Fixed-point offset iteration converges in <=3 Intl calls away from DST transitions.
// Converged but not after `after` means the minute exists and has passed: null.
// No fixed point means a DST gap or overlap; a full-day minute scan then picks the
// first exact occurrence after `after`, or the first valid local minute past the
// target (gap policy, matching daily_local), or null.
function resolveLocalMinute(
  date: { year: number; month: number; day: number },
  hour: number,
  minute: number,
  timezone: string,
  after: number,
): number | null {
  const target = hour * 60 + minute;
  const targetUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  let guess = targetUtc;
  for (let pass = 0; pass < 4; pass += 1) {
    const local = localParts(guess, timezone);
    const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    if (localAsUtc === targetUtc) return guess > after ? guess : null;
    guess += targetUtc - localAsUtc;
  }
  // DST gap/overlap only: scan the whole local day (covers every UTC offset).
  const dayStart = Date.UTC(date.year, date.month - 1, date.day);
  let fallback: number | null = null;
  for (let at = dayStart - 13 * 3_600_000; at < dayStart + 38 * 3_600_000; at += 60_000) {
    if (at <= after) continue;
    const local = localParts(at, timezone);
    if (local.year !== date.year || local.month !== date.month || local.day !== date.day) continue;
    const localMinutes = local.hour * 60 + local.minute;
    if (localMinutes === target) return at;
    if (localMinutes > target) {
      fallback = at;
      break;
    }
  }
  return fallback;
}

function dayMatches(schedule: CronSchedule, year: number, month: number, day: number): boolean {
  if (!schedule.months.includes(month)) return false;
  if (schedule.daysOfMonth === null && schedule.daysOfWeek === null) return true;
  if (schedule.daysOfMonth === null) return schedule.daysOfWeek!.includes(dayOfWeek(year, month, day));
  if (schedule.daysOfWeek === null) return schedule.daysOfMonth.includes(day);
  return (
    schedule.daysOfMonth.includes(day) || schedule.daysOfWeek.includes(dayOfWeek(year, month, day))
  );
}

const MAX_SCAN_DAYS = 366 * 2;

export function nextCronOccurrence(
  schedule: CronSchedule,
  timezone: string,
  after: number,
): number | null {
  const start = localParts(after, timezone);
  let date = { year: start.year, month: start.month, day: start.day };
  for (let scanned = 0; scanned < MAX_SCAN_DAYS; scanned += 1) {
    if (dayMatches(schedule, date.year, date.month, date.day)) {
      const monthDays = daysInMonth(date.year, date.month);
      if (
        schedule.daysOfMonth !== null &&
        !schedule.daysOfMonth.some((d) => d <= monthDays) &&
        schedule.daysOfWeek === null
      ) {
        // e.g. day 31 in a 30-day month: skip the day entirely.
      } else {
        for (const hour of schedule.hours) {
          for (const minute of schedule.minutes) {
            const at = resolveLocalMinute(date, hour, minute, timezone, after);
            if (at !== null) return at;
          }
        }
      }
    }
    date = addDays(date, 1);
  }
  return null;
}
