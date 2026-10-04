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
    applyClaimOps(store, ops([{ kind: 'pattern', text: 'Seems to prefer mornings', source: 'inferred', evidence: 'pattern across turns', touches_forgotten: false }]), AT, 'owner agreed', undefined, { owner: 'hello' });
    expect(profile(turnMemoryPrompt(store, 'when do I like meetings'))).not.toContain('prefer mornings');
  });
});
