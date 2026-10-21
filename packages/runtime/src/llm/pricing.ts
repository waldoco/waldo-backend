import { ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL, ANTHROPIC_CLAUDE_OPUS_5_5_MODEL, OPENAI_GPT_6_1_SOL_MODEL, OPENAI_GPT_6_LUNA_MODEL, type TurnModelUsage } from '@waldo/contracts';

// USD per 1M tokens, standard tier. The one place model prices live; update from
// https://developers.openai.com/api/docs/pricing when OpenAI changes them (checked 2026-09-23) and from
// https://platform.claude.com/docs/en/about-claude/pricing when Anthropic does (checked 2026-10-20).
const PRICES: Readonly<Record<string, Readonly<{ input: number; cachedInput: number; output: number }>>> = {
  // checked 2026-09-28 on the pricing page above (short-context tier; >272K input tokens bills
  // 2x input / 1.5x output, which this flat table does not model - same shape as existing rows)
  [OPENAI_GPT_6_LUNA_MODEL]: { input: 0.1, cachedInput: 0.01, output: 0.5 },
  // Short-context tier from the same page. Not modelled here either: cache writes bill $2.50 (usage reports no write
  // count), and >272K input tokens bills 2x input / 1.5x output.
  [OPENAI_GPT_6_1_SOL_MODEL]: { input: 2, cachedInput: 0.1, output: 10 },
  // Anthropic rows: the adapter reports input_tokens as the whole prompt (uncached + cache reads + cache writes), so this
  // formula holds. Not modelled: cache writes bill 1.25x input (5-minute TTL), and Haiku bills 5x above 100K prompt tokens.
  [ANTHROPIC_CLAUDE_OPUS_5_5_MODEL]: { input: 4, cachedInput: 0.2, output: 20 },
  [ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL]: { input: 0.1, cachedInput: 0.01, output: 0.5 },
};

// Hosted web search bills per call on top of tokens ("Web search (all models)" on the pricing page above). Its search
// content tokens bill at model rates; this assumes they arrive in the call's reported input tokens.
const WEB_SEARCH_USD_PER_CALL = 10 / 1_000;

export type ModelUsage = TurnModelUsage;
export type ModelCost = Readonly<{ input: number; output: number; web_search?: number; total: number }>;

export const modelCost = ({ model, input, output, cached, web_searches = 0 }: ModelUsage): ModelCost | null => {
  const price = PRICES[model];
  if (!price) return null;
  const inputUsd = ((input - cached) * price.input + cached * price.cachedInput) / 1e6;
  const outputUsd = (output * price.output) / 1e6;
  if (web_searches <= 0) return { input: inputUsd, output: outputUsd, total: inputUsd + outputUsd };
  const searchUsd = web_searches * WEB_SEARCH_USD_PER_CALL;
  return { input: inputUsd, output: outputUsd, web_search: searchUsd, total: inputUsd + outputUsd + searchUsd };
};
