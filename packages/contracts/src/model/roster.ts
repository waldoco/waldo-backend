import { z } from 'zod';

export const OPENAI_GPT_6_LUNA_MODEL = 'gpt-6-luna' as const;
export const OPENAI_GPT_6_1_SOL_MODEL = 'gpt-6.1-sol' as const;
export const OPENAI_GPT_6_1_TERRA_MODEL = 'gpt-6.1-terra' as const;
export const WORKERS_AI_GEMMA_4_26B_MODEL = '@cf/google/gemma-4-26b-a4b-it' as const;
export const ANTHROPIC_CLAUDE_OPUS_5_5_MODEL = 'claude-opus-5-5' as const;
export const ANTHROPIC_CLAUDE_SONNET_5_5_MODEL = 'claude-sonnet-5-5' as const;
export const ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL = 'claude-haiku-5-5' as const;
// Text embeddings for semantic memory recall, through the Workers AI binding. Not a chat model, so it is outside
// modelNameSchema and the roster roles: nothing routes a conversation to it.
export const WORKERS_AI_BGE_M3_EMBEDDING_MODEL = '@cf/baai/bge-m3' as const;
export const OPENAI_PROVIDER = 'openai' as const;
export const ANTHROPIC_PROVIDER = 'anthropic' as const;

// The only internal model IDs Waldo routes to. Workers AI keeps the documented @cf/<vendor>
// prefix; Anthropic values are the Claude API's undated aliases (Anthropic's models doc,
// checked 2026-10-20). The phantom `gemma-4-9b` and superseded `gemma-4-27b` are
// intentionally absent — the PreLLMCall hook rejects any ID outside this set.
export const modelNameSchema = z.enum([
  WORKERS_AI_GEMMA_4_26B_MODEL,
  ANTHROPIC_CLAUDE_OPUS_5_5_MODEL,
  ANTHROPIC_CLAUDE_SONNET_5_5_MODEL,
  ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL,
  OPENAI_GPT_6_LUNA_MODEL,
  OPENAI_GPT_6_1_SOL_MODEL,
  OPENAI_GPT_6_1_TERRA_MODEL,
]);
export type ModelName = z.infer<typeof modelNameSchema>;

// The OpenAI models of the owner path. On OpenAI, the owner's own conversation turns (app, iMessage, WhatsApp, Telegram)
// and the delegate tasks they spawn run on WALDO_CHAT_MODEL; every call that is not an owner's conversation turn
// (reaction choice, thread titles, memory extraction and consolidation, conversation compaction, reminder, day-card,
// brief and heartbeat wording, background decisions) runs on WALDO_AUXILIARY_MODEL. Not ROSTER.auxiliary below, which is
// the run loop's classifier role.
// A model swap is a pin change here; a new model also needs its roster entry, PROVIDER_OF, MODEL_REASONING, a
// context spec and a price in packages/runtime/src/llm/pricing.ts.
export const WALDO_CHAT_MODEL: ModelName = OPENAI_GPT_6_1_TERRA_MODEL;
export const WALDO_AUXILIARY_MODEL: ModelName = OPENAI_GPT_6_LUNA_MODEL;
// The Claude models of the owner path, in the same two roles: the current Claude Sonnet and the current Claude Haiku.
// Opus stays in the roster for a stronger tier. Same pin discipline as the two models above.
export const WALDO_CHAT_FALLBACK_MODEL: ModelName = ANTHROPIC_CLAUDE_SONNET_5_5_MODEL;
export const WALDO_AUXILIARY_FALLBACK_MODEL: ModelName = ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL;

// The providers that can run the owner path. The deploy picks one (WALDO_MODEL_PROVIDER); the other is every route's
// fallback when its key is deployed.
export const modelProviderSchema = z.enum([ANTHROPIC_PROVIDER, OPENAI_PROVIDER]);
export type ModelProvider = z.infer<typeof modelProviderSchema>;
export const DEFAULT_MODEL_PROVIDER: ModelProvider = ANTHROPIC_PROVIDER;
export const OWNER_MODELS: Readonly<Record<ModelProvider, Readonly<{ chat: ModelName; auxiliary: ModelName }>>> = {
  [ANTHROPIC_PROVIDER]: { chat: WALDO_CHAT_FALLBACK_MODEL, auxiliary: WALDO_AUXILIARY_FALLBACK_MODEL },
  [OPENAI_PROVIDER]: { chat: WALDO_CHAT_MODEL, auxiliary: WALDO_AUXILIARY_MODEL },
};

// The reasoning efforts Waldo asks for. Every OpenAI roster model accepts both.
export const reasoningEffortSchema = z.enum(['low', 'medium']);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

// Per OpenAI model: the efforts its OpenAI model page lists, and the effort Waldo asks for. The effort follows the
// model rather than the call, so a Luna call stays at low wherever it runs. outputTokens is the output cap a call on
// the model asks for when its route sets none: reasoning tokens count against a call's output cap, and OpenAI's
// reasoning guide asks for at least 25,000 tokens of room for reasoning and output, so the owner's chat models carry
// that room whatever effort they run at. A model without it keeps the route's cap.
export type OpenAIReasoning = Readonly<{ accepts: readonly string[]; effort: ReasoningEffort; outputTokens?: number }>;
export const OPENAI_REASONING: Readonly<Partial<Record<ModelName, OpenAIReasoning>>> = {
  [OPENAI_GPT_6_LUNA_MODEL]: { accepts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], effort: 'low' },
  [OPENAI_GPT_6_1_SOL_MODEL]: { accepts: ['low', 'medium', 'high', 'xhigh', 'max'], effort: 'medium', outputTokens: 25_000 },
  [OPENAI_GPT_6_1_TERRA_MODEL]: { accepts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], effort: 'medium', outputTokens: 25_000 },
};

// What a call asks of the model it runs on, whichever provider that is. On Claude the effort is output_config.effort under
// adaptive thinking, which these models always run; Anthropic's Sonnet 5.5 guide starts multistep tool use at medium and
// classification or extraction at low, and thinking counts against the output cap, so the chat tiers carry room for it.
// Effort and cap are measured starting points: an effort sweep on the eval can move them.
export type ModelReasoning = Readonly<{ effort: ReasoningEffort; outputTokens?: number }>;
export const MODEL_REASONING: Readonly<Partial<Record<ModelName, ModelReasoning>>> = {
  ...Object.fromEntries(Object.entries(OPENAI_REASONING).map(([model, { effort, outputTokens }]) => [model, { effort, ...(outputTokens ? { outputTokens } : {}) }])),
  [ANTHROPIC_CLAUDE_OPUS_5_5_MODEL]: { effort: 'medium', outputTokens: 32_000 },
  [ANTHROPIC_CLAUDE_SONNET_5_5_MODEL]: { effort: 'medium', outputTokens: 32_000 },
  [ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL]: { effort: 'low', outputTokens: 16_000 },
};

// Speech-to-text for owner voice notes. Not chat routes, so they stay outside modelNameSchema.
// Recommended default is ElevenLabs Scribe v2 (docs/planning/STT_SELECTION.md); smallest.ai Pulse and
// OpenAI transcription are configured options.
export const ELEVENLABS_TRANSCRIBE_MODEL = 'scribe_v2' as const;
export const SMALLEST_TRANSCRIBE_MODEL = 'pulse' as const;
export const WALDO_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe' as const;

export const providerSchema = z.enum(['workers_ai', ANTHROPIC_PROVIDER, OPENAI_PROVIDER]);
export type Provider = z.infer<typeof providerSchema>;

export const PROVIDER_OF: Readonly<Record<ModelName, Provider>> = {
  [WORKERS_AI_GEMMA_4_26B_MODEL]: 'workers_ai',
  [ANTHROPIC_CLAUDE_OPUS_5_5_MODEL]: ANTHROPIC_PROVIDER,
  [ANTHROPIC_CLAUDE_SONNET_5_5_MODEL]: ANTHROPIC_PROVIDER,
  [ANTHROPIC_CLAUDE_HAIKU_5_5_MODEL]: ANTHROPIC_PROVIDER,
  [OPENAI_GPT_6_LUNA_MODEL]: OPENAI_PROVIDER,
  [OPENAI_GPT_6_1_SOL_MODEL]: OPENAI_PROVIDER,
  [OPENAI_GPT_6_1_TERRA_MODEL]: OPENAI_PROVIDER,
};

// The documented request ID and exact response identities accepted at the Cloudflare
// chat-completions seam. This stays roster-owned so a provider wire-ID change is a pinned model
// decision, not a string transformation hidden in an adapter (ADR-0069 §1). Response identities
// remain an allowlist. The Claude rows follow the gateway's documented `anthropic/<id with dots>`
// request shape; a date-stamped response alias is added only once Cloudflare's raw model-page
// response shows one for that model.
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
  'claude-opus-5-5': {
    request: 'anthropic/claude-opus-5.5',
    response: ['claude-opus-5-5'],
  },
  'claude-sonnet-5-5': {
    request: 'anthropic/claude-sonnet-5.5',
    response: ['claude-sonnet-5-5'],
  },
  'claude-haiku-5-5': {
    request: 'anthropic/claude-haiku-5.5',
    response: ['claude-haiku-5-5'],
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
  reasoning: 'claude-opus-5-5',
  fallback: 'claude-haiku-5-5',
  auxiliary: '@cf/google/gemma-4-26b-a4b-it',
  harness_judge: 'claude-haiku-5-5',
};

// Durable protocol records pin a roster-owned reference, never duplicate the resolved model ID.
// Execution validates this reference and then resolves the current ID from ROSTER in one place.
export const ROSTER_REFS = Object.freeze({
  primary: 'roster_primary_v1',
} as const);
