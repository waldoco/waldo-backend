// ADR-0073 — GDPR-baseline consent model (withdrawal routes into the ADR-0055 deletion
// path; the outbox re-check is ADR-0054's concurrent lane).
// Invariants under test: every record is per-source, per-purpose, versioned, withdrawable,
// and 18+-attested; withdrawal is a first-class state transition preserving the grant audit
// trail; withdrawn consent stops processing (hasActiveConsent); a withdrawal that skips the
// deletion path is unrepresentable.
// Failure modes caught: blanket-consent collapse, missing version/purpose drift, under-18
// records, withdrawal modeled as row deletion, cross-purpose/source/class consent leakage.
// The consent-before-first-health-write middleware test and the outbox pre-send re-check
// exercise live middleware and are runtime-scope; hasActiveConsent is their contract form.
import { describe, expect, it } from 'vitest';
import {
  consentClassSchema,
  consentRecordSchema,
  consentStatusSchema,
  consentWithdrawalSchema,
  hasActiveConsent,
} from './consent';

const baseGrant = {
  user_id: 'user-1',
  consent_class: 'health_processing',
  source: 'whoop',
  purpose: 'daily_readiness_briefing',
  version: 1,
  status: 'granted',
  granted_at: 1_700_000_000_000,
  withdrawn_at: null,
  age_attested_18_plus: true,
} as const;

const baseWithdrawal = {
  user_id: 'user-1',
  consent_class: 'health_processing',
  source: 'whoop',
  purpose: 'daily_readiness_briefing',
  withdrawn_at: 1_700_000_600_000,
  deletion_routed: true,
} as const;

describe('consentClass', () => {
  it('is exactly the two record classes, in order', () => {
    expect(consentClassSchema.options).toEqual(['health_processing', 'telegram_content']);
  });

  it('rejects an unknown class', () => {
    expect(consentClassSchema.safeParse('marketing').success).toBe(false);
  });
});

describe('consentStatus', () => {
  it('is exactly granted and withdrawn, in order', () => {
    expect(consentStatusSchema.options).toEqual(['granted', 'withdrawn']);
  });

  it('rejects a limbo status', () => {
    expect(consentStatusSchema.safeParse('pending').success).toBe(false);
  });
});

describe('consentRecord', () => {
  it('accepts a granted per-source per-purpose versioned attested record', () => {
    expect(consentRecordSchema.safeParse(baseGrant).success).toBe(true);
  });

  it('accepts a withdrawn record that preserves the grant audit trail', () => {
    const withdrawn = consentRecordSchema.parse({
      ...baseGrant,
      status: 'withdrawn',
      withdrawn_at: 1_700_000_600_000,
    });
    expect(withdrawn.version).toBe(1);
    expect(withdrawn.granted_at).toBe(1_700_000_000_000);
  });

  it('rejects a record missing purpose (per-purpose is load-bearing)', () => {
    const { purpose: _purpose, ...withoutPurpose } = baseGrant;
    expect(consentRecordSchema.safeParse(withoutPurpose).success).toBe(false);
  });

  it('rejects a record missing version (versioning is load-bearing)', () => {
    const { version: _version, ...withoutVersion } = baseGrant;
    expect(consentRecordSchema.safeParse(withoutVersion).success).toBe(false);
  });

  it('rejects a blanket-consent boolean shape', () => {
    expect(consentRecordSchema.safeParse({ user_id: 'user-1', consented: true }).success).toBe(
      false,
    );
  });

  it('rejects an empty source', () => {
    expect(consentRecordSchema.safeParse({ ...baseGrant, source: '' }).success).toBe(false);
  });

  it('rejects version zero', () => {
    expect(consentRecordSchema.safeParse({ ...baseGrant, version: 0 }).success).toBe(false);
  });

  it('rejects a false 18+ attestation (under-18 unrepresentable)', () => {
    expect(
      consentRecordSchema.safeParse({ ...baseGrant, age_attested_18_plus: false }).success,
    ).toBe(false);
  });

  it('rejects a missing 18+ attestation', () => {
    const { age_attested_18_plus: _age, ...withoutAge } = baseGrant;
    expect(consentRecordSchema.safeParse(withoutAge).success).toBe(false);
  });

  it('rejects a granted record carrying withdrawn_at', () => {
    expect(
      consentRecordSchema.safeParse({ ...baseGrant, withdrawn_at: 1_700_000_600_000 }).success,
    ).toBe(false);
  });

  it('rejects a withdrawn record with null withdrawn_at', () => {
    expect(consentRecordSchema.safeParse({ ...baseGrant, status: 'withdrawn' }).success).toBe(
      false,
    );
  });

  it('rejects a withdrawal preceding the grant', () => {
    expect(
      consentRecordSchema.safeParse({
        ...baseGrant,
        status: 'withdrawn',
        withdrawn_at: baseGrant.granted_at - 1,
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown extra field', () => {
    expect(consentRecordSchema.safeParse({ ...baseGrant, notes: 'x' }).success).toBe(false);
  });
});

describe('consentWithdrawal', () => {
  it('accepts a deletion-routed withdrawal', () => {
    expect(consentWithdrawalSchema.safeParse(baseWithdrawal).success).toBe(true);
  });

  it('rejects a withdrawal not routed into the deletion path', () => {
    expect(
      consentWithdrawalSchema.safeParse({ ...baseWithdrawal, deletion_routed: false }).success,
    ).toBe(false);
  });

  it('rejects a withdrawal missing purpose', () => {
    const { purpose: _purpose, ...withoutPurpose } = baseWithdrawal;
    expect(consentWithdrawalSchema.safeParse(withoutPurpose).success).toBe(false);
  });
});

describe('hasActiveConsent', () => {
  const granted = consentRecordSchema.parse(baseGrant);
  const withdrawn = consentRecordSchema.parse({
    ...baseGrant,
    status: 'withdrawn',
    withdrawn_at: 1_700_000_600_000,
  });

  it('returns true for a granted matching (class, source, purpose) triple', () => {
    expect(
      hasActiveConsent([granted], 'health_processing', 'whoop', 'daily_readiness_briefing'),
    ).toBe(true);
  });

  it('returns false after withdrawal (processing stops for that purpose)', () => {
    expect(
      hasActiveConsent([withdrawn], 'health_processing', 'whoop', 'daily_readiness_briefing'),
    ).toBe(false);
  });

  it('returns false for a different purpose (no cross-purpose leakage)', () => {
    expect(hasActiveConsent([granted], 'health_processing', 'whoop', 'fetch_alerting')).toBe(
      false,
    );
  });

  it('returns false for a different source', () => {
    expect(
      hasActiveConsent([granted], 'health_processing', 'oura', 'daily_readiness_briefing'),
    ).toBe(false);
  });

  it('health-processing consent does not authorize telegram content', () => {
    expect(
      hasActiveConsent([granted], 'telegram_content', 'whoop', 'daily_readiness_briefing'),
    ).toBe(false);
  });

  it('returns false on the empty record set', () => {
    expect(
      hasActiveConsent([], 'health_processing', 'whoop', 'daily_readiness_briefing'),
    ).toBe(false);
  });
});
