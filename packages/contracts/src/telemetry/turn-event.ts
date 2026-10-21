import { z } from 'zod';
import { providerSchema } from '../model/roster';

// One per-hop record of a brain or worker turn, as every sink (DO trace table, console JSON, OTLP) consumes it.
// Bump when a field below changes meaning, so dashboards can filter by it.
export const TURN_EVENT_SCHEMA_VERSION = '9';

// Every v9 addition is a number, a boolean or a member of a closed vocabulary. Free text lives only in the
// fields named by TURN_EVENT_TEXT_FIELDS, which the privacy gate strips whenever text capture is off.
export const executionRungSchema = z.enum(['memory', 'connector', 'email', 'fetch', 'browser', 'sandbox', 'mac', 'human']);
export type ExecutionRung = z.infer<typeof executionRungSchema>;

export const rungBlockedReasonSchema = z.enum(['approval_required', 'policy_denied', 'budget_exhausted', 'unavailable', 'auth_required', 'timed_out', 'unsupported', 'on_hold']);
export type RungBlockedReason = z.infer<typeof rungBlockedReasonSchema>;

export const turnOutcomeSchema = z.enum(['answered', 'completed', 'failed', 'dropped', 'delivery_pending', 'blocked']);
export type TurnOutcome = z.infer<typeof turnOutcomeSchema>;

export const costKindSchema = z.enum(['turn', 'background', 'worker', 'heartbeat', 'eval']);
export type CostKind = z.infer<typeof costKindSchema>;

export const systemSectionSchema = z.enum(['reasons', 'behavior', 'health', 'clock', 'memory', 'orders', 'loops', 'skill_catalog', 'task_context', 'connections', 'skill_procedures', 'tool_results', 'owner_profile']);
export type SystemSection = z.infer<typeof systemSectionSchema>;

const count = z.number().int().min(0);
const millis = z.number().finite().min(0);
// Identifiers, never prose: a job id or worker profile is a short token.
export const turnIdentifierSchema = z.string().regex(/^[A-Za-z0-9:_.-]{1,64}$/);
// A typed error code, optionally qualified ("rate_limited", "transient:approval_denied").
export const turnErrorCodeSchema = z.string().regex(/^[a-z0-9_]+(?::[a-z0-9_]+)*$/).max(96);

// web_searches: hosted web search calls the model ran inside this call.
export const turnModelUsageSchema = z.strictObject({
  model: z.string().min(1), input: count, output: count, cached: count, web_searches: count.optional(),
});
export type TurnModelUsage = z.infer<typeof turnModelUsageSchema>;

// What fills one model call, in UTF-8 bytes: numeric metadata only, never text.
// tools_tokens_est: the tool definitions' size in tokens, estimated from bytes (the provider reports no split).
export const turnContextShapeSchema = z.strictObject({
  tools_count: count, tools_bytes: count, tools_tokens_est: count.optional(), tool_turns_bytes: count,
  history_messages: count, history_bytes: count, current_bytes: count, attachments: count,
  system_sections: z.partialRecord(systemSectionSchema, count).optional(),
});
export type TurnContextShape = z.infer<typeof turnContextShapeSchema>;

export const turnTextSchema = z.strictObject({ input: z.string(), output: z.string().optional(), reasoning: z.string().optional() });
export type TurnText = z.infer<typeof turnTextSchema>;

export const turnEventSchema = z.strictObject({
  trace: z.string().min(1),
  hop: z.string().min(1),
  owner: z.string().optional(),
  owner_id: z.string().optional(),
  owner_email: z.string().optional(),
  owner_identity: z.enum(['verified', 'email_unavailable', 'unknown']).optional(),
  // The verified owner principal, set only on an owner turn's owner_request hop. The host files that runtime's
  // traces under it and strips it before any sink.
  principal: z.string().optional(),
  ms: z.number().finite(),
  ok: z.boolean(),
  error: z.string().optional(),
  detail: z.string().optional(),
  code: z.string().optional(),
  guard: z.string().optional(),
  usage: turnModelUsageSchema.optional(),
  cost_kind: costKindSchema.optional(),
  responsibility_id: z.string().optional(),
  shape: z.strictObject({ system_bytes: count, request_bytes: count, context: turnContextShapeSchema.optional() }).optional(),
  text: turnTextSchema.optional(),
  // v9: tools and parallelism (a batch is a group of tool calls dispatched concurrently; one call is one batch).
  tools_called: count.optional(),
  parallel_batches: count.optional(),
  // v9: execution ladder. A hop on a rung that refused names why in blocked_reason.
  rung: executionRungSchema.optional(),
  blocked_reason: rungBlockedReasonSchema.optional(),
  job_id: turnIdentifierSchema.optional(),
  job_profile: turnIdentifierSchema.optional(),
  // v9: reserved for the browser and sandbox rungs; no producer sets them yet.
  browser_ms: millis.optional(),
  sandbox_ms: millis.optional(),
  // v9: the typed failure code (ToolError.code or the provider's ErrorCode), separate from the human-facing error text.
  error_code: turnErrorCodeSchema.optional(),
  // v9: which provider answered a model call, and whether the routing ladder had to fall back to reach it.
  provider: providerSchema.optional(),
  fallback_fired: z.boolean().optional(),
  ttft_ms: millis.optional(),
  // v9: how the turn ended, set on the root (turn / machine_turn) hop.
  outcome: turnOutcomeSchema.optional(),
});
export type TurnEvent = z.infer<typeof turnEventSchema>;

// The fields that may carry free text or personal data. Sinks gate exactly these when capture is off.
export const TURN_EVENT_TEXT_FIELDS = ['error', 'detail', 'guard', 'text', 'owner_email'] as const satisfies readonly (keyof TurnEvent)[];

export const turnTelemetryFreeOfText = (event: TurnEvent): TurnEvent => {
  const copy: Record<string, unknown> = { ...event };
  for (const field of TURN_EVENT_TEXT_FIELDS) delete copy[field];
  return copy as TurnEvent;
};
