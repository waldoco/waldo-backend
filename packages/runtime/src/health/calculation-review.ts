import { z } from 'zod';
import { iso8601Schema } from '../../../contracts/src/core/error';
import { CANDIDATE_VERSIONS } from './calculations';

// Pin regenerated from exact algorithm/producer sources and synthetic vectors.
// A fingerprint is a review target, never evidence that a review happened.
export const HEALTH_CALCULATION_REVIEW_PIN = {
  algorithm_source_sha256: 'd2401520e2f694f1e8d99dbba3f4d1ce455fd387887b09247617dc79c677511b',
  vectors_sha256: '0fdbeb14d895e10b0d374be7e6569bac643438d375ba240a3f61552e6db88ff0',
} as const;
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const reviewRef = z.string().min(1).max(200);
export const healthCalculationReviewReceiptSchema = z.strictObject({
  review_ref: reviewRef,
  algorithm_source_sha256: digest,
  vectors_sha256: digest,
  formula_review_ref: reviewRef,
  privacy_review_ref: reviewRef,
  reviewed_at: iso8601Schema,
  versions: z.strictObject({
    recovery: z.literal(CANDIDATE_VERSIONS.recovery),
    form: z.literal(CANDIDATE_VERSIONS.form),
    weight: z.literal(CANDIDATE_VERSIONS.weight),
    sleep_debt: z.literal(CANDIDATE_VERSIONS.sleep_debt),
  }),
});
export type HealthCalculationReviewReceipt = z.infer<typeof healthCalculationReviewReceiptSchema>;
export const validHealthCalculationReview = (untrusted: unknown, review_ref: string): boolean => {
  const receipt = healthCalculationReviewReceiptSchema.safeParse(untrusted);
  return receipt.success && receipt.data.review_ref === review_ref
    && receipt.data.algorithm_source_sha256 === HEALTH_CALCULATION_REVIEW_PIN.algorithm_source_sha256
    && receipt.data.vectors_sha256 === HEALTH_CALCULATION_REVIEW_PIN.vectors_sha256;
};
