import { z } from 'zod';
import { briefVariantSchema, triggerTypeSchema } from '../core/trigger';

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
  TOOLS_DONE: ['GATED', 'FAILED'],
  GATED: ['DELIVERED', 'DONE', 'FAILED'],
  DELIVERED: ['DONE'],
  DONE: [],
  FAILED: [],
};

export function runtimeRunCanAdvance(from: RuntimeRunState, to: RuntimeRunState): boolean {
  return runtimeRunStateTransitions[from].includes(to);
}

const runtimeJsonObjectSchema = z.record(z.string(), z.unknown());

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
    context_json: runtimeJsonObjectSchema.nullable(),
    scratch_json: runtimeJsonObjectSchema.nullable(),
    created_at: z.int().nonnegative(),
    updated_at: z.int().nonnegative(),
    next_expected_wake: z.int().nonnegative().nullable(),
    failure_reason: z.string().min(1).nullable(),
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
