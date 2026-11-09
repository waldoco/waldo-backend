const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const isDay = (value: string): boolean => DAY_PATTERN.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
export const shiftDay = (day: string, offset: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (earlier: string, later: string): number => Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / DAY_MS);

const offsetMinutes = (instantMs: number, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / 60_000);
};
// The first instant of a local day. Midnight is read under the offsets either side of any transition near it; where the
// clock skips midnight (Santiago, Havana), neither reads back as 00:00 and the day starts at the jump itself.
const localMidnight = (day: string, timeZone: string): number => {
  const wall = Date.parse(`${day}T00:00:00Z`);
  const before = offsetMinutes(wall - DAY_MS, timeZone), after = offsetMinutes(wall + DAY_MS, timeZone);
  const midnights = [...new Set([before, after])].map(offset => wall - offset * 60_000)
    .filter(instant => instant + offsetMinutes(instant, timeZone) * 60_000 === wall);
  if (midnights.length) return Math.min(...midnights);
  let lo = wall - after * 60_000, hi = wall - before * 60_000;
  while (hi - lo > 1000) {
    const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
    if (offsetMinutes(mid, timeZone) === after) hi = mid; else lo = mid;
  }
  return hi;
};
export const localDayWindow = (day: string, timeZone: string): Readonly<{ start: number; end: number }> =>
  ({ start: localMidnight(day, timeZone), end: localMidnight(shiftDay(day, 1), timeZone) });
// Minutes past midnight on the local wall clock, so 15:00 is 900 on a 23- or 25-hour day as on any other.
export const wallMinute = (instantMs: number, timeZone: string): number => {
  const local = instantMs + offsetMinutes(instantMs, timeZone) * 60_000;
  return Math.floor((((local % DAY_MS) + DAY_MS) % DAY_MS) / 60_000);
};
export const isTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};
