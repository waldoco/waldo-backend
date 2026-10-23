import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { claimStore, FORGOTTEN } from '../src/memory/claims';
import { consentLedger } from '../src/onboarding/consent-ledger';
import { findingStore } from '../src/onboarding/findings';
import { episodeIndex } from '../src/channels/episodes';

let sequence = 0;
const withStorage = <T>(fn: (storage: DurableObjectStorage) => T | Promise<T>) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`owner-findings-${sequence++}`)), (_instance, state) => fn(state.storage));
const stores = (storage: DurableObjectStorage, lookupOffered = true) => {
  const claims = claimStore(storage.sql, work => storage.transactionSync(work)), consent = consentLedger(storage.sql, { lookupOffered });
  return { claims, consent, findings: findingStore(storage.sql, claims, consent) };
};
// The look-up depends on the accepted notice that discloses it.
const agree = (consent: ReturnType<typeof consentLedger>, at = 1) => { consent.grant('terms', 1, at); consent.grant('privacy_notice', 1, at); return consent.grant('owner_lookup', 1, at); };
const finding = { category: 'work' as const, text: 'Product manager at Acme', source_url: 'https://acme.example/team', evidence_quote: 'Sam Rivera, product manager at Acme' };

describe('consent ledger', () => {
  it('records a grant against the current copy only, and a withdrawal as a new row', () => withStorage(storage => {
    const { consent } = stores(storage);
    expect(consent.state('owner_lookup')).toEqual({ purpose: 'owner_lookup', version: null, status: 'not_granted', granted_at: null, withdrawn_at: null });
    expect(consent.grant('owner_lookup', 2, 10)).toBe('stale_version');
    expect(consent.active('owner_lookup')).toBe(false);
    consent.grant('privacy_notice', 1, 9);
    expect(consent.grant('owner_lookup', 1, 10)).toMatchObject({ changed: true, state: { status: 'granted', version: 1, granted_at: 10 } });
    expect(consent.grant('owner_lookup', 1, 11)).toMatchObject({ changed: false });
    expect(consent.withdraw('owner_lookup', 20)).toMatchObject({ changed: true, state: { status: 'withdrawn', granted_at: 10, withdrawn_at: 20 } });
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
    const off = stores(storage, false);
    off.consent.grant('terms', 1, 1); off.consent.grant('privacy_notice', 1, 1);
    expect(off.consent.grant('owner_lookup', 1, 2)).toBe('not_offered');
    expect(off.consent.list()).toMatchObject({ owner_lookup_offered: false });
    expect(storage.sql.exec("SELECT 1 FROM consent_ledger WHERE purpose = 'owner_lookup'").toArray()).toEqual([]);
    const on = stores(storage, true);
    expect(on.consent.grant('owner_lookup', 1, 3)).toMatchObject({ changed: true });
    expect(on.consent.list()).toMatchObject({ owner_lookup_offered: true });
    expect(on.findings.record(finding, 'Team', 4)).toMatchObject({ duplicate: false });
    // Switched off again: the row stays as evidence, but nothing is recorded or shown under it.
    const offAgain = stores(storage, false);
    expect(offAgain.consent.active('owner_lookup')).toBe(false);
    expect(offAgain.findings.record({ ...finding, text: 'Runs 10Ks' }, 'Team', 5)).toBe('consent_required');
    expect(offAgain.findings.page(50).total).toBe(0);
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
    expect(findings.page(50)).toEqual({ items: [], total: 0, next_cursor: null });
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
    expect(storage.sql.exec<{ text: string }>('SELECT text FROM owner_findings ORDER BY found_at').toArray().map(row => row.text)).toEqual([`Product manager at ${FORGOTTEN}`, 'Based in Pune']);
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
