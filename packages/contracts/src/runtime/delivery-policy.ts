import { z } from 'zod';

export const deliveryVerdictSchema = z.enum(['send', 'hold', 'degrade', 'drop']);
export type DeliveryVerdict = z.infer<typeof deliveryVerdictSchema>;

export const pushClassSchema = z.literal('fetch_alert');
export type PushClass = z.infer<typeof pushClassSchema>;

export const fetchAlertPolicySchema = z.strictObject({
  push_class: pushClassSchema,
  budget_exempt: z.literal(true),
  daily_cap: z.int().positive(),
  cooldown_min: z.int().positive(),
});
export type FetchAlertPolicy = z.infer<typeof fetchAlertPolicySchema>;

export const FETCH_ALERT_POLICY: FetchAlertPolicy = {
  push_class: 'fetch_alert',
  budget_exempt: true,
  daily_cap: 3,
  cooldown_min: 120,
};

export const admissionSchema = z.strictObject({
  verdict: deliveryVerdictSchema,
  stamped: z.strictObject({
    push_class: pushClassSchema,
    is_standalone: z.literal(false),
    budget_exempt: z.literal(true),
  }),
});
export type Admission = z.infer<typeof admissionSchema>;

// Current block rule: every agent-reachable exempt class MUST carry a non-null daily cap.
// This replaces the stale "agent_invocable ∩ budget:exempt = ∅" invariant, which fetch_alert
// disproves — it is both agent-invocable and budget-exempt, yet legitimately capped.
export function agentReachableExemptHasCap(policy: FetchAlertPolicy): boolean {
  return policy.budget_exempt && policy.daily_cap !== null && policy.daily_cap > 0;
}
