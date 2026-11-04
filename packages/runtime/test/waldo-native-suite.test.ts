import { describe, expect, it } from 'vitest';
import { loadNativeSuite, parseNativeSuite } from '../evals/waldo-native-suite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const source = new URL('../evals/fixtures/Waldo_Benchmark_Cases_v2.jsonl', import.meta.url);

describe('owner-authored Waldo suite source integrity', () => {
  it('loads exact original bytes as 24 workflow and 12 regression specifications, not results', () => {
    const cases = loadNativeSuite();
    expect(cases.map(({ id }) => id)).toEqual([
      ...Array.from({ length: 24 }, (_, index) => `W${String(index + 1).padStart(2, '0')}`),
      ...Array.from({ length: 12 }, (_, index) => `R${index + 25}`),
    ]);
    expect(new Set(cases.map(({ execution_status }) => execution_status))).toEqual(new Set(['not_run']));
    expect(cases.every(({ fixture, source_ids, expected_behavior, forbidden_behavior, pass_evidence }) =>
      fixture.now && fixture.timezone && source_ids.length && expected_behavior.length && forbidden_behavior.length && pass_evidence.length)).toBe(true);
  });
  it('fails closed if original bytes change, even if the JSONL remains parseable', () => {
    const bytes = readFileSync(source);
    expect(() => parseNativeSuite(Buffer.from(bytes.toString('utf8').replace('W01', 'W00')))).toThrow(/digest mismatch/);
  });
  it('rejects an invalid structure even if its altered digest is supplied', () => {
    const bytes = readFileSync(source);
    const changed = Buffer.from(bytes.toString('utf8').replace('"execution_status": "not_run"', '"execution_status": "pass"'));
    expect(() => parseNativeSuite(changed, createHash('sha256').update(changed).digest('hex'))).toThrow(/invalid specification/);
  });
});
