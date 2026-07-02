import { z } from 'zod';

// Minimal Loop Governor sliver: one deterministic admit/deny verdict, outside the LLM.
// The priority arbiter, per-loop budgets, kill flag, and no-progress guard are Phase D.
export const admissionVerdictSchema = z.enum(['admit', 'deny']);
export type GovernorVerdict = z.infer<typeof admissionVerdictSchema>;

export const loopPolicySchema = z.strictObject({
  name: z.string().min(1),
  admit: z.boolean(),
});
export type LoopPolicy = z.infer<typeof loopPolicySchema>;
