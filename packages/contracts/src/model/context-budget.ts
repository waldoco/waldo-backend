import { z } from 'zod';
import { modelNameSchema } from './roster';
import type { ModelName } from './roster';

// Dynamic per-model context budgets (owner decision 2026-09-26): budgets derive from the
// deployed model's REAL context window instead of one fixed hand-picked number. The fixed
// schema max values (SANITISE_DESTINATION_POLICIES.*.max_chars, llmToolTurnSchema.output max)
// stay as hard wire ceilings; a derived budget may only TIGHTEN below them, never loosen above -
// fail-closed semantics preserved, and current models keep today's effective behavior.

// Conservative chars-per-token estimate for budget arithmetic. 4 chars/token is the standard
// English approximation; erring low can only shrink a derived budget, never exceed the real
// window.
export const BUDGET_CHARS_PER_TOKEN = 4 as const;

export const modelContextSpecSchema = z.strictObject({
  context_window_tokens: z.int().positive(),
  output_reserve_tokens: z.int().positive(),
  safety_margin_tokens: z.int().nonnegative(),
});
export type ModelContextSpec = z.infer<typeof modelContextSpecSchema>;

// Sources (verified 2026-09-26):
// - gpt-5-nano / gpt-5-mini: OpenAI model pages - 400,000 context, 128,000 max output
//   (developers.openai.com/api/docs/models/gpt-5-nano, .../gpt-5-mini).
// - claude-sonnet-4-6: Anthropic context-windows doc - listed in the 1M-window group, 128k max
//   output (platform.claude.com/docs/en/build-with-claude/context-windows).
// - claude-haiku-4-5: same doc - outside the 1M group, so the 200k window; 64k output reserve.
// - @cf/google/gemma-4-26b-a4b-it: Workers AI model page not publicly documented at this
//   revision - conservative 128k-window assumption, marked for correction against the
//   Workers AI dashboard before this model ever routes production traffic.
export const MODEL_CONTEXT_SPECS = {
  '@cf/google/gemma-4-26b-a4b-it': {
    context_window_tokens: 131_072,
    output_reserve_tokens: 8_192,
    safety_margin_tokens: 8_192,
  },
  'claude-sonnet-4-6': {
    context_window_tokens: 1_000_000,
    output_reserve_tokens: 128_000,
    safety_margin_tokens: 16_384,
  },
  'claude-haiku-4-5': {
    context_window_tokens: 200_000,
    output_reserve_tokens: 64_000,
    safety_margin_tokens: 8_192,
  },
  'gpt-5-nano': {
    context_window_tokens: 400_000,
    output_reserve_tokens: 128_000,
    safety_margin_tokens: 8_192,
  },
  'gpt-5-mini': {
    context_window_tokens: 400_000,
    output_reserve_tokens: 128_000,
    safety_margin_tokens: 8_192,
  },
} as const satisfies Readonly<Record<ModelName, ModelContextSpec>>;

// Every roster model must carry a spec - a roster addition without a budget entry fails here at
// compile time, not in production.
const _specCoverage: Readonly<Record<ModelName, ModelContextSpec>> = MODEL_CONTEXT_SPECS;
void _specCoverage;
void modelNameSchema;

// Effective char budget for one sanitise destination on one request model. TIGHTEN-ONLY by
// construction: the result never exceeds the destination's pinned wire ceiling. A model whose
// usable window exceeds the ceiling keeps today's behavior exactly; a smaller-window model gets
// a proportionally tighter budget instead of a fixed number invented once for the biggest model.
export const deriveContextBudgetChars = (model: ModelName, wireCeilingChars: number): number => {
  const spec = MODEL_CONTEXT_SPECS[model];
  const usableTokens = Math.max(
    spec.context_window_tokens - spec.output_reserve_tokens - spec.safety_margin_tokens,
    0,
  );
  return Math.min(usableTokens * BUDGET_CHARS_PER_TOKEN, wireCeilingChars);
};
