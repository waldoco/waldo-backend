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
// The instant a local day starts. Two passes settle the offset around a transition.
const localMidnight = (day: string, timeZone: string): number => {
  const wall = Date.parse(`${day}T00:00:00Z`);
  let guess = wall - offsetMinutes(wall, timeZone) * 60_000;
  guess = wall - offsetMinutes(guess, timeZone) * 60_000;
  return guess;
};
export const localDayWindow = (day: string, timeZone: string): Readonly<{ start: number; end: number }> =>
  ({ start: localMidnight(day, timeZone), end: localMidnight(shiftDay(day, 1), timeZone) });
export const isTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};
