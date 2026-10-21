import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { applyClaimOps, claimStore, turnMemoryPrompt } from '../src/memory/claims';

// The nightly pass grounds a claim in the owner's own message the way remember does: one message holds the whole
// evidence, so the claim names it and reaches the owner profile.
const AT = '2026-10-13T03:00:00.000Z';
const NIGHT = 'owner, day of nightly-memory:1791860400000';
const ops = (add: unknown[]) => JSON.stringify({ add, seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null });
const fact = (text: string, evidence: string) => ({ kind: 'fact', text, source: 'stated', evidence, touches_forgotten: false });
const withStore = <T>(name: string, work: (store: ReturnType<typeof claimStore>) => T) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), (_i, state) => work(claimStore(state.storage.sql)));
const profile = (prompt: string) => prompt.slice(prompt.indexOf('<owner_profile>'), prompt.indexOf('</owner_profile>'));
const messages = [{ ref: 'tg-41', text: 'morning' }, { ref: 'app-1000007', text: 'I swim every Friday before work' }, { ref: 'tg-42', text: 'and my sister is called Mira' }];
const night = { owner: messages.map(message => message.text).join('\n'), waldo: 'Noted.', ownerMessages: messages };

it('a nightly claim whose evidence sits in one owner message names that message and reaches the owner profile', async () => {
  await withStore('nightly-grounded', store => {
    applyClaimOps(store, ops([fact('Swims every Friday before work', '"I swim every Friday before work"')]), AT, NIGHT, undefined, night);
    const claim = store.claims().find(row => row.text === 'Swims every Friday before work')!;
    expect([claim.origin, claim.source_ref, claim.verification_status]).toEqual(['owner', 'owner, app-1000007', 'owner-grounded']);
    expect(profile(turnMemoryPrompt(store, 'what do I do on Fridays'))).toContain('Swims every Friday before work');
  });
});

it('evidence spread over two owner messages names neither, so the claim stays provisional', async () => {
  await withStore('nightly-spread', store => {
    applyClaimOps(store, ops([fact('Swims on Fridays and has a sister, Mira', '"I swim every Friday" and "my sister is called Mira"')]), AT, NIGHT, undefined, night);
    const claim = store.claims().find(row => row.text.startsWith('Swims on Fridays'))!;
    expect([claim.origin, claim.source_ref ?? null, claim.verification_status]).toEqual(['owner', null, 'provisional']);
    expect(profile(turnMemoryPrompt(store, 'tell me about my family'))).not.toContain('Mira');
  });
});

it('evidence that only Waldo said grounds in no owner message', async () => {
  await withStore('nightly-waldo', store => {
    applyClaimOps(store, ops([fact('Prefers short replies', '"Noted."')]), AT, NIGHT, undefined, night);
    expect(store.claims().some(row => row.text === 'Prefers short replies')).toBe(false);
  });
});
