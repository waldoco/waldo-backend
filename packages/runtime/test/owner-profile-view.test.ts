import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { barrierMemory } from '../src/context-composer/forget-barrier';
import { applyClaimOps, claimStore, turnMemoryPrompt, type ClaimStore } from '../src/memory/claims';
import { ownerProfilePrompt } from '../src/memory/owner-profile';
import { consentLedger } from '../src/onboarding/consent-ledger';
import { findingStore } from '../src/onboarding/findings';
import { firstRun, type FirstRunHost } from '../src/onboarding/first-run';

// The owner profile view: every turn reads what the owner said or kept about themselves, grouped by where it came from, with
// no health number. Synthetic owner, synthetic values.
let sequence = 0;
const AT = '2026-10-26T04:00:00.000Z';
const ops = (add: unknown[]) => JSON.stringify({ add, seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null });
const owner = (storage: DurableObjectStorage) => {
  const claims = claimStore(storage.sql, work => storage.transactionSync(work));
  const consent = consentLedger(storage.sql, { lookupOffered: true, agreementsOffered: true });
  // Saving answers reads nothing from the host: it writes claims and pins them.
  const setup = firstRun(storage.sql, consent, claims, {} as FirstRunHost, () => 1_000);
  return { storage, claims, consent, setup, findings: findingStore(storage.sql, claims, consent, () => 2_000) };
};
type Owner = ReturnType<typeof owner>;
const withOwner = <T>(work: (owner: Owner) => T | Promise<T>) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`owner-profile-view-${sequence++}`)), (_instance, state) => work(owner(state.storage)));
const say = (store: ClaimStore, kind: string, text: string, turn: string) =>
  applyClaimOps(store, ops([{ kind, text, source: 'stated', evidence: `owner, ${turn}: "${text}"`, touches_forgotten: false }]), AT, `owner, ${turn}`, undefined, { owner: text });
const block = (prompt: string) => prompt.slice(prompt.indexOf('<owner_profile>'), prompt.indexOf('</owner_profile>') + '</owner_profile>'.length);
const keptFinding = (o: Owner) => {
  o.consent.grant('terms', 1, 1); o.consent.grant('privacy_notice', 1, 1); o.consent.grant('owner_lookup', 1, 1);
  const recorded = o.findings.record({ category: 'work', text: 'Product lead at Northwind Labs', source_url: 'https://northwind.example/team', evidence_quote: 'Asha Rao, product lead' }, 'Team', 2_000);
  if (typeof recorded === 'string') throw new Error(recorded);
  expect(o.findings.decide(recorded.id, { action: 'keep' }, 3_000)).toBe('kept');
};

it('is assembled from setup answers, the owner\'s words and a kept look-up finding, in that trust order', () => withOwner(o => {
  say(o.claims, 'preference', 'Likes plans written as a short list', 'tg-1');
  o.setup.saveAnswers({ request_id: 'r1', name: 'Asha', day: { shape: 'focus', own_words: 'Mornings are for writing' }, wearable: 'samsung' });
  keptFinding(o);
  say(o.claims, 'goal', 'Wants to finish the grant draft this month', 'tg-2');
  const profile = block(ownerProfilePrompt(o.claims, 'what first?'));
  const order = ['Wants to be called Asha', 'Needs long stretches of focus', 'Wears a Samsung Galaxy Watch.', 'Likes plans written as a short list',
    'Wants to finish the grant draft this month', 'Product lead at Northwind Labs'];
  for (const text of order) expect(profile, text).toContain(text);
  // Setup answers lead, then the owner's other words newest first, then what they kept from the look-up.
  const at = order.map(text => profile.indexOf(text));
  expect(at[0]).toBeLessThan(at[1]!); expect(at[1]).toBeLessThan(at[2]!);
  expect(at[2]).toBeLessThan(at[4]!); expect(at[4]).toBeLessThan(at[3]!); expect(at[3]).toBeLessThan(at[5]!);
  expect(profile.indexOf('Kept from the web look-up')).toBeLessThan(at[5]!);
  expect(profile.indexOf('Kept from the web look-up')).toBeGreaterThan(at[3]!);
  // Each line carries the claim id remember's replaces_id takes.
  expect(profile).toMatch(/- \[c\d+ · owner-grounded\] Likes plans written as a short list/);
  // Today's renderer, once setup answers are pinned, shows pinned lines only, so this unpinned owner fact leaves every turn.
  expect(block(turnMemoryPrompt(o.claims, 'what first?'))).not.toContain('Likes plans written as a short list');
}));

it('an unconfirmed finding, an inferred read and an untrusted claim never enter the profile', () => withOwner(o => {
  o.consent.grant('terms', 1, 1); o.consent.grant('privacy_notice', 1, 1); o.consent.grant('owner_lookup', 1, 1);
  o.findings.record({ category: 'work', text: 'Speaker at a design meetup', source_url: 'https://meetup.example/talks', evidence_quote: 'Asha Rao spoke' }, 'Talks', 2_000);
  applyClaimOps(o.claims, ops([{ kind: 'fact', text: 'Seems to prefer mornings', source: 'inferred', evidence: 'pattern across turns', touches_forgotten: false }]), AT, 'owner, tg-9', undefined, { owner: 'hello' });
  o.claims.add({ kind: 'fact', text: 'Works at a bank, says a mail', source: 'stated', evidence: 'mail', origin: 'untrusted', source_ref: 'welcome:gmail:t1' }, AT);
  const profile = block(ownerProfilePrompt(o.claims, 'hi'));
  for (const text of ['Speaker at a design meetup', 'Seems to prefer mornings', 'Works at a bank']) expect(profile).not.toContain(text);
}));

it('an owner correction wins: only the corrected words are shown, under the new claim id', () => withOwner(o => {
  say(o.claims, 'fact', 'Lives in Pune', 'tg-1');
  const old = o.claims.claims().find(claim => claim.text === 'Lives in Pune')!;
  expect(o.claims.correct(old.id, { kind: 'fact', text: 'Lives in Bengaluru now', source: 'stated', evidence: 'owner, tg-2: "I moved to Bengaluru"', origin: 'owner', source_ref: 'owner, tg-2' }, AT)).toBe(true);
  o.setup.saveAnswers({ request_id: 'r1', wearable: 'apple' });
  o.setup.saveAnswers({ request_id: 'r2', wearable: 'oura' });
  const profile = block(ownerProfilePrompt(o.claims, 'where do I live?'));
  expect(profile).toContain('Lives in Bengaluru now');
  expect(profile).not.toContain('Lives in Pune');
  expect(profile).toContain('Wears an Oura Ring.');
  expect(profile).not.toContain('Apple Watch');
  expect(profile).not.toContain(`[c${old.id} `);
}));

it('a forgotten topic and a forgotten finding are excluded', () => withOwner(o => {
  say(o.claims, 'fact', 'Training for the Kaveri trail race', 'tg-1');
  say(o.claims, 'preference', 'Prefers calls after lunch', 'tg-2');
  keptFinding(o);
  const finding = o.findings.page(10).items[0]!;
  o.findings.forget(finding.finding_id, 4_000);
  // The owner turn reads memory through the held-topic view (owner-turn.ts promptMemory).
  const held = barrierMemory(o.claims, () => ['Kaveri']);
  const profile = block(ownerProfilePrompt(held, 'plans?'));
  expect(profile).toContain('Prefers calls after lunch');
  expect(profile).not.toContain('Kaveri');
  expect(profile).not.toContain('Northwind');
}));

it('carries no health number: a stated reading stays out, a health pattern in words stays in, and the gap is said', () => withOwner(o => {
  say(o.claims, 'health', 'On 22 Oct said resting HR was 52', 'tg-1');
  say(o.claims, 'health', 'Slept 5 hours last night', 'tg-2');
  say(o.claims, 'health', 'Sleeps badly before long flights', 'tg-3');
  say(o.claims, 'routine', 'Gym at 7 most weekdays', 'tg-4');
  // Today's renderer carries the reading on every turn.
  expect(block(turnMemoryPrompt(o.claims, 'hi'))).toContain('resting HR was 52');
  const profile = block(ownerProfilePrompt(o.claims, 'hi'));
  expect(profile).not.toContain('52');
  expect(profile).not.toMatch(/Slept \d/);
  expect(profile).toContain('Sleeps badly before long flights');
  // A number that is not a health value is the owner's words like any other.
  expect(profile).toContain('Gym at 7 most weekdays');
  expect(profile).toMatch(/2 health readings the owner stated are left out/);
  // Recall still finds what they said.
  expect(o.claims.recall('resting HR').some(claim => claim.text.includes('52'))).toBe(true);
}));

it('pins come first within the room; a line is never cut, and what does not fit is counted', () => withOwner(o => {
  for (let i = 0; i < 40; i++) say(o.claims, 'fact', `Synthetic detail ${i} about the owner's week and their work`, `tg-${i}`);
  o.setup.saveAnswers({ request_id: 'r1', name: 'Asha' });
  const prompt = ownerProfilePrompt(o.claims, 'hi', 900);
  expect(prompt.length).toBeLessThanOrEqual(900);
  const profile = block(prompt);
  expect(profile).toContain('Wants to be called Asha');
  expect(profile).toContain('Synthetic detail 39');
  expect(profile).not.toContain('Synthetic detail 0 ');
  expect(profile).toMatch(/\d+ more owner facts are not shown here; search memory to recall them/);
  for (const line of profile.split('\n').filter(line => line.startsWith('- ['))) expect(line).toMatch(/the owner's week and their work$|Asha$/);
  // Unbounded, the profile still holds at most the two pinned blocks' budget.
  expect(block(ownerProfilePrompt(o.claims, 'hi')).length).toBeLessThanOrEqual(4_000 + 400);
}));

it('keeps the constellation block as today', () => withOwner(o => {
  say(o.claims, 'fact', 'Runs a small studio', 'tg-1');
  const support = o.claims.claims().find(claim => claim.text === 'Runs a small studio')!;
  o.claims.saveNode({ id: null, domain: 'work', label: 'Studio owner', summary: 'Runs their own small studio', strength: 1, status: 'active', supporting_spots: [support.id] }, AT);
  const today = turnMemoryPrompt(o.claims, 'hi'), view = ownerProfilePrompt(o.claims, 'hi');
  const tail = (text: string) => text.slice(text.indexOf('<owner_constellation>'));
  expect(view).toContain('<owner_constellation>');
  expect(tail(view)).toBe(tail(today));
}));
