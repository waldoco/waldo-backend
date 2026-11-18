import { toolNameSchema } from '@waldo/contracts';
import { toolsWhere } from './records';

// The tools this owner's model loaded with find_tools, or called by name through use_tool, and when. The next turns offer
// them in the function list, so a tool the model reached for once stays in reach without another search. The set changes
// the cached tool prefix only when it changes, and it is bounded: a tool unused for two weeks drops out, and at most
// LOADED_MAX stay, most recent first. It holds tool names only; the owner object is its one writer.
type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void }>;
const KEY = 'tools_loaded_v1';
export const LOADED_MAX = 12;
export const LOADED_FOR_MS = 14 * 24 * 3_600_000;

const stored = (kv: Kv): Record<string, number> => {
  const raw = kv.get<unknown>(KEY);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([name, at]) => toolNameSchema.safeParse(name).success && typeof at === 'number' && Number.isFinite(at)));
};

export const loadedToolsBook = (kv: Kv) => {
  const recent = (now: number): readonly [string, number][] => Object.entries(stored(kv))
    .filter(([, at]) => now - at < LOADED_FOR_MS).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).slice(0, LOADED_MAX);
  return {
    // Sorted by name, so the same set gives the same tool order whatever order they were loaded in.
    names: (now: number): readonly string[] => recent(now).map(([name]) => name).sort(),
    note: (names: readonly string[], now: number) => {
      const real = names.filter((name) => toolNameSchema.safeParse(name).success);
      if (!real.length) return;
      kv.put(KEY, Object.fromEntries([...recent(now), ...real.map((name) => [name, now] as const)]));
    },
  };
};
export type LoadedToolsBook = ReturnType<typeof loadedToolsBook>;

// Tools whose source this owner has, offered in the function list rather than behind find_tools: the phone tools read what
// the owner's app sends, and the health reads what their shared body data holds. Derived from the records, so a new tool in
// either group joins without a list to keep.
export const PHONE_TOOLS: readonly string[] = [...toolsWhere((record) => record.brain === 'phone')].sort();
export const HEALTH_READ_TOOLS: readonly string[] = [...toolsWhere((record) => record.brain === 'health' && record.claim === null && record.replay.replay === 'safe_read')].sort();
// When a turn last found the owner's derived health row. Only the time is kept, never what the row held.
const HEALTH_SEEN_KEY = 'health_context_seen_at';
const HEALTH_SEEN_FOR_MS = 3 * 24 * 3_600_000;
export const noteHealthShared = (kv: Kv, now: number) => kv.put(HEALTH_SEEN_KEY, now);
export const healthSharedLately = (kv: Kv, now: number): boolean => {
  const at = kv.get<unknown>(HEALTH_SEEN_KEY);
  return typeof at === 'number' && now - at < HEALTH_SEEN_FOR_MS;
};
