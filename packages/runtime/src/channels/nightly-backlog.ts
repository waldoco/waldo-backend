import { consolidationDay, NIGHTLY_CHUNK_ATTEMPTS, NIGHTLY_CHUNK_CHARS, NIGHTLY_CHUNKS, NIGHTLY_DAILY_CALLS, NIGHTLY_QUARANTINE_AFTER_MS, NIGHTLY_THROUGH_KEY, type Episode, type EpisodeIndex } from './episodes';
import type { TurnLogEntry } from './owner-turn-types';
import { localIso } from './reminders';

// Turns a pass withheld while a forget was finishing, retried once they no longer carry a held topic (the purge redacted them,
// or the forget finished). Each names its index row and is checked against it, because a deleted row's id can be reused.
const WITHHELD_KEY = 'nightly_withheld_v1';
// The chunk that keeps failing, per lane: where it starts, how much it reads now, and since when it has failed.
const FAILURES_KEY = 'nightly_failures_v1';
// Consolidation calls made on the owner's local date, every attempt counted.
const CALLS_KEY = 'nightly_calls_v1';

type Withheld = Readonly<{ row: number; at: number; entry: string }>;
type Failure = Readonly<{ key: string; budget: number; attempts: number; failed: number; first: number }>;
type Lane = Readonly<{
  name: 'backlog' | 'withheld';
  read(budget: number): readonly Episode[];
  key(rows: readonly Episode[]): string;
  // The rows cannot be split further: one time group of the backlog, or a single withheld turn.
  single(rows: readonly Episode[]): boolean;
  settle(rows: readonly Episode[]): void;
}>;
type Kv = Pick<SyncKvStorage, 'get' | 'put'>;

export type BacklogDeps = Readonly<{
  kv: Kv;
  episodes: EpisodeIndex;
  timezone: string;
  now: () => number;
  // The held-topic test as it stands now; asked again for each chunk, since a forget can settle mid-pass.
  held: () => (text: string) => boolean;
  consolidate: (day: readonly Episode[]) => Promise<Readonly<{ done: boolean; detail: string }>>;
  log: (entry: TurnLogEntry) => void;
}>;

const capped = (log: BacklogDeps['log'], trace: string) => {
  log({ trace, hop: 'nightly_memory', ms: 0, ok: true, code: 'call_cap', detail: `${NIGHTLY_DAILY_CALLS} calls today; the next night resumes` });
  return 'capped' as const;
};

// One pass over what is not yet consolidated, oldest first, at most NIGHTLY_CHUNKS calls: first the backlog behind the mark,
// then withheld turns that no longer carry a held topic. A chunk that fails is halved for the next attempt, until it is one
// time group (one turn alone, for the withheld list); that group is skipped, with a Patrol line, only after it has failed
// NIGHTLY_CHUNK_ATTEMPTS times over more than NIGHTLY_QUARANTINE_AFTER_MS, so an outage never drops a turn. A pass stops at its
// first failure: the provider breaker is shared with the owner's turns, and the scheduler's retries and the next night carry
// the halving on. A success reads whole chunks again. A failed withheld retry never holds the mark back.
// 'more' asks for a catch-up soon; 'capped' means the local day's calls are spent and the next night resumes.
export const consolidateBacklog = async (deps: BacklogDeps, trace: string, at: number): Promise<'done' | 'more' | 'failed' | 'capped'> => {
  const { kv, episodes, log } = deps;
  const dayMs = 24 * 60 * 60_000;
  let through = kv.get<number>(NIGHTLY_THROUGH_KEY) ?? at - dayMs;
  const withheld = () => kv.get<Withheld[]>(WITHHELD_KEY) ?? [];
  const backlog: Lane = {
    name: 'backlog',
    read: budget => episodes.after(through, budget),
    key: () => String(through),
    single: rows => rows.every(row => row.at === rows[0]!.at),
    settle: rows => { through = rows.at(-1)!.at; kv.put(NIGHTLY_THROUGH_KEY, through); },
  };
  const retries: Lane = {
    name: 'withheld',
    read: budget => {
      const held = deps.held(), kept: Withheld[] = [], ready: Episode[] = [];
      let total = 0;
      for (const entry of withheld()) {
        const row = episodes.get(String(entry.row));
        if (!row || row.at !== entry.at || row.entry_id !== entry.entry) continue;
        kept.push(entry);
        if (held(row.text) || (ready.length > 0 && total + row.text.length > budget)) continue;
        ready.push({ ...row, row: entry.row }); total += row.text.length;
      }
      if (kept.length !== withheld().length) kv.put(WITHHELD_KEY, kept);
      return ready;
    },
    key: rows => String(rows[0]!.row),
    single: rows => rows.length === 1,
    settle: rows => kv.put(WITHHELD_KEY, withheld().filter(entry => !rows.some(row => row.row === entry.row))),
  };
  const today = () => localIso(deps.now(), deps.timezone).slice(0, 10);
  const spend = (): boolean => {
    const spent = kv.get<{ day: string; calls: number }>(CALLS_KEY);
    const calls = spent?.day === today() ? spent.calls : 0;
    if (calls >= NIGHTLY_DAILY_CALLS) return false;
    kv.put(CALLS_KEY, { day: today(), calls: calls + 1 });
    return true;
  };

  const step = async (lane: Lane, chunk: number): Promise<'empty' | 'consolidated' | 'failed' | 'capped'> => {
    const failures = kv.get<Partial<Record<Lane['name'], Failure>>>(FAILURES_KEY) ?? {};
    const record = (failure: Failure | undefined) => kv.put(FAILURES_KEY, { ...failures, [lane.name]: failure });
    let rows = lane.read(NIGHTLY_CHUNK_CHARS);
    if (rows.length === 0) return 'empty';
    const failure = failures[lane.name]?.key === lane.key(rows) ? failures[lane.name] : undefined;
    if (failure && failure.budget < NIGHTLY_CHUNK_CHARS) rows = lane.read(failure.budget);
    if (lane === backlog && chunk === 0) {
      // How far behind consolidation is, from the oldest turn not yet consolidated (quiet days are not a backlog), in whole days only.
      const behind = Math.floor((at - rows[0]!.at) / dayMs);
      if (behind > 1) log({ trace, hop: 'nightly_memory', ms: 0, ok: true, code: 'backlog', detail: `${behind} days behind` });
    }
    const held = deps.held();
    const turns = consolidationDay(rows), day = turns.filter(episode => !held(episode.text)), kept = turns.length - day.length;
    const withheldNote = kept ? `, ${kept} withheld while a forget finishes` : '';
    // Moves past the rows; the turns this pass withheld wait on the retry list.
    const settle = () => {
      lane.settle(rows);
      const waiting = turns.filter(row => held(row.text) && row.row !== undefined).map(row => ({ row: row.row!, at: row.at, entry: row.entry_id }));
      if (waiting.length) kv.put(WITHHELD_KEY, [...withheld(), ...waiting]);
      record(undefined);
    };
    if (day.length === 0) {
      if (kept) log({ trace, hop: 'nightly_memory', ms: 0, ok: true, detail: `0 turns${withheldNote}` });
      settle();
      return 'consolidated';
    }
    if (!spend()) return 'capped';
    const started = deps.now();
    try {
      const { done, detail } = await deps.consolidate(day);
      log({ trace, hop: 'nightly_memory', ms: deps.now() - started, ok: done, detail: `${day.length} turns${withheldNote}; ${detail}` });
      if (done) { settle(); return 'consolidated'; }
    } catch (error) {
      log({ trace, hop: 'nightly_memory', ms: deps.now() - started, ok: false, error: String(error), code: 'provider_error' });
    }
    const failed = (failure?.failed ?? 0) + 1, first = failure?.first ?? deps.now();
    if (!lane.single(rows)) {
      // Half the turns, by the characters they hold, so the next attempt reads about half as many.
      const half = rows.slice(0, Math.ceil(rows.length / 2)).reduce((sum, row) => sum + row.text.length, 0);
      record({ key: lane.key(rows), budget: Math.max(1, half), attempts: 0, failed, first });
      return 'failed';
    }
    const attempts = (failure?.attempts ?? 0) + 1;
    if (attempts < NIGHTLY_CHUNK_ATTEMPTS || deps.now() - first < NIGHTLY_QUARANTINE_AFTER_MS) {
      record({ key: lane.key(rows), budget: failure?.budget ?? NIGHTLY_CHUNK_CHARS, attempts, failed, first });
      return 'failed';
    }
    settle();
    log({ trace, hop: 'nightly_memory', ms: 0, ok: false, code: 'chunk_quarantined', detail: `${day.length} turn${day.length === 1 ? '' : 's'} skipped after ${failed} failed attempts` });
    return 'consolidated';
  };

  let chunk = 0;
  for (; chunk < NIGHTLY_CHUNKS; chunk += 1) {
    const outcome = await step(backlog, chunk);
    if (outcome === 'empty') { if (chunk === 0) log({ trace, hop: 'nightly_memory', ms: 0, ok: true, detail: 'quiet day' }); break; }
    if (outcome === 'capped') return capped(log, trace);
    if (outcome === 'failed') return 'failed';
  }
  let retried: Awaited<ReturnType<typeof step>> = 'empty';
  for (; chunk < NIGHTLY_CHUNKS; chunk += 1) {
    retried = await step(retries, chunk);
    if (retried === 'capped') return capped(log, trace);
    if (retried === 'empty' || retried === 'failed') break;
  }
  return episodes.after(through, 0).length > 0 || (retried === 'empty' || retried === 'consolidated') && retries.read(1).length > 0 ? 'more' : 'done';
};
