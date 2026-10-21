// A grading handoff, not a judge. Case/reference text stays on the evaluator side;
// nothing here manufactures a result from a scripted reply, tool-call list or plan match.
import { createHash } from 'node:crypto';
import { loadNativeSuite, type NativeCase } from './waldo-native-suite';
import { loadReferenceJudgments, type ReferenceJudgment } from './reference-judgments';

export type CapturedArtifact = Readonly<{ digest: string; bytes: string; source: string }>;
export type ObservedTrial = Readonly<{
  case_id: string;
  seed: string;
  // Captured bytes with a digest and provenance label, supplied by an isolated runner.
  fixture_manifest: CapturedArtifact;
  transcript: CapturedArtifact;
  tool_trace: CapturedArtifact;
  authority_timeline: CapturedArtifact;
  source_revisions: CapturedArtifact;
  intercepted_effects: CapturedArtifact;
  final_state_readback: CapturedArtifact;
}>;
export type GradingPacket = Readonly<{
  spec: NativeCase;
  reference_rubric: Pick<ReferenceJudgment, 'expected_evidence' | 'forbidden_effect_watchouts' | 'spec_gap_or_branch' | 'original_pass_evidence' | 'original_metric' | 'grading_rule'>;
  observed: ObservedTrial;
}>;
export type PacketPreparation = Readonly<{ status: 'incomplete'; missing: readonly string[] }> | Readonly<{ status: 'packet_prepared_ungraded'; packet: GradingPacket }>;

const verifiedCapture = (value: CapturedArtifact): boolean => Boolean(value?.bytes && value?.source?.trim()) &&
  value.digest === `sha256:${createHash('sha256').update(value.bytes).digest('hex')}`;
const fields = ['fixture_manifest', 'transcript', 'tool_trace', 'authority_timeline', 'source_revisions', 'intercepted_effects', 'final_state_readback'] as const;
const branchGaps = new Set(['W01', 'W20', 'W22', 'W24', 'R33']);

// `resolvedBranches` is an evaluator-authored fixture adjudication, not model output or
// text from the reference artifact. Ambiguous cases wait for the owner/fixture decision.
export const prepareNativeGrade = (trial: ObservedTrial, resolvedBranches: Readonly<Record<string, CapturedArtifact>> = {}): PacketPreparation => {
  const spec = loadNativeSuite().find((row) => row.id === trial.case_id);
  const reference = loadReferenceJudgments().find((row) => row.id === trial.case_id);
  if (!spec || !reference) return { status: 'incomplete', missing: ['unknown case or reference'] };
  const missing = fields.filter((field) => !verifiedCapture(trial[field])).map((field) => `missing or digest-invalid ${field}`);
  if (!trial.seed.trim()) missing.push('missing independent trial seed');
  if (branchGaps.has(spec.id) && !verifiedCapture(resolvedBranches[spec.id]!)) missing.push(`unresolved ${spec.id} fixture branch`);
  if (spec.id === 'R33') missing.push('R33 tariff table, research question, source snapshots and deterministic error schedule are not pinned as fixture inputs');
  if (missing.length) return { status: 'incomplete', missing };
  // A valid digest proves only these bytes were handed over, never that they are true or
  // source-authorized. This packet is NOT a score or an assertion that a case ran.
  // An independent evaluator must inspect provenance and final state before grading.
  return {
    status: 'packet_prepared_ungraded',
    packet: {
      spec,
      reference_rubric: {
        expected_evidence: reference.expected_evidence,
        forbidden_effect_watchouts: reference.forbidden_effect_watchouts,
        spec_gap_or_branch: reference.spec_gap_or_branch,
        original_pass_evidence: reference.original_pass_evidence,
        original_metric: reference.original_metric,
        grading_rule: reference.grading_rule,
      },
      observed: trial,
    },
  };
};
