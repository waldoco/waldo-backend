import { applyClaimOps, sourceClaimOps, withoutHealthClaims, type ClaimStore } from '../memory/claims';
import { heldTopicsOf, holdsIn } from '../memory/forget-guard';
import type { TurnLogEntry } from './owner-turn-types';
import { localIso } from './reminders';
import { changeLines, type UpdateBook } from './update-cards';

// The nightly pass's read of the calendar and mail changes the update sweep recorded, behind MEMORY_NIGHTLY_SOURCE_UPDATES.
// It keeps its own mark and never folds a row, so the day cards still read every change they would have. A change carrying a
// topic an unfinished forget still holds never reaches the model; a finished forget is a content-free barrier, enforced at
// admission as for every writer. The model call runs outside any transaction; the adds and the mark then commit together, so
// a stop before the commit writes nothing and the next run reads the same rows, and one after it never reads them again.
export const NIGHTLY_SOURCES_THROUGH_KEY = 'nightly_sources_through_v1';
// A sweep records at most ten new primary-inbox mails (sender, subject, preview) and the calendar changes, each mail line about
// 450 characters. Three calls of 40k characters read about 250 such mails a night; a day busier than that drains over the
// following nights, oldest first.
export const NIGHTLY_SOURCES_CHUNK_CHARS = 40_000;
export const NIGHTLY_SOURCES_CALLS = 3;
const ROWS_PER_READ = 200;
const DAY_MS = 24 * 60 * 60_000;

export type SourcesDeps = Readonly<{
  kv: Pick<SyncKvStorage, 'get' | 'put'>;
  updates: UpdateBook;
  claims: ClaimStore;
  transaction: <T>(work: () => T) => T;
  timezone: string;
  now: () => number;
  health: boolean;
  // One model call over the changes text; its reply is applied here.
  ask: (updates: string) => Promise<string>;
  log: (entry: TurnLogEntry) => void;
}>;

export const consolidateSources = async (deps: SourcesDeps, trace: string): Promise<'empty' | 'consolidated' | 'more' | 'failed'> => {
  const stored = deps.kv.get<number>(NIGHTLY_SOURCES_THROUGH_KEY);
  let through = stored ?? deps.now() - DAY_MS;
  if (stored === undefined) deps.kv.put(NIGHTLY_SOURCES_THROUGH_KEY, through);
  for (let call = 0; call < NIGHTLY_SOURCES_CALLS; call++) {
    const rows = deps.updates.recordedAfter(through, ROWS_PER_READ);
    if (!rows.length) return call ? 'consolidated' : 'empty';
    const held = holdsIn(heldTopicsOf(deps.claims));
    const lines: string[] = [];
    let size = 0, last = through;
    for (const row of rows) {
      const kept = changeLines(row.changes.filter((change) => !held(change.detail))).trim();
      const text = kept ? `[${localIso(row.at, deps.timezone)}]\n${kept}` : '';
      // Whole rows only; a first row over the budget still goes alone, so the mark always moves.
      if (lines.length && size + text.length + 1 > NIGHTLY_SOURCES_CHUNK_CHARS) break;
      if (text) { lines.push(text); size += text.length + 1; }
      last = row.at;
    }
    const settle = (at: number) => deps.kv.put(NIGHTLY_SOURCES_THROUGH_KEY, at);
    if (!lines.length) { settle(last); through = last; continue; }
    const started = deps.now();
    try {
      const updates = lines.join('\n');
      const raw = await deps.ask(updates);
      const ops = deps.health ? sourceClaimOps(raw) : withoutHealthClaims(sourceClaimOps(raw));
      const detail = deps.transaction(() => {
        const applied = applyClaimOps(deps.claims, ops, new Date(deps.now()).toISOString(), `outside content, ${trace}`, undefined, { shared: updates, outside: true }, false);
        settle(last);
        return applied;
      });
      through = last;
      deps.log({ trace, hop: 'nightly_memory', ms: deps.now() - started, ok: true, detail: `source rows; ${detail}` });
    } catch (error) {
      deps.log({ trace, hop: 'nightly_memory', ms: deps.now() - started, ok: false, code: 'provider_error', error: error instanceof Error ? error.name : 'error' });
      return 'failed';
    }
  }
  const behind = deps.updates.recordedAfter(through, 1).length > 0;
  if (behind) deps.log({ trace, hop: 'nightly_memory', ms: 0, ok: true, code: 'backlog', detail: 'source rows left for the next night' });
  return behind ? 'more' : 'consolidated';
};
