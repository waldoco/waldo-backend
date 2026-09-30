// Evaluator-only status ledger; source specifications remain immutable `not_run`.
// A scripted harness smoke cannot become a scored native case by filling a field.
import { inspectNativeManifest, type NativeManifest } from './native-manifest';
import { auditIsolatedWorld } from './isolated-world-audit';
import type { CapturedArtifact, ObservedTrial } from './grading-contract';
import { prepareNativeGrade } from './grading-contract';
import { gradeNativeOutcome, type IndependentReview } from './outcome-grader';
import { verifyCaptureReceipts, type ReceiptKeys, type SealedReceipt } from './trial-provenance';
import type { IsolatedCapture } from './isolated-capture';
import { reconcileTrialUsage, type UsageLine } from './usage-reconciliation';

export type TrialStatus = 'not_run' | 'blocked_fixture' | 'harness_error' | 'review_pending' | 'failed' | 'candidate_pass_unverified';
export type TrialResult = Readonly<{case_id: string; seed: string | null; status: TrialStatus; reasons: readonly string[]; total_usd: number | null}>;
export type CapturedTrial = Readonly<{
  observed: ObservedTrial;
  // Control-owner audit rows must accompany receipt-bound candidate rows.
  world_evidence?: Parameters<typeof auditIsolatedWorld>[1];
  // Evaluator-authored, trial-bound evidence. Not owner authority or model output.
  branch_adjudications?: readonly Readonly<{ case_id: string; trial_seed: string; artifact: CapturedArtifact }>[];
  isolation: Pick<IsolatedCapture, 'owners' | 'candidate_owner'>;
  receipts: readonly SealedReceipt[];
  // Runner assertion until independently reconciled to provider usage. Never an official score.
  actual_model_calls: number;
  scripted_model: boolean;
  observed_cost_usd: number | null; // legacy diagnostic only; native token receipts set null
  runner_usage: readonly UsageLine[];
  provider_usage: readonly UsageLine[]; // raw Responses capture; not independent billing proof
}>;
const result = (case_id: string, seed: string | null, status: TrialStatus, reasons: readonly string[], total_usd: number | null): TrialResult =>
  ({ case_id, seed, status, reasons, total_usd });
// Packet-only diagnostic. No typed fixture/readiness claim or native result.
export const evaluateDiagnosticPacket = (case_id: string, capture: CapturedTrial | null, keys: ReceiptKeys,
  review: IndependentReview | null = null): TrialResult => {
  if (!capture) return result(case_id, null, 'not_run', ['no trial capture'], null);
  const { observed } = capture;
  if (observed.case_id !== case_id || capture.scripted_model || !Number.isSafeInteger(capture.actual_model_calls) || capture.actual_model_calls < 1 ||
    (capture.observed_cost_usd !== null && (!Number.isFinite(capture.observed_cost_usd) || capture.observed_cost_usd < 0)))
    return result(case_id, observed.seed, 'harness_error', ['no valid actual-model trial or model-usage receipt'], null);
  const usage = reconcileTrialUsage(capture.runner_usage, capture.provider_usage, capture.observed_cost_usd);
  if (usage.status === 'harness_error' || capture.actual_model_calls !== capture.runner_usage.length)
    return result(case_id, observed.seed, 'harness_error', [...usage.errors, ...(capture.actual_model_calls !== capture.runner_usage.length ? ['model call count mismatch'] : [])], null);
  const invalid = verifyCaptureReceipts(observed, capture.isolation, capture.receipts, keys);
  if (invalid.length) return result(case_id, observed.seed, 'harness_error', invalid, usage.total_usd);
  const branches = capture.branch_adjudications ?? [];
  if (branches.length > 1 || branches.some((branch) => branch.case_id !== case_id || branch.trial_seed !== observed.seed))
    return result(case_id, observed.seed, 'harness_error', ['branch adjudication case/seed mismatch or duplicate'], usage.total_usd);
  const resolvedBranches: Readonly<Record<string, CapturedArtifact>> = Object.fromEntries(branches.map((branch) => [branch.case_id, branch.artifact]));
  const prepared = prepareNativeGrade(observed, resolvedBranches);
  if (prepared.status === 'incomplete') return result(case_id, observed.seed, 'blocked_fixture', prepared.missing, usage.total_usd);
  const grade = gradeNativeOutcome(observed, review, resolvedBranches);
  const status: TrialStatus = grade.status === 'incomplete' ? 'blocked_fixture' : grade.status === 'blocked' ? 'review_pending'
    : grade.status === 'fail' ? 'failed' : 'candidate_pass_unverified';
  return result(case_id, observed.seed, status, grade.reasons, usage.total_usd);
};

// Native result entrypoint validates the exact receipt-bound manifest bytes and world
// evidence before packet grading. Literal labels cannot upgrade a diagnostic packet.
export const evaluateCapturedTrial = (case_id:string,capture:CapturedTrial|null,keys:ReceiptKeys,review:IndependentReview|null=null):TrialResult => {
  if(!capture)return result(case_id,null,'not_run',['no trial capture'],null);
  let manifest:NativeManifest;
  try{manifest=JSON.parse(capture.observed.fixture_manifest.bytes) as NativeManifest;
    const check=inspectNativeManifest(manifest);
    if(check.status!=='ready_for_isolated_trial')return result(case_id,capture.observed.seed,'blocked_fixture',check.missing,null);
  }catch{return result(case_id,capture.observed.seed,'blocked_fixture',['typed native manifest unavailable'],null);}
  if(manifest.case_id!==case_id||manifest.candidate_owner!==capture.isolation.candidate_owner||
    capture.isolation.owners.length!==2||!capture.isolation.owners.includes(manifest.control_owner)||!capture.isolation.owners.includes(manifest.candidate_owner))
    return result(case_id,capture.observed.seed,'harness_error',['native manifest case/owner mismatch'],null);
  if(!capture.world_evidence)return result(case_id,capture.observed.seed,'blocked_fixture',['isolated world evidence unavailable'],null);
  // Bind candidate evidence to the same sealed adapter packet used by the grader.
  const receiptErrors=verifyCaptureReceipts(capture.observed,capture.isolation,capture.receipts,keys);
  if(receiptErrors.length)return result(case_id,capture.observed.seed,'harness_error',receiptErrors,null);
  try{
    const effects=JSON.parse(capture.observed.intercepted_effects.bytes) as {owner_id:string;fixture_only:boolean;data:unknown};
    const readback=JSON.parse(capture.observed.final_state_readback.bytes) as {owner_id:string;fixture_only:boolean;data:{calendar:unknown;world_evidence:unknown}};
    if(effects.owner_id!==manifest.candidate_owner||readback.owner_id!==manifest.candidate_owner||effects.fixture_only!==true||readback.fixture_only!==true||
      JSON.stringify(effects.data)!==JSON.stringify(capture.world_evidence.candidate_effects)||JSON.stringify(readback.data.calendar)!==JSON.stringify(capture.world_evidence.candidate_calendar)||JSON.stringify(readback.data.world_evidence)!==JSON.stringify(capture.world_evidence))
      return result(case_id,capture.observed.seed,'harness_error',['world evidence differs from sealed adapter capture'],null);
  }catch{return result(case_id,capture.observed.seed,'harness_error',['world adapter capture unavailable'],null);}

  let audit:ReturnType<typeof auditIsolatedWorld>;
  try{audit=auditIsolatedWorld(manifest,capture.world_evidence);}catch{return result(case_id,capture.observed.seed,'harness_error',['invalid isolated world evidence'],null);}
  if(audit.status!=='consistent_fixture')return result(case_id,capture.observed.seed,'harness_error',audit.errors,null);
  return evaluateDiagnosticPacket(case_id,capture,keys,review);
};
