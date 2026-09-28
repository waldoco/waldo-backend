import { OPENAI_GPT_6_LUNA_MODEL } from '@waldo/contracts';

// USD per 1M tokens, standard tier. The one place model prices live; update from
// https://developers.openai.com/api/docs/pricing when OpenAI changes them (checked 2026-09-23).
const PRICES: Readonly<Record<string, Readonly<{ input: number; cachedInput: number; output: number }>>> = {
  // checked 2026-09-28 on the pricing page above (short-context tier; >272K input tokens bills
  // 2x input / 1.5x output, which this flat table does not model - same shape as existing rows)
  [OPENAI_GPT_6_LUNA_MODEL]: { input: 0.1, cachedInput: 0.01, output: 0.5 },
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
