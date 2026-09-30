import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { appendPromptVersion, buildPromptCatalog, buildToolCatalog, selectPrompt } from '../evals/prompt-experiments/catalog';
import { compareExperiments, type ExperimentInput, type ToolReview } from '../evals/prompt-experiments/compare';
import { getContextHandler } from '../src/tools/live/get-context';
import { assembleIsolatedCapture, type CaptureSource, type IsolatedCapture } from '../evals/isolated-capture';
import type { IndependentReview, OutcomeFinding } from '../evals/outcome-grader';
import { WALDO_NATIVE_SUITE_SHA256 } from '../evals/waldo-native-suite';

const source = 'c002d446327bfccb72cbe3e13492017f5c828b6d';
const handlers = [getContextHandler({ timezone: 'UTC', now: () => new Date('2026-09-30T00:00:00Z') })];
const initial = buildPromptCatalog(source);
const catalog = appendPromptVersion(initial, { ...selectPrompt(initial, 'waldo.reply', 1), version: 2 });
const tools = buildToolCatalog(handlers, 1, source);
const artifact = (bytes: string) => ({ bytes, source: 'synthetic evaluator', digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
const capture = (input: ExperimentInput, violated = false) => {
  const part = (role: CaptureSource['role'], bytes: string) => ({ owner_id: 'synthetic-a', role, bytes });
  const trace = JSON.stringify({ format: 1, calls: [{ id: 'call-1', name: 'get_context', arguments: {} }], latency_ms: 12, token_estimate: { input: 100, output: 25 } });
  const isolated: IsolatedCapture = { case_id: input.binding.case_id, seed: input.binding.seed, owners: ['synthetic-a', 'synthetic-b'], candidate_owner: 'synthetic-a',
    fixture_manifest: part('runner', JSON.stringify({ experiment: input.binding, fixture: input.fixture, model_input: input.model_input })), transcript: part('runner', 'synthetic useful result'), tool_trace: part('runner', trace),
    authority_timeline: part('runner', 'synthetic owner scope'), source_revisions: part('source_adapter', 'synthetic source revision'), intercepted_effects: part('effect_interceptor', 'synthetic no effects'), final_state_readback: part('provider_readback', 'synthetic final state'),
  };
  const trial = assembleIsolatedCapture(isolated);
  const findings: OutcomeFinding[] = [
    { criterion: 'useful_outcome', status: violated ? 'violated' : 'met', artifact: 'transcript', excerpt: 'synthetic useful result', explanation: 'synthetic reviewer finding' },
    { criterion: 'source_evidence', status: 'met', artifact: 'source_revisions', excerpt: 'synthetic source revision', explanation: 'synthetic source finding' },
    { criterion: 'authority', status: 'met', artifact: 'authority_timeline', excerpt: 'synthetic owner scope', explanation: 'synthetic authority finding' },
    { criterion: 'forbidden_effects', status: 'met', artifact: 'intercepted_effects', excerpt: 'synthetic no effects', explanation: 'synthetic effect finding' },
    { criterion: 'final_state', status: 'met', artifact: 'final_state_readback', excerpt: 'synthetic final state', explanation: 'synthetic readback finding' },
  ];
  const reviewBody = { case_id: trial.case_id, trial_seed: trial.seed, reviewer: 'synthetic independent evaluator', findings };
  const review: IndependentReview = { ...reviewBody, review_record: artifact(JSON.stringify(reviewBody)) };
  const judgment = { call_id: 'call-1', appropriate: 'yes' as const, unnecessary: 'no' as const, excerpt: '"id":"call-1"', explanation: 'synthetic tool rubric finding' };
  const metricsBody = { binding: input.binding, tool_trace_digest: trial.tool_trace.digest, reviewer: review.reviewer, judgments: [judgment] };
  return { capture: isolated, review, tool_review: { ...metricsBody, record: artifact(JSON.stringify(metricsBody)) } };
};
const options = { catalog, dataset_digest: WALDO_NATIVE_SUITE_SHA256, cases: [{ id: 'W02', seed: 'paired-seed' }], variants: [
  { name: 'v1', prompt_id: 'waldo.reply' as const, prompt_version: 1, tools, handlers },
  { name: 'v2-control', prompt_id: 'waldo.reply' as const, prompt_version: 2, tools, handlers },
] };

describe('pinned prompt/tool experiment foundation', () => {
  it('keeps a caller-authored five-positive-finding packet diagnostic-only', async () => {
    const report = await compareExperiments(options, async (input) => capture(input));
    expect(report).toMatchObject({ evidence_kind: 'diagnostic_packet', native_result_eligible: false, native_score: null });
    expect(report.trials[0]).toMatchObject({ diagnostic_review: { status: 'diagnostic_findings_supplied' } });
    expect(report.pairs[0]).toMatchObject({ diagnostic_reviews: ['diagnostic_findings_supplied', 'diagnostic_findings_supplied'] });
    expect(JSON.stringify(report)).not.toMatch(/native_grade|candidate_pass_unverified/);
  });
  it('cannot turn forged calendar or control effect bytes into a native result', async () => {
    for (const forged of ['forged calendar event persisted', 'forged control effect executed']) {
      const report = await compareExperiments(options, async (input) => {
        const result = capture(input);
        const findings = result.review.findings.map((finding) => finding.criterion === 'final_state' ? { ...finding, excerpt: forged } : finding);
        const body = { case_id: input.binding.case_id, trial_seed: input.binding.seed, reviewer: 'caller-authored evaluator', findings };
        return { ...result, capture: { ...result.capture, final_state_readback: { ...result.capture.final_state_readback, bytes: forged }, intercepted_effects: { ...result.capture.intercepted_effects, bytes: `synthetic no effects; ${forged}` } }, review: { ...body, review_record: artifact(JSON.stringify(body)) } };
      });
      expect(report).toMatchObject({ evidence_kind: 'diagnostic_packet', native_result_eligible: false, native_score: null });
      expect(report.trials[0]).toMatchObject({ diagnostic_review: { status: 'diagnostic_findings_supplied' }, evidence_limits: { reviewer_proof: 'unverified', source_proof: 'unverified', custody_proof: 'unverified', execution_proof: 'unverified' } });
      expect(JSON.stringify(report)).not.toMatch(/native_grade|candidate_pass_unverified/);
    }
  });
  it('reports missing reviewer and source proof even with positive packet findings', async () => {
    const report = await compareExperiments(options, async (input) => capture(input));
    expect(report.trials[0]).toMatchObject({ evidence_limits: { reviewer_proof: 'unverified', source_proof: 'unverified', custody_proof: 'unverified', execution_proof: 'unverified' }, tool_review_checks: { reviewer_proof: 'unverified' } });
    expect(report.trials[0]).toMatchObject({ code_checks: { scope: 'packet_structure_and_schema_only' } });
  });
  it('maps incomplete fixture inputs to an exclusively diagnostic status', async () => {
    const report = await compareExperiments({ ...options, cases: [{ id: 'R33', seed: 'diagnostic-incomplete' }] }, async (input) => capture(input));
    expect(report.trials.every((row) => row.diagnostic_review.status === 'diagnostic_incomplete')).toBe(true);
    expect(report).toMatchObject({ evidence_kind: 'diagnostic_packet', native_result_eligible: false, native_score: null });
    expect(report.evidence_limits).toMatchObject({ reviewer_proof: 'unverified', source_proof: 'unverified' });
  });
  it('compares two versions through diagnostic excerpt checks, with distinct evidence layers', async () => {
    const report = await compareExperiments(options, async (input) => {
      expect(Object.keys(input.model_input)).toEqual(['instruction', 'response_schema', 'user_prompt', 'tools']);
      expect(input.model_input).not.toHaveProperty('expected_behavior');
      expect(input.model_input).not.toHaveProperty('authority');
      expect(input.model_input.instruction).toContain('Tools available in this chat: get_context.');
      return capture(input, input.binding.prompt_version === 2);
    });
    expect(report.trials.map((row) => row.diagnostic_review.status)).toEqual(['diagnostic_findings_supplied', 'diagnostic_violation']);
    expect(report.trials.map((row) => row.judgment.task_completion)).toEqual(['met', 'violated']);
    expect(report.trials[0]!.code_checks).toEqual({ scope: 'packet_structure_and_schema_only', argument_valid: 1, argument_invalid: 0 });
    expect(report.trials[0]!.judgment).toMatchObject({ appropriate_tool_selection: 1, unnecessary_calls: 0, approval_behavior: 'met' });
    expect(report.trials[0]!.measurements).toEqual({ latency_ms: 12, token_estimate: { input: 100, output: 25 }, calls: 1 });
    expect(report.trials[0]!.unverified_source_records.final_state_readback.bytes).toBe('synthetic final state');
    expect(report.baseline_gate).toBe('external_36_trial_run_required');
  });
  it('rejects a different dataset or mislabeled capture before diagnostic review', async () => {
    await expect(compareExperiments({ ...options, dataset_digest: 'changed' }, async (input) => capture(input))).rejects.toThrow('dataset');
    await expect(compareExperiments(options, async (input) => capture({ ...input, binding: { ...input.binding, prompt_version: 99 } }))).rejects.toThrow('binding');
  });
  it('keeps missing independent review and missing measurements unknown', async () => {
    const report = await compareExperiments(options, async (input) => {
      const captured = capture(input);
      const trace = { ...captured.capture.tool_trace, bytes: JSON.stringify({ format: 1, calls: [] }) };
      return { ...captured, capture: { ...captured.capture, tool_trace: trace }, review: null, tool_review: null };
    });
    expect(report.trials.every((row) => row.diagnostic_review.status === 'diagnostic_blocked')).toBe(true);
    expect(report.trials[0]!.evidence_limits).toMatchObject({ reviewer_proof: 'unverified', source_proof: 'unverified' });
    expect(report.trials[0]!.tool_review_checks).toMatchObject({ packet_binding: 'not_supplied', reviewer_proof: 'unverified' });
    expect(report.trials[0]!.judgment.task_completion).toBe('unknown');
    expect(report.trials[0]!.measurements.latency_ms).toBeNull();
    expect(report.trials[0]!.measurements.token_estimate).toBeNull();
  });
  it('rejects missing or swapped fixtures, crossed owners and unanchored judgments', async () => {
    for (const fixture of [undefined, { now: 'wrong', timezone: 'UTC', facts: [] }]) {
      await expect(compareExperiments(options, async (input) => {
        const result = capture(input);
        return { ...result, capture: { ...result.capture, fixture_manifest: { ...result.capture.fixture_manifest, bytes: JSON.stringify({ experiment: input.binding, model_input: input.model_input, fixture }) } } };
      })).rejects.toThrow('binding');
    }
    await expect(compareExperiments(options, async (input) => {
      const result = capture(input);
      return { ...result, capture: { ...result.capture, final_state_readback: { ...result.capture.final_state_readback, owner_id: 'synthetic-b' } } };
    })).rejects.toThrow('unbound');
    await expect(compareExperiments(options, async (input) => {
      const result = capture(input);
      const body = { ...result.tool_review, judgments: [{ ...result.tool_review.judgments[0]!, excerpt: 'fabricated' }] };
      const { record: _record, ...recordBody } = body;
      return { ...result, tool_review: { ...body, record: artifact(JSON.stringify(recordBody)) } };
    })).rejects.toThrow('evidence invalid');
  });
  it('checks invalid and unknown-tool arguments and supports a tool-version comparison', async () => {
    const report = await compareExperiments({ ...options, variants: [options.variants[0]!, { ...options.variants[1]!, prompt_version: 1, tools: buildToolCatalog(handlers, 2, source) }] }, async (input) => {
      const result = capture(input);
      const bytes = JSON.stringify({ format: 1, calls: [{ id: 'bad-args', name: 'get_context', arguments: { unexpected: true } }, { id: 'unknown-tool', name: 'nonexistent', arguments: {} }] });
      return { ...result, capture: { ...result.capture, tool_trace: { ...result.capture.tool_trace, bytes } }, review: null, tool_review: null };
    });
    expect(report.trials.map((row) => row.binding.tool_version)).toEqual([1, 2]);
    expect(report.trials[0]!.code_checks).toEqual({ scope: 'packet_structure_and_schema_only', argument_valid: 0, argument_invalid: 2 });
    expect(report.trials[0]!.judgment.appropriate_tool_selection).toBeNull();
    await expect(compareExperiments({ ...options, variants: [{ ...options.variants[0]!, tools: buildToolCatalog([], 1, source) }, options.variants[1]!] }, async (input) => capture(input))).rejects.toThrow('handler schemas');
  });
  it('passes the catalog response schema to structured prompt experiments', async () => {
    const reaction = appendPromptVersion(catalog, { ...selectPrompt(catalog, 'waldo.reaction', 1), version: 2 });
    const report = await compareExperiments({ ...options, catalog: reaction, variants: options.variants.map((variant) => ({ ...variant, prompt_id: 'waldo.reaction' as const })) }, async (input) => {
      expect(input.model_input.response_schema).toEqual(selectPrompt(reaction, 'waldo.reaction', 1).response_schema);
      return capture(input);
    });
    expect(report.comparison_kind).toBe('identical_content_control');
  });
  it('rejects replaying a per-call review across paired variants with identical tool traces', async () => {
    let prior: ToolReview | undefined;
    await expect(compareExperiments(options, async (input) => {
      const result = capture(input);
      if (!prior) { prior = result.tool_review; return result; }
      return { ...result, tool_review: prior };
    })).rejects.toThrow('identity');
  });
});
