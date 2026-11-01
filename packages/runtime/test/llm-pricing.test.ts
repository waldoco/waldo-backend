import { expect, it } from 'vitest';
import { ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, WORKERS_AI_GEMMA_4_26B_MODEL, modelNameSchema, OPENAI_GPT_6_1_SOL_MODEL, OPENAI_GPT_6_1_TERRA_MODEL, OPENAI_GPT_6_LUNA_MODEL, WALDO_CHAT_FALLBACK_MODEL, WALDO_CHAT_MODEL } from '@waldo/contracts';
import { modelCost } from '../src/llm/pricing';

const M = 1_000_000;

it('prices Sol at $2 input, $0.10 cached input and $10 output per million tokens', () => {
  expect(modelCost({ model: OPENAI_GPT_6_1_SOL_MODEL, input: M, output: 0, cached: 0 })?.total).toBeCloseTo(2, 10);
  expect(modelCost({ model: OPENAI_GPT_6_1_SOL_MODEL, input: M, output: 0, cached: M })?.total).toBeCloseTo(0.1, 10);
  expect(modelCost({ model: OPENAI_GPT_6_1_SOL_MODEL, input: 0, output: M, cached: 0 })?.total).toBeCloseTo(10, 10);
  expect(modelCost({ model: OPENAI_GPT_6_1_SOL_MODEL, input: 2_000, output: 100, cached: 1_500 })).toEqual({
    input: expect.closeTo((500 * 2 + 1_500 * 0.1) / M, 12),
    output: expect.closeTo((100 * 10) / M, 12),
    total: expect.closeTo((500 * 2 + 1_500 * 0.1 + 100 * 10) / M, 12),
  });
});

it('prices Terra at $1 input, $0.05 cached input and $5 output per million tokens', () => {
  expect(modelCost({ model: OPENAI_GPT_6_1_TERRA_MODEL, input: M, output: 0, cached: 0 })?.total).toBeCloseTo(1, 10);
  expect(modelCost({ model: OPENAI_GPT_6_1_TERRA_MODEL, input: M, output: 0, cached: M })?.total).toBeCloseTo(0.05, 10);
  expect(modelCost({ model: OPENAI_GPT_6_1_TERRA_MODEL, input: 0, output: M, cached: 0 })?.total).toBeCloseTo(5, 10);
});

it('prices Sonnet at $2 input, $0.10 cached input and $10 output per million tokens', () => {
  expect(modelCost({ model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, input: M, output: 0, cached: 0 })?.total).toBeCloseTo(2, 10);
  expect(modelCost({ model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, input: M, output: 0, cached: M })?.total).toBeCloseTo(0.1, 10);
  expect(modelCost({ model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, input: 0, output: M, cached: 0 })?.total).toBeCloseTo(10, 10);
});

it('prices the chat model and its fallback, so the owner spend ceiling accrues on it', () => {
  expect(modelCost({ model: WALDO_CHAT_MODEL, input: 1, output: 1, cached: 0 })).not.toBeNull();
  expect(modelCost({ model: WALDO_CHAT_FALLBACK_MODEL, input: 1, output: 1, cached: 0 })).not.toBeNull();
});

it('keeps Luna at $0.10 input, $0.01 cached input and $0.50 output per million tokens', () => {
  expect(modelCost({ model: OPENAI_GPT_6_LUNA_MODEL, input: M, output: M, cached: 0 })?.total).toBeCloseTo(0.6, 10);
  expect(modelCost({ model: OPENAI_GPT_6_LUNA_MODEL, input: M, output: 0, cached: M })?.total).toBeCloseTo(0.01, 10);
});

it('has no price for a model outside the table', () => {
  expect(modelCost({ model: 'unpriced-model', input: 1, output: 1, cached: 0 })).toBeNull();
});

it('adds hosted web search at $10 per 1,000 calls to the call total', () => {
  const tokens = modelCost({ model: OPENAI_GPT_6_1_SOL_MODEL, input: 2_000, output: 100, cached: 1_500 })!;
  const searched = modelCost({ model: OPENAI_GPT_6_1_SOL_MODEL, input: 2_000, output: 100, cached: 1_500, web_searches: 3 })!;
  expect(searched.web_search).toBeCloseTo(0.03, 12);
  expect(searched.total).toBeCloseTo(tokens.total + 0.03, 12);
  expect(modelCost({ model: OPENAI_GPT_6_LUNA_MODEL, input: 0, output: 0, cached: 0, web_searches: 1 })?.total).toBeCloseTo(0.01, 12);
});

it('leaves the cost shape unchanged for a call with no hosted search', () => {
  expect(modelCost({ model: OPENAI_GPT_6_LUNA_MODEL, input: 1, output: 1, cached: 0, web_searches: 0 })).not.toHaveProperty('web_search');
});

// Cache writes bill at their own rate (OpenAI 30-minute write, Anthropic 5-minute write), never as plain input.
it('prices cache writes at each provider\'s published write rate, apart from reads and uncached input', () => {
  expect(modelCost({ model: OPENAI_GPT_6_1_TERRA_MODEL, input: M, output: 0, cached: 0, cache_write: M })?.total).toBeCloseTo(1.25, 10);
  expect(modelCost({ model: OPENAI_GPT_6_1_SOL_MODEL, input: M, output: 0, cached: 0, cache_write: M })?.total).toBeCloseTo(2.5, 10);
  expect(modelCost({ model: OPENAI_GPT_6_LUNA_MODEL, input: M, output: 0, cached: 0, cache_write: M })?.total).toBeCloseTo(0.125, 10);
  expect(modelCost({ model: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, input: M, output: 0, cached: 0, cache_write: M })?.total).toBeCloseTo(2.5, 10);
  const mixed = modelCost({ model: OPENAI_GPT_6_1_TERRA_MODEL, input: 2_000, output: 100, cached: 500, cache_write: 1_000 })!;
  expect(mixed).toEqual({
    input: expect.closeTo((500 * 1 + 500 * 0.05) / M, 12),
    cache_write: expect.closeTo((1_000 * 1.25) / M, 12),
    output: expect.closeTo((100 * 5) / M, 12),
    total: expect.closeTo((500 * 1 + 500 * 0.05 + 1_000 * 1.25 + 100 * 5) / M, 12),
  });
});

it('leaves the cost shape unchanged for a call that wrote nothing to the cache', () => {
  expect(modelCost({ model: OPENAI_GPT_6_1_TERRA_MODEL, input: 1, output: 1, cached: 0, cache_write: 0 })).not.toHaveProperty('cache_write');
});

it('never prices uncached input below zero when a provider reports reads and writes that exceed the whole prompt', () => {
  const cost = modelCost({ model: OPENAI_GPT_6_1_TERRA_MODEL, input: 1_000, output: 0, cached: 600, cache_write: 700 })!;
  expect(cost.input).toBeCloseTo((600 * 0.05) / M, 12);
  expect(cost.total).toBeGreaterThanOrEqual(0);
});

it('prices every model the router can pick, Workers AI included', () => {
  for (const model of modelNameSchema.options) expect(modelCost({ model, input: 1, output: 1, cached: 0 }), model).not.toBeNull();
  expect(modelCost({ model: WORKERS_AI_GEMMA_4_26B_MODEL, input: M, output: M, cached: 0 })?.total).toBeCloseTo(0.4, 10);
});
