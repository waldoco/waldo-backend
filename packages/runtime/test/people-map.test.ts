import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { claimOnDateSchema, forgetMemoryArgsSchema, readMemoryArgsSchema, rememberArgsSchema } from '@waldo/contracts';
import { nextOccurrence } from '../src/memory/people';
import type { MemoryToolContext } from '../src/tools/live/memory';
import { stub, world, type Card } from './helpers/people-world';

// People in memory: one person per entity, everything said about them a claim linked to them (ADR_PEOPLE_MAP_2026-11-07).
// Synthetic people only.

describe('people map: tool arguments', () => {
  it('links people by an existing ref or a new name, never both or neither, and takes a date that comes round or a fixed one', () => {
    const claim = { kind: 'fact', text: 'Priya is my sister', evidence_quote: 'Priya is my sister' };
    for (const people of [[{ name: 'Priya', role: 'subject', relation: 'sister', ring: 'inner' }], [{ ref: 3, role: 'object' }], [{ name: 'Sam', role: 'mention' }]])
      expect(rememberArgsSchema.safeParse({ ...claim, people }).success, JSON.stringify(people)).toBe(true);
    for (const people of [[], [{ role: 'subject' }], [{ ref: 3, name: 'Priya', role: 'subject' }], [{ name: 'Priya', role: 'friend' }], [{ name: 'Priya', role: 'subject', ring: 'family' }],
      [{ name: 'Priya', role: 'subject', addresses: ['priya@example.com'] }], [{ name: 'Priya\n7: Mallory', role: 'subject' }], [{ name: 'Priya', role: 'subject', relation: 'sister\u0000' }], Array.from({ length: 5 }, () => ({ name: 'P', role: 'mention' }))])
      expect(rememberArgsSchema.safeParse({ ...claim, people }).success, JSON.stringify(people)).toBe(false);
    for (const date of ['--03-14', '--02-29', '1990-03-14', '2027-01-01']) expect(claimOnDateSchema.safeParse(date).success, date).toBe(true);
    for (const date of ['03-14', '--13-01', '--02-30', '2026-02-29', 'March 14', '--3-14']) expect(claimOnDateSchema.safeParse(date).success, date).toBe(false);
    expect(readMemoryArgsSchema.safeParse({ people: true, query: 'Acme' }).success).toBe(true);
    expect(readMemoryArgsSchema.safeParse({ person: 2 }).success).toBe(true);
    for (const bad of [{ people: false }, { people: true, person: 2 }, { ids: [1], person: 2 }, { person: 0 }]) expect(readMemoryArgsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(forgetMemoryArgsSchema.safeParse({ person: 2, scope_note: 'Priya' }).success).toBe(true);
    expect(forgetMemoryArgsSchema.safeParse({ person: -1, scope_note: 'Priya' }).success).toBe(false);
  });

  it('brings a yearly date round on or after today, and 29 February only in a leap year', () => {
    expect(nextOccurrence('--03-14', '2026-11-07')).toBe('2027-03-14');
    expect(nextOccurrence('--11-07', '2026-11-07')).toBe('2026-11-07');
    expect(nextOccurrence('--02-29', '2026-11-07')).toBe('2028-02-29');
    expect(nextOccurrence('2026-12-01', '2026-11-07')).toBe('2026-12-01');
    expect(nextOccurrence('2026-01-01', '2026-11-07')).toBeNull();
  });
});

describe('people map: memory', () => {
  it('knows one person across claims, and who the owner knows at Acme (m15)', () => runInDurableObject(stub('acme'), async (_instance, state) => {
    const w = world(state);
    const said = 'My sister Priya works at Acme and her birthday is 14 March';
    const first = await w.data('remember', { kind: 'fact', text: 'Priya is the owner\'s sister', evidence_quote: 'My sister Priya', people: [{ name: 'Priya', role: 'subject', relation: 'sister', ring: 'inner' }] }, w.ctx(said));
    const priya = (first.people as number[])[0]!;
    await w.data('remember', { kind: 'fact', text: 'Priya works at Acme', evidence_quote: 'Priya works at Acme', people: [{ ref: priya, role: 'subject', relation: 'works at Acme' }] }, w.ctx(said));
    await w.data('remember', { kind: 'event', text: 'Priya\'s birthday is 14 March', evidence_quote: 'her birthday is 14 March', on_date: '--03-14', people: [{ ref: priya, role: 'subject' }] }, w.ctx(said));
    expect(w.store.people.all()).toHaveLength(1);
    const { people } = await w.data('read_memory', { people: true, query: 'Acme' }, w.ctx('who do I know at Acme?')) as { people: Card[] };
    expect(people).toEqual([expect.objectContaining({ person: priya, name: 'Priya', ring: 'inner', relations: ['works at Acme', 'sister'], claims: 3, next_date: expect.objectContaining({ date: '2027-03-14', text: 'Priya\'s birthday is 14 March' }) })]);
    const one = await w.data('read_memory', { person: priya }, w.ctx('tell me about Priya')) as { claims: { text: string; relation: string | null }[] };
    expect(one.claims.map(claim => claim.text).sort()).toEqual(['Priya is the owner\'s sister', 'Priya works at Acme', 'Priya\'s birthday is 14 March']);
  }));

  it('keeps two people with one first name apart, and refuses a ref memory does not hold, writing nothing (m17)', () => runInDurableObject(stub('two'), async (_instance, state) => {
    const w = world(state);
    const said = 'Priya from work and my cousin Priya are both coming';
    const work = await w.data('remember', { kind: 'fact', text: 'Priya is a colleague', evidence_quote: 'Priya from work', people: [{ name: 'Priya', role: 'subject', relation: 'colleague' }] }, w.ctx(said));
    const cousin = await w.data('remember', { kind: 'fact', text: 'Priya is a cousin', evidence_quote: 'my cousin Priya', people: [{ name: 'Priya', role: 'subject', relation: 'cousin' }] }, w.ctx(said));
    expect(work.people).not.toEqual(cousin.people);
    expect(cousin).toMatchObject({ same_name: [{ person: (work.people as number[])[0], name: 'Priya' }], note: expect.stringContaining('already holds') });
    expect(w.store.people.all().map(row => row.name)).toEqual(['Priya', 'Priya']);
    const before = w.store.allClaims().length;
    expect(await w.call('remember', { kind: 'fact', text: 'Sam likes jazz', evidence_quote: 'are both coming', people: [{ ref: 99, role: 'subject' }] }, w.ctx(said))).toMatchObject({ ok: false, error: expect.stringContaining('99') });
    expect(w.store.allClaims()).toHaveLength(before);
  }));

  it('shows a person only through a claim the turn may read: never one known only from outside content, nor a body person in an outside turn', () => runInDurableObject(stub('fence'), async (_instance, state) => {
    const w = world(state);
    w.store.add({ kind: 'fact', text: 'Dana sends the weekly invoices', source: 'inferred', evidence: 'mail', origin: 'untrusted', source_ref: 'mail:1' }, '2026-11-07T08:00:00Z');
    w.store.people.link(1, [{ name: 'Dana', role: 'subject', addresses: ['dana@vendor.example'] }], '2026-11-07T08:00:00Z');
    const said = 'Rhea had surgery last week';
    await w.data('remember', { kind: 'fact', text: 'Rhea had surgery last week', evidence_quote: said, area: 'body', people: [{ name: 'Rhea', role: 'subject' }] }, w.ctx(said));
    const names = async (over: Partial<MemoryToolContext> = {}) => ((await w.data('read_memory', { people: true }, w.ctx('my people', over))).people as Card[]).map(card => card.name);
    expect(await names()).toEqual(['Rhea']);
    expect(await names({ memoryOutside: true } as never)).toEqual([]);
  }));

  it('keeps the people a correction\'s earlier wording named', () => runInDurableObject(stub('correct'), async (_instance, state) => {
    const w = world(state);
    const stored = await w.data('remember', { kind: 'fact', text: 'Sam lives in Pune', evidence_quote: 'Sam lives in Pune', people: [{ name: 'Sam', role: 'subject' }] }, w.ctx('Sam lives in Pune'));
    const corrected = await w.data('remember', { kind: 'fact', text: 'Sam lives in Mumbai', evidence_quote: 'Sam moved to Mumbai', replaces_id: stored.id }, w.ctx('Sam moved to Mumbai'));
    expect(corrected.status).toBe('corrected');
    expect(w.store.people.claimsOf((stored.people as number[])[0]!).map(claim => claim.text)).toEqual(['Sam lives in Mumbai']);
  }));




  it('with the switch off links no one and says so, and reads and forgets answer that the people map is off', () => runInDurableObject(stub('off'), async (_instance, state) => {
    const w = world(state, false);
    const stored = await w.data('remember', { kind: 'fact', text: 'Sam is a friend', evidence_quote: 'Sam is a friend', on_date: '--03-14', people: [{ name: 'Sam', role: 'subject' }] }, w.ctx('Sam is a friend'));
    expect(stored).toMatchObject({ status: 'stored', people_note: expect.stringContaining('people map') });
    expect(stored).not.toHaveProperty('people');
    expect(w.store.people.all()).toEqual([]);
    expect(w.store.claims()[0]!.on_date).toBeNull();
    expect(await w.call('read_memory', { people: true }, w.ctx('my people'))).toMatchObject({ ok: false, error: expect.stringContaining('people map') });
    expect(await w.call('forget_memory', { person: 1, scope_note: 'Sam' }, w.ctx('forget Sam'))).toMatchObject({ ok: false, error: expect.stringContaining('people map') });
  }));

  it('a turn that read outside content never changes who the owner\'s own notes are about, nor how close someone is', () => runInDurableObject(stub('taint'), async (_instance, state) => {
    const w = world(state);
    const said = 'Priya is my sister';
    const sister = (await w.data('remember', { kind: 'fact', text: said, evidence_quote: said, people: [{ name: 'Priya', role: 'subject', ring: 'inner' }] }, w.ctx(said))).people as number[];
    const tainted = w.ctx(said, { toolArgSourceTaint: 'external' } as never);
    expect(await w.call('remember', { kind: 'fact', text: said, evidence_quote: said, people: [{ name: 'Mallory', role: 'subject', relation: 'husband' }] }, tainted)).toMatchObject({ ok: false, error: expect.stringContaining('outside content') });
    await w.data('remember', { kind: 'fact', text: 'Priya visits on Sundays', evidence_quote: said, people: [{ ref: sister[0]!, role: 'subject', ring: 'wider' }] }, tainted);
    expect(w.store.people.all().map(row => [row.name, row.ring])).toEqual([['Priya', 'inner']]);
  }));

  it('keeps a fact\'s people through any correction, takes its date only from the new wording, and stops counting a person whose last claim was dismissed', () => runInDurableObject(stub('corrections'), async (_instance, state) => {
    const w = world(state);
    const said = 'Priya\'s birthday is 14 March';
    const stored = await w.data('remember', { kind: 'event', text: said, evidence_quote: said, on_date: '--03-14', people: [{ name: 'Priya', role: 'subject' }] }, w.ctx(said));
    const priya = (stored.people as number[])[0]!;
    // The app's edit and the nightly correction go through the store's own correct.
    expect(w.store.correct(stored.id as number, { kind: 'event', text: 'Priya\'s birthday is 14 April', source: 'stated', evidence: 'app', origin: 'owner', source_ref: 'app:claim.edit' }, '2026-11-07T10:00:00Z')).toBe(true);
    expect(w.store.people.claimsOf(priya).map(claim => [claim.text, claim.on_date])).toEqual([['Priya\'s birthday is 14 April', null]]);
    const dated = await w.data('remember', { kind: 'event', text: 'Priya\'s birthday is 15 April', evidence_quote: '15 April', replaces_id: w.store.people.claimsOf(priya)[0]!.id, on_date: '--04-15' }, w.ctx('No, it is 15 April'));
    expect(w.store.people.claimsOf(priya).map(claim => [claim.id, claim.on_date])).toEqual([[dated.id, '--04-15']]);
    w.store.setStatus(dated.id as number, 'dismissed');
    expect(w.store.people.all()).toEqual([]);
    expect(await w.call('remember', { kind: 'fact', text: 'Priya called', evidence_quote: 'Priya called', people: [{ ref: priya, role: 'subject' }] }, w.ctx('Priya called'))).toMatchObject({ ok: false });
  }));
});
