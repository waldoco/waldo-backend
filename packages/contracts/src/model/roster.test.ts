import { describe, expect, it } from 'vitest';
import { modelNameSchema, PROVIDER_OF, ROSTER } from './roster';

describe('modelName', () => {
  it('accepts the three canonical roster ids', () => {
    expect(modelNameSchema.options).toHaveLength(3);
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
  });
});
