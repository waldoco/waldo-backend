import { z } from 'zod';
import { triggerTypeSchema } from '../core/trigger';
import { toolNameSchema } from '../tools/permissions';

// Tracer governor verdict. ADR-0074 does not define a broader typed arbiter verdict:
// "admit/drop/coalesce/degrade/hold" remains build-image prose, not contract.
export const admissionVerdictSchema = z.enum(['admit', 'deny']);
export type GovernorVerdict = z.infer<typeof admissionVerdictSchema>;

export const loopTypeSchema = z.enum([
  'fetch',
  'intervention',
  'pre_activity_spot',
  'brief',
  'chat',
  'patrol',
  'dreaming',
  'routine',
]);
export type LoopType = z.infer<typeof loopTypeSchema>;

export const killFlagScopeSchema = z.enum(['loop', 'global']);
export type KillFlagScope = z.infer<typeof killFlagScopeSchema>;

export const socketResidencySchema = z.enum(['active-chat-only', 'none']);
export type SocketResidency = z.infer<typeof socketResidencySchema>;

export const autonomyLevelSchema = z.enum(['L0', 'L1', 'L2', 'L3']);
export type AutonomyLevel = z.infer<typeof autonomyLevelSchema>;

export const loopPolicySchema = z
  .strictObject({
    name: z.string().min(1),
    loop_type: loopTypeSchema,
    priority_tier: z.int().min(1).max(5),
    max_tokens_per_run: z.int().positive(),
    max_subagent_spawns_per_run: z.int().nonnegative(),
    max_iterations_per_run: z.int().positive(),
    kill_flag_scope: killFlagScopeSchema,
    socket_residency: socketResidencySchema,
    egress_gated: z.boolean(),
    autonomy_level: autonomyLevelSchema,
    cooldown_ms: z.int().nonnegative(),
  })
  .refine((p) => p.socket_residency !== 'active-chat-only' || p.loop_type === 'chat', {
    error: 'active-chat-only socket residency belongs only on chat loops',
    path: ['socket_residency'],
  });
export type LoopPolicy = z.infer<typeof loopPolicySchema>;

export const loopPriorityTierByType: Readonly<Record<LoopType, number>> = {
  fetch: 1,
  intervention: 2,
  pre_activity_spot: 3,
  brief: 4,
  chat: 5,
  patrol: 5,
  dreaming: 5,
  routine: 5,
};

export const loopProgressRowSchema = z
  .strictObject({
    loop_name: z.string().min(1),
    occurrence_id: z.string().min(1),
    call_count: z.int().nonnegative(),
    unique_param_hashes: z.int().nonnegative(),
    successes: z.int().nonnegative(),
    updated_at: z.int().nonnegative(),
  })
  .refine((r) => r.unique_param_hashes <= r.call_count, {
    error: 'unique_param_hashes cannot exceed call_count',
    path: ['unique_param_hashes'],
  })
  .refine((r) => r.successes <= r.call_count, {
    error: 'successes cannot exceed call_count',
    path: ['successes'],
  });
export type LoopProgressRow = z.infer<typeof loopProgressRowSchema>;

export function isNoProgress(
  row: LoopProgressRow,
  diversityThreshold: number,
  successThreshold: number,
): boolean {
  if (row.call_count === 0) return false;
  const paramDiversity = row.unique_param_hashes / row.call_count;
  const successRate = row.successes / row.call_count;
  return paramDiversity <= diversityThreshold && successRate <= successThreshold;
}

export const loopToolObservationSchema = z.strictObject({
  tool_name: toolNameSchema,
  canonical_params_hash: z.string().regex(/^[0-9a-f]{64}$/),
  result_hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type LoopToolObservation = z.infer<typeof loopToolObservationSchema>;

export const loopKillFlagSchema = z.strictObject({
  scope: killFlagScopeSchema,
  loop_name: z.string().min(1).nullable(),
  active: z.boolean(),
  updated_at: z.int().nonnegative(),
});
export type LoopKillFlag = z.infer<typeof loopKillFlagSchema>;

export const outboundHealthValuePattern =
  /\b(?:hrv|heart rate variability|hr|heart rate|rhr|spo2|sleep|slept)\s*:?\s*\d+(?:\.\d+)?\s*(?:ms|bpm|%|h|hours|hrs)?\b/i;

export function outboundTextPassesArt9Floor(text: string): boolean {
  return !outboundHealthValuePattern.test(text);
}

export const loopInvocationSchema = z.strictObject({
  trigger: triggerTypeSchema,
  loop_name: z.string().min(1),
  occurrence_id: z.string().min(1),
});
export type LoopInvocation = z.infer<typeof loopInvocationSchema>;
