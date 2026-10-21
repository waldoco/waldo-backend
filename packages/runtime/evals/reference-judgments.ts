// Independent, unexecuted reference judgments are rubric inputs, never a matching
// trajectory, a fixture authority grant or evidence that an agent ran the case.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadNativeSuite, WALDO_NATIVE_SUITE_SHA256 } from './waldo-native-suite';

export const REFERENCE_JUDGMENTS_SHA256 = 'df5783365923212d740f6b635ff93b79e99d6f7b48536f35953c65a5736d2786';

export type ReferenceJudgment = Readonly<{
  id: string;
  title: string;
  source_spec_sha256: string;
  reference_kind: 'unexecuted_independent_judgment';
  run_status: 'not_run';
  observed_tools: readonly never[];
  observed_receipts: readonly never[];
  golden_plan: string;
  decision_rationale: string;
  expected_evidence: string;
  forbidden_effect_watchouts: readonly string[];
  spec_gap_or_branch: string;
  original_pass_evidence: readonly string[];
  original_metric: string;
  grading_rule: string;
}>;

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(nonempty);
const keys = [
  'id', 'title', 'source_spec_sha256', 'reference_kind', 'run_status', 'observed_tools',
  'observed_receipts', 'golden_plan', 'decision_rationale', 'expected_evidence',
  'forbidden_effect_watchouts', 'spec_gap_or_branch', 'original_pass_evidence', 'original_metric', 'grading_rule',
];

export const parseReferenceJudgments = (bytes: Buffer, expectedHash = REFERENCE_JUDGMENTS_SHA256): readonly ReferenceJudgment[] => {
  if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw new Error('reference judgments byte digest mismatch');
  const source = loadNativeSuite();
  const rows = bytes.toString('utf8').trimEnd().split('\n').map((line, index): ReferenceJudgment => {
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; }
    catch { throw new Error(`reference judgments invalid JSON at line ${index + 1}`); }
    const spec = source[index];
    if (!spec || Object.keys(row).sort().join(',') !== [...keys].sort().join(',') ||
      row.id !== spec.id || row.title !== spec.title || row.source_spec_sha256 !== WALDO_NATIVE_SUITE_SHA256 ||
      row.reference_kind !== 'unexecuted_independent_judgment' || row.run_status !== 'not_run' ||
      !Array.isArray(row.observed_tools) || row.observed_tools.length !== 0 ||
      !Array.isArray(row.observed_receipts) || row.observed_receipts.length !== 0 ||
      !nonempty(row.golden_plan) || !nonempty(row.decision_rationale) || !nonempty(row.expected_evidence) ||
      !nonempty(row.spec_gap_or_branch) || !nonempty(row.original_metric) || !nonempty(row.grading_rule) ||
      !strings(row.forbidden_effect_watchouts) || !strings(row.original_pass_evidence) ||
      JSON.stringify(row.original_pass_evidence) !== JSON.stringify(spec.pass_evidence) ||
      row.original_metric !== spec.primary_metric) throw new Error(`reference judgments invalid row at line ${index + 1}`);
    return row as ReferenceJudgment;
  });
  if (rows.length !== source.length) throw new Error(`reference judgments require ${source.length} rows`);
  return rows;
};

export const loadReferenceJudgments = (): readonly ReferenceJudgment[] =>
  parseReferenceJudgments(readFileSync(fileURLToPath(new URL('./fixtures/Waldo_Reference_Judgments_2026-09-29.jsonl', import.meta.url))));
