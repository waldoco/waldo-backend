// People read "2 hours ago" faster than a timestamp; the exact time stays one hover away (see `exactTime`).
export function relativeTime(iso: string, now: Date = new Date()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 'time unavailable';
  const minutes = Math.round((now.getTime() - at) / 60000);
  const future = minutes < 0, m = Math.abs(minutes);
  const say = (n: number, unit: string) => future ? `in ${n} ${unit}${n === 1 ? '' : 's'}` : `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (m < 1) return 'just now';
  if (m < 60) return say(m, 'minute');
  if (m < 60 * 24) return say(Math.round(m / 60), 'hour');
  if (m < 60 * 24 * 7) return say(Math.round(m / 1440), 'day');
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(at));
}
export function exactTime(iso: string, zone?: string): string {
  try { return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', ...(zone ? { timeZone: zone } : {}) }).format(new Date(iso)); } catch { return 'Time unavailable'; }
}
