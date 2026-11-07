import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { MemoryToolContext } from '../src/tools/live/memory';
import { OWNER, stub, world } from './helpers/people-world';

// Forgetting a person: the entities and claim_links rows go, with every claim about them, and their name and addresses are
// barred (ADR_PEOPLE_MAP_2026-11-07 §4). Synthetic people only.
describe('forget a person', () => {
  it('forgets one person: every claim about them, their name and addresses barred, another person sharing a first name untouched (m18)', () => runInDurableObject(stub('forget'), async (_instance, state) => {
    const w = world(state);
    const said = 'Priya Shah and Priya Rao both love jazz';
    const shah = (await w.data('remember', { kind: 'fact', text: 'Priya Shah is a friend', evidence_quote: 'Priya Shah', people: [{ name: 'Priya Shah', role: 'subject' }] }, w.ctx(said))).people as number[];
    // The address Waldo saw her mail from, as the source pass writes it.
    w.store.people.link(1, [{ ref: shah[0]!, role: 'subject', addresses: ['priya.shah@example.com'] }], '2026-11-07T09:00:00Z');
    await w.data('remember', { kind: 'preference', text: 'Loves jazz', evidence_quote: 'love jazz', people: [{ ref: shah[0]!, role: 'subject' }] }, w.ctx(said));
    const rao = (await w.data('remember', { kind: 'fact', text: 'Priya Rao is a friend', evidence_quote: 'Priya Rao', people: [{ name: 'Priya Rao', role: 'subject' }] }, w.ctx(said))).people as number[];
    state.storage.sql.exec("UPDATE entities SET aliases = '[\"Priya\"]'");
    const forgotten = await w.data('forget_memory', { person: shah[0]!, scope_note: 'Priya Shah' }, w.ctx('Forget Priya Shah'));
    expect(forgotten.removed_ids).toEqual([1, 2]);
    expect(w.store.people.all().map(row => row.id)).toEqual(rao);
    const stored = JSON.stringify(state.storage.sql.exec('SELECT * FROM entities').toArray()) + JSON.stringify(state.storage.sql.exec('SELECT * FROM claim_links').toArray());
    expect(stored).not.toContain('Shah');
    expect(stored).not.toContain('priya.shah@example.com');
    expect(w.hidden.flat()).toEqual(expect.arrayContaining(['Priya Shah', 'priya.shah@example.com']));
    expect(w.hidden.flat()).not.toContain('Priya');
    expect(await w.call('remember', { kind: 'fact', text: 'Met a new friend', evidence_quote: 'new friend', people: [{ name: 'Priya Shah', role: 'subject' }] }, w.ctx('a new friend'))).toMatchObject({ ok: false, error: expect.stringContaining('forget') });
    expect(await w.call('remember', { kind: 'fact', text: 'Met a new friend', evidence_quote: 'new friend', people: [{ name: 'Priya', role: 'subject' }] }, w.ctx('a new friend'))).toMatchObject({ ok: true });
  }));
  it('forgets a person named by a topic, with claims that never say their name', () => runInDurableObject(stub('topic'), async (_instance, state) => {
    const w = world(state);
    const sam = (await w.data('remember', { kind: 'fact', text: 'Sam Okafor is my mentor', evidence_quote: 'Sam Okafor is my mentor', people: [{ name: 'Sam Okafor', role: 'subject' }] }, w.ctx('Sam Okafor is my mentor'))).people as number[];
    await w.data('remember', { kind: 'preference', text: 'Prefers morning calls', evidence_quote: 'morning calls', people: [{ ref: sam[0]!, role: 'subject' }] }, w.ctx('he likes morning calls'));
    await w.data('forget_memory', { topic: 'Sam Okafor', scope_note: 'Sam Okafor' }, w.ctx('forget Sam Okafor'));
    expect(w.store.claims().map(claim => claim.text)).not.toContain('Prefers morning calls');
    expect(w.store.people.all()).toEqual([]);
  }));
  it('forgets a person only from the owner\'s own message, never from an approved card replay', () => runInDurableObject(stub('replay'), async (_instance, state) => {
    const w = world(state);
    const sam = (await w.data('remember', { kind: 'fact', text: 'Sam is a friend', evidence_quote: 'Sam is a friend', people: [{ name: 'Sam', role: 'subject' }] }, w.ctx('Sam is a friend'))).people as number[];
    const replay = { authenticatedUserId: OWNER, trigger: 'user_message', toolArgSourceTaint: 'external', approvedTaintedAction: { tool: 'forget_memory', args_digest: 'd' } } as unknown as MemoryToolContext;
    expect(await w.call('forget_memory', { person: sam[0]!, claim_ids: [1], scope_note: 'Sam' }, replay)).toMatchObject({ ok: false });
    expect(w.store.people.all()).toHaveLength(1);
  }));
});
