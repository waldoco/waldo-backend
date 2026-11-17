import { PERSON_ADDRESSES_MAX, type PersonLink, type PersonRing, type PersonWrite } from '@waldo/contracts';
import { carriesTopic, forgettableTopic } from './forget-guard';
import type { Claim } from './claims';

// The people in the owner's memory. A person is an entity of kind person; everything said about them is a claim linked to
// them, so confirm, correct, forget and origin stay the claims'. Only the claim store writes these tables: it hands this module
// its own SQL handle, and nothing else imports the writers.
export type Person = Readonly<{
  id: number; kind: string; name: string; aliases: string | null; area: string | null; ring: PersonRing | null; ring_by: string | null;
  name_by: string | null; addresses: string | null; last_contact_at: string | null; last_contact_via: string | null; created_at: string; last_seen_at: string;
}>;
export type PersonClaimLink = Readonly<{ claim_id: number; entity_id: number; role: string; relation: string | null }>;
const LIVE = "('active', 'promoted')";

type Sql = Pick<SqlStorage, 'exec'>;
export const ensurePeopleSchema = (sql: Sql): void => {
  sql.exec(`CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, name TEXT NOT NULL, aliases TEXT, area TEXT,
    ring TEXT, ring_by TEXT, name_by TEXT, addresses TEXT, last_contact_at TEXT, last_contact_via TEXT,
    created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS claim_links (
    claim_id INTEGER NOT NULL, entity_id INTEGER NOT NULL, role TEXT NOT NULL, relation TEXT,
    PRIMARY KEY (claim_id, entity_id, role))`);
  sql.exec('CREATE INDEX IF NOT EXISTS claim_links_entity ON claim_links (entity_id)');
};

const listOf = (raw: string | null): string[] => { try { const value: unknown = JSON.parse(raw ?? '[]'); return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; } catch { return []; } };
const addressKey = (address: string): string => address.trim().toLowerCase();

export const peopleTables = (sql: Sql) => {
  // A person counts only while a live claim names them: one whose last claim was dismissed or retired waits for prune() and is
  // never resolved, offered or counted in the meantime.
  const living = `kind = 'person' AND EXISTS (SELECT 1 FROM claim_links JOIN claims ON claims.id = claim_links.claim_id WHERE claim_links.entity_id = entities.id AND claims.status IN ${LIVE})`;
  const person = (id: number): Person | undefined => sql.exec<Person>(`SELECT * FROM entities WHERE id = ? AND ${living}`, id).toArray()[0];
  const all = (): Person[] => sql.exec<Person>(`SELECT * FROM entities WHERE ${living} ORDER BY id`).toArray();
  const namesOf = (row: Person): string[] => [row.name, ...listOf(row.aliases)];
  const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
  return {
    person,
    all,
    // Refs that name no person in this owner's memory. Checked before the claim is written, so a bad ref writes nothing.
    unknownRefs: (links: readonly PersonLink[]): number[] => links.flatMap(link => link.ref !== undefined && person(link.ref) === undefined ? [link.ref] : []),
    // Links a written claim to its people, creating each new one. What the model sets about a person (ring) never overrides what
    // the owner set; addresses are merged, at most PERSON_ADDRESSES_MAX. Returns the people linked, in order.
    link(claimId: number, links: readonly PersonWrite[], at: string): number[] {
      return links.map(link => {
        const id = link.ref ?? sql.exec<{ id: number }>("INSERT INTO entities (kind, name, created_at, last_seen_at) VALUES ('person', ?, ?, ?) RETURNING id", link.name!, at, at).one().id;
        // A new person has no claim yet; a ref must still be a living person when the write commits.
        const row = link.ref === undefined ? sql.exec<Person>('SELECT * FROM entities WHERE id = ?', id).one() : person(id);
        if (!row) throw new StalePersonRef(id);
        const addresses = [...new Set([...listOf(row.addresses), ...(link.addresses ?? []).map(addressKey)])].slice(0, PERSON_ADDRESSES_MAX);
        const ring = link.ring !== undefined && row.ring_by !== 'owner' ? link.ring : row.ring;
        sql.exec('UPDATE entities SET last_seen_at = ?, addresses = ?, ring = ?, ring_by = CASE WHEN ? THEN \'model\' ELSE ring_by END WHERE id = ?',
          at, addresses.length ? JSON.stringify(addresses) : null, ring, link.ring !== undefined && row.ring_by !== 'owner' ? 1 : 0, id);
        sql.exec('INSERT OR IGNORE INTO claim_links (claim_id, entity_id, role, relation) VALUES (?, ?, ?, ?)', claimId, id, link.role, link.relation ?? null);
        return id;
      });
    },
    linksOf: (claimId: number): PersonClaimLink[] => sql.exec<PersonClaimLink>('SELECT * FROM claim_links WHERE claim_id = ?', claimId).toArray(),
    // A correction's new wording keeps the people the replaced wording was about, unless the model named them again.
    carryLinks(from: number, to: number): void {
      sql.exec('INSERT OR IGNORE INTO claim_links (claim_id, entity_id, role, relation) SELECT ?, entity_id, role, relation FROM claim_links WHERE claim_id = ?', to, from);
    },
    // A person's live claims, each with how it names them, newest first.
    claimsOf: (entityId: number): (Claim & Readonly<{ role: string; relation: string | null }>)[] =>
      sql.exec<Claim & { role: string; relation: string | null }>(`SELECT claims.*, claim_links.role AS role, claim_links.relation AS relation FROM claim_links JOIN claims ON claims.id = claim_links.claim_id WHERE claim_links.entity_id = ? AND claims.status IN ${LIVE} ORDER BY claims.last_seen_at DESC, claims.id DESC`, entityId).toArray(),
    // Whether the owner has said or confirmed something about them: what outside content may then add to them is only claims.
    ownersOwn: (entityId: number): boolean => sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM claim_links JOIN claims ON claims.id = claim_links.claim_id WHERE claim_links.entity_id = ? AND claims.origin = 'owner' AND claims.status IN ${LIVE}`, entityId).one().n > 0,
    claimIdsOf: (entityId: number): number[] => sql.exec<{ claim_id: number }>('SELECT claim_id FROM claim_links WHERE entity_id = ?', entityId).toArray().map(row => row.claim_id),
    // The people a forgotten topic names exactly, by their name, another name or an address: their claims go with the topic. A
    // topic inside a name ("Acme" in sam@acme.com, a shared surname) names no one.
    namedBy(topics: readonly string[]): Person[] {
      return all().filter(row => topics.some(topic => [...namesOf(row), ...listOf(row.addresses)].some(text => same(text, topic))));
    },
    // What forgetting one person bars: every address, and each of their names that no other living person's name contains or is
    // contained in, so forgetting one Priya never forgets another, nor "Priya Patel" with "Priya".
    forgetTexts(id: number): string[] {
      const row = person(id);
      if (!row) return [];
      const others = all().filter(other => other.id !== id).flatMap(namesOf);
      const shared = (name: string) => others.some(other => carriesTopic(other, name) || carriesTopic(name, other));
      // A name too short to forget as a word ("Al") would mask that word across all history; their claims still go by id.
      return [...namesOf(row).filter(name => forgettableTopic(name) && !shared(name)), ...listOf(row.addresses)];
    },
    // Last contact: a person heard from when mail Waldo saw came from one of their addresses. Exact address, newest time kept.
    heardFrom(address: string, at: string): number {
      const key = addressKey(address);
      let touched = 0;
      for (const row of all()) {
        if (!listOf(row.addresses).includes(key) || (row.last_contact_at !== null && row.last_contact_at >= at)) continue;
        sql.exec("UPDATE entities SET last_contact_at = ?, last_contact_via = 'mail' WHERE id = ?", at, row.id);
        touched += 1;
      }
      return touched;
    },
    // The owner's own word on a person: their name, or how close they are. Later model writes never overwrite either.
    // A renamed person keeps the old name as another of theirs, so mail under it is still them and a forget still bars it.
    rename(id: number, name: string, at: string): boolean {
      const row = person(id);
      if (!row) return false;
      const aliases = [...new Set([...listOf(row.aliases), ...(same(row.name, name) ? [] : [row.name])])].slice(-10);
      return sql.exec("UPDATE entities SET name = ?, name_by = 'owner', aliases = ?, last_seen_at = ? WHERE id = ?", name, aliases.length ? JSON.stringify(aliases) : null, at, id).rowsWritten === 1;
    },
    setRing(id: number, ring: PersonRing, at: string): boolean {
      return person(id) !== undefined && sql.exec("UPDATE entities SET ring = ?, ring_by = 'owner', last_seen_at = ? WHERE id = ?", ring, at, id).rowsWritten === 1;
    },
    // A person is derived: one with no live claim left is deleted, and so are links to claims that are gone or being forgotten.
    prune(): void {
      sql.exec(`DELETE FROM claim_links WHERE claim_id NOT IN (SELECT id FROM claims WHERE status NOT IN ('purging', 'forgotten'))`);
      sql.exec(`DELETE FROM entities WHERE id NOT IN (SELECT claim_links.entity_id FROM claim_links JOIN claims ON claims.id = claim_links.claim_id WHERE claims.status IN ${LIVE})`);
      sql.exec('DELETE FROM claim_links WHERE entity_id NOT IN (SELECT id FROM entities)');
    },
  };
};
export type PeopleTables = ReturnType<typeof peopleTables>;
// A ref that named a living person when it was checked, and no longer did when the write committed.
export class StalePersonRef extends Error { constructor(readonly ref: number) { super('stale_person_ref'); } }
export const personAddresses = (row: Pick<Person, 'addresses'>): string[] => listOf(row.addresses);

// The next time a dated claim's day comes round, on or after today (YYYY-MM-DD), or null when a fixed date has passed.
export const nextOccurrence = (onDate: string, today: string): string | null => {
  if (!onDate.startsWith('--')) return onDate >= today ? onDate : null;
  const monthDay = onDate.slice(2), year = Number(today.slice(0, 4));
  for (const candidate of [year, year + 1, year + 2, year + 3, year + 4]) {
    const day = `${candidate}-${monthDay}`;
    // 29 February comes round only in a leap year.
    const real = new Date(`${day}T00:00:00Z`);
    if (!Number.isNaN(real.getTime()) && real.toISOString().slice(0, 10) === day && day >= today) return day;
  }
  return null;
};

// The address a From header names: the angle address it ends with (a display name can itself hold one, "Priya <p@x>" <m@y>),
// or the header itself when it is a bare address.
export const fromAddress = (header: string): string | null => {
  const trimmed = header.trim();
  const inside = /<([^<>\s]+@[^<>\s]+)>$/.exec(trimmed)?.[1] ?? (/^[^<>\s]+@[^<>\s]+$/.test(trimmed) ? trimmed : null);
  return inside ? inside.toLowerCase() : null;
};
// A person as a card, from the claims about them a reader may see (newest first): how those claims name them, the soonest day
// one comes round, and when Waldo last saw them write or meet. Shared by read_memory and the app's people view.
export type PersonCard = Readonly<{
  person: number; name: string; other_names: string[]; ring: PersonRing | null; ring_by: 'model' | 'owner' | null; relations: string[];
  next_date: Readonly<{ date: string; claim_id: number; text: string }> | null; last_contact: Readonly<{ at: string; via: string | null }> | null; claims: number;
}>;
export const personCard = (row: Person, claims: readonly (Claim & Readonly<{ relation: string | null }>)[], today: string): PersonCard => ({
  person: row.id, name: row.name, other_names: listOf(row.aliases), ring: row.ring, ring_by: row.ring_by === 'owner' || row.ring_by === 'model' ? row.ring_by : null,
  relations: [...new Set(claims.flatMap(claim => claim.relation ? [claim.relation] : []))].slice(0, 3),
  next_date: claims.flatMap(claim => { const date = claim.on_date ? nextOccurrence(claim.on_date, today) : null; return date ? [{ date, claim_id: claim.id, text: claim.text }] : []; })
    .sort((a, b) => a.date.localeCompare(b.date))[0] ?? null,
  last_contact: row.last_contact_at ? { at: row.last_contact_at, via: row.last_contact_via } : null,
  claims: claims.length,
});
