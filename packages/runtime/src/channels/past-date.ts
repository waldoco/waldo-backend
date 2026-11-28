import { localIso } from './reminders';

// How long ago a time passed, in words the model reads beside an item, so it can tell an item that is over from one still
// ahead. A fact, not a rule: whether a passed item is done, moved or still wanted is the model's call. '' while the time is
// ahead, or when it cannot be read.
const ago = (minutes: number): string => {
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  if (minutes < 60) return 'passed less than an hour ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `passed ${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `passed ${days} day${days === 1 ? '' : 's'} ago`;
};

// An instant (epoch ms).
export const passedSince = (then: number, now: number): string => ago((now - then) / 60_000);

// A date or date-time on the owner's local clock, as loops and quests store it (2026-11-16 or 2026-11-16T09:30). A date alone
// has passed once its day is over.
export const passedLocal = (at: string, now: number, timezone: string): string => {
  const local = localIso(now, timezone);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(at);
  if (!date && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(at)) return '';
  const then = Date.parse(date ? `${at}T00:00:00Z` : `${at.slice(0, 16)}:00Z`) + (date ? 86_400_000 : 0);
  const minutes = (Date.parse(`${local.slice(0, 16)}:00Z`) - then) / 60_000;
  if (!date) return ago(minutes);
  // A whole day: counted in days, from the day after it.
  return Number.isFinite(minutes) && minutes >= 0 ? (minutes < 1_440 ? 'passed yesterday' : ago(minutes + 1_440)) : '';
};

// The item's date with what passed beside it: "due 2026-11-16 09:30, passed 3 days ago".
export const withPassed = (label: string, at: string, now: number, timezone: string): string => {
  const passed = passedLocal(at, now, timezone);
  return `${label} ${at.replace('T', ' ')}${passed ? `, ${passed}` : ''}`;
};
