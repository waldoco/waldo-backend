import type { CompactionFlush } from '../conversation/compaction';
import type { Claim } from '../memory/claims';
import { consolidationDay, consolidationSides, transcript, type EpisodeIndex } from './episodes';

type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void; delete(key: string): boolean }>;

// Whether memory Waldo writes on its own (the flush before older chat leaves its view, and the nightly pass) keeps health
// notes: how the owner says they feel and what tends to affect it, in words. On unless the owner turns it off; a note the
// owner asks Waldo to remember is theirs to ask for either way.
export const HEALTH_MEMORY_KEY = 'health_memory_v1';
export const healthMemoryOn = (kv: Pick<Kv, 'get'>): boolean => kv.get<boolean>(HEALTH_MEMORY_KEY) !== false;
export const setHealthMemory = (kv: Kv, value: string): boolean => {
  if (value !== 'on' && value !== 'off') return false;
  kv.put(HEALTH_MEMORY_KEY, value === 'on');
  return true;
};

// Health notes saved on Waldo's own since the owner last heard about them. Ids only: the next reply reads each note from
// memory then, so a note forgotten or corrected in between is never named in its old words.
export const HEALTH_SAVED_KEY = 'health_memory_saved_v1';
const KEPT = 50;
const NAMED = 5;
export const noteHealthSaved = (kv: Kv, ids: readonly number[]): void => {
  if (!ids.length) return;
  const waiting = kv.get<number[]>(HEALTH_SAVED_KEY) ?? [];
  kv.put(HEALTH_SAVED_KEY, [...new Set([...waiting, ...ids])].slice(-KEPT));
};

// One line naming each waiting note that is still in memory, and how to correct, forget or stop them; null when nothing
// that waits is still there. The notes it names stop waiting only when taken, once the reply carrying the line is saved,
// so a run that closes first names them next time; a note saved after the line was read keeps waiting.
export type HealthNotice = Readonly<{ line: string; taken(): void }>;
export const healthNotice = (kv: Kv, active: () => readonly Pick<Claim, 'id' | 'text'>[]): HealthNotice | null => {
  const waiting = kv.get<number[]>(HEALTH_SAVED_KEY);
  if (!waiting?.length) return null;
  const taken = () => {
    const rest = (kv.get<number[]>(HEALTH_SAVED_KEY) ?? []).filter((id) => !waiting.includes(id));
    if (rest.length) kv.put(HEALTH_SAVED_KEY, rest);
    else kv.delete(HEALTH_SAVED_KEY);
  };
  const byId = new Map(active().map((claim) => [claim.id, claim.text]));
  const saved = waiting.filter((id) => byId.has(id));
  if (!saved.length) { taken(); return null; }
  const named = saved.slice(0, NAMED).map((id) => `"${byId.get(id)}" (c${id})`).join('; ');
  const more = saved.length > NAMED ? `; and ${saved.length - NAMED} more` : '';
  return { line: `Saved to memory from our earlier chat: ${named}${more}. Tell me to correct or forget any of it, or turn health notes off in your settings.`, taken };
};

// Before older chat leaves the model's view, what the owner said there is kept as memory, read from the episode rows of the
// span: the owner's own words split from what they quoted, as the nightly pass reads them. The rows are bounded like a
// nightly chunk; rows past it wait for the nightly pass, which reads the same rows. Health notes kept this way are named
// to the owner in their next reply.
export const FLUSH_SPAN_CHARS = 40_000;
export const memoryFlushHooks = (deps: Readonly<{ kv: Kv; episodes: Pick<EpisodeIndex, 'of'>; claims: () => readonly Pick<Claim, 'id' | 'text'>[]; timezone: () => string }>) => ({
  compactionFlush: (async (span, keep) => {
    const day = consolidationDay(deps.episodes.of(span.entryIds, FLUSH_SPAN_CHARS));
    if (!day.length) return;
    const saved = await keep.save(transcript(day, deps.timezone()), consolidationSides(day), { health: healthMemoryOn(deps.kv) });
    noteHealthSaved(deps.kv, saved.filter((claim) => claim.kind === 'health').map((claim) => claim.id));
  }) satisfies CompactionFlush,
  memoryNotice: () => healthNotice(deps.kv, deps.claims),
});
