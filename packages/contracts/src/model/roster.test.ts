import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL,
  ANTHROPIC_CLAUDE_OPUS_5_5_MODEL,
  ANTHROPIC_CLAUDE_SONNET_5_5_MODEL,
  CLOUDFLARE_CHAT_COMPLETIONS_MODEL_IDS,
  DEFAULT_MODEL_PROVIDER,
  MODEL_REASONING,
  modelProviderSchema,
  OWNER_MODELS,
  OPENAI_GPT_6_1_SOL_MODEL,
  OPENAI_GPT_6_1_TERRA_MODEL,
  OPENAI_GPT_6_LUNA_MODEL,
  OPENAI_REASONING,
  modelNameSchema,
  PROVIDER_OF,
  reasoningEffortSchema,
  ROSTER,
  WALDO_AUXILIARY_FALLBACK_MODEL,
  WALDO_AUXILIARY_MODEL,
  WALDO_CHAT_FALLBACK_MODEL,
  WALDO_CHAT_MODEL,
} from './roster';

describe('modelName', () => {
  it('accepts the canonical roster ids', () => {
    expect(modelNameSchema.options).toHaveLength(7);
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
  it('accepts the exact Terra id and rejects its near misses', () => {
    expect(OPENAI_GPT_6_1_TERRA_MODEL).toBe('gpt-6.1-terra');
    expect(modelNameSchema.parse('gpt-6.1-terra')).toBe(OPENAI_GPT_6_1_TERRA_MODEL);
    for (const id of ['gpt-6-terra', 'gpt-6.1-terra-mini', 'GPT-6.1-TERRA', 'gpt-6.1-terra ', 'openai/gpt-6.1-terra']) {
      expect(modelNameSchema.safeParse(id).success, id).toBe(false);
    }
  });

  it('runs owner conversation turns on Terra and every auxiliary call on Luna', () => {
    expect(WALDO_CHAT_MODEL).toBe(OPENAI_GPT_6_1_TERRA_MODEL);
    expect(WALDO_AUXILIARY_MODEL).toBe(OPENAI_GPT_6_LUNA_MODEL);
  });

  it('accepts the exact Sonnet id and rejects its near misses', () => {
    expect(ANTHROPIC_CLAUDE_SONNET_5_5_MODEL).toBe('claude-sonnet-5-5');
    expect(modelNameSchema.parse('claude-sonnet-5-5')).toBe(ANTHROPIC_CLAUDE_SONNET_5_5_MODEL);
    for (const id of ['claude-sonnet-5.5', 'claude-sonnet-5', 'CLAUDE-SONNET-5-5', 'claude-sonnet-5-5 ', 'anthropic/claude-sonnet-5.5']) {
      expect(modelNameSchema.safeParse(id).success, id).toBe(false);
    }
  });

  it('falls back to the current Claude Sonnet for owner turns and the current Claude Haiku for auxiliary calls, and never to Opus', () => {
    expect(WALDO_CHAT_FALLBACK_MODEL).toBe('claude-sonnet-5-5');
    expect(WALDO_CHAT_FALLBACK_MODEL).not.toBe(ANTHROPIC_CLAUDE_OPUS_5_5_MODEL);
    expect(WALDO_AUXILIARY_FALLBACK_MODEL).toBe('claude-haiku-5-5');
    expect(PROVIDER_OF[WALDO_CHAT_FALLBACK_MODEL]).toBe('anthropic');
    expect(PROVIDER_OF[WALDO_AUXILIARY_FALLBACK_MODEL]).toBe('anthropic');
  });
});

describe('owner model provider', () => {
  it('defaults the owner path to Claude, Sonnet for turns and Haiku for everything else, with OpenAI as the other provider', () => {
    expect(DEFAULT_MODEL_PROVIDER).toBe('anthropic');
    expect(OWNER_MODELS.anthropic).toEqual({ chat: ANTHROPIC_CLAUDE_SONNET_5_5_MODEL, auxiliary: ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL });
    expect(OWNER_MODELS.openai).toEqual({ chat: OPENAI_GPT_6_1_TERRA_MODEL, auxiliary: OPENAI_GPT_6_LUNA_MODEL });
    for (const provider of modelProviderSchema.options) {
      expect(PROVIDER_OF[OWNER_MODELS[provider].chat], provider).toBe(provider);
      expect(PROVIDER_OF[OWNER_MODELS[provider].auxiliary], provider).toBe(provider);
    }
  });

  it('switches between exactly the two providers that hold owner keys', () => {
    expect(modelProviderSchema.options).toEqual(['anthropic', 'openai']);
    for (const value of ['workers_ai', 'Anthropic', 'claude', '']) expect(modelProviderSchema.safeParse(value).success, value).toBe(false);
  });
});

describe('model reasoning', () => {
  it('asks Sonnet for medium and Haiku for low, with output room for adaptive thinking', () => {
    expect(MODEL_REASONING[ANTHROPIC_CLAUDE_SONNET_5_5_MODEL]).toEqual({ effort: 'medium', outputTokens: 32_000 });
    expect(MODEL_REASONING[ANTHROPIC_CLAUDE_OPUS_5_5_MODEL]).toEqual({ effort: 'medium', outputTokens: 32_000 });
    expect(MODEL_REASONING[ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL]).toEqual({ effort: 'low', outputTokens: 16_000 });
  });

  it('carries every OpenAI setting unchanged and covers every owner model of both providers', () => {
    for (const [model, reasoning] of Object.entries(OPENAI_REASONING)) {
      expect(MODEL_REASONING[model as keyof typeof MODEL_REASONING], model).toEqual({ effort: reasoning!.effort, ...(reasoning!.outputTokens ? { outputTokens: reasoning!.outputTokens } : {}) });
    }
    for (const provider of modelProviderSchema.options) {
      for (const model of Object.values(OWNER_MODELS[provider])) expect(MODEL_REASONING[model], model).toBeDefined();
    }
  });
});

describe('reasoning effort', () => {
  it('routes only low and medium, and has no none or minimal', () => {
    for (const effort of ['low', 'medium']) expect(reasoningEffortSchema.safeParse(effort).success, effort).toBe(true);
    for (const effort of ['none', 'minimal', 'MEDIUM', '', null]) expect(reasoningEffortSchema.safeParse(effort).success, String(effort)).toBe(false);
  });

  it('asks Sol and Terra for medium and Luna for low', () => {
    expect(OPENAI_REASONING[OPENAI_GPT_6_1_SOL_MODEL]?.effort).toBe('medium');
    expect(OPENAI_REASONING[OPENAI_GPT_6_1_TERRA_MODEL]?.effort).toBe('medium');
    expect(OPENAI_REASONING[OPENAI_GPT_6_LUNA_MODEL]?.effort).toBe('low');
  });

  it('records the efforts each OpenAI model page lists: Sol takes no none or minimal, Terra takes none', () => {
    expect(OPENAI_REASONING[OPENAI_GPT_6_1_SOL_MODEL]?.accepts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(OPENAI_REASONING[OPENAI_GPT_6_1_TERRA_MODEL]?.accepts).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(OPENAI_REASONING[OPENAI_GPT_6_LUNA_MODEL]?.accepts).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('gives the chat model and the Sol and Terra tiers at least 25,000 output tokens, and Luna none', () => {
    for (const model of [WALDO_CHAT_MODEL, OPENAI_GPT_6_1_SOL_MODEL, OPENAI_GPT_6_1_TERRA_MODEL]) {
      expect(OPENAI_REASONING[model]?.outputTokens ?? 0, model).toBeGreaterThanOrEqual(25_000);
    }
    expect(OPENAI_REASONING[OPENAI_GPT_6_LUNA_MODEL]?.outputTokens).toBeUndefined();
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
    expect(ROSTER.reasoning).toBe('claude-opus-5-5');
    expect(ROSTER.fallback).toBe('claude-haiku-5-5');
    expect(ROSTER.auxiliary).toBe(ROSTER.primary);
    expect(ROSTER.harness_judge).toBe(ROSTER.fallback);
  });

  it('assigns the correct provider per model', () => {
    expect(PROVIDER_OF['@cf/google/gemma-4-26b-a4b-it']).toBe('workers_ai');
    expect(PROVIDER_OF['claude-opus-5-5']).toBe('anthropic');
    expect(PROVIDER_OF['claude-haiku-5-5']).toBe('anthropic');
    expect(PROVIDER_OF[ANTHROPIC_CLAUDE_SONNET_5_5_MODEL]).toBe('anthropic');
    expect(PROVIDER_OF[OPENAI_GPT_6_LUNA_MODEL]).toBe('openai');
    expect(PROVIDER_OF[OPENAI_GPT_6_1_SOL_MODEL]).toBe('openai');
    expect(PROVIDER_OF[OPENAI_GPT_6_1_TERRA_MODEL]).toBe('openai');
  });

  it('owns exact Cloudflare request and response identities for every internal model', () => {
    expect(Object.keys(CLOUDFLARE_CHAT_COMPLETIONS_MODEL_IDS).sort()).toEqual(
      modelNameSchema.options.filter((model) => PROVIDER_OF[model] !== 'openai').sort(),
    );
    expect(CLOUDFLARE_CHAT_COMPLETIONS_MODEL_IDS[ROSTER.reasoning]).toEqual({
      request: 'anthropic/claude-opus-5.5',
      response: ['claude-opus-5-5'],
    });
    expect(CLOUDFLARE_CHAT_COMPLETIONS_MODEL_IDS[ANTHROPIC_CLAUDE_SONNET_5_5_MODEL]).toEqual({
      request: 'anthropic/claude-sonnet-5.5',
      response: ['claude-sonnet-5-5'],
    });
    expect(CLOUDFLARE_CHAT_COMPLETIONS_MODEL_IDS[ROSTER.fallback]).toEqual({
      request: 'anthropic/claude-haiku-5.5',
      response: ['claude-haiku-5-5'],
    });
  });
});
