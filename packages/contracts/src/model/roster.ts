import { z } from 'zod';

// The only internal model IDs Waldo routes to. Workers AI keeps the documented @cf/<vendor>
// prefix; Anthropic values are stable internal aliases. The phantom `gemma-4-9b` and
// superseded `gemma-4-27b` are intentionally absent — the PreLLMCall hook rejects any ID
// outside this set.
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

// The documented request ID and exact response identities accepted at the Cloudflare
// chat-completions seam. This stays roster-owned so a provider wire-ID change is a pinned model
// decision, not a string transformation hidden in an adapter (ADR-0069 §1). Response identities
// remain an allowlist: the Haiku date-stamped alias is sourced from Cloudflare's raw model-page
// response and is compatibility evidence, not a family/version prefix rule.
export type CloudflareChatCompletionsModelIdentity = Readonly<{
  request: string;
  response: readonly string[];
}>;

export const CLOUDFLARE_CHAT_COMPLETIONS_MODEL_IDS: Readonly<
  Record<ModelName, CloudflareChatCompletionsModelIdentity>
> = {
  '@cf/google/gemma-4-26b-a4b-it': {
    request: '@cf/google/gemma-4-26b-a4b-it',
    response: ['@cf/google/gemma-4-26b-a4b-it'],
  },
  'claude-sonnet-4-6': {
    request: 'anthropic/claude-sonnet-4.6',
    response: ['claude-sonnet-4-6'],
  },
  'claude-haiku-4-5': {
    request: 'anthropic/claude-haiku-4.5',
    response: ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'],
  },
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
