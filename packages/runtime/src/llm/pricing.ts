import { OPENAI_GPT_6_1_SOL_MODEL, OPENAI_GPT_6_LUNA_MODEL } from '@waldo/contracts';

// USD per 1M tokens, standard tier. The one place model prices live; update from
// https://developers.openai.com/api/docs/pricing when OpenAI changes them (checked 2026-09-23).
const PRICES: Readonly<Record<string, Readonly<{ input: number; cachedInput: number; output: number }>>> = {
  // checked 2026-09-28 on the pricing page above (short-context tier; >272K input tokens bills
  // 2x input / 1.5x output, which this flat table does not model - same shape as existing rows)
  [OPENAI_GPT_6_LUNA_MODEL]: { input: 0.1, cachedInput: 0.01, output: 0.5 },
  // Short-context tier from the same page. Not modelled here either: cache writes bill $2.50 (usage reports no write
  // count), and >272K input tokens bills 2x input / 1.5x output.
  [OPENAI_GPT_6_1_SOL_MODEL]: { input: 2, cachedInput: 0.1, output: 10 },
};

// Hosted web search bills per call on top of tokens; the content it returns is billed as input tokens, which usage
// already counts. Checked 2026-10-15 on the pricing page above ("Web search (all models)").
const WEB_SEARCH_USD_PER_CALL = 10 / 1_000;

// web_searches: hosted web search calls the model ran inside this call.
export type ModelUsage = Readonly<{ model: string; input: number; output: number; cached: number; web_searches?: number }>;
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
