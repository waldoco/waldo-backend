import { ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL, ANTHROPIC_CLAUDE_OPUS_5_5_MODEL, ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, OPENAI_GPT_6_1_SOL_MODEL, OPENAI_GPT_6_1_TERRA_MODEL, OPENAI_GPT_6_LUNA_MODEL, WORKERS_AI_GEMMA_4_26B_MODEL, type TurnModelUsage } from '@waldo/contracts';

// USD per 1M tokens, standard tier. The one place model prices live; update from
// https://developers.openai.com/api/docs/pricing when OpenAI changes them and from
// https://platform.claude.com/docs/en/about-claude/pricing when Anthropic does (both checked 2026-10-30), and from
// https://developers.cloudflare.com/workers-ai/platform/pricing/ when Cloudflare does (checked 2026-10-30). Workers AI has no
// prompt cache, so its reads and writes bill as plain input.
// cacheWrite is the rate for prompt tokens written to the cache, billed instead of input: OpenAI's default 30-minute write
// (the adapter sets no longer lifetime) and Anthropic's 5-minute write (the adapter's ephemeral marks).
// Not modelled: OpenAI bills >272K input tokens at 2x input / 1.5x output, and Haiku bills 5x above 100K prompt tokens.
const PRICES: Readonly<Record<string, Readonly<{ input: number; cachedInput: number; cacheWrite: number; output: number }>>> = {
  [OPENAI_GPT_6_LUNA_MODEL]: { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
  [OPENAI_GPT_6_1_SOL_MODEL]: { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 },
  [OPENAI_GPT_6_1_TERRA_MODEL]: { input: 1, cachedInput: 0.05, cacheWrite: 1.25, output: 5 },
  [ANTHROPIC_CLAUDE_OPUS_5_5_MODEL]: { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 },
  [ANTHROPIC_CLAUDE_SONNET_5_5_MODEL]: { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 },
  [ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL]: { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
  [WORKERS_AI_GEMMA_4_26B_MODEL]: { input: 0.1, cachedInput: 0.1, cacheWrite: 0.1, output: 0.3 },
};

// Hosted web search bills per call on top of tokens ("Web search (all models)" on the pricing page above). Its search
// content tokens bill at model rates; this assumes they arrive in the call's reported input tokens.
const WEB_SEARCH_USD_PER_CALL = 10 / 1_000;

export type ModelUsage = TurnModelUsage;
// input is the uncached input and the cache reads; cache_write the tokens written to the cache, which bill only at the write rate.
export type ModelCost = Readonly<{ input: number; cache_write?: number; output: number; web_search?: number; total: number }>;

// Uncached input: the whole prompt less its cache reads and writes, never below zero.
export const uncachedInput = ({ input, cached, cache_write = 0 }: Pick<ModelUsage, 'input' | 'cached' | 'cache_write'>): number => Math.max(0, input - cached - cache_write);

// A provider that reports more reads and writes than the whole prompt broke the assumption that usage.input includes them.
export const usageAnomalous = ({ input, cached, cache_write = 0 }: Pick<ModelUsage, 'input' | 'cached' | 'cache_write'>): boolean => input < cached + cache_write;

// usage.input is the whole prompt, cache reads and cache writes inside it.
export const modelCost = ({ model, input, output, cached, cache_write = 0, web_searches = 0 }: ModelUsage): ModelCost | null => {
  const price = PRICES[model];
  if (!price) return null;
  const inputUsd = (uncachedInput({ input, cached, cache_write }) * price.input + cached * price.cachedInput) / 1e6;
  const writeUsd = (cache_write * price.cacheWrite) / 1e6;
  const outputUsd = (output * price.output) / 1e6;
  const searchUsd = web_searches * WEB_SEARCH_USD_PER_CALL;
  return {
    input: inputUsd, ...(cache_write > 0 ? { cache_write: writeUsd } : {}), output: outputUsd,
    ...(web_searches > 0 ? { web_search: searchUsd } : {}), total: inputUsd + writeUsd + outputUsd + searchUsd,
  };
};
