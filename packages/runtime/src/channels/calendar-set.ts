import type { CalendarListItem } from '../connectors/google';

// The calendars the owner reads, for GOOGLE_REALTIME_TRIAGE: the same set Weight reads (selected and not hidden), less the
// ones whose events cannot be listed (free/busy only). The primary calendar is kept by its 'primary' alias, so its cursor and
// channel stay one through a reconnect. Watch upkeep refreshes the set; until it has, only the primary calendar is read.
type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void }>;
const KEY = 'realtime_calendars_v1';
export const MAX_READ_CALENDARS = 20;
const LISTABLE: ReadonlySet<CalendarListItem['access_role']> = new Set(['reader', 'writer', 'owner', 'writerWithoutPrivateAccess']);

export const readableCalendars = (items: readonly CalendarListItem[]): readonly string[] => {
  const read = items.filter(item => item.selected && !item.hidden && LISTABLE.has(item.access_role));
  const others = read.filter(item => !item.primary).map(item => item.id);
  return ['primary', ...others].slice(0, MAX_READ_CALENDARS);
};

export const calendarSet = (kv: Kv) => ({
  calendars: (): readonly string[] => {
    const stored = kv.get<unknown>(KEY);
    return Array.isArray(stored) && stored.length && stored.every(id => typeof id === 'string') ? stored as string[] : ['primary'];
  },
  set: (ids: readonly string[]) => kv.put(KEY, ids.length ? [...ids] : ['primary']),
});
export type CalendarSet = ReturnType<typeof calendarSet>;
