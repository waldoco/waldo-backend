import { describe, expect, it } from 'vitest';
import {
  CLOUDFLARE_CHAT_COMPLETIONS_MODEL_IDS,
  OPENAI_GPT_6_1_SOL_MODEL,
  OPENAI_GPT_6_LUNA_MODEL,
  OPENAI_REASONING,
  modelNameSchema,
  PROVIDER_OF,
  reasoningEffortSchema,
  ROSTER,
  WALDO_AUXILIARY_MODEL,
  WALDO_CHAT_MODEL,
} from './roster';

describe('modelName', () => {
  it('accepts the canonical roster ids', () => {
    expect(modelNameSchema.options).toHaveLength(5);
    for (const id of modelNameSchema.options) {
      expect(modelNameSchema.parse(id)).toBe(id);
    }
  });

  it('rejects the phantom 9b and the superseded 27b (ADR-0069)', () => {
    expect(modelNameSchema.safeParse('gemma-4-9b').success).toBe(false);
    expect(modelNameSchema.safeParse('gemma-4-27b').success).toBe(false);
    expect(modelNameSchema.safeParse('@cf/google/gemma-4-27b').success).toBe(false);
  });

  it('accepts the exact Sol id and rejects its near misses', () => {
    expect(OPENAI_GPT_6_1_SOL_MODEL).toBe('gpt-6.1-sol');
    expect(modelNameSchema.parse('gpt-6.1-sol')).toBe(OPENAI_GPT_6_1_SOL_MODEL);
    for (const id of ['gpt-6-sol', 'gpt-6.1-sol-mini', 'GPT-6.1-SOL', 'gpt-6.1-sol ', 'openai/gpt-6.1-sol', 'gpt-6.1']) {
      expect(modelNameSchema.safeParse(id).success, id).toBe(false);
    }
  });
});

describe('chat model seam', () => {
  it('runs owner conversation turns on Sol and every auxiliary call on Luna', () => {
    expect(WALDO_CHAT_MODEL).toBe(OPENAI_GPT_6_1_SOL_MODEL);
    expect(WALDO_AUXILIARY_MODEL).toBe(OPENAI_GPT_6_LUNA_MODEL);
  });
});

describe('reasoning effort', () => {
  it('routes only low and medium, and has no none or minimal', () => {
    for (const effort of ['low', 'medium']) expect(reasoningEffortSchema.safeParse(effort).success, effort).toBe(true);
    for (const effort of ['none', 'minimal', 'MEDIUM', '', null]) expect(reasoningEffortSchema.safeParse(effort).success, String(effort)).toBe(false);
  });

  it('asks Sol for medium and Luna for low', () => {
    expect(OPENAI_REASONING[OPENAI_GPT_6_1_SOL_MODEL]?.effort).toBe('medium');
    expect(OPENAI_REASONING[OPENAI_GPT_6_LUNA_MODEL]?.effort).toBe('low');
  });

  it('records the efforts each OpenAI model page lists: Sol takes no none or minimal', () => {
    expect(OPENAI_REASONING[OPENAI_GPT_6_1_SOL_MODEL]?.accepts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(OPENAI_REASONING[OPENAI_GPT_6_LUNA_MODEL]?.accepts).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('covers every OpenAI roster model with an effort it accepts, and no other provider', () => {
    for (const model of modelNameSchema.options) {
      const reasoning = OPENAI_REASONING[model];
      if (PROVIDER_OF[model] === 'openai') expect(reasoning?.accepts, model).toContain(reasoning?.effort);
      else expect(reasoning, model).toBeUndefined();
    }
  });
});

describe('roster', () => {
  it('binds each role to the ADR-0069 model, with the two reuse invariants', () => {
    expect(ROSTER.primary).toBe('@cf/google/gemma-4-26b-a4b-it');
    expect(ROSTER.reasoning).toBe('claude-sonnet-4-6');
    expect(ROSTER.fallback).toBe('claude-haiku-4-5');
    expect(ROSTER.auxiliary).toBe(ROSTER.primary);
    expect(ROSTER.harness_judge).toBe(ROSTER.fallback);
  });

  it('assigns the correct provider per model', () => {
    expect(PROVIDER_OF['@cf/google/gemma-4-26b-a4b-it']).toBe('workers_ai');
    expect(PROVIDER_OF['claude-sonnet-4-6']).toBe('anthropic');
    expect(PROVIDER_OF['claude-haiku-4-5']).toBe('anthropic');
    expect(PROVIDER_OF[OPENAI_GPT_6_LUNA_MODEL]).toBe('openai');
    expect(PROVIDER_OF[OPENAI_GPT_6_1_SOL_MODEL]).toBe('openai');
  });

  it('owns exact Cloudflare request and response identities for every internal model', () => {
    expect(Object.keys(CLOUDFLARE_CHAT_COMPLETIONS_MODEL_IDS).sort()).toEqual(
      modelNameSchema.options.filter((model) => PROVIDER_OF[model] !== 'openai').sort(),
    );
    expect(CLOUDFLARE_CHAT_COMPLETIONS_MODEL_IDS[ROSTER.reasoning]).toEqual({
      request: 'anthropic/claude-sonnet-4.6',
      response: ['claude-sonnet-4-6'],
    });
    expect(CLOUDFLARE_CHAT_COMPLETIONS_MODEL_IDS[ROSTER.fallback]).toEqual({
      request: 'anthropic/claude-haiku-4.5',
      response: ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'],
    });
  });
});
