import {
  ANTHROPIC_PROVIDER,
  OPENAI_PROVIDER,
  PROVIDER_OF,
  routingPolicySchema,
  WALDO_AUXILIARY_FALLBACK_MODEL,
  WALDO_CHAT_FALLBACK_MODEL,
  WALDO_REASONING_FALLBACK_MODEL,
  WALDO_REASONING_MODEL,
  type ModelName,
  type RoutingPolicy,
} from '@waldo/contracts';
import { AnthropicMessagesAdapter } from './anthropic';
import { validModelCredential } from './credential-shape';
import { OpenAIResponsesAdapter, type OpenAIResponseMetadata } from './openai';
import { routedGateway, type CircuitBreaker, type LLMAttempt, type LLMGatewayAdapter } from './provider';

// What the owner responder needs to reach the model providers: the OpenAI key alone (callers that predate the second
// provider), or every provider's key. Credentials stay here and in the adapters; they never reach a prompt, a trace or a store.
// `floorReply` lets the owner's own turn answer once every provider has failed. As a promise, it keeps the message for a
// later answer and returns the reply that says by when (the brain's retry job); `true` answers MODEL_UNREACHABLE_REPLY, for
// a host that keeps and answers failed messages itself. Off, a failed turn ends the way it always did.
// `health` is the owner's provider breaker, kept by the owner's Durable Object so misses count across turns and channels;
// without it each responder starts with every provider closed.
// `text` is the message as the model read it, with any words someone else wrote in their labelled blocks; `taint` is
// 'external' when the turn carried such words, so a retry of it runs under the same taint.
export type FloorTurn = Readonly<{ traceId: string; conversationRef: string; surface: string; text: string; taint: 'external' | null; messageRef?: string; receivedAt: number }>;
export type FloorPromise = Readonly<{ promise(turn: FloorTurn): string }>;
// toolSearch: the brain's reply loads core tools up front and the rest through the provider's tool search, with strict
// schemas where the provider allows them. Off by default until a staging smoke shows both providers take the request.
// toolLoader 'harness': the reply loads core tools up front and the rest through the harness's own find_tools and use_tool
// (tools/loader.ts), on any provider. It wins over toolSearch.
// onAttempts: told every model call's attempts, so a provider that refused the key is noticed whichever call met it.
export type OwnerModelAccess = Readonly<{ openaiApiKey: string; anthropicApiKey?: string; floorReply?: boolean | FloorPromise; health?: CircuitBreaker; toolSearch?: boolean; toolLoader?: 'harness';
  onAttempts?: (attempts: readonly LLMAttempt[]) => void }>;

export const ownerModelAccess = (access: string | OwnerModelAccess): OwnerModelAccess =>
  typeof access === 'string' ? { openaiApiKey: access } : access;

// The floor of the owner's own turns, read when no provider could answer.
export const MODEL_UNREACHABLE_REPLY = "I can't reach my model right now. I've kept your message and will answer as soon as I can.";

// Every owner-path route: its model, then the second provider when its key is deployed, then the floor. Without a usable
// key the route has no fallback step at all, so nothing counts it as a provider ahead and the route is exactly the
// single-provider route it was before the second provider existed. A call on the responder's chat model falls
// to the second provider's chat model, and a turn routed to the reasoning model to the second provider's reasoning model,
// each with its system prompt and latest messages cached provider-side and room for its thinking in the output cap; every
// other call (side jobs on the auxiliary model) falls to the second provider's small model.
//
// The floor stays 'template' on every route: the routes run under the user_message trigger, and the routing contract
// keeps user-facing triggers on the template (ADR-0069 §4). Only the owner's own reply passes a renderTemplate, so a side
// job that exhausts its route fails as template_unavailable and its caller treats that as deferred work.
export const ownerRoutePolicy = (primary: ModelName, chatModel: ModelName, access: OwnerModelAccess): RoutingPolicy => routingPolicySchema.parse({
  routes: [{
    trigger: 'user_message',
    primary: { provider: PROVIDER_OF[primary], model: primary, cache: 'none', max_tokens: 4096 },
    fallback: !validModelCredential(access.anthropicApiKey) ? [] : [primary === WALDO_REASONING_MODEL || primary === chatModel
      ? { provider: ANTHROPIC_PROVIDER, model: primary === WALDO_REASONING_MODEL ? WALDO_REASONING_FALLBACK_MODEL : WALDO_CHAT_FALLBACK_MODEL, cache: 'anthropic_native', max_tokens: 16_000 }
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
