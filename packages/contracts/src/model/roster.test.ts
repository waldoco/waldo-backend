import { describe, expect, it } from 'vitest';
import {
  CLOUDFLARE_CHAT_COMPLETIONS_MODEL_IDS,
  OPENAI_GPT_5_NANO_MODEL,
  modelNameSchema,
  PROVIDER_OF,
  ROSTER,
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
    expect(PROVIDER_OF[OPENAI_GPT_5_NANO_MODEL]).toBe('openai');
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
