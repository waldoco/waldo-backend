import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadReferenceJudgments, parseReferenceJudgments } from '../evals/reference-judgments';

const bytes = readFileSync(new URL('../evals/fixtures/Waldo_Reference_Judgments_2026-09-29.jsonl', import.meta.url));
const digest = (value: Buffer): string => createHash('sha256').update(value).digest('hex');
const change = (f: (value: Record<string, unknown>) => void): Buffer => {
  const rows = bytes.toString('utf8').trimEnd().split('\n');
  const first = JSON.parse(rows[0]!) as Record<string, unknown>;
  f(first); rows[0] = JSON.stringify(first);
  return Buffer.from(`${rows.join('\n')}\n`);
};

describe('independent reference judgment input', () => {
  it('pins all 36 ordered judgments to the original suite and labels them unexecuted', () => {
    const rows = loadReferenceJudgments();
    expect(rows).toEqual(parseReferenceJudgments(bytes));
    expect(rows).toHaveLength(36);
    expect(rows.every((row) => row.run_status === 'not_run' && row.observed_tools.length === 0 && row.observed_receipts.length === 0)).toBe(true);
    expect(rows.map((row) => row.id)).toEqual([...Array.from({ length: 24 }, (_, i) => `W${String(i + 1).padStart(2, '0')}`), ...Array.from({ length: 12 }, (_, i) => `R${i + 25}`)]);
  });
  it('rejects changed bytes and forged observed receipts even when a matching digest is supplied', () => {
    expect(() => parseReferenceJudgments(change((row) => { row.golden_plan = 'altered'; }))).toThrow(/digest mismatch/);
    const forged = change((row) => { row.observed_receipts = ['fabricated']; });
    expect(() => parseReferenceJudgments(forged, digest(forged))).toThrow(/invalid row/);
  });
  it('rejects reference authority, metric or pass evidence drift against the original suite', () => {
    const changed = change((row) => { row.original_pass_evidence = ['different pass']; });
    expect(() => parseReferenceJudgments(changed, digest(changed))).toThrow(/invalid row/);
    const forged = change((row) => { row.run_status = 'pass'; });
    expect(() => parseReferenceJudgments(forged, digest(forged))).toThrow(/invalid row/);
  });
});
