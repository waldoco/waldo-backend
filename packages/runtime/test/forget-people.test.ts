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

  it('forgets one of two people with the same name without touching the other, or a longer name that contains it (m17 with m18)', () => runInDurableObject(stub('two-priyas'), async (_instance, state) => {
    const w = world(state);
    const said = 'Priya from work, my cousin Priya and Priya Patel are coming';
    const work = (await w.data('remember', { kind: 'fact', text: 'Priya is a colleague', evidence_quote: 'Priya from work', people: [{ name: 'Priya', role: 'subject' }] }, w.ctx(said))).people as number[];
    await w.data('remember', { kind: 'preference', text: 'Likes chess', evidence_quote: 'are coming', people: [{ ref: work[0]!, role: 'subject' }] }, w.ctx(said));
    const cousin = (await w.data('remember', { kind: 'fact', text: 'Priya is a cousin', evidence_quote: 'my cousin Priya', people: [{ name: 'Priya', role: 'subject' }] }, w.ctx(said))).people as number[];
    await w.data('remember', { kind: 'preference', text: 'Loves hiking', evidence_quote: 'coming', people: [{ ref: cousin[0]!, role: 'subject' }] }, w.ctx(said));
    const patel = (await w.data('remember', { kind: 'fact', text: 'Priya Patel is a neighbour', evidence_quote: 'Priya Patel', people: [{ name: 'Priya Patel', role: 'subject' }] }, w.ctx(said))).people as number[];
    await w.data('forget_memory', { person: work[0]!, scope_note: 'Priya from work' }, w.ctx('forget Priya from work'));
    expect(w.store.people.all().map(row => row.id)).toEqual([cousin[0], patel[0]]);
    expect(w.store.claims().map(claim => claim.text).sort()).toEqual(['Loves hiking', 'Priya Patel is a neighbour', 'Priya is a cousin']);
    expect(w.hidden.flat()).not.toContain('Priya');
    expect(await w.call('remember', { kind: 'fact', text: 'Priya called', evidence_quote: 'Priya called', people: [{ ref: cousin[0]!, role: 'subject' }] }, w.ctx('Priya called'))).toMatchObject({ ok: true });
  }));

  it('takes a person\'s claims with a topic only when it is one of their names or addresses exactly, never a domain or a surname inside one', () => runInDurableObject(stub('acme-topic'), async (_instance, state) => {
    const w = world(state);
    const sam = (await w.data('remember', { kind: 'fact', text: 'Sam is my brother', evidence_quote: 'Sam is my brother', people: [{ name: 'Sam Shah', role: 'subject' }] }, w.ctx('Sam is my brother'))).people as number[];
    w.store.people.link(1, [{ ref: sam[0]!, role: 'subject', addresses: ['sam@acme.com'] }], '2026-11-07T09:00:00Z');
    await w.data('remember', { kind: 'fact', text: 'Works with Acme on the launch', evidence_quote: 'Acme on the launch' }, w.ctx('I work with Acme on the launch'));
    await w.data('forget_memory', { topic: 'Acme', scope_note: 'Acme' }, w.ctx('forget Acme'));
    expect(await w.call('forget_memory', { topic: 'Shah', scope_note: 'Shah' }, w.ctx('forget Shah'))).toMatchObject({ ok: false, error: expect.stringContaining('No stored memory') });
    expect(w.store.claims().map(claim => claim.text)).toEqual(['Sam is my brother']);
    expect(w.store.people.all().map(row => row.id)).toEqual(sam);
  }));

  it('takes the earlier wordings of a person\'s claims too, so their words leave history', () => runInDurableObject(stub('history'), async (_instance, state) => {
    const w = world(state);
    const sam = await w.data('remember', { kind: 'fact', text: 'Sam Okafor lives in Pune', evidence_quote: 'Sam Okafor lives in Pune', people: [{ name: 'Sam Okafor', role: 'subject' }] }, w.ctx('Sam Okafor lives in Pune'));
    await w.data('remember', { kind: 'fact', text: 'Sam Okafor lives in Lagos', evidence_quote: 'Sam Okafor moved to Lagos', replaces_id: sam.id }, w.ctx('Sam Okafor moved to Lagos'));
    await w.data('forget_memory', { person: (sam.people as number[])[0]!, scope_note: 'Sam Okafor' }, w.ctx('forget Sam Okafor'));
    expect(JSON.stringify(state.storage.sql.exec("SELECT text, status FROM claims WHERE status NOT IN ('purging')").toArray())).not.toContain('Okafor');
  }));
});
