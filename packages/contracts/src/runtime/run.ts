import { z } from 'zod';
import { triggerTypeSchema } from '../core/trigger';
import { deliveryVerdictSchema } from './delivery-policy';

// ADR-0054 durable run journal states. Each state is a committed resume point; a worker
// wake continues from the last stored value instead of replaying already-committed effects.
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

export const runtimeRunStateTransitions: Readonly<
  Record<RuntimeRunState, readonly RuntimeRunState[]>
> = {
  PENDING: ['CONTEXT_BUILT', 'FAILED'],
  CONTEXT_BUILT: ['LLM_CALLED', 'FAILED'],
  LLM_CALLED: ['TOOLS_DONE', 'FAILED'],
  TOOLS_DONE: ['GATED', 'FAILED'],
  GATED: ['DELIVERED', 'FAILED'],
  DELIVERED: ['DONE', 'FAILED'],
  DONE: [],
  FAILED: [],
};

const VERDICT_BEARING_STATES: ReadonlySet<RuntimeRunState> = new Set<RuntimeRunState>([
  'GATED',
  'DELIVERED',
  'DONE',
]);

// The full runtime run row, distinct from runtime/journal.ts's Phase-C tracer row. The
// checkpoint id is an opaque pointer to persisted context/working-memory material; this
// contract owns the run spine, not the checkpoint storage format.
export const runtimeRunRowSchema = z
  .strictObject({
    run_id: z.string().min(1),
    user_id: z.string().min(1),
    trigger: triggerTypeSchema,
    state: runtimeRunStateSchema,
    delivery_verdict: deliveryVerdictSchema.nullable(),
    checkpoint_id: z.string().min(1).nullable(),
    occurrence_at: z.int().nonnegative(),
    created_at: z.int().nonnegative(),
    updated_at: z.int().nonnegative(),
  })
  .refine((row) => row.delivery_verdict === null || VERDICT_BEARING_STATES.has(row.state), {
    error: 'delivery_verdict may only be set once the run has reached GATED or later',
    path: ['delivery_verdict'],
  });
export type RuntimeRunRow = z.infer<typeof runtimeRunRowSchema>;
