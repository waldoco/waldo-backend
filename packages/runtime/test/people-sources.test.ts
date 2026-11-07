import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { consolidateSources } from '../src/channels/nightly-sources';
import { updateBook, type Change } from '../src/channels/update-cards';
import { claimStore, knownPeopleBlock, SOURCE_PEOPLE_CLAIMS_SCHEMA } from '../src/memory/claims';
import { fromAddress } from '../src/memory/people';

// The people map, slice 3 (ADR_PEOPLE_MAP_2026-11-07 §2 and §3): the source pass may say who a claim it adds is about, and mail
// from a person's address is their last contact. Synthetic people and mail only.
const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-07T08:00:00Z');
const mail = (from: string, subject: string): Change => ({ source: 'mail', kind: 'new', detail: JSON.stringify({ from, subject, date: '2026-11-07' }) });
const withStorage = <T>(name: string, work: (state: DurableObjectState) => Promise<T>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => work(state));
const deps = (state: DurableObjectState, ask: () => Promise<string>, people = true) => ({
  kv: state.storage.kv, updates: updateBook(state.storage.sql), claims: claimStore(state.storage.sql, (work) => state.storage.transactionSync(work)),
  transaction: <R>(work: () => R) => state.storage.transactionSync(work), timezone: 'UTC', now: () => NOW, health: true, people, ask, log: () => undefined,
});
const add = (text: string, evidence: string, people: unknown[]) => ({ kind: 'fact', text, source: 'inferred', evidence, touches_forgotten: false, aliases: [], aliases_touch_forgotten: false, area: null, people });
const person = (over: Record<string, unknown>) => ({ ref: null, name: null, role: 'subject', relation: null, addresses: [], ...over });

describe('people from the source pass', () => {
  it('links the people the pass names, as Waldo\'s read of outside content, and drops a forgotten name, an unknown ref or a bad address', async () => {
    await withStorage('people-sources-link', async (state) => {
      const store = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
      store.barrier('Mallory Vance', '2026-11-01T00:00:00Z');
      updateBook(state.storage.sql).record('2026-11-07', NOW - HOUR, [mail('Dana Okoye <Dana@BookClub.example>', 'Book club moves to Tuesdays')], null);
      const reply = JSON.stringify({ add: [
        add('Dana runs the owner\'s book club', 'Book club moves to Tuesdays', [person({ name: 'Dana Okoye', relation: 'book club', addresses: ['Dana@BookClub.example', 'not an address'] })]),
        add('Book club meets on Tuesdays now', 'Book club moves to Tuesdays', [person({ name: 'Mallory Vance' }), person({ ref: 999 })]),
      ] });
      expect(await consolidateSources(deps(state, async () => reply), 't')).toBe('consolidated');
      const [dana] = store.people.all();
      expect(store.people.all()).toHaveLength(1);
      expect(dana).toMatchObject({ name: 'Dana Okoye', addresses: '["dana@bookclub.example"]' });
      expect(store.people.claimsOf(dana!.id).map((claim) => [claim.text, claim.origin])).toEqual([['Dana runs the owner\'s book club', 'untrusted']]);
      // Mail from her address is her last contact.
      expect(dana!.last_contact_at).toBe(new Date(NOW - HOUR).toISOString());
      expect(dana!.last_contact_via).toBe('mail');
    });
  });

  it('keeps the newest last contact, touches only an exact address, and with the switch off links and touches no one', async () => {
    await withStorage('people-sources-contact', async (state) => {
      const store = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
      store.add({ kind: 'fact', text: 'Sam is my brother', source: 'stated', evidence: 'Sam is my brother', origin: 'owner', source_ref: 'owner, m1' }, '2026-11-01T00:00:00Z');
      const [sam] = store.people.link(1, [{ name: 'Sam', role: 'subject', addresses: ['sam@family.example'] }], '2026-11-01T00:00:00Z');
      const book = updateBook(state.storage.sql);
      book.record('2026-11-07', NOW - 2 * HOUR, [mail('"Sam" <sam@family.example>', 'Dinner?')], null);
      book.record('2026-11-07', NOW - HOUR, [mail('sam@family.example.evil', 'Lookalike'), mail('Someone <other@family.example>', 'Hi')], null);
      expect(await consolidateSources(deps(state, async () => '{"add":[]}'), 't')).toBe('consolidated');
      expect(store.people.person(sam!)).toMatchObject({ last_contact_at: new Date(NOW - 2 * HOUR).toISOString() });
      expect(store.people.heardFrom('sam@family.example', new Date(NOW - 5 * HOUR).toISOString())).toBe(0);
      expect(store.people.person(sam!)?.last_contact_at).toBe(new Date(NOW - 2 * HOUR).toISOString());
    });
    await withStorage('people-sources-off', async (state) => {
      const store = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
      store.add({ kind: 'fact', text: 'Sam is my brother', source: 'stated', evidence: 'Sam is my brother', origin: 'owner', source_ref: 'owner, m1' }, '2026-11-01T00:00:00Z');
      const [sam] = store.people.link(1, [{ name: 'Sam', role: 'subject', addresses: ['sam@family.example'] }], '2026-11-01T00:00:00Z');
      updateBook(state.storage.sql).record('2026-11-07', NOW - HOUR, [mail('Sam <sam@family.example>', 'Dinner?')], null);
      const reply = JSON.stringify({ add: [add('Sam hosts dinner on Fridays', 'Dinner?', [person({ ref: sam })])] });
      expect(await consolidateSources(deps(state, async () => reply, false), 't')).toBe('consolidated');
      expect(store.people.claimsOf(sam!).map((claim) => claim.text)).toEqual(['Sam is my brother']);
      expect(store.people.person(sam!)?.last_contact_at).toBeNull();
    });
  });

  it('shows the pass the people it may name by id, never one known only through body or mind claims', async () => {
    await withStorage('people-sources-known', async (state) => {
      const store = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
      store.add({ kind: 'fact', text: 'Priya is my sister', source: 'stated', evidence: 'Priya is my sister', origin: 'owner', source_ref: 'owner, m1' }, '2026-11-01T00:00:00Z');
      store.add({ kind: 'fact', text: 'Rhea had surgery', source: 'stated', evidence: 'Rhea had surgery', origin: 'owner', source_ref: 'owner, m1', area: 'body' }, '2026-11-01T00:00:00Z');
      const [priya] = store.people.link(1, [{ name: 'Priya', role: 'subject' }], '2026-11-01T00:00:00Z');
      store.people.link(2, [{ name: 'Rhea', role: 'subject' }], '2026-11-01T00:00:00Z');
      expect(knownPeopleBlock(store)).toBe(`<known_people>\n${priya}: Priya\n</known_people>`);
    });
  });

  it('reads the address a From header names, and nothing from a header that names none', () => {
    expect(fromAddress('Dana Okoye <Dana@BookClub.example>')).toBe('dana@bookclub.example');
    expect(fromAddress('sam@family.example')).toBe('sam@family.example');
    expect(fromAddress('"Sam, J." <sam@family.example>')).toBe('sam@family.example');
    for (const header of ['Dana Okoye', '', '<not an address>']) expect(fromAddress(header)).toBeNull();
  });

  it('asks the pass for people in a strict shape: every field required, a ref or a name, addresses as a list', () => {
    const item = SOURCE_PEOPLE_CLAIMS_SCHEMA.properties.add.items;
    expect(item.required).toContain('people');
    expect(item.properties.people.items.required).toEqual(['ref', 'name', 'role', 'relation', 'addresses']);
    expect(item.properties.people.items.additionalProperties).toBe(false);
  });
});
