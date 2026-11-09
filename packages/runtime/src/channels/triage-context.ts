import type { ClaimStore } from '../memory/claims';
import { heldTopicsOf } from '../memory/forget-guard';
import { outsideSafe } from '../memory/outside-view';
import { fromAddress, personAddresses, type PeopleTables, type Person } from '../memory/people';
import { localIso } from './reminders';
import type { ToldBook } from './triage-told';
import type { Change } from './update-cards';

// What the owner did after recent updates and cards, so triage calibrates on more than explicit ratings. Each line is facts the
// code can read (a rating, a Like, a next message, the mail handled, a card's state); what they mean is the model's call.
export type SignalDeps = Readonly<{
  sql: Pick<SqlStorage, 'exec'>; told: Pick<ToldBook, 'recent'>; timezone: string;
  // The owner's app Like or Dislike on a Main chat row.
  rating(appRow: string): 'up' | 'down' | undefined;
  // When the owner next wrote, on any surface, after `at`.
  nextSpoke(at: number): number | null;
}>;
const SIGNAL_TEXT_CHARS = 140;
export const SIGNAL_BATCHES = 6;
const cut = (text: string) => { const line = text.replace(/\s+/g, ' ').trim(); return line.length > SIGNAL_TEXT_CHARS ? `${line.slice(0, SIGNAL_TEXT_CHARS - 1)}…` : line; };
// Each reads after "the owner".
const CARD_STATES: Readonly<Record<string, string>> = {
  done: 'approved the card', running: 'approved the card', skipped: 'skipped the card', expired: 'let the card expire unanswered',
  withdrawn: 'saw the card withdrawn', open: 'has not answered the card yet', card_unconfirmed: 'has not answered the card yet', review_only: 'has not answered the card yet',
};
const tableExists = (sql: SignalDeps['sql'], name: string) => sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;

export const responseSignals = (deps: SignalDeps, limit = SIGNAL_BATCHES): string => {
  const { sql } = deps;
  const ledger = tableExists(sql, 'ledger');
  return deps.told.recent(limit).map(batch => {
    const card = sql.exec<{ text: string | null; delivered_at: number | null; app_row: string | null; feedback: string | null }>(
      'SELECT text, delivered_at, app_row, feedback FROM update_cards WHERE id = ?', batch.update_id).toArray()[0];
    const said = card?.delivered_at ? card.text : null;
    const at = card?.delivered_at ?? batch.at;
    const cards = ledger && batch.cards.length ? sql.exec<{ status: string; summary: string }>(`SELECT status, summary FROM ledger WHERE id IN (${batch.cards.map(() => '?').join(', ')})`, ...batch.cards).toArray() : [];
    // The owner's own handling of the mail it was about, recorded by later reads.
    const handled = batch.messages.length ? [...new Set(sql.exec<{ kind: string }>(`SELECT json_extract(j.value, '$.kind') AS kind FROM update_cards c, json_each(c.changes) j
      WHERE c.at > ? AND json_extract(j.value, '$.kind') IN ('read', 'archived', 'starred') AND json_extract(j.value, '$.ref') IN (${batch.messages.map(() => '?').join(', ')})`,
      at, ...batch.messages.map(id => `message:${id}`)).toArray().map(row => row.kind))] : [];
    const rating = card?.app_row ? deps.rating(card.app_row) : undefined;
    const next = deps.nextSpoke(at);
    const facts = [
      ...(card?.feedback ? [`rated it ${card.feedback}`] : []),
      ...(rating ? [rating === 'up' ? 'liked it in the app' : 'disliked it in the app'] : []),
      ...cards.map(row => CARD_STATES[row.status] ?? `has the card in state ${row.status}`),
      ...(handled.length ? [`${handled.join(' and ')} the mail it was about`] : []),
      next === null ? 'has not written since' : `next wrote ${Math.max(0, Math.round((next - at) / 60_000))} min later`,
    ];
    const what = said ? `told "${cut(said)}"` : cards.length ? `card "${cut(cards[0]!.summary)}"` : 'held, nothing sent';
    return `- [${localIso(at, deps.timezone).slice(0, 16).replace('T', ' ')}] ${what}: the owner ${facts.join('; ')}`;
  }).join('\n');
};

// The people this batch involves whom the owner's memory knows (a sender by address, an attendee by name), then those the owner
// was most recently in touch with. Matching is by address or exact name; what a person means for the batch is the model's call.
// Triage reads mail, so it sees the owner's people as read_memory shows them to a turn that read outside content: a person
// only through a claim not taken from outside content and carrying no health. Someone known only from mail, or only through
// a body or mind note, is not named to it.
export const peopleOutsideMay = (people: Pick<PeopleTables, 'all' | 'claimsOf'>): Person[] =>
  people.all().filter(person => people.claimsOf(person.id).some(claim => claim.origin !== 'untrusted' && outsideSafe(claim)));
export const PEOPLE_IN_PLAY = 8;
const RECENT_PEOPLE = 5;
const detailOf = (change: Change): Record<string, unknown> => { try { const parsed: unknown = JSON.parse(change.detail); return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}; } catch { return {}; } };
const personLine = (person: Person, inBatch: boolean) =>
  `- ${person.name}${person.ring ? ` (${person.ring})` : ''}${person.last_contact_at ? `, last in touch ${person.last_contact_at.slice(0, 10)}${person.last_contact_via ? ` by ${person.last_contact_via}` : ''}` : ''}${inBatch ? '; in this batch' : ''}`;
export const peopleInPlay = (people: readonly Person[], changes: readonly Change[], limit = PEOPLE_IN_PLAY): string => {
  const addresses = new Set<string>(), names = new Set<string>();
  for (const change of changes) {
    const detail = detailOf(change);
    const from = typeof detail.from === 'string' ? fromAddress(detail.from) : null;
    if (from) addresses.add(from);
    for (const name of Array.isArray(detail.attendee_names) ? detail.attendee_names : []) if (typeof name === 'string') names.add(name.trim().toLowerCase());
  }
  const named = (person: Person) => [person.name, ...(() => { try { return JSON.parse(person.aliases ?? '[]') as unknown[]; } catch { return []; } })()]
    .some(name => typeof name === 'string' && names.has(name.trim().toLowerCase()));
  const inBatch = people.filter(person => personAddresses(person).some(address => addresses.has(address.toLowerCase())) || named(person));
  const recent = people.filter(person => person.last_contact_at && !inBatch.includes(person))
    .sort((a, b) => b.last_contact_at!.localeCompare(a.last_contact_at!)).slice(0, RECENT_PEOPLE);
  return [...inBatch.map(person => personLine(person, true)), ...recent.map(person => personLine(person, false))].slice(0, limit).join('\n');
};

// What triage reads besides the changes: the owner's goals as their memory holds them, and today's day shaping. With
// TRIAGE_CARES (signals given), bounded: what they did after recent updates, the last day of their conversation across surfaces
// and, with PEOPLE_MAP, the people in play as an outside turn may see them; the conversation and the people wait while a
// forget settles.
export type TriageOwnerDeps = Readonly<{
  claims: Pick<ClaimStore, 'claims' | 'pendingTopics' | 'people'>;
  peopleMap: boolean;
  shaping(): Promise<string>;
  exchange(): string;
  signals?: () => SignalDeps;
}>;
export const triageOwnerContext = async (deps: TriageOwnerDeps, changes: readonly Change[]) => {
  const goals = deps.claims.claims().filter(claim => claim.kind === 'goal').slice(-12).map(claim => `- ${claim.text}`).join('\n');
  const shaping = await deps.shaping();
  if (!deps.signals) return { goals, shaping };
  const settling = heldTopicsOf(deps.claims).length > 0;
  return { goals, shaping, signals: responseSignals(deps.signals()),
    ...(settling ? {} : { exchange: deps.exchange(), ...(deps.peopleMap ? { people: peopleInPlay(peopleOutsideMay(deps.claims.people), changes) } : {}) }) };
};
