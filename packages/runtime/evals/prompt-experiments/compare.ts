import { createHash } from 'node:crypto';
import { z } from 'zod';
import { buildToolCatalog, digest, loadToolCatalog, selectPrompt, type PromptCatalog, type PromptEntry, type ReflectedHandler, type ToolCatalog } from './catalog';
import { loadNativeSuite, WALDO_NATIVE_SUITE_SHA256, type NativeCase } from '../waldo-native-suite';
import { gradeNativeOutcome, type IndependentReview } from '../outcome-grader';
import type { CapturedArtifact } from '../grading-contract';
import { MESSAGING_BEHAVIOR, messagingSystemPrompt } from '../../src/prompt/messaging-behavior';
import { assembleIsolatedCapture, type IsolatedCapture } from '../isolated-capture';

export type Variant = Readonly<{ name: string; prompt_id: PromptEntry['id']; prompt_version: number; tools: ToolCatalog; handlers: readonly ReflectedHandler[] }>;
export type ExperimentBinding = Readonly<{ dataset_digest: string; case_id: string; seed: string; variant: string; prompt_id: string; prompt_version: number; prompt_digest: string; tool_version: number; tool_digest: string; fixture_digest: string; input_digest: string }>;
export type ExperimentInput = Readonly<{
  binding: ExperimentBinding;
  model_input: Readonly<{ instruction: string; response_schema: PromptEntry['response_schema']; user_prompt: string; tools: readonly Readonly<{ name: string; description: string; parameters: Record<string, unknown> }>[] }>;
  fixture: NativeCase['fixture'];
}>;
const judgmentSchema = z.object({ call_id: z.string().min(1), appropriate: z.enum(['yes', 'no', 'unknown']), unnecessary: z.enum(['yes', 'no', 'unknown']), excerpt: z.string().min(1), explanation: z.string().min(1) }).strict();
export type ToolReview = Readonly<{ binding: ExperimentBinding; tool_trace_digest: string; reviewer: string; judgments: readonly z.infer<typeof judgmentSchema>[]; record: CapturedArtifact }>;
export type DiagnosticExperimentCapture = Readonly<{ capture: IsolatedCapture; review: IndependentReview | null; tool_review?: ToolReview | null; resolved_branches?: Readonly<Record<string, CapturedArtifact>> }>;
export type DiagnosticReviewStatus = 'diagnostic_incomplete' | 'diagnostic_blocked' | 'diagnostic_violation' | 'diagnostic_findings_supplied';
const diagnosticStatuses: Readonly<Record<ReturnType<typeof gradeNativeOutcome>['status'], DiagnosticReviewStatus>> = {
  incomplete: 'diagnostic_incomplete', blocked: 'diagnostic_blocked', fail: 'diagnostic_violation', candidate_pass_unverified: 'diagnostic_findings_supplied',
};
const evidenceLimits = {
  reviewer_proof: 'unverified', source_proof: 'unverified', custody_proof: 'unverified', execution_proof: 'unverified',
} as const;
export type ExperimentOptions = Readonly<{ catalog: PromptCatalog; dataset_digest: string; cases: readonly Readonly<{ id: string; seed: string }>[]; variants: readonly Variant[] }>;
const traceSchema = z.object({
  format: z.literal(1), calls: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), arguments: z.unknown() }).strict()),
  latency_ms: z.number().finite().nonnegative().optional(),
  token_estimate: z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() }).strict().optional(),
}).strict();
const validArtifact = (artifact: CapturedArtifact) => Boolean(artifact.bytes && artifact.source.trim()) && artifact.digest === `sha256:${createHash('sha256').update(artifact.bytes).digest('hex')}`;

const reviewDiagnosticPacket = (binding: ExperimentBinding, variant: Variant, capture: DiagnosticExperimentCapture) => {
  const trial = assembleIsolatedCapture(capture.capture);
  const manifest = JSON.parse(trial.fixture_manifest.bytes);
  if (trial.case_id !== binding.case_id || trial.seed !== binding.seed || !validArtifact(trial.fixture_manifest) ||
    digest(manifest.experiment) !== digest(binding) || !manifest.fixture || !manifest.model_input ||
    digest(manifest.fixture) !== binding.fixture_digest || digest(manifest.model_input) !== binding.input_digest) throw new Error('experiment capture binding mismatch');
  if (!validArtifact(trial.tool_trace)) throw new Error('tool trace digest invalid');
  const trace = traceSchema.parse(JSON.parse(trial.tool_trace.bytes));
  if (new Set(trace.calls.map((call) => call.id)).size !== trace.calls.length) throw new Error('duplicate tool call id');
  // Excerpt checks only: caller-authored labels/digests never establish custody.
  const excerptCheck = gradeNativeOutcome(trial, capture.review, capture.resolved_branches);
  const diagnosticReview = {
    status: diagnosticStatuses[excerptCheck.status], case_id: excerptCheck.case_id,
    reasons: [...excerptCheck.reasons, 'diagnostic packet only; reviewer, source, custody and execution proof remain unverified'],
  };
  const reviewUsable = diagnosticReview.status === 'diagnostic_violation' || diagnosticReview.status === 'diagnostic_findings_supplied';
  const criterion = (name: 'useful_outcome' | 'authority') => reviewUsable ? capture.review!.findings.find((item) => item.criterion === name)!.status : 'unknown';
  let appropriate: number | null = null;
  let unnecessary: number | null = null;
  const toolReview = capture.tool_review;
  if (toolReview) {
    const { record, ...body } = toolReview;
    const judgments = z.array(judgmentSchema).parse(body.judgments);
    if (digest(body.binding) !== digest(binding) || body.tool_trace_digest !== trial.tool_trace.digest || !body.reviewer.trim() || !validArtifact(record) || record.bytes !== JSON.stringify(body) ||
      judgments.length !== trace.calls.length || new Set(judgments.map((item) => item.call_id)).size !== judgments.length ||
      judgments.some((item) => !trace.calls.some((call) => call.id === item.call_id && JSON.stringify(call).includes(item.excerpt)))) throw new Error('tool review identity, coverage or evidence invalid');
    appropriate = judgments.some((item) => item.appropriate === 'unknown') ? null : judgments.filter((item) => item.appropriate === 'yes').length;
    unnecessary = judgments.some((item) => item.unnecessary === 'unknown') ? null : judgments.filter((item) => item.unnecessary === 'yes').length;
  }
  const valid = trace.calls.filter((call) => variant.handlers.find((handler) => handler.name === call.name)?.schema.safeParse(call.arguments).success).length;
  return {
    binding, diagnostic_review: diagnosticReview, evidence_limits: { ...evidenceLimits },
    code_checks: { scope: 'packet_structure_and_schema_only' as const, argument_valid: valid, argument_invalid: trace.calls.length - valid },
    judgment: { scope: 'caller_supplied_diagnostic_findings' as const, task_completion: criterion('useful_outcome'), approval_behavior: criterion('authority'), appropriate_tool_selection: appropriate, unnecessary_calls: unnecessary },
    tool_review_checks: { packet_binding: toolReview ? 'matched' : 'not_supplied', excerpt_binding: toolReview ? 'matched' : 'not_supplied', reviewer_proof: 'unverified' as const },
    measurements: { latency_ms: trace.latency_ms ?? null, token_estimate: trace.token_estimate ?? null, calls: trace.calls.length },
    unverified_source_records: { source_revisions: trial.source_revisions, authority_timeline: trial.authority_timeline, intercepted_effects: trial.intercepted_effects, final_state_readback: trial.final_state_readback },
    packet_records: { fixture_manifest: trial.fixture_manifest, transcript: trial.transcript, tool_trace: trial.tool_trace },
    review_records: { diagnostic_review_record: capture.review?.review_record ?? null, tool_review: toolReview?.record ?? null },
  };
};

// Caller-supplied packets are diagnostic input, not audited execution evidence.
// This module neither calls providers nor changes runtime prompts or tool dispatch.
export const compareExperiments = async (options: ExperimentOptions, execute: (input: ExperimentInput) => Promise<DiagnosticExperimentCapture>) => {
  if (options.dataset_digest !== WALDO_NATIVE_SUITE_SHA256) throw new Error('dataset digest differs from pinned native suite');
  const suite = loadNativeSuite();
  if (options.variants.length !== 2 || new Set(options.variants.map((variant) => variant.name)).size !== 2 || options.variants.some((variant) => !variant.name.trim())) throw new Error('two distinct named variants required');
  if (!options.cases.length || options.cases.some((item) => !item.seed.trim() || !suite.some((row) => row.id === item.id)) ||
    new Set(options.cases.map((item) => `${item.id}:${item.seed}`)).size !== options.cases.length) throw new Error('invalid or duplicate case/seed');
  const variants = options.variants.map((variant) => {
    const prompt = selectPrompt(options.catalog, variant.prompt_id, variant.prompt_version);
    const tools = loadToolCatalog(JSON.stringify(variant.tools));
    if (buildToolCatalog(variant.handlers, tools.version, tools.source_revision).digest !== tools.digest) throw new Error('handler schemas or policy flags differ from tool catalog');
    return { variant, prompt, tools };
  });
  const trials: ReturnType<typeof reviewDiagnosticPacket>[] = [];
  for (const item of options.cases) {
    const spec = suite.find((row) => row.id === item.id)!;
    for (const { variant, prompt, tools } of variants) {
      const instruction = prompt.id === 'waldo.reply' ? prompt.instruction + messagingSystemPrompt(tools.entries.map((tool) => tool.name)).slice(MESSAGING_BEHAVIOR.length) : prompt.instruction;
      const modelInput: ExperimentInput['model_input'] = { instruction, response_schema: prompt.response_schema, user_prompt: spec.user_prompt, tools: tools.entries.map(({ name, description, parameters }) => ({ name, description, parameters })) };
      const binding: ExperimentBinding = { dataset_digest: options.dataset_digest, case_id: item.id, seed: item.seed, variant: variant.name, prompt_id: prompt.id, prompt_version: prompt.version, prompt_digest: prompt.content_digest, tool_version: tools.version, tool_digest: tools.digest, fixture_digest: digest(spec.fixture), input_digest: digest(modelInput) };
      const input: ExperimentInput = { binding, model_input: modelInput, fixture: spec.fixture };
      const captured = await execute(structuredClone(input));
      trials.push(reviewDiagnosticPacket(binding, variant, captured));
    }
  }
  return { format: 1 as const, evidence_kind: 'diagnostic_packet' as const, native_result_eligible: false as const, native_score: null,
    evidence_limits: { ...evidenceLimits }, dataset_digest: options.dataset_digest, baseline_gate: 'external_36_trial_run_required' as const,
    comparison_kind: variants[0]!.prompt.content_digest === variants[1]!.prompt.content_digest && digest(variants[0]!.tools.entries) === digest(variants[1]!.tools.entries) ? 'identical_content_control' : 'content_comparison',
    trials,
    pairs: options.cases.map((item, index) => {
      const left = trials[index * 2]!; const right = trials[index * 2 + 1]!;
      return { case_id: item.id, seed: item.seed, variants: [left.binding.variant, right.binding.variant], diagnostic_reviews: [left.diagnostic_review.status, right.diagnostic_review.status],
        latency_delta_ms: left.measurements.latency_ms === null || right.measurements.latency_ms === null ? null : right.measurements.latency_ms - left.measurements.latency_ms,
        call_delta: right.measurements.calls - left.measurements.calls };
    }),
  };
};
