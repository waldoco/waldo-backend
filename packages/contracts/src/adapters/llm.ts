import { z } from 'zod';
import type { AdapterResult } from '../core/error';
import { modelNameSchema, PROVIDER_OF } from '../model/roster';

export const llmMessageSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
});
export type LLMMessage = z.infer<typeof llmMessageSchema>;

// No credential field exists here by design: provider keys live in the gateway BYOK store,
// never in the contract or Worker env (ADR-0069 §5.2).
export const llmRequestSchema = z.strictObject({
  model: modelNameSchema,
  system: z.string().min(1).optional(),
  messages: z.array(llmMessageSchema).min(1),
  max_tokens: z.int().min(1).max(8192),
  temperature: z.number().min(0).max(2),
});
export type LLMRequest = z.infer<typeof llmRequestSchema>;

// Metering fields are required on every success — the ADR-0051 spend cap and the ADR-0069
// dogfood metering read them per step; cache_read_input_tokens is the native-cache
// verification signal (ADR-0069 §5.6). The refine encodes the corrected caching reality
// (ADR-0004 as amended; ADR-0069 §5): the gateway cache is exact-match only and never
// cross-provider, Workers AI serves no prompt caching at all, and only Anthropic-native
// cache_control pass-through produces cache reads.
export const llmResponseSchema = z
  .strictObject({
    model: modelNameSchema,
    text: z.string().min(1),
    input_tokens: z.int().nonnegative(),
    output_tokens: z.int().nonnegative(),
    cache_read_input_tokens: z.int().nonnegative(),
    latency_ms: z.int().nonnegative(),
  })
  .refine((r) => PROVIDER_OF[r.model] !== 'workers_ai' || r.cache_read_input_tokens === 0, {
    error: 'workers_ai has no prompt caching: cache_read_input_tokens must be 0',
    path: ['cache_read_input_tokens'],
  });
export type LLMResponse = z.infer<typeof llmResponseSchema>;

// ADR-0069 §5.3: the platform default collects prompt/response payloads at the gateway.
// This header rides every request as a non-configurable constant; the literal makes any
// other value unrepresentable. Gateway logs carry metadata only, never payload text.
export const gatewayConstantHeadersSchema = z.strictObject({
  'cf-aig-collect-log-payload': z.literal('false'),
});
export type GatewayConstantHeaders = z.infer<typeof gatewayConstantHeadersSchema>;

export const GATEWAY_CONSTANT_HEADERS: GatewayConstantHeaders = {
  'cf-aig-collect-log-payload': 'false',
};

// The LLMProvider seam (ADR-0004): every model — and every in-memory fake — is an adapter
// at this seam in front of CF AI Gateway. complete() never throws on a model failure; the
// coded AdapterResult drives the ADR-0069 §4 fallback ladder, and a fallback hop re-renders
// the prompt for the target model rather than replaying the previous hop's rendered string.
export interface LLMProvider {
  complete(request: LLMRequest): Promise<AdapterResult<LLMResponse>>;
  // The ADR-0039 classifier route: always the auxiliary roster role, never escalates.
  classify(content: string, taxonomy: string[]): Promise<string[]>;
}
