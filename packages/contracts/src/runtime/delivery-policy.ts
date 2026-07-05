import { z } from 'zod';
import { channelNameSchema } from '../adapters/channel';
import { triggerTypeSchema } from '../core/trigger';
import type { TriggerType } from '../core/trigger';

export const deliveryVerdictSchema = z.enum(['send', 'hold', 'degrade', 'drop']);
export type DeliveryVerdict = z.infer<typeof deliveryVerdictSchema>;

export const pushClassSchema = z.enum([
  'brief',
  'fetch_alert',
  'adjustment',
  'pre_activity_spot',
  'constellation_first',
  'constellation_update',
  'spot_digest',
  'intervention_knock',
  'sync_error',
  'system_consent',
]);
export type PushClass = z.infer<typeof pushClassSchema>;

export const cooldownScopeSchema = z.enum(['class', 'event']);
export type CooldownScope = z.infer<typeof cooldownScopeSchema>;

export const quietHoursRuleSchema = z.enum(['allow', 'hold', 'drop', 'fetch_confidence_bypass']);
export type QuietHoursRule = z.infer<typeof quietHoursRuleSchema>;

export const deliveryPolicyRowSchema = z
  .strictObject({
    push_class: pushClassSchema,
    agent_invocable: z.boolean(),
    budget_exempt: z.boolean(),
    counts_apns_budget: z.boolean(),
    is_standalone: z.boolean(),
    apns: z.boolean(),
    telegram: z.boolean(),
    in_app: z.boolean(),
    quiet_hours: quietHoursRuleSchema,
    collapse_id: z.string().min(1).nullable(),
    class_cap_per_day: z.int().positive().nullable(),
    cooldown_min: z.int().positive().nullable(),
    cooldown_scope: cooldownScopeSchema,
    exempt_after_h: z.int().positive().nullable(),
  })
  .refine((row) => !row.budget_exempt || !row.counts_apns_budget, {
    error: 'budget-exempt classes do not decrement the daily APNs budget',
    path: ['counts_apns_budget'],
  })
  .refine(
    (row) => row.class_cap_per_day !== null || row.cooldown_min !== null || row.push_class === 'system_consent',
    {
      error: 'delivery classes need a cap or cooldown unless legally required',
      path: ['class_cap_per_day'],
    },
  );
export type DeliveryPolicyRow = z.infer<typeof deliveryPolicyRowSchema>;

export const fetchAlertPolicySchema = z.strictObject({
  push_class: z.literal('fetch_alert'),
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

export const DELIVERY_POLICY: Readonly<Record<PushClass, DeliveryPolicyRow>> = {
  brief: {
    push_class: 'brief',
    agent_invocable: true,
    budget_exempt: false,
    counts_apns_budget: false,
    is_standalone: false,
    apns: false,
    telegram: true,
    in_app: true,
    quiet_hours: 'drop',
    collapse_id: null,
    class_cap_per_day: 3,
    cooldown_min: null,
    cooldown_scope: 'class',
    exempt_after_h: null,
  },
  fetch_alert: {
    push_class: 'fetch_alert',
    agent_invocable: true,
    budget_exempt: true,
    counts_apns_budget: false,
    is_standalone: false,
    apns: true,
    telegram: true,
    in_app: true,
    quiet_hours: 'fetch_confidence_bypass',
    collapse_id: 'stack',
    class_cap_per_day: FETCH_ALERT_POLICY.daily_cap,
    cooldown_min: FETCH_ALERT_POLICY.cooldown_min,
    cooldown_scope: 'class',
    exempt_after_h: null,
  },
  adjustment: {
    push_class: 'adjustment',
    agent_invocable: true,
    budget_exempt: false,
    counts_apns_budget: true,
    is_standalone: false,
    apns: true,
    telegram: true,
    in_app: true,
    quiet_hours: 'hold',
    collapse_id: 'stack',
    class_cap_per_day: 3,
    cooldown_min: 60,
    cooldown_scope: 'class',
    exempt_after_h: null,
  },
  pre_activity_spot: {
    push_class: 'pre_activity_spot',
    agent_invocable: true,
    budget_exempt: false,
    counts_apns_budget: true,
    is_standalone: false,
    apns: true,
    telegram: true,
    in_app: true,
    quiet_hours: 'hold',
    collapse_id: 'stack',
    class_cap_per_day: 2,
    cooldown_min: 60,
    cooldown_scope: 'event',
    exempt_after_h: null,
  },
  constellation_first: {
    push_class: 'constellation_first',
    agent_invocable: false,
    budget_exempt: true,
    counts_apns_budget: false,
    is_standalone: true,
    apns: true,
    telegram: true,
    in_app: true,
    quiet_hours: 'hold',
    collapse_id: 'evt:{constellation_id}',
    class_cap_per_day: 1,
    cooldown_min: null,
    cooldown_scope: 'event',
    exempt_after_h: null,
  },
  constellation_update: {
    push_class: 'constellation_update',
    agent_invocable: false,
    budget_exempt: false,
    counts_apns_budget: true,
    is_standalone: false,
    apns: true,
    telegram: true,
    in_app: true,
    quiet_hours: 'hold',
    collapse_id: 'stack',
    class_cap_per_day: 1,
    cooldown_min: null,
    cooldown_scope: 'class',
    exempt_after_h: null,
  },
  spot_digest: {
    push_class: 'spot_digest',
    agent_invocable: false,
    budget_exempt: false,
    counts_apns_budget: true,
    is_standalone: false,
    apns: true,
    telegram: true,
    in_app: true,
    quiet_hours: 'drop',
    collapse_id: 'stack',
    class_cap_per_day: 1,
    cooldown_min: null,
    cooldown_scope: 'class',
    exempt_after_h: null,
  },
  intervention_knock: {
    push_class: 'intervention_knock',
    agent_invocable: false,
    budget_exempt: true,
    counts_apns_budget: false,
    is_standalone: true,
    apns: true,
    telegram: true,
    in_app: false,
    quiet_hours: 'hold',
    collapse_id: 'evt:{intervention_id}',
    class_cap_per_day: 2,
    cooldown_min: null,
    cooldown_scope: 'event',
    exempt_after_h: null,
  },
  sync_error: {
    push_class: 'sync_error',
    agent_invocable: false,
    budget_exempt: false,
    counts_apns_budget: true,
    is_standalone: true,
    apns: true,
    telegram: false,
    in_app: true,
    quiet_hours: 'hold',
    collapse_id: 'evt:{connector}',
    class_cap_per_day: 1,
    cooldown_min: 1_440,
    cooldown_scope: 'event',
    exempt_after_h: 6,
  },
  system_consent: {
    push_class: 'system_consent',
    agent_invocable: false,
    budget_exempt: true,
    counts_apns_budget: false,
    is_standalone: true,
    apns: true,
    telegram: false,
    in_app: true,
    quiet_hours: 'hold',
    collapse_id: 'evt:{notice_id}',
    class_cap_per_day: null,
    cooldown_min: null,
    cooldown_scope: 'event',
    exempt_after_h: null,
  },
};

export const deliveryBudgetTierSchema = z.enum(['pro', 'pro_max']);
export type DeliveryBudgetTier = z.infer<typeof deliveryBudgetTierSchema>;

export const DAILY_PUSH_BUDGET: Readonly<Record<DeliveryBudgetTier, number>> = {
  pro: 3,
  pro_max: 5,
};

export const triggerPushClassesSchema = z.record(triggerTypeSchema, z.array(pushClassSchema));
export const TRIGGER_PUSH_CLASSES: Readonly<Record<TriggerType, readonly PushClass[]>> = {
  brief: ['brief'],
  fetch_alert: ['fetch_alert'],
  patrol: [],
  handoff_explore: [],
  handoff_plan: ['adjustment'],
  handoff_act: ['adjustment'],
  handoff_replan: ['adjustment'],
  intervention: [],
  user_message: ['adjustment'],
  dreaming_mode: [],
  pre_activity_spot: ['pre_activity_spot'],
  pre_brief_sweep: [],
};

export const deliveryCandidateSchema = z.strictObject({
  push_class: pushClassSchema,
  trigger: triggerTypeSchema,
  event_id: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  expires_at: z.int().nonnegative().nullable().optional(),
});
export type DeliveryCandidate = z.infer<typeof deliveryCandidateSchema>;

export const admissionSchema = z
  .strictObject({
    verdict: deliveryVerdictSchema,
    hold_until: z.int().nonnegative().nullable().optional(),
    channels: z.array(channelNameSchema),
    collapse_id: z.string().min(1).nullable(),
    budget_charged: z.boolean(),
    stamped: z.strictObject({
      push_class: pushClassSchema,
      is_standalone: z.boolean(),
      budget_exempt: z.boolean(),
      expires_at: z.int().nonnegative().nullable().optional(),
    }),
  })
  .refine((a) => !a.stamped.budget_exempt || !a.budget_charged, {
    error: 'budget-exempt admissions cannot charge the counted APNs budget',
    path: ['budget_charged'],
  })
  .refine((a) => a.verdict !== 'hold' || a.hold_until !== undefined, {
    error: 'held admissions must name hold_until',
    path: ['hold_until'],
  });
export type Admission = z.infer<typeof admissionSchema>;

export const heldCandidateSchema = z.strictObject({
  event_id: z.string().min(1),
  push_class: pushClassSchema,
  candidate: deliveryCandidateSchema,
  hold_until: z.int().nonnegative(),
  expires_at: z.int().nonnegative().nullable(),
});
export type HeldCandidate = z.infer<typeof heldCandidateSchema>;

// Current ADR-0068 rule: every agent-reachable exempt class is still class-capped. This
// preserves fetch_alert as both agent-invocable and budget-exempt without making it unbounded.
export function agentReachableExemptHasCap(policy: FetchAlertPolicy | DeliveryPolicyRow): boolean {
  const cap = 'daily_cap' in policy ? policy.daily_cap : policy.class_cap_per_day;
  return policy.budget_exempt && cap !== null && cap > 0;
}
