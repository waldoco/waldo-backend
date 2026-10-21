import { describe, expect, it } from 'vitest';
import { costNotice, parseCeilingUsd, spendPosture } from '../src/llm/cost-ledger';

describe('spend posture', () => {
  it('runs normally below 80% of the ceiling', () => {
    expect(spendPosture(7.9, 10)).toEqual({ effort: 'normal', background: 'run', batchProactive: false, ceilingReached: false });
  });
  it('runs background work at low effort and batches proactive work from 80%', () => {
    expect(spendPosture(8, 10)).toEqual({ effort: 'low', background: 'run', batchProactive: true, ceilingReached: false });
  });
  it('skips background work at 100% and reports the number', () => {
    expect(spendPosture(10, 10)).toEqual({ effort: 'low', background: 'skip', batchProactive: true, ceilingReached: true });
    expect(costNotice(10.04, 10)).toContain('$10.04 of your $10.00');
  });
  it('has no limit without a ceiling', () => {
    expect(spendPosture(1e6, null).background).toBe('run');
    expect(parseCeilingUsd(undefined)).toBeNull();
    expect(parseCeilingUsd('abc')).toBeNull();
    expect(parseCeilingUsd('25')).toBe(25);
  });
});
