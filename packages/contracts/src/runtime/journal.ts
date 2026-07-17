import { z } from 'zod';
import { triggerTypeSchema } from '../core/trigger';
import { deliveryGateReasonSchema, deliveryVerdictSchema } from './delivery-policy';

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
]);
const VERDICT_FORBIDDEN: ReadonlySet<RunState> = new Set<RunState>([
  'RUN_OPENED',
  'GOVERNOR_ADMITTED',
]);

// The reduced journal normally describes a proactive delivery effect. A trusted internal
// invocation is the one intentional no-effect terminal: it has completed durable work, but has
// no DeliveryGate verdict, candidate, outbox row, or sink acknowledgement. Keep that distinction
// in the journal itself so a generic reader never mistakes malformed proactive state for a valid
// no-output completion.
export const journalCompletionModeSchema = z.enum(['trusted_internal_no_output']);
export type JournalCompletionMode = z.infer<typeof journalCompletionModeSchema>;

export const journalRowSchema = z
  .strictObject({
    run_id: z.string().min(1),
    user_id: z.string().min(1),
    trigger: triggerTypeSchema,
    state: runStateSchema,
    verdict: deliveryVerdictSchema.nullable(),
    gate_reason: deliveryGateReasonSchema.nullable(),
    completion_mode: journalCompletionModeSchema.nullable().default(null),
    occurrence_at: z.int().nonnegative(),
    created_at: z.int().nonnegative(),
    updated_at: z.int().nonnegative(),
  })
  .refine((row) => !VERDICT_REQUIRED.has(row.state) || row.verdict !== null, {
    error: 'verdict is present from GATED through ACK_RECORDED',
    path: ['verdict'],
  })
  .refine(
    (row) =>
      row.verdict !== null ||
      row.state !== 'DONE' ||
      row.completion_mode === 'trusted_internal_no_output',
    {
      error: 'a null-verdict DONE row requires trusted_internal_no_output completion mode',
      path: ['completion_mode'],
    },
  )
  .refine(
    (row) =>
      row.completion_mode === null || (row.state === 'DONE' && row.verdict === null),
    {
      error: 'trusted internal completion mode is only valid for a null-verdict DONE row',
      path: ['completion_mode'],
    },
  )
  .refine((row) => !VERDICT_FORBIDDEN.has(row.state) || row.verdict === null, {
    error: 'verdict is absent before GATED',
    path: ['verdict'],
  })
  .refine((row) => row.verdict !== null || row.gate_reason === null, {
    error: 'gate_reason requires a verdict',
    path: ['gate_reason'],
  })
  .refine((row) => row.verdict !== 'send' || row.gate_reason === null, {
    error: 'send verdicts must not carry a gate reason',
    path: ['gate_reason'],
  })
  .refine((row) => row.verdict === null || row.verdict === 'send' || row.gate_reason !== null, {
    error: 'non-send verdicts must carry a gate reason',
    path: ['gate_reason'],
  });
export type JournalRow = z.infer<typeof journalRowSchema>;
