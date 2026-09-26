import { describe, expect, it } from 'vitest';
import {
  BUDGET_CHARS_PER_TOKEN,
  MODEL_CONTEXT_SPECS,
  deriveContextBudgetChars,
  modelContextSpecSchema,
} from './context-budget';
import { modelNameSchema } from './roster';

describe('MODEL_CONTEXT_SPECS', () => {
  it('covers every roster model exactly', () => {
    expect(Object.keys(MODEL_CONTEXT_SPECS).sort()).toEqual([...modelNameSchema.options].sort());
  });

  it('every spec parses and reserves less than the window', () => {
    for (const spec of Object.values(MODEL_CONTEXT_SPECS)) {
      const parsed = modelContextSpecSchema.parse(spec);
      expect(parsed.output_reserve_tokens + parsed.safety_margin_tokens).toBeLessThan(
        parsed.context_window_tokens,
      );
    }
  });
});

describe('deriveContextBudgetChars', () => {
  it('clamps to the wire ceiling for large-window models (today\'s behavior preserved)', () => {
    // gpt-5-nano usable window is (400k - 128k - 8k) * 4 = 1,055,232 chars - far above any
    // current wire ceiling, so the derived budget IS the ceiling.
    expect(deriveContextBudgetChars('gpt-5-nano', 32_768)).toBe(32_768);
    expect(deriveContextBudgetChars('gpt-5-mini', 32_768)).toBe(32_768);
    expect(deriveContextBudgetChars('claude-sonnet-4-6', 32_768)).toBe(32_768);
    expect(deriveContextBudgetChars('claude-haiku-4-5', 32_768)).toBe(32_768);
    expect(deriveContextBudgetChars('@cf/google/gemma-4-26b-a4b-it', 32_768)).toBe(32_768);
  });

  it('derives from the model window when the ceiling is not the binding constraint', () => {
    expect(deriveContextBudgetChars('gpt-5-nano', 2_000_000)).toBe(
      (400_000 - 128_000 - 8_192) * BUDGET_CHARS_PER_TOKEN,
    );
    expect(deriveContextBudgetChars('@cf/google/gemma-4-26b-a4b-it', 1_000_000)).toBe(
      (131_072 - 8_192 - 8_192) * BUDGET_CHARS_PER_TOKEN,
    );
  });

  it('is tighten-only: never exceeds the wire ceiling', () => {
    for (const model of modelNameSchema.options) {
      for (const ceiling of [1_024, 32_768, 65_536, 10_000_000]) {
        expect(deriveContextBudgetChars(model, ceiling)).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it('never returns a negative budget', () => {
    for (const model of modelNameSchema.options) {
      expect(deriveContextBudgetChars(model, 1)).toBeGreaterThan(0);
    }
  });
});
