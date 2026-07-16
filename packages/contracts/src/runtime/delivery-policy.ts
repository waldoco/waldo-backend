import { z } from 'zod';
import { channelNameSchema } from '../adapters/channel';
import { triggerTypeSchema, type TriggerType } from '../core/trigger';
export { pushClassSchema, type PushClass } from './push-class';
import { pushClassSchema, type PushClass } from './push-class';

// ADR-0068: one typed delivery-policy table is the single representation of every proactive send:
// class x channel x budget x standalone x quiet-hours x priority x cooldown. The 2026-06-27
// current-decision block supersedes the older body text: fetch_alert is exempt-but-counted,
// defer_next_day is deleted, and proposed adjustments are capped separately from executed ones.
export const deliveryVerdictSchema = z.enum(['send', 'hold', 'degrade', 'drop']);
export type DeliveryVerdict = z.infer<typeof deliveryVerdictSchema>;

export const deliveryGateReasonSchema = z.enum([
  'candidate_expired',
  'class_cap_exhausted',
  'cooldown_active',
  'budget_cap_exhausted',
  'once_ever_already_sent',
]);
export type DeliveryGateReason = z.infer<typeof deliveryGateReasonSchema>;

export const quietHoursRuleSchema = z.enum([
  'hold',
  'drop',
  'bypass_high_confidence',
  'hold_while_pending',
]);
export type QuietHoursRule = z.infer<typeof quietHoursRuleSchema>;

export const budgetClassSchema = z.enum(['counted', 'exempt']);
export type BudgetClass = z.infer<typeof budgetClassSchema>;

export const cooldownScopeSchema = z.enum(['class', 'event']);
export type CooldownScope = z.infer<typeof cooldownScopeSchema>;

// A bounded cap can reset at the UTC-day boundary or span the lifetime of the user/class pair.
// Gate admission and durable counter reads consume this field rather than special-casing a class.
export const deliveryCapScopeSchema = z.enum(['utc_day', 'lifetime']);
export type DeliveryCapScope = z.infer<typeof deliveryCapScopeSchema>;

export const adjustmentSubKindSchema = z.enum(['proposed', 'executed']);
export type AdjustmentSubKind = z.infer<typeof adjustmentSubKindSchema>;

export const subCapSchema = z.strictObject({
  daily_cap: z.int().positive().nullable(),
  cooldown_min: z.int().positive().nullable(),
});
export type SubCap = z.infer<typeof subCapSchema>;

export const deliveryPolicyRowSchema = z
  .strictObject({
    apns: z.boolean(),
    telegram: z.boolean(),
    feed: z.boolean(),
    budget: budgetClassSchema,
    exempt_after_h: z.int().positive().nullable(),
    is_standalone: z.boolean(),
    quiet_hours: quietHoursRuleSchema,
    priority: z.int().min(1).max(7).nullable(),
    daily_cap: z.int().positive().nullable(),
    cap_scope: deliveryCapScopeSchema.default('utc_day'),
    cooldown_min: z.int().positive().nullable(),
    cooldown_scope: cooldownScopeSchema,
    agent_invocable: z.boolean(),
    sub_caps: z.strictObject({ proposed: subCapSchema, executed: subCapSchema }).nullable(),
  })
  .refine((row) => row.sub_caps === null || row.sub_caps.proposed.daily_cap !== null, {
    error: "a sub-capped class must cap its 'proposed' sub-kind",
    path: ['sub_caps', 'proposed', 'daily_cap'],
  })
  .refine((row) => row.cap_scope !== 'lifetime' || row.daily_cap !== null, {
    error: 'a lifetime-capped class must name a finite cap',
    path: ['daily_cap'],
  });
export type DeliveryPolicyRow = z.infer<typeof deliveryPolicyRowSchema>;

export const DELIVERY_POLICY: Readonly<Record<PushClass, DeliveryPolicyRow>> = {
  brief: {
    apns: false,
    telegram: true,
    feed: true,
    budget: 'counted',
    exempt_after_h: null,
    is_standalone: false,
    quiet_hours: 'drop',
    priority: null,
    daily_cap: 3,
    cap_scope: 'utc_day',
    cooldown_min: null,
    cooldown_scope: 'class',
    agent_invocable: true,
    sub_caps: null,
  },
  fetch_alert: {
    apns: true,
    telegram: true,
    feed: true,
    budget: 'exempt',
    exempt_after_h: null,
    is_standalone: false,
    quiet_hours: 'bypass_high_confidence',
    priority: 1,
    daily_cap: 3,
    cap_scope: 'utc_day',
    cooldown_min: 120,
    cooldown_scope: 'class',
    agent_invocable: true,
    sub_caps: null,
  },
  adjustment: {
    apns: true,
    telegram: true,
    feed: true,
    budget: 'counted',
    exempt_after_h: null,
    is_standalone: false,
    quiet_hours: 'hold',
    priority: 2,
    daily_cap: null,
    cap_scope: 'utc_day',
    cooldown_min: null,
    cooldown_scope: 'class',
    agent_invocable: true,
    sub_caps: {
      proposed: { daily_cap: 3, cooldown_min: 60 },
      executed: { daily_cap: null, cooldown_min: null },
    },
  },
  pre_activity_spot: {
    apns: true,
    telegram: true,
    feed: true,
    budget: 'counted',
    exempt_after_h: null,
    is_standalone: false,
    quiet_hours: 'hold',
    priority: 3,
    daily_cap: 2,
    cap_scope: 'utc_day',
    cooldown_min: 60,
    cooldown_scope: 'event',
    agent_invocable: true,
    sub_caps: null,
  },
  constellation_first: {
    apns: true,
    telegram: true,
    feed: true,
    budget: 'exempt',
    exempt_after_h: null,
    is_standalone: true,
    quiet_hours: 'hold',
    priority: null,
    daily_cap: 1,
    cap_scope: 'lifetime',
    cooldown_min: null,
    cooldown_scope: 'class',
    agent_invocable: false,
    sub_caps: null,
  },
  constellation_update: {
    apns: true,
    telegram: true,
    feed: true,
    budget: 'counted',
    exempt_after_h: null,
    is_standalone: false,
    quiet_hours: 'hold',
    priority: 5,
    daily_cap: 1,
    cap_scope: 'utc_day',
    cooldown_min: null,
    cooldown_scope: 'class',
    agent_invocable: false,
    sub_caps: null,
  },
  spot_digest: {
    apns: true,
    telegram: true,
    feed: true,
    budget: 'counted',
    exempt_after_h: null,
    is_standalone: false,
    quiet_hours: 'drop',
    priority: 6,
    daily_cap: 1,
    cap_scope: 'utc_day',
    cooldown_min: null,
    cooldown_scope: 'class',
    agent_invocable: false,
    sub_caps: null,
  },
  intervention_knock: {
    apns: true,
    telegram: true,
    feed: false,
    budget: 'exempt',
    exempt_after_h: null,
    is_standalone: true,
    quiet_hours: 'hold_while_pending',
    priority: null,
    daily_cap: 2,
    cap_scope: 'utc_day',
    cooldown_min: null,
    cooldown_scope: 'class',
    agent_invocable: false,
    sub_caps: null,
  },
  sync_error: {
    apns: true,
    telegram: false,
    feed: true,
    budget: 'counted',
    exempt_after_h: 6,
    is_standalone: true,
    quiet_hours: 'hold',
    priority: 7,
    daily_cap: null,
    cap_scope: 'utc_day',
    cooldown_min: 1_440,
    cooldown_scope: 'event',
    agent_invocable: false,
    sub_caps: null,
  },
  system_consent: {
    apns: true,
    telegram: false,
    feed: true,
    budget: 'exempt',
    exempt_after_h: null,
    is_standalone: true,
    quiet_hours: 'hold',
    priority: null,
    daily_cap: null,
    cap_scope: 'utc_day',
    cooldown_min: null,
    cooldown_scope: 'class',
    agent_invocable: false,
    sub_caps: null,
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
  pre_brief_sweep: [],
  handoff_explore: [],
  handoff_plan: [],
  handoff_act: ['adjustment'],
  handoff_replan: [],
  intervention: [],
  user_message: [],
  dreaming_mode: [],
  pre_activity_spot: ['pre_activity_spot', 'adjustment'],
};

export function agentReachableExemptHasCap(row: DeliveryPolicyRow): boolean {
  return !(row.agent_invocable && row.budget === 'exempt') || (row.daily_cap !== null && row.daily_cap > 0);
}

function requirePositive(value: number | null, field: string): number {
  if (value === null) throw new Error(`fetch_alert policy missing ${field}`);
  return value;
}

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
  daily_cap: requirePositive(DELIVERY_POLICY.fetch_alert.daily_cap, 'daily_cap'),
  cooldown_min: requirePositive(DELIVERY_POLICY.fetch_alert.cooldown_min, 'cooldown_min'),
};

export const deliveryCandidateSchema = z.strictObject({
  push_class: pushClassSchema,
  trigger: triggerTypeSchema,
  event_id: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  expires_at: z.int().nonnegative().nullable().optional(),
  sub_kind: adjustmentSubKindSchema.optional(),
}).refine(
  (candidate) =>
    candidate.push_class === 'adjustment'
      ? candidate.sub_kind !== undefined
      : candidate.sub_kind === undefined,
  {
    error: 'sub_kind is required only for adjustment candidates',
    path: ['sub_kind'],
  },
);
export type DeliveryCandidate = z.infer<typeof deliveryCandidateSchema>;

export const admissionSchema = z
  .strictObject({
    verdict: deliveryVerdictSchema,
    reason: deliveryGateReasonSchema.nullable(),
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
  })
  .refine((a) => (a.verdict === 'send') === (a.reason === null), {
    error: 'non-send admissions must carry a gate reason, sends must not',
    path: ['reason'],
  })
  .refine(
    (a) =>
      a.stamped.budget_exempt === (DELIVERY_POLICY[a.stamped.push_class].budget === 'exempt') &&
      a.stamped.is_standalone === DELIVERY_POLICY[a.stamped.push_class].is_standalone,
    { error: 'admission stamp must match its class policy row' },
  );
export type Admission = z.infer<typeof admissionSchema>;

export const heldCandidateSchema = z
  .strictObject({
    event_id: z.string().min(1),
    push_class: pushClassSchema,
    candidate: deliveryCandidateSchema,
    hold_until: z.int().nonnegative(),
    expires_at: z.int().nonnegative().nullable(),
  })
  .refine((held) => held.push_class === held.candidate.push_class, {
    error: 'held candidate class must match the frozen candidate',
    path: ['push_class'],
  });
export type HeldCandidate = z.infer<typeof heldCandidateSchema>;
