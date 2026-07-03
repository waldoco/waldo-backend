import { z } from 'zod';

// The only model ids Waldo routes to, addressed exactly as the CF AI Gateway seam needs them
// (ADR-0069 §1). Workers-AI models carry the @cf/<vendor>/ prefix the binding requires;
// Anthropic models are addressed bare. The phantom `gemma-4-9b` and the superseded `gemma-4-27b`
// are intentionally absent — the PreLLMCall hook rejects any id outside this set.
export const modelNameSchema = z.enum([
  '@cf/google/gemma-4-26b-a4b-it',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]);
export type ModelName = z.infer<typeof modelNameSchema>;

export const providerSchema = z.enum(['workers_ai', 'anthropic']);
export type Provider = z.infer<typeof providerSchema>;

export const PROVIDER_OF: Readonly<Record<ModelName, Provider>> = {
  '@cf/google/gemma-4-26b-a4b-it': 'workers_ai',
  'claude-sonnet-4-6': 'anthropic',
  'claude-haiku-4-5': 'anthropic',
};

export const rosterRoleSchema = z.enum([
  'primary',
  'reasoning',
  'fallback',
  'auxiliary',
  'harness_judge',
]);
export type RosterRole = z.infer<typeof rosterRoleSchema>;

// One canonical model story (ADR-0069 §1). `auxiliary` reuses the primary in a distinct
// judge/classifier prompt; `harness_judge` reuses the fallback where cross-family separation
// is load-bearing. Which model fills a role is config behind the LLMProvider seam — a swap is
// a pin change here plus the ADR-0069 re-run ritual, never a code change at call sites.
export const ROSTER: Readonly<Record<RosterRole, ModelName>> = {
  primary: '@cf/google/gemma-4-26b-a4b-it',
  reasoning: 'claude-sonnet-4-6',
  fallback: 'claude-haiku-4-5',
  auxiliary: '@cf/google/gemma-4-26b-a4b-it',
  harness_judge: 'claude-haiku-4-5',
};
