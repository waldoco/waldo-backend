import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { applyClaimOps, claimStore, turnMemoryPrompt } from '../src/memory/claims';

// About-me: what the owner states about themselves is stored as owner-grounded claims and reaches the
// next turn's prompt in <owner_profile>. Fixture level (scripted writer output, synthetic values).
const AT = '2026-10-04T00:00:00.000Z';
const ops = (add: unknown[]) => JSON.stringify({ add, seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null });
const withStore = <T>(name: string, work: (store: ReturnType<typeof claimStore>) => T) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), (_i, state) => work(claimStore(state.storage.sql)));
const profile = (prompt: string) => prompt.slice(prompt.indexOf('<owner_profile>'), prompt.indexOf('</owner_profile>'));

it('every owner-stated fact reaches <owner_profile>, not just the first eight', async () => {
  await withStore('owner-profile-all', (store) => {
    const facts = Array.from({ length: 12 }, (_, i) => `Fact ${i + 1}: the owner's synthetic detail number ${i + 1}`);
    for (const [i, text] of facts.entries()) {
      const said = `about me, ${text}`;
      applyClaimOps(store, ops([{ kind: 'fact', text, source: 'stated', evidence: `owner, tg-${i}: "${said}"`, touches_forgotten: false }]), AT, `owner, tg-${i}`, undefined, { owner: said });
    }
    const block = profile(turnMemoryPrompt(store, 'unrelated question about the weather'));
    for (const text of facts) expect(block, 'owner-grounded profile fact missing from the prompt').toContain(text);
  });
});

it('an inferred claim never enters <owner_profile>', async () => {
  await withStore('owner-profile-inferred', (store) => {
    applyClaimOps(store, ops([{ kind: 'fact', text: 'Seems to prefer mornings', source: 'inferred', evidence: 'pattern across turns', touches_forgotten: false }]), AT, 'owner, tg-9', undefined, { owner: 'hello' });
    // The write path must have kept it as an inferred claim (not owner-grounded), so the source guard is what excludes it.
    const stored = store.claims().find(claim => claim.text === 'Seems to prefer mornings');
    expect(stored?.source).toBe('inferred');
    expect(profile(turnMemoryPrompt(store, 'when do I like meetings'))).not.toContain('prefer mornings');
  });
});

it('with a room limit the newest owner facts stay, the rest are counted, and nothing is dropped without a note', async () => {
  await withStore('owner-profile-room', (store) => {
    for (let i = 0; i < 30; i++) {
      const said = `about me, Fact ${i}: synthetic detail ${i}`;
      applyClaimOps(store, ops([{ kind: 'fact', text: `Fact ${i}: synthetic detail ${i}`, source: 'stated', evidence: `owner, tg-${i}: "${said}"`, touches_forgotten: false }]), AT, `owner, tg-${i}`, undefined, { owner: said });
    }
    const prompt = turnMemoryPrompt(store, 'unrelated', 1_200);
    expect(prompt.length).toBeLessThanOrEqual(1_200);
    expect(profile(prompt)).toContain('Fact 29: synthetic detail 29');
    expect(profile(prompt)).not.toContain('Fact 0: synthetic detail 0');
    expect(profile(prompt)).toMatch(/\d+ older owner facts are not shown here/);
    expect(profile(turnMemoryPrompt(store, 'unrelated'))).toContain('Fact 0: synthetic detail 0');
  });
});

it('active and promoted owner facts are ordered newest-first together', async () => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('owner-profile-interleaved')), (_i, state) => {
    const store = claimStore(state.storage.sql);
    const add = (i: number) => store.add({ kind: 'fact', text: `Order ${i}`, source: 'stated', evidence: `owner, tg-${i}: "x"`, origin: 'owner', source_ref: `owner, tg-${i}` }, AT);
    [0, 1, 2, 3].forEach(add);
    for (const i of [0, 2]) state.storage.sql.exec("UPDATE claims SET status='promoted' WHERE id=?", store.claims().find(c => c.text === `Order ${i}`)!.id);
    expect(store.claims('promoted').length, 'two claims promoted').toBe(2);
    const block = profile(turnMemoryPrompt(store, 'unrelated'));
    expect(block.indexOf('Order 3')).toBeLessThan(block.indexOf('Order 2'));
    expect(block.indexOf('Order 2')).toBeLessThan(block.indexOf('Order 1'));
    expect(block.indexOf('Order 1')).toBeLessThan(block.indexOf('Order 0'));
  });
});
