import type { TurnLogEntry } from '../channels/owner-turn-types';
import { localIso } from '../channels/reminders';
import { applyClaimOps, sourceClaimOps, withoutHealthClaims, type ClaimStore } from './claims';
import { heldTopicsOf, holdsIn } from './forget-guard';

// The learning loop's first source: what Waldo suggested on a card or set itself to watch as a loop, and what became of it. The
// nightly pass reads the cards decided and the loops closed since its own mark, and the model may add patterns across them
// ("moves to the morning are taken; evening ones are declined") as Waldo's own reads, untrusted until the owner confirms them.
// The rows are read where they live (the approval ledger and the loops table) and never copied; nothing here stores a health
// value. How the body responded is not read yet: a health pattern is new health-pattern persistence and waits for its contract.
export const OUTCOMES_THROUGH_KEY = 'nightly_outcomes_through_v1';
const ROWS_PER_READ = 200;
const DAY_MS = 24 * 60 * 60_000;

// A decided card's end, in words. A card still open, or one whose effect is still running, has no outcome yet.
const CARD_ENDED = {
  done: 'the owner approved it and it was done',
  undone: 'the owner approved it, it was done, then the owner undid it',
  rejected: 'the owner declined it',
  expired: 'it expired with no answer from the owner',
  failed: 'the owner approved it but it could not be done',
  withdrawn: 'Waldo withdrew it before the owner answered',
  skipped: 'it was set aside before the owner answered',
} as const;
const LOOP_ENDED = { done: 'it was finished', dropped: 'the owner no longer wanted it' } as const;

export type OutcomeRow = Readonly<{ source: 'card' | 'loop'; status: string; text: string; created_at: number; at: number }>;
export type OutcomeBook = Readonly<{ endedAfter(at: number, limit: number): readonly OutcomeRow[] }>;

const tableExists = (sql: SqlStorage, name: string): boolean =>
  sql.exec('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?', 'table', name).toArray().length > 0;
// Read only: the approval desk and the loop book own their tables, and an owner object that never made one has nothing to read.
export const outcomeBook = (sql: SqlStorage): OutcomeBook => ({
  endedAfter(at, limit) {
    const cards = tableExists(sql, 'ledger')
      ? sql.exec<OutcomeRow>(`SELECT 'card' AS source, status, summary AS text, created_at, decided_at AS at FROM ledger
          WHERE decided_at > ? AND status IN (${Object.keys(CARD_ENDED).map(() => '?').join(', ')}) ORDER BY decided_at LIMIT ?`, at, ...Object.keys(CARD_ENDED), limit).toArray()
      : [];
    const loops = tableExists(sql, 'loops')
      ? sql.exec<OutcomeRow>("SELECT 'loop' AS source, status, title AS text, created_at, closed_at AS at FROM loops WHERE closed_at > ? AND status IN ('done', 'dropped') ORDER BY closed_at LIMIT ?", at, limit).toArray()
      : [];
    return [...cards, ...loops].sort((a, b) => a.at - b.at).slice(0, limit);
  },
});

const outcomeLine = (row: OutcomeRow, timezone: string): string => {
  const ended = row.source === 'card' ? CARD_ENDED[row.status as keyof typeof CARD_ENDED] : LOOP_ENDED[row.status as keyof typeof LOOP_ENDED];
  const what = row.source === 'card' ? 'Waldo suggested' : 'Waldo set itself to follow up on';
  return `[${localIso(row.created_at, timezone)}] ${what}: ${row.text}\n[${localIso(row.at, timezone)}] Then ${ended}.`;
};

export type OutcomesDeps = Readonly<{
  kv: Pick<SyncKvStorage, 'get' | 'put'>;
  outcomes: OutcomeBook;
  claims: ClaimStore;
  transaction: <T>(work: () => T) => T;
  timezone: string;
  now: () => number;
  health: boolean;
  // One model call over the outcome lines; its reply is applied here.
  ask: (outcomes: string) => Promise<string>;
  log: (entry: TurnLogEntry) => void;
}>;

// One read a night. The model call runs outside any transaction; the adds and the mark commit together, and a pass moves the
// mark only from where it read it, so two passes over the same rows write once.
export const consolidateOutcomes = async (deps: OutcomesDeps, trace: string): Promise<'empty' | 'consolidated' | 'failed' | 'raced'> => {
  const stored = deps.kv.get<number>(OUTCOMES_THROUGH_KEY);
  const through = stored ?? deps.now() - 7 * DAY_MS;
  if (stored === undefined) deps.kv.put(OUTCOMES_THROUGH_KEY, through);
  const rows = deps.outcomes.endedAfter(through, ROWS_PER_READ);
  if (!rows.length) return 'empty';
  const last = rows[rows.length - 1]!.at;
  const held = holdsIn(heldTopicsOf(deps.claims));
  const lines = rows.filter(row => !held(row.text)).map(row => outcomeLine(row, deps.timezone));
  const settle = () => {
    if (deps.kv.get<number>(OUTCOMES_THROUGH_KEY) !== through) return false;
    deps.kv.put(OUTCOMES_THROUGH_KEY, last);
    return true;
  };
  const raced = () => { deps.log({ trace, hop: 'nightly_memory', ms: 0, ok: true, code: 'raced', detail: 'outcome rows taken by another pass' }); return 'raced' as const; };
  if (!lines.length) return deps.transaction(settle) ? 'consolidated' : raced();
  const started = deps.now();
  try {
    const outcomes = lines.join('\n');
    const raw = await deps.ask(outcomes);
    const ops = deps.health ? sourceClaimOps(raw) : withoutHealthClaims(sourceClaimOps(raw));
    const detail = deps.transaction(() => (settle() ? applyClaimOps(deps.claims, ops, new Date(deps.now()).toISOString(), `Waldo's suggestions and what became of them, ${trace}`, undefined, { shared: outcomes, outside: true }, false) : null));
    if (detail === null) return raced();
    deps.log({ trace, hop: 'nightly_memory', ms: deps.now() - started, ok: true, detail: `outcome rows; ${detail}` });
    return 'consolidated';
  } catch (error) {
    deps.log({ trace, hop: 'nightly_memory', ms: deps.now() - started, ok: false, code: 'provider_error', error: error instanceof Error ? error.name : 'error' });
    return 'failed';
  }
};
