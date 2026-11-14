import type { CalendarListItem } from '../connectors/google';

// The switch: exact deltas, every calendar watched, and the triage turn. It builds on the day state; off unless both are '1'.
export const realtimeTriage = (env: Readonly<{ WALDO_DAY_STATE?: string; GOOGLE_REALTIME_TRIAGE?: string }>): boolean =>
  env.WALDO_DAY_STATE === '1' && env.GOOGLE_REALTIME_TRIAGE === '1';

// The calendars the owner reads on each connected account, for GOOGLE_REALTIME_TRIAGE: the same set Weight reads (selected and
// not hidden), less the ones whose events cannot be listed (free/busy only). Each primary calendar is kept by its 'primary'
// alias, so its cursor and channel stay one through a reconnect. Watch upkeep refreshes the set; until it has, an account's
// primary calendar alone is read.
type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void }>;
const KEY = 'realtime_calendars_v1';
export const MAX_READ_CALENDARS = 20;
const LISTABLE: ReadonlySet<CalendarListItem['access_role']> = new Set(['reader', 'writer', 'owner', 'writerWithoutPrivateAccess']);

export const readableCalendars = (items: readonly CalendarListItem[]): readonly string[] => {
  const read = items.filter(item => item.selected && !item.hidden && LISTABLE.has(item.access_role));
  return ['primary', ...read.filter(item => !item.primary).map(item => item.id)];
};

// The cap counts across every account: each account's primary calendar first, then the others in account order.
export const capCalendars = (sets: readonly (readonly [string, readonly string[]])[]): Readonly<Record<string, readonly string[]>> => {
  const kept = new Map(sets.map(([account]) => [account, [] as string[]]));
  let left = MAX_READ_CALENDARS;
  for (const [account, ids] of sets) if (left > 0 && ids.includes('primary')) { kept.get(account)!.push('primary'); left -= 1; }
  for (const [account, ids] of sets) for (const id of ids) if (left > 0 && id !== 'primary') { kept.get(account)!.push(id); left -= 1; }
  return Object.fromEntries(kept);
};

export const calendarSet = (kv: Kv) => {
  const read = (): Record<string, unknown> => { const stored = kv.get<unknown>(KEY); return typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? stored as Record<string, unknown> : {}; };
  return {
    calendars: (account: string): readonly string[] => {
      const ids = read()[account];
      return Array.isArray(ids) && ids.every(id => typeof id === 'string') ? ids as string[] : ['primary'];
    },
    // Replaces every account's set at once: an account left out reads its primary calendar alone until upkeep lists it.
    set: (sets: Readonly<Record<string, readonly string[]>>) => kv.put(KEY, sets),
  };
};
export type CalendarSet = ReturnType<typeof calendarSet>;
