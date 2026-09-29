// Evaluator-only status ledger; source specifications remain immutable `not_run`.
// A scripted harness smoke cannot become a scored native case by filling a field.
import type { ObservedTrial } from './grading-contract';
import { prepareNativeGrade } from './grading-contract';
import { gradeNativeOutcome, type IndependentReview } from './outcome-grader';
import { verifyCaptureReceipts, type ReceiptKeys, type SealedReceipt } from './trial-provenance';
import type { IsolatedCapture } from './isolated-capture';

export type TrialStatus = 'not_run' | 'blocked_fixture' | 'harness_error' | 'review_pending' | 'failed' | 'candidate_pass_unverified';
export type TrialResult = Readonly<{case_id: string; seed: string | null; status: TrialStatus; reasons: readonly string[]; total_usd: number | null}>;
export type CapturedTrial = Readonly<{
  observed: ObservedTrial;
  isolation: Pick<IsolatedCapture, 'owners' | 'candidate_owner'>;
  receipts: readonly SealedReceipt[];
  // Runner assertion until independently reconciled to provider usage. Never an official score.
  actual_model_calls: number;
  scripted_model: boolean;
  observed_cost_usd: number | null; // estimate/receipt supplied by runner, not billing proof
}>;
const result = (case_id: string, seed: string | null, status: TrialStatus, reasons: readonly string[], total_usd: number | null): TrialResult =>
  ({ case_id, seed, status, reasons, total_usd });
export const evaluateCapturedTrial = (case_id: string, capture: CapturedTrial | null, keys: ReceiptKeys,
  review: IndependentReview | null = null): TrialResult => {
  if (!capture) return result(case_id, null, 'not_run', ['no trial capture'], null);
  const { observed } = capture;
  if (observed.case_id !== case_id || capture.scripted_model || !Number.isSafeInteger(capture.actual_model_calls) || capture.actual_model_calls < 1 ||
    capture.observed_cost_usd === null || !Number.isFinite(capture.observed_cost_usd) || capture.observed_cost_usd < 0)
    return result(case_id, observed.seed, 'harness_error', ['no valid actual-model trial or model-usage receipt'], null);
  const invalid = verifyCaptureReceipts(observed, capture.isolation, capture.receipts, keys);
  if (invalid.length) return result(case_id, observed.seed, 'harness_error', invalid, capture.observed_cost_usd);
  const prepared = prepareNativeGrade(observed);
  if (prepared.status === 'incomplete') return result(case_id, observed.seed, 'blocked_fixture', prepared.missing, capture.observed_cost_usd);
  const grade = gradeNativeOutcome(observed, review);
  const status: TrialStatus = grade.status === 'incomplete' ? 'blocked_fixture' : grade.status === 'blocked' ? 'review_pending'
    : grade.status === 'fail' ? 'failed' : 'candidate_pass_unverified';
  return result(case_id, observed.seed, status, grade.reasons, capture.observed_cost_usd);
};
