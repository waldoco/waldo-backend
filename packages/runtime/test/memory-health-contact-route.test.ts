import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { applyClaimOps, claimStore, turnMemoryPrompt } from '../src/memory/claims';

// Admitted-claims route, fixture level (synthetic values, scripted writer output): what an
// owner-grounded health or contact claim can answer, versus raw history which stays external.
// Not covered here: writer model selection (live), the owner turn's claims read in a full turn.
const AT = '2026-10-01T00:00:00.000Z';
const ops = (add: unknown[]) => JSON.stringify({ add, seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null });
const withStore = <T>(name: string, work: (store: ReturnType<typeof claimStore>) => T) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), (_i, state) => work(claimStore(state.storage.sql)));

const HEALTH_SAID = 'my HbA1c was 9.1 last week and I take metformin 500mg';
const CONTACT_SAID = 'Riya number is 98765 43210 and her email is riya@example.com';

it('an owner-grounded health claim is stored and answers with exact values', async () => {
  await withStore('claims-health', (store) => {
    const result = applyClaimOps(store, ops([{ kind: 'health', text: 'HbA1c was 9.1 last week; takes metformin 500mg', source: 'stated', evidence: `owner, tg-1: "${HEALTH_SAID}"`, touches_forgotten: false }]), AT, 'owner agreed', undefined, { owner: HEALTH_SAID });
    expect(result).toMatch(/^\+1 /);
    const prompt = turnMemoryPrompt(store, 'what was my HbA1c?');
    expect(prompt).toContain('9.1');
    expect(prompt).toContain('metformin 500mg');
    // Written as the owner's stated fact. It answers through relevant_claims (exact values); it is
    // not in <owner_profile> until verified, which is the existing admission rule.
    expect(prompt).toContain('source="stated"');
    expect(prompt.slice(prompt.indexOf('<owner_profile>'), prompt.indexOf('</owner_profile>'))).not.toContain('9.1');
  });
});

// FINDING (characterisation): evidence the owner never said is not rejected. It is downgraded to
// source="inferred" and still surfaces in relevant_claims with its exact (invented) value, labelled
// inferred and never in <owner_profile>. Exact-value answers therefore rest on the model heeding
// that label; whether to withhold such claims from recall is an owner/core decision.
it('a health claim whose evidence the owner never said is downgraded to inferred, not dropped', async () => {
  await withStore('claims-health-invented', (store) => {
    applyClaimOps(store, ops([{ kind: 'health', text: 'HbA1c was 7.2', source: 'stated', evidence: 'owner, tg-1: "my HbA1c was 7.2 last month"', touches_forgotten: false }]), AT, 'owner agreed', undefined, { owner: HEALTH_SAID });
    const prompt = turnMemoryPrompt(store, 'what was my HbA1c?');
    expect(prompt).toContain('source="inferred"');
    expect(prompt.slice(prompt.indexOf('<owner_profile>'), prompt.indexOf('</owner_profile>'))).not.toContain('7.2');
  });
});

it('an owner-grounded contact fact is stored and answers with the exact values', async () => {
  await withStore('claims-contact', (store) => {
    applyClaimOps(store, ops([{ kind: 'fact', text: 'Riya number is 98765 43210, email riya@example.com', source: 'stated', evidence: `owner, tg-2: "${CONTACT_SAID}"`, touches_forgotten: false }]), AT, 'owner agreed', undefined, { owner: CONTACT_SAID });
    const prompt = turnMemoryPrompt(store, 'what is Riya number and email?');
    expect(prompt).toContain('98765 43210');
    expect(prompt).toContain('riya@example.com');
  });
});

// Provenance presentation: the evidence label comes from code-written origin / source_ref, never
// from the writer's text. Unknown (legacy NULL origin) stays unlabelled; no row is hidden or promoted.
const rendered = (origin: string | undefined, sourceRef?: string): Promise<string | undefined> => withStore(`claims-label-${origin ?? 'null'}-${sourceRef ? 'ref' : 'noref'}`, (store) => {
  store.add({ kind: 'health', text: 'HbA1c was 8.8', source: origin === 'owner' ? 'stated' : 'inferred', evidence: 'owner, tg-1: "my HbA1c was 8.8"', origin, source_ref: sourceRef }, AT);
  const prompt = turnMemoryPrompt(store, 'what was my HbA1c?');
  return prompt.split('\n').find((line) => line.startsWith('<claim '));
});

it('evidence label follows code-written origin: agent is labelled, owner-with-ref and unknown are unchanged, untrusted never rendered', async () => {
  const quote = 'evidence: owner, tg-1: "my HbA1c was 8.8"';
  expect(await rendered('owner', 'owner, tg-1')).toContain(`${quote} | source ref:`);
  expect(await rendered('owner', 'owner, tg-1')).not.toContain('writer-stated');
  expect(await rendered(undefined)).toContain(`| ${quote}`);
  expect(await rendered(undefined)).not.toContain('writer-stated');
  expect(await rendered('agent')).toContain('evidence (writer-stated quote, not found in the owner\'s words or shared content): owner, tg-1');
  expect(await rendered('untrusted')).toBeUndefined(); // recall already excludes untrusted rows
});
