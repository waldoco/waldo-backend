import type { CompactionFlush } from '../conversation/compaction';
import type { Claim } from '../memory/claims';
import { consolidationDay, consolidationSides, transcript, type EpisodeIndex } from './episodes';

type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void; delete(key: string): boolean }>;

// Whether memory Waldo writes on its own (the flush before older chat leaves its view, the nightly pass and the notes-file
// migration) keeps health notes: what the owner says about their health, readings and goals included. On unless the owner
// turns it off; a note the owner asks Waldo to remember is theirs to ask for either way.
export const HEALTH_MEMORY_KEY = 'health_memory_v1';
export const healthMemoryOn = (kv: Pick<Kv, 'get'>): boolean => kv.get<boolean>(HEALTH_MEMORY_KEY) !== false;
export const setHealthMemory = (kv: Kv, value: string): boolean => {
  if (value !== 'on' && value !== 'off') return false;
  kv.put(HEALTH_MEMORY_KEY, value === 'on');
  return true;
};

// Health notes saved on Waldo's own since the owner last heard about them. Ids only: the next reply checks each is still in
// memory then, so a note forgotten or corrected in between is not counted.
export const HEALTH_SAVED_KEY = 'health_memory_saved_v1';
const KEPT = 50;
const NAMED = 5;
export const noteHealthSaved = (kv: Kv, ids: readonly number[]): void => {
  if (!ids.length) return;
  const waiting = kv.get<number[]>(HEALTH_SAVED_KEY) ?? [];
  kv.put(HEALTH_SAVED_KEY, [...new Set([...waiting, ...ids])].slice(-KEPT));
};

// One line counting up to five waiting notes that are still in memory, and how to change, forget or stop them; null when
// nothing that waits is still there. The owner is told how many, never the notes' words or ids: a quoted note can carry a
// reading they did not ask to see. modelLine is the same line with the ids it counts, for the reply as the model reads it
// back, so "forget that" reaches those claims. The notes it counts stop waiting only when taken, once the reply carrying the
// line is saved, so a run that closes first counts them next time. A note counted only as "more", or saved after the line
// was read, keeps waiting; one no longer in memory stops waiting.
export type HealthNotice = Readonly<{ line: string; modelLine: string; taken(): void }>;
export const healthNotice = (kv: Kv, active: () => readonly Pick<Claim, 'id'>[]): HealthNotice | null => {
  const waiting = kv.get<number[]>(HEALTH_SAVED_KEY);
  if (!waiting?.length) return null;
  const present = new Set(active().map((claim) => claim.id));
  const saved = waiting.filter((id) => present.has(id));
  const named = saved.slice(0, NAMED);
  const done = waiting.filter((id) => !present.has(id) || named.includes(id));
  const taken = () => {
    const rest = (kv.get<number[]>(HEALTH_SAVED_KEY) ?? []).filter((id) => !done.includes(id));
    if (rest.length) kv.put(HEALTH_SAVED_KEY, rest);
    else kv.delete(HEALTH_SAVED_KEY);
  };
  if (!named.length) { taken(); return null; }
  const one = named.length === 1;
  const more = saved.length > NAMED ? `, plus ${saved.length - NAMED} more` : '';
  const line = `I kept ${one ? 'a note' : `${named.length} notes`} about your health from earlier${more}. Say if you want ${one ? 'it' : 'any'} changed or gone, or turn health notes off in settings.`;
  const ids = named.map((id) => `c${id}`).join(', ');
  return { line, modelLine: `${line}\n[Not shown to the owner: the notes are ${ids}. forget_memory takes them as claim_ids; remember takes one as replaces_id.]`, taken };
};

// Before older chat leaves the model's view, what the owner said there is kept as memory, read from the episode rows of the
// span: the owner's own words split from what they quoted, as the nightly pass reads them. The rows are bounded like a
// nightly chunk; rows past it wait for the nightly pass, which reads the same rows. Health notes kept this way are named
// to the owner in their next reply.
// A span whose summary is refused stays in the window and is offered again, grown by any newer rows. Each row is flushed
// once: the conversation's flushed-through mark is the last row of the last span flushed, and only rows after it are saved.
// The mark is written once the save returns, so a flush that fails is tried again.
export const FLUSH_SPAN_CHARS = 40_000;
const FLUSHED_THROUGH_PREFIX = 'memory_flushed_through_v1:';
export const memoryFlushHooks = (deps: Readonly<{ kv: Kv; episodes: Pick<EpisodeIndex, 'of'>; claims: () => readonly Pick<Claim, 'id'>[]; timezone: () => string }>) => ({
  compactionFlush: (async (span, keep) => {
    const day = consolidationDay(deps.episodes.of(span.entryIds, FLUSH_SPAN_CHARS));
    if (!day.length) return;
    const sides = consolidationSides(day);
    const mark = FLUSHED_THROUGH_PREFIX + span.conversationRef;
    const fresh = new Set(span.entryIds.slice(span.entryIds.indexOf(deps.kv.get<string>(mark) ?? '') + 1));
    const unsaved = day.filter((episode) => fresh.has(episode.entry_id));
    if (unsaved.length) {
      const saved = await keep.save(transcript(unsaved, deps.timezone()), consolidationSides(unsaved), { health: healthMemoryOn(deps.kv) });
      deps.kv.put(mark, span.covers.to_id);
      noteHealthSaved(deps.kv, saved.filter((claim) => claim.kind === 'health').map((claim) => claim.id));
    }
    return { owner: sides.owner };
  }) satisfies CompactionFlush,
  memoryNotice: () => healthNotice(deps.kv, deps.claims),
});
