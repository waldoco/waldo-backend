import { z } from 'zod';
import { deliveryVerdictSchema } from './delivery-policy';

// Reduced tracer FSM. Full ADR-0054 FSM is
// PENDING -> CONTEXT_BUILT -> LLM_CALLED -> TOOLS_DONE -> GATED -> DELIVERED -> DONE.
// The tracer does no LLM/tool work, so CONTEXT_BUILT/LLM_CALLED/TOOLS_DONE collapse into
// GOVERNOR_ADMITTED, and DELIVERED expands into SINK_SENT + ACK_RECORDED. SINK_SENT means
// "a send attempt is durably marked" (committed BEFORE the sink is reached), not "delivery
// confirmed" — the run is in-doubt until ACK_RECORDED commits the sink ack.
export const runStateSchema = z.enum([
  'RUN_OPENED',
  'GOVERNOR_ADMITTED',
  'GATED',
  'SINK_SENT',
  'ACK_RECORDED',
  'DONE',
  'FAILED',
]);
export type RunState = z.infer<typeof runStateSchema>;

export const runStateTransitions: Readonly<Record<RunState, readonly RunState[]>> = {
  RUN_OPENED: ['GOVERNOR_ADMITTED', 'FAILED'],
  GOVERNOR_ADMITTED: ['GATED', 'FAILED'],
  GATED: ['SINK_SENT', 'FAILED'],
  SINK_SENT: ['ACK_RECORDED', 'FAILED'],
  ACK_RECORDED: ['DONE', 'FAILED'],
  DONE: [],
  FAILED: [],
};

// A verdict is durable from the GATED transaction onward. FAILED can happen before or after
// that point, so it may carry no verdict or the verdict that was already committed.
const VERDICT_REQUIRED: ReadonlySet<RunState> = new Set<RunState>([
  'GATED',
  'SINK_SENT',
  'ACK_RECORDED',
  'DONE',
]);
const VERDICT_FORBIDDEN: ReadonlySet<RunState> = new Set<RunState>([
  'RUN_OPENED',
  'GOVERNOR_ADMITTED',
]);

export const journalRowSchema = z
  .strictObject({
    run_id: z.string().min(1),
    user_id: z.string().min(1),
    trigger: z.literal('fetch_alert'),
    state: runStateSchema,
    verdict: deliveryVerdictSchema.nullable(),
    occurrence_at: z.int().nonnegative(),
    created_at: z.int().nonnegative(),
    updated_at: z.int().nonnegative(),
  })
  .refine((row) => !VERDICT_REQUIRED.has(row.state) || row.verdict !== null, {
    error: 'verdict is present from GATED through DONE',
    path: ['verdict'],
  })
  .refine((row) => !VERDICT_FORBIDDEN.has(row.state) || row.verdict === null, {
    error: 'verdict is absent before GATED',
    path: ['verdict'],
  });
export type JournalRow = z.infer<typeof journalRowSchema>;
