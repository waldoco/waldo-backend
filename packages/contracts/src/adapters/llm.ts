import { z } from 'zod';
import type { AdapterResult } from '../core/error';
import { modelNameSchema, PROVIDER_OF } from '../model/roster';

export const llmMessageSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
});
export type LLMMessage = z.infer<typeof llmMessageSchema>;

export const llmAttachmentSchema = z.strictObject({
  kind: z.enum(['image', 'file']),
  mime_type: z.string().min(1).max(128),
  filename: z.string().min(1).max(256),
  data_base64: z.string().min(1),
});
export type LLMAttachment = z.infer<typeof llmAttachmentSchema>;

export const llmToolSchema = z.strictObject({
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(1024),
  parameters: z.record(z.string(), z.unknown()),
});
export type LLMTool = z.infer<typeof llmToolSchema>;

export const toolParameters = (schema: z.ZodType): Record<string, unknown> => {
  const json = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  // zod v4 stamps its output with a non-configurable '~standard' marker so the result can
  // double as a schema; that marker carries function values, which are not JSON. Tool
  // definitions ride the wire to providers and pass through request sanitisation, both of
  // which require pure JSON.
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(json)) {
    if (key !== '~standard') clean[key] = value;
  }
  return clean;
};

export const llmToolCallSchema = z.strictObject({
  call_id: z.string().min(1).max(128),
  name: z.string().min(1).max(64),
  arguments: z.string().max(16_384),
});
export type LLMToolCall = z.infer<typeof llmToolCallSchema>;

export const llmToolTurnSchema = z.strictObject({
  call: llmToolCallSchema,
  output: z.string().max(32_768),
  // Raw provider output items (encrypted reasoning, function calls) from the round that
  // produced this call; replayed verbatim so the model continues its own reasoning.
  prior_items: z.array(z.record(z.string(), z.unknown())).optional(),
});
export type LLMToolTurn = z.infer<typeof llmToolTurnSchema>;

// No credential field exists here by design: provider keys live in the gateway BYOK store,
// never in the contract or Worker env (ADR-0069 §5.2).
export const llmRequestSchema = z.strictObject({
  model: modelNameSchema,
  system: z.string().min(1).optional(),
  messages: z.array(llmMessageSchema).min(1),
  // Wire ceiling only (ego-audit S5): 128,000 matches the largest published output limit of
  // a roster provider. It is not a request default - surfaces pin their own (telegram chat
  // pins 4,096) and the provider adapter reports an oversize finish as 'incomplete'
  // truthfully. Per-model derivation lands with the roster window table when the roster grows.
  max_tokens: z.int().min(1).max(128_000),
  temperature: z.number().min(0).max(2),
  // Prompt-cache affinity hint (OpenAI prompt_cache_key): stable per owner, never content,
  // never a credential. Providers without keyed caching ignore it.
  cache_key: z.string().min(1).max(128).optional(),
  // Asks the provider to constrain output to this JSON schema where it can (OpenAI strict
  // structured outputs). Callers still validate the result; other providers ignore it.
  response_format: z.strictObject({ name: z.string().min(1).max(64), schema: z.record(z.string(), z.unknown()) }).optional(),
  // Owner-sent images and files for the final user message. Kept outside messages so text
  // sanitisation never rewrites binary data; providers without file input reject the request.
  attachments: z.array(llmAttachmentSchema).min(1).max(4).optional(),
  tools: z.array(llmToolSchema).min(1).max(32).optional(),
  tool_turns: z.array(llmToolTurnSchema).max(64).optional(),
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
    text: z.string(),
    tool_calls: z.array(llmToolCallSchema).min(1).max(16).optional(),
    input_tokens: z.int().nonnegative(),
    output_tokens: z.int().nonnegative(),
    cache_read_input_tokens: z.int().nonnegative(),
    latency_ms: z.int().nonnegative(),
    output_items: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .refine((r) => r.text.length > 0 || r.tool_calls !== undefined, {
    error: 'a response carries text or tool calls',
    path: ['text'],
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
