import {
  ANTHROPIC_PROVIDER,
  OPENAI_PROVIDER,
  PROVIDER_OF,
  routingPolicySchema,
  WALDO_AUXILIARY_FALLBACK_MODEL,
  WALDO_CHAT_FALLBACK_MODEL,
  type ModelName,
  type RoutingPolicy,
} from '@waldo/contracts';
import { AnthropicMessagesAdapter } from './anthropic';
import { OpenAIResponsesAdapter, type OpenAIResponseMetadata } from './openai';
import { routedGateway, type LLMGatewayAdapter } from './provider';

// What the owner responder needs to reach the model providers: the OpenAI key alone (callers that predate the second
// provider), or every provider's key. Credentials stay here and in the adapters; they never reach a prompt, a trace or a store.
// `floorReply` lets the owner's own turn answer with MODEL_UNREACHABLE_REPLY once every provider has failed. It stays off
// until a failed turn's message is actually kept and answered later; until then a failed turn ends the way it always did.
export type OwnerModelAccess = Readonly<{ openaiApiKey: string; anthropicApiKey?: string; floorReply?: boolean }>;

export const ownerModelAccess = (access: string | OwnerModelAccess): OwnerModelAccess =>
  typeof access === 'string' ? { openaiApiKey: access } : access;

// The floor of the owner's own turns, read when no provider could answer.
export const MODEL_UNREACHABLE_REPLY = "I can't reach my model right now. I've kept your message and will answer as soon as I can.";

// Every owner-path route: its model, then the second provider, then the floor. A call on the responder's chat model falls
// to the second provider's chat model, with the stable system prompt cached provider-side and room for its thinking in the
// output cap; every other call (side jobs on the auxiliary model) falls to the second provider's small model.
//
// The floor stays 'template' on every route: the routes run under the user_message trigger, and the routing contract
// keeps user-facing triggers on the template (ADR-0069 §4). Only the owner's own reply passes a renderTemplate, so a side
// job that exhausts its route fails as template_unavailable and its caller treats that as deferred work.
export const ownerRoutePolicy = (primary: ModelName, chatModel: ModelName): RoutingPolicy => routingPolicySchema.parse({
  routes: [{
    trigger: 'user_message',
    primary: { provider: PROVIDER_OF[primary], model: primary, cache: 'none', max_tokens: 4096 },
    fallback: [primary === chatModel
      ? { provider: ANTHROPIC_PROVIDER, model: WALDO_CHAT_FALLBACK_MODEL, cache: 'anthropic_native', max_tokens: 16_000 }
      : { provider: ANTHROPIC_PROVIDER, model: WALDO_AUXILIARY_FALLBACK_MODEL, cache: 'none', max_tokens: 4096 }],
    floor: 'template',
  }],
  escalation: [],
  template_fallback: true,
});

// One gateway for the owner path: each attempt goes to its step's provider. A provider whose key is not deployed fails
// its step as auth_failed without a network call, so the route reaches the floor as fast as it did with one provider.
export const ownerModelGateway = (access: OwnerModelAccess, options: Readonly<{
  timeoutMs?: number;
  onOpenAIMetadata?: (metadata: OpenAIResponseMetadata) => void;
}> = {}): LLMGatewayAdapter => {
  const timeout = options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };
  return routedGateway({
    [OPENAI_PROVIDER]: new OpenAIResponsesAdapter({ apiKey: access.openaiApiKey, ...timeout, ...(options.onOpenAIMetadata ? { onResponseMetadata: options.onOpenAIMetadata } : {}) }),
    [ANTHROPIC_PROVIDER]: new AnthropicMessagesAdapter({ ...(access.anthropicApiKey === undefined ? {} : { apiKey: access.anthropicApiKey }), ...timeout }),
  });
};
