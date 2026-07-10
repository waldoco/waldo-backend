import { z } from 'zod';
import { briefVariantSchema, triggerTypeSchema } from '../core/trigger';
import { formZoneSchema } from '../health/crs';
import {
  sanitiseFailureReasonSchema,
  sourceTaintSchema,
} from '../memory/sanitise';
import { modelNameSchema } from '../model/roster';
import { getCrsArgsSchema } from '../tools/schemas/reads';
import { toolNameSchema } from '../tools/permissions';
import { deliveryGateReasonSchema } from './delivery-policy';
import { FALLBACK_LADDER } from './routing';

export const runtimeRunStateSchema = z.enum([
  'PENDING',
  'CONTEXT_BUILT',
  'LLM_CALLED',
  'TOOLS_DONE',
  'GATED',
  'DELIVERED',
  'DONE',
  'FAILED',
]);
export type RuntimeRunState = z.infer<typeof runtimeRunStateSchema>;

export const RUNTIME_RUN_STATE_SEQUENCE: readonly RuntimeRunState[] =
  runtimeRunStateSchema.options;

export const runtimeRunStateTransitions: Readonly<
  Record<RuntimeRunState, readonly RuntimeRunState[]>
> = {
  PENDING: ['CONTEXT_BUILT', 'FAILED'],
  CONTEXT_BUILT: ['LLM_CALLED', 'FAILED'],
  LLM_CALLED: ['TOOLS_DONE', 'GATED', 'FAILED'],
  TOOLS_DONE: ['LLM_CALLED', 'GATED', 'FAILED'],
  GATED: ['DELIVERED', 'DONE', 'FAILED'],
  DELIVERED: ['DONE'],
  DONE: [],
  FAILED: [],
};

export function runtimeRunCanAdvance(from: RuntimeRunState, to: RuntimeRunState): boolean {
  return runtimeRunStateTransitions[from].includes(to);
}

export const runtimeOperationalRefSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/);

export const runtimeRunContextSchema = z
  .strictObject({
    source: z.literal('fake-derived'),
    trigger: triggerTypeSchema,
    body_state: formZoneSchema,
    session_started_at: z.int().nonnegative(),
    tool_permissions: z.array(toolNameSchema).max(toolNameSchema.options.length),
    source_taint: sourceTaintSchema,
  })
  .refine(
    (context) => new Set(context.tool_permissions).size === context.tool_permissions.length,
    { error: 'tool_permissions must not contain duplicates', path: ['tool_permissions'] },
  );
export type RuntimeRunContext = z.infer<typeof runtimeRunContextSchema>;

export const runtimeToolDispatchFailureReasonSchema = z.enum([
  'unknown_tool',
  'handler_unavailable',
  'handler_acl_drift',
  'acl_denied',
  'invalid_args',
  'approval_denied',
  'egress_denied',
  'sanitise_denied',
  'hook_halt',
  'handler_failed',
  'invalid_handler_result',
  'tool_result_error',
  'invalid_tool_result',
  'result_oversize',
]);
export type RuntimeToolDispatchFailureReason = z.infer<
  typeof runtimeToolDispatchFailureReasonSchema
>;

export const runtimeGovernorDenyReasonSchema = z.enum([
  'policy_missing',
  'kill_flag_active',
  'no_progress',
  'duplicate_observation',
  'token_budget_exhausted',
  'iteration_budget_exhausted',
  'subagent_budget_exhausted',
  'art9_egress_blocked',
]);
export type RuntimeGovernorDenyReason = z.infer<typeof runtimeGovernorDenyReasonSchema>;

export const runtimeProviderFailureReasonSchema = z.enum([
  'spend_state_unavailable',
  'hook_halt',
  'gateway_exhausted',
  'invalid_response',
  'template_unavailable',
]);
export type RuntimeProviderFailureReason = z.infer<typeof runtimeProviderFailureReasonSchema>;

export const runtimeRunFailureReasonSchema = z.union([
  z.templateLiteral(['governor:', runtimeGovernorDenyReasonSchema]),
  z.templateLiteral(['llm:', runtimeProviderFailureReasonSchema]),
  z.templateLiteral(['llm_observe:', runtimeProviderFailureReasonSchema]),
  z.literal('tool_parse:invalid_args'),
  z.templateLiteral(['tool_dispatch:', runtimeToolDispatchFailureReasonSchema]),
  z.templateLiteral(['delivery_gate:', deliveryGateReasonSchema]),
  z.templateLiteral(['scribe:', sanitiseFailureReasonSchema]),
]);
export type RuntimeRunFailureReason = z.infer<typeof runtimeRunFailureReasonSchema>;

export const runtimeRunFallbackStepSchema = z.enum([...FALLBACK_LADDER, 'defer']);
export type RuntimeRunFallbackStep = z.infer<typeof runtimeRunFallbackStepSchema>;

export const runtimeRunToolCallSchema = z.strictObject({
  id: runtimeOperationalRefSchema.max(128),
  name: z.literal('get_crs'),
  args: getCrsArgsSchema,
});
export type RuntimeRunToolCall = z.infer<typeof runtimeRunToolCallSchema>;

export const runtimeRunToolResultSummarySchema = z.discriminatedUnion('ok', [
  z.strictObject({
    tool: z.literal('get_crs'),
    ok: z.literal(true),
  }),
  z.strictObject({
    tool: z.literal('get_crs'),
    ok: z.literal(false),
    reason: runtimeToolDispatchFailureReasonSchema,
  }),
]);
export type RuntimeRunToolResultSummary = z.infer<typeof runtimeRunToolResultSummarySchema>;

export const runtimeRunScratchSchema = z
  .strictObject({
    tool_calls: z.array(runtimeRunToolCallSchema).max(16).optional(),
    tool_results: z.array(runtimeRunToolResultSummarySchema).max(16).optional(),
    delivery_text: z.string().min(1).max(4_096).optional(),
    delivery_text_source: z.enum(['fallback', 'llm']).optional(),
    llm: z
      .strictObject({
        model: modelNameSchema,
        fallback_step: runtimeRunFallbackStepSchema,
        degraded: z.boolean(),
        tool_call_count: z.int().nonnegative().max(16),
      })
      .optional(),
    source_taint: sourceTaintSchema,
  })
  .refine(
    (scratch) =>
      (scratch.delivery_text === undefined) ===
      (scratch.delivery_text_source === undefined),
    {
      error: 'delivery_text and delivery_text_source must be recorded together',
      path: ['delivery_text_source'],
    },
  );
export type RuntimeRunScratch = z.infer<typeof runtimeRunScratchSchema>;

export const runtimeRunRecordSchema = z
  .strictObject({
    run_id: z.string().min(1),
    user_id: z.string().min(1),
    trigger: triggerTypeSchema,
    variant: briefVariantSchema.nullable(),
    state: runtimeRunStateSchema,
    step: z.int().nonnegative(),
    attempts: z.int().nonnegative(),
    run_nonce: z.string().min(1),
    context_json: runtimeRunContextSchema.nullable(),
    scratch_json: runtimeRunScratchSchema.nullable(),
    created_at: z.int().nonnegative(),
    updated_at: z.int().nonnegative(),
    next_expected_wake: z.int().nonnegative().nullable(),
    failure_reason: runtimeRunFailureReasonSchema.nullable(),
  })
  .refine((run) => run.updated_at >= run.created_at, {
    error: 'updated_at must be greater than or equal to created_at',
    path: ['updated_at'],
  })
  .refine((run) => (run.state === 'FAILED') === (run.failure_reason !== null), {
    error: 'failure_reason is required only for FAILED runs',
    path: ['failure_reason'],
  });
export type RuntimeRunRecord = z.infer<typeof runtimeRunRecordSchema>;

const runtimeRunIdentityBaseShape = {
  user_id: z.string().min(1),
  trigger: triggerTypeSchema,
  variant: briefVariantSchema.nullable(),
} as const;

export const runtimeRunIdempotencyInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('message_nonce'),
    ...runtimeRunIdentityBaseShape,
    run_nonce: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('scheduled_occurrence'),
    ...runtimeRunIdentityBaseShape,
    schedule_id: z.string().min(1),
    occurrence_at: z.int().nonnegative(),
  }),
]);
export type RuntimeRunIdempotencyInput = z.infer<typeof runtimeRunIdempotencyInputSchema>;

export function canonicalRuntimeRunIdempotencySerialization(
  input: RuntimeRunIdempotencyInput,
): string {
  const parsed = runtimeRunIdempotencyInputSchema.parse(input);

  if (parsed.kind === 'message_nonce') {
    return JSON.stringify([
      ['kind', parsed.kind],
      ['user_id', parsed.user_id],
      ['trigger', parsed.trigger],
      ['variant', parsed.variant],
      ['run_nonce', parsed.run_nonce],
    ]);
  }

  return JSON.stringify([
    ['kind', parsed.kind],
    ['user_id', parsed.user_id],
    ['trigger', parsed.trigger],
    ['variant', parsed.variant],
    ['schedule_id', parsed.schedule_id],
    ['occurrence_at', parsed.occurrence_at],
  ]);
}
