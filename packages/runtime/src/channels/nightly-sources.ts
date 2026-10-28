import type { ClaimStore } from '../memory/claims';
import { heldTopicsOf, holdsIn } from '../memory/forget-guard';
import type { TurnLogEntry } from './owner-turn-types';
import { localIso } from './reminders';
import { changeLines, type UpdateBook } from './update-cards';

// The nightly pass's read of the calendar and mail changes the update sweep recorded, behind NIGHTLY_SOURCE_UPDATES. It keeps
// its own mark and never folds a row, so the day cards still read every change they would have. A change carrying a topic an
// unfinished forget still holds never reaches the model; a finished forget is a content-free barrier, enforced at admission as
// for every writer. The first pass starts a day back and stores that mark, so a failed call keeps it and the next night reads
// the same rows.
export const NIGHTLY_SOURCES_THROUGH_KEY = 'nightly_sources_through_v1';
const NIGHTLY_SOURCES_ROWS = 50;
const DAY_MS = 24 * 60 * 60_000;

export type SourcesDeps = Readonly<{
  kv: Pick<SyncKvStorage, 'get' | 'put'>;
  updates: UpdateBook;
  claims: ClaimStore;
  timezone: string;
  now: () => number;
  consolidate: (updates: string) => Promise<Readonly<{ done: boolean; detail: string }>>;
  log: (entry: TurnLogEntry) => void;
}>;

export const consolidateSources = async (deps: SourcesDeps, trace: string): Promise<'empty' | 'consolidated' | 'failed'> => {
  const stored = deps.kv.get<number>(NIGHTLY_SOURCES_THROUGH_KEY), through = stored ?? deps.now() - DAY_MS;
  if (stored === undefined) deps.kv.put(NIGHTLY_SOURCES_THROUGH_KEY, through);
  const rows = deps.updates.recordedAfter(through, NIGHTLY_SOURCES_ROWS);
  if (!rows.length) return 'empty';
  const held = holdsIn(heldTopicsOf(deps.claims));
  const text = rows.map((row) => {
    const lines = changeLines(row.changes.filter((change) => !held(change.detail))).trim();
    return lines ? `[${localIso(row.at, deps.timezone)}]\n${lines}` : '';
  }).filter(Boolean).join('\n');
  const settle = () => deps.kv.put(NIGHTLY_SOURCES_THROUGH_KEY, rows.at(-1)!.at);
  if (!text) { settle(); return 'empty'; }
  const started = deps.now();
  try {
    const { done, detail } = await deps.consolidate(text);
    deps.log({ trace, hop: 'nightly_memory', ms: deps.now() - started, ok: done, detail: `${rows.length} source rows; ${detail}` });
    if (done) { settle(); return 'consolidated'; }
  } catch (error) {
    deps.log({ trace, hop: 'nightly_memory', ms: deps.now() - started, ok: false, error: String(error), code: 'provider_error' });
  }
  return 'failed';
};
