import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { peopleInPlay, peopleOutsideMay } from '../src/channels/triage-context';
import type { Change } from '../src/channels/update-cards';
import type { MemoryToolContext } from '../src/tools/live/memory';
import { stub, world, type Card } from './helpers/people-world';

// Triage reads mail, so it sees the owner's people only as read_memory shows them to a turn that read outside content.
// Synthetic people only.
describe('triage people in play', () => {
  it('names no one known only from mail or only through a body note, exactly as read_memory shows an outside turn', () => runInDurableObject(stub('triage-fence'), async (_instance, state) => {
    const w = world(state);
    w.store.add({ kind: 'fact', text: 'Dana sends the weekly invoices', source: 'inferred', evidence: 'mail', origin: 'untrusted', source_ref: 'mail:1' }, '2026-11-07T08:00:00Z');
    w.store.people.link(1, [{ name: 'Dana', role: 'subject', addresses: ['dana@vendor.example'] }], '2026-11-07T08:00:00Z');
    await w.data('remember', { kind: 'fact', text: 'Rhea had surgery last week', evidence_quote: 'Rhea had surgery last week', area: 'body', people: [{ name: 'Rhea', role: 'subject' }] }, w.ctx('Rhea had surgery last week'));
    await w.data('remember', { kind: 'fact', text: 'Priya is the owner\'s sister', evidence_quote: 'My sister Priya', people: [{ name: 'Priya', role: 'subject', relation: 'sister' }] }, w.ctx('My sister Priya'));
    w.store.people.heardFrom('dana@vendor.example', '2026-11-08T08:00:00Z');

    const outside = ((await w.data('read_memory', { people: true }, w.ctx('my people', { memoryOutside: true } as Partial<MemoryToolContext>))).people as Card[]).map(card => card.name);
    expect(outside).toEqual(['Priya']);
    expect(peopleOutsideMay(w.store.people).map(person => person.name)).toEqual(outside);

    // Dana sent this mail and was the last in touch, and is still not named to the turn.
    const mail: Change = { source: 'mail', kind: 'new', ref: 'message:m-1', detail: JSON.stringify({ from: 'Dana <dana@vendor.example>' }) };
    expect(peopleInPlay(w.store.people.all(), [mail])).toMatch(/Dana.*in this batch/);
    const section = peopleInPlay(peopleOutsideMay(w.store.people), [mail]);
    expect(section).not.toMatch(/Dana|Rhea/);
  }));
});
