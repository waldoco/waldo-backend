import { describe, expect, it } from 'vitest';
import {
  BUDGET_CHARS_PER_TOKEN,
  MODEL_CONTEXT_SPECS,
  deriveContextBudgetChars,
  modelContextSpecSchema,
} from './context-budget';
import {
  ANTHROPIC_CLAUDE_HAIKU_4_5_MODEL,
  ANTHROPIC_CLAUDE_SONNET_4_6_MODEL,
  OPENAI_GPT_5_MINI_MODEL,
  OPENAI_GPT_5_NANO_MODEL,
  OPENAI_GPT_6_LUNA_MODEL,
  WORKERS_AI_GEMMA_4_26B_MODEL,
  modelNameSchema,
} from './roster';

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
    // OPENAI_GPT_5_NANO_MODEL usable window is (400k - 128k - 8k) * 4 = 1,055,232 chars - far
    // above any current wire ceiling, so the derived budget IS the ceiling.
    expect(deriveContextBudgetChars(OPENAI_GPT_5_NANO_MODEL, 32_768)).toBe(32_768);
    expect(deriveContextBudgetChars(OPENAI_GPT_5_MINI_MODEL, 32_768)).toBe(32_768);
    expect(deriveContextBudgetChars(OPENAI_GPT_6_LUNA_MODEL, 32_768)).toBe(32_768);
    expect(deriveContextBudgetChars(ANTHROPIC_CLAUDE_SONNET_4_6_MODEL, 32_768)).toBe(32_768);
    expect(deriveContextBudgetChars(ANTHROPIC_CLAUDE_HAIKU_4_5_MODEL, 32_768)).toBe(32_768);
    expect(deriveContextBudgetChars(WORKERS_AI_GEMMA_4_26B_MODEL, 32_768)).toBe(32_768);
  });

  it('derives from the model window when the ceiling is not the binding constraint', () => {
    expect(deriveContextBudgetChars(OPENAI_GPT_5_NANO_MODEL, 2_000_000)).toBe(
      (400_000 - 128_000 - 8_192) * BUDGET_CHARS_PER_TOKEN,
    );
    expect(deriveContextBudgetChars(WORKERS_AI_GEMMA_4_26B_MODEL, 1_000_000)).toBe(
      (131_072 - 8_192 - 8_192) * BUDGET_CHARS_PER_TOKEN,
    );
    expect(deriveContextBudgetChars(OPENAI_GPT_6_LUNA_MODEL, 10_000_000)).toBe(
      (1_050_000 - 128_000 - 8_192) * BUDGET_CHARS_PER_TOKEN,
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
