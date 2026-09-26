import { z } from 'zod';
import {
  ANTHROPIC_CLAUDE_HAIKU_4_5_MODEL,
  ANTHROPIC_CLAUDE_SONNET_4_6_MODEL,
  OPENAI_GPT_5_MINI_MODEL,
  OPENAI_GPT_5_NANO_MODEL,
  OPENAI_GPT_6_LUNA_MODEL,
  WORKERS_AI_GEMMA_4_26B_MODEL,
  modelNameSchema,
} from './roster';
import type { ModelName } from './roster';

// Dynamic per-model context budgets (owner decision 2026-09-26): budgets derive from the
// deployed model's REAL context window instead of one fixed hand-picked number. The fixed
// schema max values (SANITISE_DESTINATION_POLICIES.*.max_chars, llmToolTurnSchema.output max)
// stay as hard wire ceilings; a derived budget may only TIGHTEN below them, never loosen above -
// fail-closed semantics preserved, and current models keep today's effective behavior.

// Chars-per-token estimate for budget arithmetic. 4 chars/token is the standard English
// approximation ONLY: non-English or token-heavy text can run denser than 4 chars/token, in
// which case a char-derived budget can exceed the real token window. This estimate is
// therefore NOT a proven bound - it is acceptable while derived budgets stay at or below
// today's fixed ceilings, but any RAISED wire ceiling must switch to actual token counting
// or a proven bound (owner review on #211).
export const BUDGET_CHARS_PER_TOKEN = 4 as const;

export const modelContextSpecSchema = z.strictObject({
  context_window_tokens: z.int().positive(),
  output_reserve_tokens: z.int().positive(),
  safety_margin_tokens: z.int().nonnegative(),
});
export type ModelContextSpec = z.infer<typeof modelContextSpecSchema>;

// Sources (verified 2026-09-26; keyed by the roster constants, which own the identifiers):
// - OPENAI_GPT_5_NANO_MODEL / OPENAI_GPT_5_MINI_MODEL: OpenAI model pages - 400,000 context,
//   128,000 max output (developers.openai.com/api/docs/models/<id>).
// - OPENAI_GPT_6_LUNA_MODEL: OpenAI model page - 1,050,000 context, 128,000 max output
//   (OpenAI model page; identifier is owned by the roster).
// - ANTHROPIC_CLAUDE_SONNET_4_6_MODEL: Anthropic context-windows doc - listed in the 1M-window
//   group, 128k max output (platform.claude.com/docs/en/build-with-claude/context-windows).
// - ANTHROPIC_CLAUDE_HAIKU_4_5_MODEL: same doc - outside the 1M group, so the 200k window;
//   64k output reserve.
// - WORKERS_AI_GEMMA_4_26B_MODEL: Workers AI model page not publicly documented at this
//   revision - conservative 128k-window assumption, marked for correction against the
//   Workers AI dashboard before this model ever routes production traffic.
export const MODEL_CONTEXT_SPECS = {
  [WORKERS_AI_GEMMA_4_26B_MODEL]: {
    context_window_tokens: 131_072,
    output_reserve_tokens: 8_192,
    safety_margin_tokens: 8_192,
  },
  [ANTHROPIC_CLAUDE_SONNET_4_6_MODEL]: {
    context_window_tokens: 1_000_000,
    output_reserve_tokens: 128_000,
    safety_margin_tokens: 16_384,
  },
  [ANTHROPIC_CLAUDE_HAIKU_4_5_MODEL]: {
    context_window_tokens: 200_000,
    output_reserve_tokens: 64_000,
    safety_margin_tokens: 8_192,
  },
  [OPENAI_GPT_5_NANO_MODEL]: {
    context_window_tokens: 400_000,
    output_reserve_tokens: 128_000,
    safety_margin_tokens: 8_192,
  },
  [OPENAI_GPT_5_MINI_MODEL]: {
    context_window_tokens: 400_000,
    output_reserve_tokens: 128_000,
    safety_margin_tokens: 8_192,
  },
  [OPENAI_GPT_6_LUNA_MODEL]: {
    context_window_tokens: 1_050_000,
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
