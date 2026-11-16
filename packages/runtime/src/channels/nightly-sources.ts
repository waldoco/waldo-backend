import { fromAddress } from '../memory/people';
import { applyClaimOps, knownPeople, OUTSIDE_REF, sourceClaimOps, withoutHealthClaims, type ClaimStore } from '../memory/claims';
import { heldTopicsOf, holdsIn } from '../memory/forget-guard';
import type { TurnLogEntry } from './owner-turn-types';
import { localIso } from './reminders';
import { changeLines, type Change, type UpdateBook } from './update-cards';

// The nightly pass's read of the calendar and mail changes the update sweep recorded, behind MEMORY_NIGHTLY_SOURCE_UPDATES.
// It keeps its own mark and never folds a row, so the day cards still read every change they would have. A change carrying a
// topic an unfinished forget still holds never reaches the model; a finished forget is a content-free barrier, enforced at
// admission as for every writer. The model call runs outside any transaction; the adds and the mark then commit together, so
// a stop before the commit writes nothing and the next run reads the same rows, and one after it never reads them again.
// The nightly run and the daytime pass share the mark, and it is the single writer: a pass moves it only from where it read
// it, so of two passes over the same rows the second to commit writes nothing and returns 'raced'.
export const NIGHTLY_SOURCES_THROUGH_KEY = 'nightly_sources_through_v1';
// A sweep records at most ten new primary-inbox mails (sender, subject, preview) and the calendar changes, each mail line about
// 450 characters. Three calls of 40k characters read about 250 such mails a night; a day busier than that drains over the
// following nights, oldest first.
export const NIGHTLY_SOURCES_CHUNK_CHARS = 40_000;
export const NIGHTLY_SOURCES_CALLS = 3;
const ROWS_PER_READ = 200;
const DAY_MS = 24 * 60 * 60_000;

// A new mail's sender as its From header says, and when it was sent: the mail's own time when it reads as one and is not after
// the sweep saw it, otherwise when the sweep saw it.
const newMail = (change: Change, seenAt: number): { from: string; at: number } | null => {
  if (change.source !== 'mail' || change.kind !== 'new') return null;
  let mail: { from?: unknown; at?: unknown };
  try { mail = JSON.parse(change.detail) as typeof mail; } catch { return null; }
  const sent = typeof mail.at === 'string' ? Date.parse(mail.at) : Number.NaN;
  return typeof mail.from === 'string' ? { from: mail.from, at: Number.isFinite(sent) && sent <= seenAt ? sent : seenAt } : null;
};
// What a note is stored as having come from: the sender and day of a new mail, the day the sweep saw anything else. The
// sender's name is outside text shown in a bracketed tag, so it keeps no bracket or control character.
const changeRef = (change: Change, seenAt: number, timezone: string): string => {
  const mail = newMail(change, seenAt);
  const from = mail?.from.replace(/[[\]\p{Cc}]+/gu, ' ').replace(/ +/g, ' ').trim().slice(0, 120);
  return `${OUTSIDE_REF}${change.source === 'calendar' ? 'calendar change' : from ? `mail from ${from}` : 'mail'}, ${localIso(mail?.at ?? seenAt, timezone).slice(0, 10)}`;
};

export type SourcesDeps = Readonly<{
  kv: Pick<SyncKvStorage, 'get' | 'put'>;
  updates: UpdateBook;
  claims: ClaimStore;
  transaction: <T>(work: () => T) => T;
  timezone: string;
  now: () => number;
  health: boolean;
  // PEOPLE_MAP: the pass may say who a claim is about, and new mail from a person's address is their last contact.
  people?: boolean;
  // One model call over the changes text; its reply is applied here.
  ask: (updates: string) => Promise<string>;
  log: (entry: TurnLogEntry) => void;
}>;

export const consolidateSources = async (deps: SourcesDeps, trace: string, calls = NIGHTLY_SOURCES_CALLS): Promise<'empty' | 'consolidated' | 'more' | 'failed' | 'raced'> => {
  const stored = deps.kv.get<number>(NIGHTLY_SOURCES_THROUGH_KEY);
  let through = stored ?? deps.now() - DAY_MS;
  if (stored === undefined) deps.kv.put(NIGHTLY_SOURCES_THROUGH_KEY, through);
  const raced = () => { deps.log({ trace, hop: 'nightly_memory', ms: 0, ok: true, code: 'raced', detail: 'source rows taken by another pass' }); return 'raced' as const; };
  // Moves the mark from where this pass read it; false when another pass moved it first.
  const settle = (at: number) => {
    if (deps.kv.get<number>(NIGHTLY_SOURCES_THROUGH_KEY) !== through) return false;
    deps.kv.put(NIGHTLY_SOURCES_THROUGH_KEY, at);
    return true;
  };
  for (let call = 0; call < calls; call++) {
    const rows = deps.updates.recordedAfter(through, ROWS_PER_READ);
    if (!rows.length) return call ? 'consolidated' : 'empty';
    const held = holdsIn(heldTopicsOf(deps.claims));
    const lines: string[] = [];
    const parts: { ref: string; text: string }[] = [];
    let size = 0, last = through;
    for (const row of rows) {
      const changes = row.changes.filter((change) => !held(change.detail));
      const kept = changeLines(changes).trim();
      const text = kept ? `[${localIso(row.at, deps.timezone)}]\n${kept}` : '';
      // Whole rows only; a first row over the budget still goes alone, so the mark always moves.
      if (lines.length && size + text.length + 1 > NIGHTLY_SOURCES_CHUNK_CHARS) break;
      if (text) { lines.push(text); size += text.length + 1; parts.push(...changes.map((change) => ({ ref: changeRef(change, row.at, deps.timezone), text: changeLines([change]) }))); }
      last = row.at;
    }
    if (!lines.length) { if (!settle(last)) return raced(); through = last; continue; }
    const started = deps.now();
    try {
      const updates = lines.join('\n');
      const raw = await deps.ask(updates);
      const ops = deps.health ? sourceClaimOps(raw) : withoutHealthClaims(sourceClaimOps(raw));
      const detail = deps.transaction(() => {
        if (!settle(last)) return null;
        const at = new Date(deps.now()).toISOString();
        // The new mail this batch read, not held by a forget: whom each came from, and when.
        const heard = deps.people ? rows.filter((row) => row.at <= last).flatMap((row) => row.changes.filter((change) => !held(change.detail)).flatMap((change) => {
          const mail = newMail(change, row.at);
          const address = mail ? fromAddress(mail.from) : null;
          return mail && address ? [{ address, at: new Date(mail.at).toISOString() }] : [];
        })) : [];
        const scope = deps.people ? { refs: new Set(knownPeople(deps.claims).map((row) => row.id)), addresses: new Set(heard.map((mail) => mail.address)) } : undefined;
        const detail = applyClaimOps(deps.claims, ops, at, `outside content, ${trace}`, undefined, { shared: updates, outside: true, sharedParts: parts }, false, undefined, undefined, undefined, scope);
        for (const mail of heard) deps.claims.people.heardFrom(mail.address, mail.at);
        return detail;
      });
      if (detail === null) return raced();
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
