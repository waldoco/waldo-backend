import { expect, it } from 'vitest';
import { OPENAI_GPT_6_1_SOL_MODEL, OPENAI_GPT_6_LUNA_MODEL } from '@waldo/contracts';
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

it('keeps Luna at $0.10 input, $0.01 cached input and $0.50 output per million tokens', () => {
  expect(modelCost({ model: OPENAI_GPT_6_LUNA_MODEL, input: M, output: M, cached: 0 })?.total).toBeCloseTo(0.6, 10);
  expect(modelCost({ model: OPENAI_GPT_6_LUNA_MODEL, input: M, output: 0, cached: M })?.total).toBeCloseTo(0.01, 10);
});

it('has no price for a model outside the table', () => {
  expect(modelCost({ model: 'unpriced-model', input: 1, output: 1, cached: 0 })).toBeNull();
});
