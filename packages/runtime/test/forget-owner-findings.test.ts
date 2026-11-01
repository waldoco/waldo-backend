import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { APP_FINDING_UNCONFIRMED_DAYS_V1 } from '../../contracts/src/app/onboarding';
import { claimStore, FORGOTTEN } from '../src/memory/claims';
import { consentLedger } from '../src/onboarding/consent-ledger';
import { findingStore } from '../src/onboarding/findings';
import { episodeIndex } from '../src/channels/episodes';

let sequence = 0;
const withStorage = <T>(fn: (storage: DurableObjectStorage) => T | Promise<T>) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`owner-findings-${sequence++}`)), (_instance, state) => fn(state.storage));
type Switches = Readonly<{ lookupOffered?: boolean; agreementsOffered?: boolean; now?: () => number }>;
const stores = (storage: DurableObjectStorage, { lookupOffered = true, agreementsOffered = true, now = () => 1_000 }: Switches = {}) => {
  const claims = claimStore(storage.sql, work => storage.transactionSync(work)), consent = consentLedger(storage.sql, { lookupOffered, agreementsOffered });
  return { claims, consent, findings: findingStore(storage.sql, claims, consent, now) };
};
const DAY = 86_400_000;
// The look-up depends on the accepted notice that discloses it.
const agree = (consent: ReturnType<typeof consentLedger>, at = 1) => { consent.grant('terms', 1, at); consent.grant('privacy_notice', 1, at); return consent.grant('owner_lookup', 1, at); };
const finding = { category: 'work' as const, text: 'Product manager at Acme', source_url: 'https://acme.example/team', evidence_quote: 'Sam Rivera, product manager at Acme' };

describe('consent ledger', () => {
  it('records a grant against the current copy only, and a withdrawal as a new row', () => withStorage(storage => {
    const { consent } = stores(storage);
    expect(consent.state('owner_lookup')).toEqual({ purpose: 'owner_lookup', version: null, status: 'not_granted', granted_at: null, withdrawn_at: null, active: false });
    expect(consent.grant('owner_lookup', 2, 10)).toBe('stale_version');
    expect(consent.active('owner_lookup')).toBe(false);
    consent.grant('privacy_notice', 1, 9);
    expect(consent.grant('owner_lookup', 1, 10)).toMatchObject({ changed: true, state: { status: 'granted', version: 1, granted_at: 10, active: true } });
    expect(consent.grant('owner_lookup', 1, 11)).toMatchObject({ changed: false });
    expect(consent.withdraw('owner_lookup', 20)).toMatchObject({ changed: true, state: { status: 'withdrawn', granted_at: 10, withdrawn_at: 20, active: false } });
    expect(consent.active('owner_lookup')).toBe(false);
    expect(consent.withdraw('owner_lookup', 21).changed).toBe(false);
    expect(consent.grant('owner_lookup', 1, 30)).toMatchObject({ changed: true, state: { status: 'granted', granted_at: 30 } });
    // Nothing is rewritten: every grant and withdrawal stays as evidence.
    expect(storage.sql.exec<{ action: string }>("SELECT action FROM consent_ledger WHERE purpose = 'owner_lookup' ORDER BY id").toArray().map(row => row.action)).toEqual(['granted', 'withdrawn', 'granted']);
  }));
  it('records the 18+ attestation on the account once', () => withStorage(storage => {
    const { consent } = stores(storage);
    expect(consent.list().age_attested_18_plus).toBe(false);
    consent.attestAge(5); consent.attestAge(6);
    expect(consent.list()).toMatchObject({ age_attested_18_plus: true });
    expect(consent.list().consents.map(row => row.purpose)).toEqual(['terms', 'privacy_notice', 'owner_lookup']);
    expect(storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM consent_ledger WHERE purpose = 'age_18_plus'").one().n).toBe(1);
  }));
  it('refuses the look-up until the privacy notice that discloses it is accepted', () => withStorage(storage => {
    const { consent } = stores(storage);
    expect(consent.grant('owner_lookup', 1, 10)).toBe('notice_required');
    consent.grant('terms', 1, 11);
    expect(consent.grant('owner_lookup', 1, 12)).toBe('notice_required');
    expect(consent.state('owner_lookup').status).toBe('not_granted');
    expect(storage.sql.exec("SELECT 1 FROM consent_ledger WHERE purpose = 'owner_lookup'").toArray()).toEqual([]);
    consent.grant('privacy_notice', 1, 13);
    expect(consent.grant('owner_lookup', 1, 14)).toMatchObject({ changed: true, state: { status: 'granted' } });
    expect(consent.active('owner_lookup')).toBe(true);
  }));
  it('reads the look-up as off when the notice it depends on is not live, whatever its own row says', () => withStorage(storage => {
    const { consent, findings } = stores(storage);
    agree(consent);
    // A notice row that is not the current copy, as after a copy bump: the look-up's own row is no longer enough.
    storage.sql.exec("INSERT INTO consent_ledger (purpose, action, version, at) VALUES ('privacy_notice', 'granted', 0, 2)");
    expect(consent.state('owner_lookup').status).toBe('granted');
    expect(consent.active('owner_lookup')).toBe(false);
    expect(findings.record(finding, 'Team', 3)).toBe('consent_required');
    expect(findings.lookup()).toBe('not_granted');
  }));
  it('offers no look-up while this server has it off, and a yes recorded before then stops counting', () => withStorage(storage => {
    const off = stores(storage, { lookupOffered: false });
    off.consent.grant('terms', 1, 1); off.consent.grant('privacy_notice', 1, 1);
    expect(off.consent.grant('owner_lookup', 1, 2)).toBe('not_offered');
    expect(off.consent.list()).toMatchObject({ owner_lookup_offered: false });
    expect(storage.sql.exec("SELECT 1 FROM consent_ledger WHERE purpose = 'owner_lookup'").toArray()).toEqual([]);
    const on = stores(storage);
    expect(on.consent.grant('owner_lookup', 1, 3)).toMatchObject({ changed: true });
    expect(on.consent.list()).toMatchObject({ owner_lookup_offered: true });
    expect(on.findings.record(finding, 'Team', 4)).toMatchObject({ duplicate: false });
    // Switched off again: the row stays as evidence and nothing new is recorded, but what was found stays listed for the owner
    // to forget.
    const offAgain = stores(storage, { lookupOffered: false });
    expect(offAgain.consent.active('owner_lookup')).toBe(false);
    expect(offAgain.findings.record({ ...finding, text: 'Runs 10Ks' }, 'Team', 5)).toBe('consent_required');
    const listed = offAgain.findings.page(50);
    expect(listed.items.map(item => item.text)).toEqual([finding.text]);
    expect(offAgain.findings.forget(listed.items[0]!.finding_id, 6)).toEqual([finding.text, finding.evidence_quote]);
    expect(offAgain.findings.page(50).total).toBe(0);
  }));
  it('offers no agreements while this server holds their copy back, and the look-up goes with them', () => withStorage(storage => {
    const held = stores(storage, { agreementsOffered: false });
    expect(held.consent.grant('terms', 1, 1)).toBe('not_offered');
    expect(held.consent.grant('privacy_notice', 1, 1)).toBe('not_offered');
    expect(held.consent.grant('owner_lookup', 1, 1)).toBe('not_offered');
    expect(held.consent.list()).toMatchObject({ agreements_offered: false, owner_lookup_offered: false });
    expect(storage.sql.exec('SELECT 1 FROM consent_ledger').toArray()).toEqual([]);
    // A yes recorded while the copy was offered stops counting once it is held back again; the rows stay as evidence.
    agree(stores(storage).consent);
    const again = stores(storage, { agreementsOffered: false });
    expect(again.consent.agreed()).toBe(false);
    expect(again.consent.active('owner_lookup')).toBe(false);
    expect(again.consent.state('terms').status).toBe('granted');
    expect(stores(storage).consent.agreed()).toBe(true);
  }));
});

describe('owner findings', () => {
  it('refuses a finding without live look-up consent, so a withdrawal mid-turn wins', () => withStorage(storage => {
    const { consent, findings } = stores(storage);
    expect(findings.record(finding, 'Team', 1)).toBe('consent_required');
    agree(consent);
    expect(findings.record(finding, 'Team', 2)).toMatchObject({ duplicate: false });
    consent.withdraw('owner_lookup', 3);
    expect(findings.record({ ...finding, text: 'Runs 10Ks' }, 'Team', 4)).toBe('consent_required');
    // The ledger alone erases nothing: a withdrawal erases in its own commit (below).
    expect(findings.page(50).total).toBe(1);
  }));
  it('keeps what was found listed and forgettable after a notice bump stops the look-up counting', () => withStorage(storage => {
    const { consent, findings } = stores(storage);
    agree(consent);
    const { id } = findings.record(finding, 'Team', 2) as { id: string };
    storage.sql.exec("INSERT INTO consent_ledger (purpose, action, version, at) VALUES ('privacy_notice', 'granted', 0, 3)");
    expect(findings.lookup()).toBe('not_granted');
    expect(findings.page(50)).toMatchObject({ total: 1, items: [{ finding_id: id, state: 'unconfirmed' }] });
    expect(findings.forget(id, 4)).toEqual([finding.text, finding.evidence_quote]);
    expect(findings.page(50).total).toBe(0);
  }));
  it('deletes an unconfirmed finding 30 days after it was found, keeps one the owner decided, and bars nothing', () => withStorage(storage => {
    const found = 5 * DAY;
    let clock = found;
    const { consent, findings } = stores(storage, { now: () => clock });
    agree(consent);
    const left = findings.record(finding, 'Team', found) as { id: string };
    const kept = findings.record({ ...finding, text: 'Based in Pune', category: 'based_in' }, 'Team', found) as { id: string };
    findings.decide(kept.id, { action: 'keep' }, found + DAY);
    clock = found + APP_FINDING_UNCONFIRMED_DAYS_V1 * DAY - 1;
    expect(findings.page(50).total).toBe(2);
    clock += 1;
    // The owner object builds the store when it wakes, alarms included, so expiry does not wait for the owner to look.
    stores(storage, { now: () => clock });
    expect(storage.sql.exec<{ id: string }>('SELECT id FROM owner_findings').toArray().map(row => row.id)).toEqual([kept.id]);
    expect(findings.page(50).items.map(item => item.finding_id)).toEqual([kept.id]);
    expect(findings.get(left.id)).toBeNull();
    expect(findings.decide(left.id, { action: 'keep' }, clock)).toBe('not_found');
    // Expiry is not the owner's no: the same page found again is recorded afresh.
    expect(findings.record(finding, 'Team', clock)).toMatchObject({ duplicate: false });
  }));
  it('records a page found again after its finding expired as a new finding, even before anything read the old one', () => withStorage(storage => {
    let clock = DAY;
    const { consent, findings } = stores(storage, { now: () => clock });
    agree(consent);
    const old = findings.record(finding, 'Team', clock) as { id: string };
    clock += APP_FINDING_UNCONFIRMED_DAYS_V1 * DAY;
    const again = findings.record(finding, 'Team', clock) as { id: string; duplicate: boolean };
    expect(again.duplicate).toBe(false);
    expect(findings.page(50).items).toMatchObject([{ finding_id: again.id, found_at: clock }]);
    expect(again.id).not.toBe(old.id);
  }));
  it('keeps one finding per page and fact, and pages newest first', () => withStorage(storage => {
    const { consent, findings } = stores(storage);
    agree(consent);
    const first = findings.record(finding, 'Team', 1);
    expect(findings.record({ ...finding, text: '  product MANAGER at acme ' }, 'Team', 2)).toEqual({ id: (first as { id: string }).id, duplicate: true });
    findings.record({ ...finding, text: 'Spoke at JSConf', category: 'public_work' }, 'Team', 3);
    findings.record({ ...finding, text: 'Based in Pune', category: 'based_in' }, 'Team', 4);
    const one = findings.page(2);
    expect(one.items.map(item => item.text)).toEqual(['Based in Pune', 'Spoke at JSConf']);
    expect(one.total).toBe(3);
    expect(findings.page(2, one.next_cursor!).items.map(item => item.text)).toEqual(['Product manager at Acme']);
  }));
  it('turns a kept or corrected finding into an owner claim, and forgetting it removes both', () => withStorage(storage => {
    const { claims, consent, findings } = stores(storage);
    agree(consent);
    const { id } = findings.record(finding, 'Team', 1) as { id: string };
    expect(claims.claims()).toHaveLength(0);
    expect(findings.decide(id, { action: 'keep' }, 2)).toBe('kept');
    expect(claims.claims()).toMatchObject([{ text: 'Product manager at Acme', origin: 'owner', source: 'confirmed', verification_status: 'owner-grounded' }]);
    expect(findings.decide(id, { action: 'correct', text: 'Product lead at Acme' }, 3)).toBe('corrected');
    expect(claims.claims().map(claim => claim.text)).toEqual(['Product lead at Acme']);
    expect(findings.get(id)).toMatchObject({ state: 'corrected', text: 'Product lead at Acme', source: { url: finding.source_url }, decided_at: 3 });
    expect(findings.texts(id)).toEqual(['Product lead at Acme', finding.evidence_quote]);
    expect(findings.forget(id, 4)).toEqual(['Product lead at Acme', finding.evidence_quote]);
    expect(findings.get(id)).toBeNull();
    expect(claims.claims()).toHaveLength(0);
    // The barrier refuses the same fact when a later search finds it again.
    expect(findings.record({ ...finding, text: 'Product lead at Acme' }, 'Team', 5)).toBe('forgotten');
    expect(findings.forget(id, 6)).toBe('not_found');
  }));
  it('drops a kept finding whose claim the owner forgot through memory', () => withStorage(storage => {
    const { claims, consent, findings } = stores(storage);
    agree(consent);
    const { id } = findings.record(finding, 'Team', 1) as { id: string };
    findings.decide(id, { action: 'keep' }, 2);
    claims.forget(claims.claims()[0]!.id);
    expect(findings.get(id)).toBeNull();
  }));
  it('is reached by a literal forget of a topic it carries', () => withStorage(storage => {
    const { claims, consent, findings } = stores(storage);
    agree(consent);
    findings.record(finding, 'Team', 1);
    findings.record({ ...finding, text: 'Based in Pune', category: 'based_in', evidence_quote: 'Pune', source_url: 'https://samrivera.dev/about' }, 'About', 2);
    const purge = claims.purge([], new Date(3).toISOString(), ['Acme']);
    expect(purge.ready).toBe(true);
    expect(storage.sql.exec<{ text: string }>('SELECT text FROM owner_findings ORDER BY found_at').toArray().map(row => row.text)).toEqual(['Based in Pune']);
    expect(findings.page(50).items.map(item => item.text)).toEqual(['Based in Pune']);
    expect(storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM owner_findings WHERE text LIKE '%Acme%' OR source_url LIKE '%acme%'").one().n).toBe(0);
  }));
  it('erases every finding, and any claim one became, when the owner withdraws', () => withStorage(storage => {
    const { claims, consent, findings } = stores(storage);
    agree(consent);
    const { id } = findings.record(finding, 'Team', 1) as { id: string };
    findings.record({ ...finding, text: 'Based in Pune', category: 'based_in' }, 'Team', 2);
    findings.decide(id, { action: 'keep' }, 3);
    const erased = findings.eraseAll(4);
    expect(erased.erased).toBe(2);
    expect([...erased.texts].sort()).toEqual(['Based in Pune', 'Product manager at Acme', finding.evidence_quote].sort());
    expect(storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM owner_findings').one().n).toBe(0);
    expect(claims.allClaims()).toHaveLength(0);
  }));
  it('bars what a withdrawal erased, so a later yes and the same search cannot bring it back', () => withStorage(storage => {
    const { consent, findings } = stores(storage);
    agree(consent);
    findings.record(finding, 'Team', 1);
    storage.transactionSync(() => { consent.withdraw('owner_lookup', 2); findings.eraseAll(2); });
    expect(consent.grant('owner_lookup', 1, 3)).toMatchObject({ changed: true });
    expect(findings.record(finding, 'Team', 4)).toBe('forgotten');
    expect(findings.record({ ...finding, text: 'Product manager at Acme, Pune' }, 'Team', 5)).toBe('forgotten');
    expect(findings.page(50).total).toBe(0);
  }));
  it('keeps a claim the owner stated themselves when a finding that only pointed at it is erased', () => withStorage(storage => {
    const { claims, consent, findings } = stores(storage);
    agree(consent);
    claims.add({ kind: 'fact', text: 'Product manager at Acme', source: 'stated', evidence: 'I am a product manager at Acme', origin: 'owner', source_ref: 'owner, m1' }, new Date(1).toISOString());
    const { id } = findings.record(finding, 'Team', 2) as { id: string };
    expect(findings.decide(id, { action: 'keep' }, 3)).toBe('kept');
    expect(claims.claims()).toHaveLength(1);
    storage.transactionSync(() => findings.eraseAll(4));
    expect(claims.claims().map(claim => [claim.text, claim.source_ref])).toEqual([['Product manager at Acme', 'owner, m1']]);
    expect(findings.page(50).total).toBe(0);
  }));
  it("purges a kept finding's claim from derived memory, not only the claims table", () => withStorage(storage => {
    const { claims, consent, findings } = stores(storage);
    agree(consent);
    const { id } = findings.record(finding, 'Team', 1) as { id: string };
    findings.decide(id, { action: 'correct', text: 'Product lead at Acme' }, 2);
    episodeIndex(storage.sql).add('e1', 'waldo', 'Noted: Product lead at Acme.', 3);
    storage.transactionSync(() => findings.eraseAll(4));
    expect(storage.sql.exec<{ text: string }>('SELECT text FROM episodes').toArray().map(row => row.text)).toEqual([`Noted: ${FORGOTTEN}.`]);
    expect(storage.sql.exec('SELECT 1 FROM purge_pending').toArray()).toEqual([]);
    expect(claims.allClaims()).toHaveLength(0);
  }));
});

// A welcome node may rest on Waldo's read of look-up findings. The finding is outside text the owner has not confirmed, so the
// read goes when the finding does: forgotten, corrected, withdrawn with the look-up, or expired unconfirmed.
describe('welcome reads resting on findings', () => {
  const at = new Date(1_000).toISOString();
  const seed = (storage: DurableObjectStorage, now: { at: number }) => {
    const { claims, consent, findings } = stores(storage, { now: () => now.at });
    agree(consent);
    const id = (findings.record(finding, 'Team', 1_000) as { id: string }).id;
    const other = (findings.record({ ...finding, text: 'Speaks at design meetups', evidence_quote: 'Sam Rivera, product manager at Acme' }, 'Team', 1_000) as { id: string }).id;
    const support = (text: string, ref: string, origin = 'untrusted') => { claims.add({ kind: 'observation', text, source: 'inferred', evidence: 'welcome build', origin, source_ref: ref }, at); return claims.allClaims().at(-1)!.id; };
    const web = support('Works in product at Acme.', `welcome:web:${id}`), calendar = support('A weekly product review recurs.', 'welcome:calendar:evt_a');
    const kept = support('Speaks at meetups.', `welcome:web:${other}`);
    const lone = claims.saveNode({ id: null, domain: 'work', label: 'Product role at Acme', summary: 'Works in product.', strength: 0.5, status: 'active', supporting_spots: [web] }, at);
    const shared = claims.saveNode({ id: null, domain: 'work', label: 'Runs product reviews', summary: 'Reviews product weekly.', strength: 0.5, status: 'active', supporting_spots: [web, calendar] }, at);
    const meetups = claims.saveNode({ id: null, domain: 'interests', label: 'Design meetups', summary: 'Goes to design meetups.', strength: 0.5, status: 'active', supporting_spots: [kept] }, at);
    return { claims, findings, id, other, web, calendar, lone, shared, meetups };
  };
  const live = (claims: ReturnType<typeof claimStore>, id: number) => claims.allClaims().some(claim => claim.id === id && (claim.status === 'active' || claim.status === 'promoted'));
  const nodeIds = (claims: ReturnType<typeof claimStore>) => claims.nodes().map(node => node.id);

  it('a forgotten finding takes the read on it and every node that read held up, whose words may carry it', () => withStorage(storage => {
    const s = seed(storage, { at: 2_000 });
    s.findings.forget(s.id, 2_000);
    expect(live(s.claims, s.web)).toBe(false);
    expect(live(s.claims, s.calendar)).toBe(true);
    expect(nodeIds(s.claims)).toEqual([s.meetups]);
  }));

  it('a corrected finding takes the read on its old words; a kept one leaves it standing', () => withStorage(storage => {
    const s = seed(storage, { at: 2_000 });
    expect(s.findings.decide(s.other, { action: 'keep' }, 2_000)).toBe('kept');
    expect(nodeIds(s.claims)).toContain(s.meetups);
    expect(s.findings.decide(s.id, { action: 'correct', text: 'Design lead at Acme' }, 2_000)).toBe('corrected');
    expect(live(s.claims, s.web)).toBe(false);
    expect(nodeIds(s.claims)).toEqual([s.meetups]);
  }));

  it('withdrawing the look-up takes every read on a finding with it', () => withStorage(storage => {
    const s = seed(storage, { at: 2_000 });
    s.findings.eraseAll(2_000);
    expect(nodeIds(s.claims)).toEqual([]);
  }));

  it('a finding that expires unconfirmed takes its read too', () => withStorage(storage => {
    const now = { at: 2_000 };
    const s = seed(storage, now);
    now.at = 1_000 + APP_FINDING_UNCONFIRMED_DAYS_V1 * DAY;
    expect(s.findings.page(10).total).toBe(0);
    expect(nodeIds(s.claims)).toEqual([]);
  }));
});
