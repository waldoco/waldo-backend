import { z } from 'zod';

export const OPENAI_GPT_5_NANO_MODEL = 'gpt-5-nano' as const;
export const OPENAI_PROVIDER = 'openai' as const;

// The only internal model IDs Waldo routes to. Workers AI keeps the documented @cf/<vendor>
// prefix; Anthropic values are stable internal aliases. The phantom `gemma-4-9b` and
// superseded `gemma-4-27b` are intentionally absent — the PreLLMCall hook rejects any ID
// outside this set.
export const modelNameSchema = z.enum([
  '@cf/google/gemma-4-26b-a4b-it',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  OPENAI_GPT_5_NANO_MODEL,
]);
export type ModelName = z.infer<typeof modelNameSchema>;

// The model Waldo chats, remembers and reacts with. Swapping models is this one line when the
// target is already in the roster with an OpenAI provider; a new model also needs its roster
// entry above, PROVIDER_OF below and a price in packages/runtime/src/llm/pricing.ts.
export const WALDO_CHAT_MODEL: ModelName = OPENAI_GPT_5_NANO_MODEL;

// Speech-to-text for owner voice notes. Not chat routes, so they stay outside modelNameSchema.
// Recommended default is ElevenLabs Scribe v2 (docs/planning/STT_SELECTION.md); smallest.ai Pulse and
// OpenAI transcription are configured options.
export const ELEVENLABS_TRANSCRIBE_MODEL = 'scribe_v2' as const;
export const SMALLEST_TRANSCRIBE_MODEL = 'pulse' as const;
export const WALDO_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe' as const;

export const providerSchema = z.enum(['workers_ai', 'anthropic', OPENAI_PROVIDER]);
export type Provider = z.infer<typeof providerSchema>;

export const PROVIDER_OF: Readonly<Record<ModelName, Provider>> = {
  '@cf/google/gemma-4-26b-a4b-it': 'workers_ai',
  'claude-sonnet-4-6': 'anthropic',
  'claude-haiku-4-5': 'anthropic',
  [OPENAI_GPT_5_NANO_MODEL]: OPENAI_PROVIDER,
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
  Partial<Record<ModelName, CloudflareChatCompletionsModelIdentity>>
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

// Durable protocol records pin a roster-owned reference, never duplicate the resolved model ID.
// Execution validates this reference and then resolves the current ID from ROSTER in one place.
export const ROSTER_REFS = Object.freeze({
  primary: 'roster_primary_v1',
} as const);
