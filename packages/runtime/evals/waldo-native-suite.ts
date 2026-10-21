// Author-supplied Waldo development specifications, not executable trials. Do not put
// fixture authority or pass targets into a live owner turn or model prompt.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const WALDO_NATIVE_SUITE_SHA256 = 'fc651ed0e02bf53d3875d2497637f9f9309db794b6ce02386227a04b7155211f';
const source = new URL('./fixtures/Waldo_Benchmark_Cases_v2.jsonl', import.meta.url);
const workflowIds = Array.from({ length: 24 }, (_, index) => `W${String(index + 1).padStart(2, '0')}`);
const regressionIds = Array.from({ length: 12 }, (_, index) => `R${index + 25}`);

export type NativeCase = Readonly<{
  id: string;
  title: string;
  persona: string;
  scope: string;
  legacy_use_cases: readonly string[];
  fixture: Readonly<{ now: string; timezone: string; facts: readonly string[] }>;
  user_prompt: string;
  authority: string;
  expected_behavior: readonly string[];
  forbidden_behavior: readonly string[];
  pass_evidence: readonly string[];
  primary_metric: string;
  source_ids: readonly string[];
  scenario_type: 'product_workflow' | 'control_regression';
  execution_status: 'not_run';
  evaluation_note: string;
  shareable_headline?: string;
}>;

const nonemptyStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string' && entry.length > 0);

export const parseNativeSuite = (bytes: Buffer, expectedHash = WALDO_NATIVE_SUITE_SHA256): readonly NativeCase[] => {
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== expectedHash) throw new Error(`Waldo native suite byte digest mismatch: ${hash}`);
  const rows = bytes.toString('utf8').trimEnd().split('\n').map((line, index): NativeCase => {
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; }
    catch { throw new Error(`Waldo native suite invalid JSON at line ${index + 1}`); }
    const fixture = row.fixture as Record<string, unknown> | null;
    const expectedType = index < 24 ? 'product_workflow' : 'control_regression';
    const expectedId = [...workflowIds, ...regressionIds][index];
    if (row.id !== expectedId || row.scenario_type !== expectedType || row.execution_status !== 'not_run' ||
      typeof row.title !== 'string' || !row.title || typeof row.persona !== 'string' ||
      typeof row.scope !== 'string' || !Array.isArray(row.legacy_use_cases) ||
      typeof row.user_prompt !== 'string' || !row.user_prompt || typeof row.authority !== 'string' ||
      !nonemptyStrings(row.expected_behavior) || !nonemptyStrings(row.forbidden_behavior) ||
      !nonemptyStrings(row.pass_evidence) || !nonemptyStrings(row.source_ids) ||
      typeof row.primary_metric !== 'string' || typeof row.evaluation_note !== 'string' ||
      !fixture || typeof fixture.now !== 'string' || Number.isNaN(Date.parse(fixture.now)) ||
      typeof fixture.timezone !== 'string' || !nonemptyStrings(fixture.facts)) {
      throw new Error(`Waldo native suite invalid specification at line ${index + 1}`);
    }
    return row as NativeCase;
  });
  if (rows.length !== 36) throw new Error(`Waldo native suite requires 36 specifications, got ${rows.length}`);
  return rows;
};

export const loadNativeSuite = (): readonly NativeCase[] => parseNativeSuite(readFileSync(fileURLToPath(source)));
