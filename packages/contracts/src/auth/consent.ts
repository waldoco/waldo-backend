import { z } from 'zod';

// ADR-0073 consent contract — the GDPR-baseline floor, applied to every user regardless of
// geography (geo-exclusion is market filtering, not a data-protection boundary). The record
// is per-source, per-purpose, versioned, withdrawable, and 18+-attested; it shapes
// migration 001 and must exist before it. ADR-0073 pins those properties, not field names —
// the names here are authored against the pinned properties.

// Two record classes: the baseline health-processing consent and the separate explicit
// revocable Telegram-content consent. Until a telegram_content grant exists, Telegram
// carries content-free nudge + deep-link only.
export const consentClassSchema = z.enum(['health_processing', 'telegram_content']);
export type ConsentClass = z.infer<typeof consentClassSchema>;

// Withdrawal is a first-class state transition, never row deletion — the grant's version
// and timestamp survive as audit trail. Re-grant after withdrawal is a new record, so at
// most one non-withdrawn record exists per (class, source, purpose).
export const consentStatusSchema = z.enum(['granted', 'withdrawn']);
export type ConsentStatus = z.infer<typeof consentStatusSchema>;

export const consentRecordSchema = z
  .strictObject({
    user_id: z.string().min(1),
    consent_class: consentClassSchema,
    // Source vocabulary is owned by the connector/adapter layer; the contract pins only
    // that consent is scoped per source — a blanket grant cannot parse.
    source: z.string().min(1).max(100),
    purpose: z.string().min(1).max(200),
    // Consent-copy version captured at grant time, so a grant is auditable against the
    // canonical privacy-claims page it was obtained under.
    version: z.int().positive(),
    status: consentStatusSchema,
    granted_at: z.int().nonnegative(),
    withdrawn_at: z.int().nonnegative().nullable(),
    // DPDP hard 18+ gate: an un-attested or under-18 record is unrepresentable — signup
    // rejects before a record can exist.
    age_attested_18_plus: z.literal(true),
  })
  .refine((r) => (r.status === 'withdrawn') === (r.withdrawn_at !== null), {
    error: 'withdrawn status and withdrawn_at must agree',
    path: ['withdrawn_at'],
  })
  .refine((r) => r.withdrawn_at === null || r.withdrawn_at >= r.granted_at, {
    error: 'withdrawal cannot precede grant',
    path: ['withdrawn_at'],
  });
export type ConsentRecord = z.infer<typeof consentRecordSchema>;

// The recorded withdrawal transition. Withdrawal stops processing for that purpose AND
// routes into the ADR-0055 deletion path; the literal(true) makes a withdrawal that skips
// the deletion path unrepresentable.
export const consentWithdrawalSchema = z.strictObject({
  user_id: z.string().min(1),
  consent_class: consentClassSchema,
  source: z.string().min(1).max(100),
  purpose: z.string().min(1).max(200),
  withdrawn_at: z.int().nonnegative(),
  deletion_routed: z.literal(true),
});
export type ConsentWithdrawal = z.infer<typeof consentWithdrawalSchema>;

// Deterministic form of the two ADR-0073-mandated checks: consent-before-first-health-write
// (middleware) and the outbox pre-send re-check (ADR-0054 — a run started pre-withdrawal
// cannot deliver post-withdrawal). Withdrawal transitions the record rather than deleting
// it, so a granted record over the exact (user, class, source, purpose) tuple is the whole rule.
export function hasActiveConsent(
  records: readonly ConsentRecord[],
  userId: string,
  consentClass: ConsentClass,
  source: string,
  purpose: string,
): boolean {
  return records.some(
    (r) =>
      r.user_id === userId &&
      r.consent_class === consentClass &&
      r.source === source &&
      r.purpose === purpose &&
      r.status === 'granted',
  );
}
