import { OPENAI_GPT_5_MINI_MODEL, OPENAI_GPT_5_NANO_MODEL } from '@waldo/contracts';

// USD per 1M tokens, standard tier. The one place model prices live; update from
// https://developers.openai.com/api/docs/pricing when OpenAI changes them (checked 2026-09-23).
const PRICES: Readonly<Record<string, Readonly<{ input: number; cachedInput: number; output: number }>>> = {
  [OPENAI_GPT_5_NANO_MODEL]: { input: 0.05, cachedInput: 0.005, output: 0.4 },
  // checked 2026-09-24 on the model page linked from the pricing page above
  [OPENAI_GPT_5_MINI_MODEL]: { input: 0.25, cachedInput: 0.025, output: 2 },
};

export type ModelUsage = Readonly<{ model: string; input: number; output: number; cached: number }>;
export type ModelCost = Readonly<{ input: number; output: number; total: number }>;

export const modelCost = ({ model, input, output, cached }: ModelUsage): ModelCost | null => {
  const price = PRICES[model];
  if (!price) return null;
  const inputUsd = ((input - cached) * price.input + cached * price.cachedInput) / 1e6;
  const outputUsd = (output * price.output) / 1e6;
  return { input: inputUsd, output: outputUsd, total: inputUsd + outputUsd };
};
