import { describe, expect, it } from 'vitest';
import { ESCALATE_GRID, LIGHT_GRID, renderSweep, sweep } from '../evals/router/sweep';
import { ROUTER_LABELLED, type LabelledCase } from '../evals/router/labelled';

const cases: LabelledCase[] = [
  { id: 'hi', tier: 'light', turns: [{ role: 'owner', text: 'hi' }] },
  { id: 'plan', tier: 'standard', turns: [{ role: 'owner', text: 'plan my day' }] },
  { id: 'hard', tier: 'deep', turns: [{ role: 'owner', text: 'which offer?' }] },
];
const row = (rows: ReturnType<typeof sweep>, escalateAt: number, lunaAt: number) => rows.find((r) => r.escalateAt === escalateAt && r.lunaAt === lunaAt)!;

describe('the router threshold sweep', () => {
  it('counts each misroute against the label at every threshold pair, routing each case as a cold first turn', () => {
    const rows = sweep(cases, [
      { id: 'hi', verdict: { tier: 'light', confidence: 0.85 } },
      { id: 'plan', verdict: { tier: 'light', confidence: 0.92 } },
      { id: 'hard', verdict: { tier: 'deep', confidence: 0.75 } },
    ]);
    expect(rows).toHaveLength(ESCALATE_GRID.length * LIGHT_GRID.length);
    expect(row(rows, 0.7, 0.8)).toMatchObject({ light_wrong: 1, deep_missed: 0, deep_wasted: 0, routed: { light: 2, standard: 0, deep: 1 } });
    expect(row(rows, 0.8, 0.95)).toMatchObject({ light_wrong: 0, deep_missed: 1, deep_wasted: 0, routed: { light: 0, standard: 3, deep: 0 } });
  });

  it('counts a reasoning-model turn the label did not need as waste, and a failed router as the chat model', () => {
    const rows = sweep(cases, [
      { id: 'hi', verdict: null },
      { id: 'plan', verdict: { tier: 'deep', confidence: 0.95 } },
      { id: 'hard', verdict: null },
    ]);
    expect(row(rows, 0.9, 0.9)).toMatchObject({ light_wrong: 0, deep_missed: 1, deep_wasted: 1, routed: { light: 0, standard: 2, deep: 1 } });
  });

  it('refuses a recording that is missing a labelled case', () => {
    expect(() => sweep(cases, [{ id: 'hi', verdict: null }])).toThrow(/plan, hard/);
  });

  it('renders one table row per threshold pair', () => {
    const text = renderSweep(sweep(cases, cases.map((labelled) => ({ id: labelled.id, verdict: null }))), cases.length);
    expect(text).toMatch(/over 3 labelled cases/);
    expect(text.split('\n').filter((line) => /^\| 0\.\d/.test(line))).toHaveLength(ESCALATE_GRID.length * LIGHT_GRID.length);
  });

  it('labels every case once and covers every tier', () => {
    const ids = ROUTER_LABELLED.map((labelled) => labelled.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ROUTER_LABELLED.map((labelled) => labelled.tier))).toEqual(new Set(['light', 'standard', 'deep']));
  });
});
