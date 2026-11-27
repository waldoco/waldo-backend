import { z } from 'zod';
import { fromRowZone } from '../../../contracts/src/health/zone-bridge';
import type { TurnLogEntry } from '../channels/owner-turn-types';
import { localIso } from '../channels/reminders';
import { shiftDay } from '../health/scores/time';
import { DAY_CARDS } from '../prompt/day-cards';
import { applyClaimOps, fittingLines, profileLine, sourceClaimOps, statedReading, withoutHealthClaims, type ClaimStore, type OutcomesPolicy } from './claims';
import { heldTopicsOf, holdsIn } from './forget-guard';

// The learning loop: what Waldo did on its own initiative and what became of it. Cards it suggested and what the owner decided,
// follow-ups it set itself and how they closed, day cards and update cards it sent unasked and when the owner next wrote. The
// nightly pass reads what ended since its own mark, and the model may add patterns across them as Waldo's own reads, which
// every later turn sees as correctable context. Rows are read where they live, never copied; nothing here stores a health value.
// A row drawn from outside content (a card raised by a run that read it, a follow-up opened from mail, an update card, a day
// card written after reading mail) goes to the model apart from Waldo's own rows, its adds stay untrusted, and the body never
// sits beside it. With the body read (MEMORY_BODY_PATTERNS, only while the owner shares health with memory), each of Waldo's
// own rows also gives the owner's Recovery and Form zone words on the day it ended and the next, so a pattern may say how the
// body tended to respond. Words only: no score reaches the model.
export const OUTCOMES_THROUGH_KEY = 'nightly_outcomes_through_v1';
// The ids of the claims this pass wrote from Waldo's own rows: ids only, so a claim the owner corrects, dismisses or forgets
// leaves the reads by its own status.
export const OUTCOME_CLAIMS_KEY = 'nightly_outcome_claims_v1';
const ROWS_PER_READ = 200;
const DAY_MS = 24 * 60 * 60_000;
// What the reads section may take of a turn's prompt.
const OUTCOME_READS_CHARS = 1_500;

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
const UPDATE_RATED = { useful: 'the owner marked it useful', 'not useful': 'the owner marked it not useful' } as const;
const OWNER_SPEAKERS = ['owner', 'owner_said', 'owner_said_answering_outside', 'quoted'] as const;

// source message: a day card Waldo sent unasked (label names it); update: an update card. ownerNext: when the owner next wrote
// to Waldo after a message, or null when they have not since.
export type OutcomeRow = Readonly<{
  source: 'card' | 'loop' | 'message' | 'update'; status: string | null; text: string; created_at: number; at: number; outside: boolean;
  label?: string; ownerNext?: number | null;
}>;
export type OutcomeBook = Readonly<{ endedAfter(at: number, limit: number): readonly OutcomeRow[] }>;

type Sql = Pick<SqlStorage, 'exec'>;
const tableExists = (sql: Sql, name: string): boolean =>
  sql.exec('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?', 'table', name).toArray().length > 0;
const hasColumn = (sql: Sql, table: string, column: string): boolean =>
  sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().some(row => row.name === column);
const cardName = (id: string): string => DAY_CARDS.find(card => card.id === id)?.name ?? id;

// Read only: the approval desk, the loop book, the day plan, the update cards and the chat index own their tables, and an owner
// object that never made one has nothing to read there.
export const outcomeBook = (sql: Sql): OutcomeBook => {
  const ownerNext = (after: number): number | null => !tableExists(sql, 'episodes') ? null
    : sql.exec<{ at: number | null }>(`SELECT MIN(CAST(at AS INTEGER)) AS at FROM episodes WHERE speaker IN (${OWNER_SPEAKERS.map(() => '?').join(', ')}) AND CAST(at AS INTEGER) > ?`, ...OWNER_SPEAKERS, after).one().at;
  // A delivered day card's words as the chat holds them now, so a forget or a deleted chat takes them with it.
  const sent = (entryId: string): Readonly<{ text: string; outside: boolean }> | null => {
    if (!tableExists(sql, 'episodes')) return null;
    const rows = sql.exec<{ speaker: string; text: string }>("SELECT speaker, text FROM episodes WHERE entry_id = ? AND speaker IN ('waldo', 'waldo_read_outside') ORDER BY rowid", entryId).toArray();
    return rows.length ? { text: rows.map(row => row.text).join('\n'), outside: rows.some(row => row.speaker === 'waldo_read_outside') } : null;
  };
  return {
    endedAfter(at, limit) {
      // A card with no mark of where it came from is read as the desk reads it: as one that may quote outside content.
      const cards = !tableExists(sql, 'ledger') ? [] : sql.exec<{ status: string; text: string; created_at: number; at: number; outside: number }>(
        `SELECT status, summary AS text, created_at, decided_at AS at, ${hasColumn(sql, 'ledger', 'raised_outside') ? 'COALESCE(raised_outside, 1)' : '1'} AS outside FROM ledger
          WHERE decided_at > ? AND status IN (${Object.keys(CARD_ENDED).map(() => '?').join(', ')}) ORDER BY decided_at LIMIT ?`, at, ...Object.keys(CARD_ENDED), limit).toArray()
        .map(row => ({ source: 'card' as const, status: row.status, text: row.text, created_at: row.created_at, at: row.at, outside: row.outside !== 0 }));
      const fromMail = tableExists(sql, 'loop_mail_sources');
      const loops = !tableExists(sql, 'loops') ? [] : sql.exec<{ status: string; text: string; created_at: number; at: number; outside: number }>(
        `SELECT status, title AS text, created_at, closed_at AS at, ${fromMail ? 'EXISTS (SELECT 1 FROM loop_mail_sources s WHERE s.loop_id = loops.id)' : '0'} AS outside
          FROM loops WHERE closed_at > ? AND status IN ('done', 'dropped') ORDER BY closed_at LIMIT ?`, at, limit).toArray()
        .map(row => ({ source: 'loop' as const, status: row.status, text: row.text, created_at: row.created_at, at: row.at, outside: row.outside !== 0 }));
      const messages = !tableExists(sql, 'day_plan') || !hasColumn(sql, 'day_plan', 'delivered_at') ? [] : sql.exec<{ card: string; message_id: string; at: number }>(
        'SELECT card, delivered_message_id AS message_id, delivered_at AS at FROM day_plan WHERE delivered_message_id IS NOT NULL AND delivered_at > ? ORDER BY delivered_at LIMIT ?', at, limit).toArray()
        .flatMap(row => {
          const words = sent(row.message_id);
          return words ? [{ source: 'message' as const, status: null, text: words.text, created_at: row.at, at: row.at, outside: words.outside, label: cardName(row.card), ownerNext: ownerNext(row.at) }] : [];
        });
      // An update card is written from calendar and mail changes, so it is always outside content.
      const updates = !tableExists(sql, 'update_cards') || !hasColumn(sql, 'update_cards', 'delivered_at') ? [] : sql.exec<{ text: string | null; at: number; feedback: string | null }>(
        'SELECT text, delivered_at AS at, feedback FROM update_cards WHERE delivered_at > ? AND text IS NOT NULL ORDER BY delivered_at LIMIT ?', at, limit).toArray()
        .map(row => ({ source: 'update' as const, status: row.feedback, text: row.text ?? '', created_at: row.at, at: row.at, outside: true, ownerNext: ownerNext(row.at) }));
      return [...cards, ...loops, ...messages, ...updates].sort((a, b) => a.at - b.at).slice(0, limit);
    },
  };
};

// The zones read answers a window of at most 31 days, so the body is read for the newest outcomes' days only.
const ZONE_WINDOW_DAYS = 31;
const zonesAnswer = z.object({ zones: z.object({ days: z.array(z.object({ day: z.string(), recovery: z.string().nullable(), form: z.string().nullable() })) }) });
type DayZones = Readonly<{ recovery: string | null; form: string | null }>;
const zoneWords = (raw: { recovery: string | null; form: string | null }): DayZones => ({ recovery: fromRowZone('recovery', raw.recovery), form: fromRowZone('form', raw.form) });
const said = (zones: DayZones | undefined): string | null => {
  const words = [zones?.recovery ? `Recovery ${zones.recovery}` : null, zones?.form ? `Form ${zones.form}` : null].filter(Boolean);
  return words.length ? words.join(', ') : null;
};
// The owner's body around one outcome, in zone words: the day it ended and the day after. Null when neither day has a zone.
const bodyLine = (day: string, zones: ReadonlyMap<string, DayZones>): string | null => {
  const that = said(zones.get(day)), next = said(zones.get(shiftDay(day, 1)));
  if (!that && !next) return null;
  return `The owner's body: ${[that ? `that day ${that}` : null, next ? `the next day ${next}` : null].filter(Boolean).join('; ')}.`;
};
const readBody = async (rows: readonly OutcomeRow[], deps: OutcomesDeps, trace: string): Promise<ReadonlyMap<string, DayZones> | null> => {
  if (!deps.readZones || !deps.health) return null;
  const today = localIso(deps.now(), deps.timezone).slice(0, 10);
  const earliest = localIso(rows[0]!.at, deps.timezone).slice(0, 10), floor = shiftDay(today, 1 - ZONE_WINDOW_DAYS);
  try {
    const answer = zonesAnswer.safeParse(await deps.readZones(earliest > floor ? earliest : floor, today));
    if (!answer.success) throw new Error('zones answer of another shape');
    return new Map(answer.data.zones.days.map(row => [row.day, zoneWords(row)]));
  } catch (error) {
    // The outcomes are read without the body; a pattern about the body waits for a night the read answers.
    deps.log({ trace, hop: 'nightly_memory', ms: 0, ok: false, code: 'body_unread', error: error instanceof Error ? error.name : 'error' });
    return null;
  }
};

const nextWrote = (row: OutcomeRow, timezone: string, now: number): string =>
  row.ownerNext ? `The owner next wrote to Waldo at ${localIso(row.ownerNext, timezone)}.` : `The owner has not written to Waldo since (as of ${localIso(now, timezone)}).`;
const outcomeLine = (row: OutcomeRow, timezone: string, now: number, body: ReadonlyMap<string, DayZones> | null): string => {
  const when = (at: number) => `[${localIso(at, timezone)}]`;
  const after = body && !row.outside ? bodyLine(localIso(row.at, timezone).slice(0, 10), body) : null;
  const lines = row.source === 'card' ? [`${when(row.created_at)} Waldo suggested: ${row.text}`, `${when(row.at)} Then ${CARD_ENDED[row.status as keyof typeof CARD_ENDED]}.`]
    : row.source === 'loop' ? [`${when(row.created_at)} Waldo set itself to follow up on: ${row.text}`, `${when(row.at)} Then ${LOOP_ENDED[row.status as keyof typeof LOOP_ENDED]}.`]
    : row.source === 'message' ? [`${when(row.at)} Waldo sent the owner its day card "${row.label}" unasked:`, row.text, nextWrote(row, timezone, now)]
    : [`${when(row.at)} Waldo sent the owner an update unasked:`, row.text, ...(row.status && row.status in UPDATE_RATED ? [`Then ${UPDATE_RATED[row.status as keyof typeof UPDATE_RATED]}.`] : []), nextWrote(row, timezone, now)];
  return [...lines, ...(after ? [after] : [])].join('\n');
};

const textKey = (text: unknown) => typeof text === 'string' ? text.trim().toLowerCase() : '';
const addedTexts = (ops: string): string[] => (JSON.parse(ops) as { add: { text?: unknown }[] }).add.map(claim => textKey(claim.text));
const withoutAdds = (ops: string, texts: ReadonlySet<string>): string => {
  const parsed = JSON.parse(ops) as { add: { text?: unknown }[] };
  return JSON.stringify({ ...parsed, add: parsed.add.filter(claim => !texts.has(textKey(claim.text))) });
};

export type OutcomesDeps = Readonly<{
  kv: Pick<SyncKvStorage, 'get' | 'put'>;
  outcomes: OutcomeBook;
  claims: ClaimStore;
  transaction: <T>(work: () => T) => T;
  timezone: string;
  now: () => number;
  health: boolean;
  // The owner's zone words for each day from..to, as waldo.health_zones_read answers. Given only with MEMORY_BODY_PATTERNS on.
  readZones?: (from: string, to: string) => Promise<unknown>;
  // One model call over a group of outcome lines (outcomesInput with the policy); its reply is applied here.
  ask: (outcomes: string, policy: OutcomesPolicy) => Promise<string>;
  log: (entry: TurnLogEntry) => void;
}>;

// One read a night. The model calls run outside any transaction; the adds of both groups and the mark commit together, and a
// pass moves the mark only from where it read it, so two passes over the same rows write once. A failed call writes nothing.
export const consolidateOutcomes = async (deps: OutcomesDeps, trace: string): Promise<'empty' | 'consolidated' | 'failed' | 'raced'> => {
  const stored = deps.kv.get<number>(OUTCOMES_THROUGH_KEY);
  const through = stored ?? deps.now() - 7 * DAY_MS;
  if (stored === undefined) deps.kv.put(OUTCOMES_THROUGH_KEY, through);
  const rows = deps.outcomes.endedAfter(through, ROWS_PER_READ);
  if (!rows.length) return 'empty';
  const last = rows[rows.length - 1]!.at;
  const held = holdsIn(heldTopicsOf(deps.claims));
  const kept = rows.filter(row => !held(row.text));
  const own = kept.filter(row => !row.outside), outside = kept.filter(row => row.outside);
  const settle = () => {
    if (deps.kv.get<number>(OUTCOMES_THROUGH_KEY) !== through) return false;
    deps.kv.put(OUTCOMES_THROUGH_KEY, last);
    return true;
  };
  const raced = () => { deps.log({ trace, hop: 'nightly_memory', ms: 0, ok: true, code: 'raced', detail: 'outcome rows taken by another pass' }); return 'raced' as const; };
  if (!kept.length) return deps.transaction(settle) ? 'consolidated' : raced();
  const started = deps.now();
  try {
    const body = own.length ? await readBody(own, deps, trace) : null;
    const ownLines = own.map(row => outcomeLine(row, deps.timezone, started, body)).join('\n');
    const outsideLines = outside.map(row => outcomeLine(row, deps.timezone, started, null)).join('\n');
    const reply = async (lines: string, policy: OutcomesPolicy) => {
      const ops = sourceClaimOps(await deps.ask(lines, policy));
      return deps.health ? ops : withoutHealthClaims(ops);
    };
    const ownOps = own.length ? await reply(ownLines, { health: deps.health, body: body !== null, outside: false }) : null;
    const outsideReply = outside.length ? await reply(outsideLines, { health: deps.health, body: false, outside: true }) : null;
    // The two calls read memory before either writes, so a pattern both groups show is kept once, as Waldo's own read.
    const ownTexts = new Set(ownOps ? addedTexts(ownOps) : []);
    const outsideOps = outsideReply && ownTexts.size ? withoutAdds(outsideReply, ownTexts) : outsideReply;
    const at = new Date(deps.now()).toISOString();
    const detail = deps.transaction(() => {
      if (!settle()) return null;
      const before = new Set(deps.claims.claims().map(claim => claim.id));
      // Waldo's own rows ground in no one's words: what the pass adds from them is Waldo's own read (origin agent).
      const ownDetail = ownOps ? applyClaimOps(deps.claims, ownOps, at, `Waldo's own outcomes, ${trace}`, undefined, { outside: false }, false) : null;
      const added = deps.claims.claims().filter(claim => !before.has(claim.id)).map(claim => claim.id);
      if (added.length) {
        const live = new Set(deps.claims.claims().map(claim => claim.id));
        deps.kv.put(OUTCOME_CLAIMS_KEY, [...(deps.kv.get<number[]>(OUTCOME_CLAIMS_KEY) ?? []).filter(id => live.has(id)), ...added]);
      }
      const outsideDetail = outsideOps ? applyClaimOps(deps.claims, outsideOps, at, `Waldo's outcomes from outside content, ${trace}`, undefined, { shared: outsideLines, outside: true }, false) : null;
      return [ownDetail ? `own ${ownDetail}` : null, outsideDetail ? `outside ${outsideDetail}` : null].filter(Boolean).join('; ');
    });
    if (detail === null) return raced();
    deps.log({ trace, hop: 'nightly_memory', ms: deps.now() - started, ok: true, detail: `outcome rows; ${detail}` });
    return 'consolidated';
  } catch (error) {
    deps.log({ trace, hop: 'nightly_memory', ms: deps.now() - started, ok: false, code: 'provider_error', error: error instanceof Error ? error.name : 'error' });
    return 'failed';
  }
};

// What every later turn reads of the pass: the claims it wrote from Waldo's own rows that are still live, newest first, by id
// so the model can correct one with remember. Health notes stay out, since this section also reaches jobs built from outside
// content (the owner's own turns still recall them), and so does a claim the owner asked Waldo to bring up less.
export const outcomeReadsSection = (store: ClaimStore, ids: readonly number[] | undefined, maxChars = OUTCOME_READS_CHARS): string => {
  const wanted = new Set(ids ?? []);
  if (!wanted.size) return '';
  const reads = store.claims().filter(claim => wanted.has(claim.id) && claim.kind !== 'health' && !statedReading(claim) && !claim.bring_up_less_at).sort((a, b) => b.id - a.id);
  const lines = fittingLines(reads.map(profileLine), maxChars);
  return lines.length ? ['What Waldo has learned from how the owner answered its own suggestions and messages. These are Waldo\'s reads, not the owner\'s words and not rules: today may differ, and the owner can correct or remove any of them.', ...lines].join('\n') : '';
};
