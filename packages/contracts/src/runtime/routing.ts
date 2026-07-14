import { z } from 'zod';
import { triggerTypeSchema } from '../core/trigger';
import type { TriggerType } from '../core/trigger';
import { modelNameSchema, PROVIDER_OF, providerSchema, ROSTER } from '../model/roster';
import type { ModelName } from '../model/roster';

// 'anthropic_native' is provider-side prompt caching (cache_control pass-through);
// 'exact' is the gateway's exact-match cache — provider-agnostic, but legal only on
// identical-prompt aux routes. Workers AI has no provider-side prompt caching, and no
// semantic or cross-provider cache exists anywhere (ADR-0004 amendment; ADR-0069 §5).
export const gatewayCacheSchema = z.enum(['none', 'exact', 'anthropic_native']);
export type GatewayCache = z.infer<typeof gatewayCacheSchema>;

// Gateway Dynamic Route ids (ADR-0069 §5). Per-route budgets are the fleet-level
// backstop; exact per-user enforcement is run-journal metering in the DO.
export const gatewayRouteIdSchema = z.enum([
  'primary',
  'reasoning-pro',
  'reasoning-promax',
  'fallback-haiku',
  'aux',
]);
export type GatewayRouteId = z.infer<typeof gatewayRouteIdSchema>;

export const gatewayStepSchema = z
  .strictObject({
    provider: providerSchema,
    model: modelNameSchema,
    cache: gatewayCacheSchema,
    max_tokens: z.int().min(1).max(8192).optional(),
  })
  .refine((s) => PROVIDER_OF[s.model] === s.provider, {
    error: 'provider must be the roster provider of the model',
  })
  .refine((s) => s.cache !== 'anthropic_native' || s.provider === 'anthropic', {
    error: 'anthropic_native caching exists only on anthropic steps',
  });
export type GatewayStep = z.infer<typeof gatewayStepSchema>;

// The bottom of the availability ladder a route may reach (ADR-0069 §4): 'template' = L3
// deterministic per-trigger template; 'skip' = L4 skip + silent log; 'defer' = dreaming's
// L4 variant, retry next night.
export const availabilityFloorSchema = z.enum(['template', 'skip', 'defer']);
export type AvailabilityFloor = z.infer<typeof availabilityFloorSchema>;

// An auxiliary failure MUST never block a delivery: user-visible triggers floor on the
// template, so L4 is unreachable for them (ADR-0069 §4).
const USER_FACING: ReadonlySet<TriggerType> = new Set<TriggerType>(['brief', 'user_message']);

export const modelRouteSchema = z
  .strictObject({
    trigger: triggerTypeSchema,
    primary: gatewayStepSchema,
    fallback: z.array(gatewayStepSchema),
    floor: availabilityFloorSchema,
  })
  .refine((r) => [r.primary, ...r.fallback].every((s) => s.cache !== 'exact'), {
    error: 'exact-match cache is off for per-user routes',
  })
  .refine((r) => !USER_FACING.has(r.trigger) || r.floor === 'template', {
    error: 'user-facing triggers floor on the template; L4 skip is unreachable',
  });
export type ModelRoute = z.infer<typeof modelRouteSchema>;

// Escalation is decided by deterministic PRE-CALL predicates in two input classes
// (ADR-0069 §3). Snapshot-structured inputs are injection-proof by construction;
// intent/counter inputs are user-steerable, so that class is always ceiling-bound and
// never sufficient alone. Nothing else reaches a predicate — the retired confidence-based
// escalation config (self-reported reasons + min_confidence) has no home here.
export const escalationPredicateClassSchema = z.enum([
  'snapshot_structured',
  'intent_counter_derived',
]);
export type EscalationPredicateClass = z.infer<typeof escalationPredicateClassSchema>;

// Typed labels from the ADR-0039 classifier over user-authored messages only.
export const chatIntentSchema = z.enum(['constellation', 'pattern']);
export type ChatIntent = z.infer<typeof chatIntentSchema>;

// Typed numeric/flag fields only — no free-text field exists, so injected calendar/tool
// text cannot enter a predicate. gap_hours is populated metadata about missing data,
// never a null read: null never escalates (ADR-0069 Failure·null).
export const snapshotPredicateInputSchema = z.strictObject({
  crs_delta: z.number(),
  pillar_conflict_flags: z.int().nonnegative(),
  gap_hours: z.number().nonnegative(),
});
export type SnapshotPredicateInput = z.infer<typeof snapshotPredicateInputSchema>;

export const intentCounterPredicateInputSchema = z.strictObject({
  intent: chatIntentSchema.nullable(),
  failed_tool_loops: z.int().nonnegative(),
});
export type IntentCounterPredicateInput = z.infer<typeof intentCounterPredicateInputSchema>;

export const escalationRuleSchema = z.strictObject({
  trigger: triggerTypeSchema,
  class: escalationPredicateClassSchema,
  // shadow = escalation is logged-only, never routed (fetch ships shadow-mode, ADR-0069 §2)
  shadow: z.boolean(),
});
export type EscalationRule = z.infer<typeof escalationRuleSchema>;

// Default-deny: a trigger absent here never escalates (ADR-0069 §2/§3).
export const ESCALATION_RULES: readonly EscalationRule[] = [
  { trigger: 'brief', class: 'snapshot_structured', shadow: false },
  { trigger: 'fetch_alert', class: 'snapshot_structured', shadow: true },
  { trigger: 'user_message', class: 'intent_counter_derived', shadow: false },
];

export const routingPolicySchema = z.strictObject({
  routes: z.array(modelRouteSchema),
  escalation: z.array(escalationRuleSchema),
  // the L3 floor is on by default; turning it off is an explicit policy decision
  template_fallback: z.boolean().default(true),
});
export type RoutingPolicy = z.infer<typeof routingPolicySchema>;

export const tierSchema = z.enum(['free', 'pro', 'pro_max']);
export type Tier = z.infer<typeof tierSchema>;

// A tier must be bounded: a count ceiling, a metered-spend dollar ceiling (ADR-0051), or
// both. daily_count null = count-uncapped — legal only because a dollar ceiling still
// bounds the blast radius (ADR-0069 §3).
export const escalationCeilingSchema = z
  .strictObject({
    daily_count: z.int().nonnegative().nullable(),
    daily_spend_cap_cents: z.int().positive().nullable(),
  })
  .refine((c) => c.daily_count !== null || c.daily_spend_cap_cents !== null, {
    error: 'a tier must carry a count ceiling or a dollar ceiling',
  });
export type EscalationCeiling = z.infer<typeof escalationCeilingSchema>;

// θ thresholds are a versioned constant in the Worker bundle — single writer is git,
// rollback is a redeploy, and a θ change is a config-only PR carrying the shadow-eval
// diff (ADR-0069 §3). No KV/dashboard knob: a second writer would un-audit the margin.
export const routingConfigSchema = z
  .strictObject({
    version: z.int().positive(),
    // null until the shadow-eval harness seeds it; a null θ means the brief snapshot
    // predicate cannot fire (ADR-0069 §6)
    theta_b: z.number().positive().nullable(),
    chat_escalation_timeout_ms: z.int().positive(),
    // the pre-DPA clamp is config, not a hardcoded assumption: while false, non-founder
    // traffic never reaches the anthropic tiers — the ladder collapses to primary →
    // template (ADR-0069 Security notes)
    anthropic_dpa_signed: z.boolean(),
    ceilings: z.strictObject({
      free: escalationCeilingSchema,
      pro: escalationCeilingSchema,
      pro_max: escalationCeilingSchema,
    }),
  })
  .refine((c) => c.ceilings.free.daily_count === 0, {
    error: 'free tier is primary-only: its escalation count ceiling must be 0',
  });
export type RoutingConfig = z.infer<typeof routingConfigSchema>;

export const ROUTING_CONFIG: Readonly<RoutingConfig> = {
  version: 1,
  theta_b: null,
  // provisional until dogfood re-measures chat-escalation p95 (ADR-0069 §2)
  chat_escalation_timeout_ms: 20_000,
  anthropic_dpa_signed: false,
  ceilings: {
    free: { daily_count: 0, daily_spend_cap_cents: null },
    pro: { daily_count: 3, daily_spend_cap_cents: null },
    // the ~$0.70/day metered-spend ceiling ratified in ADR-0069 §3; the canonical dollar
    // value is owned with the ADR-0051 spend-cap contract
    pro_max: { daily_count: null, daily_spend_cap_cents: 70 },
  },
};

// L2 gateway chains (ADR-0069 §4). Order is load-bearing: the haiku rung is the
// cross-provider availability hedge, and the reasoning chain ends on the primary because
// degrade beats template.
export const CHEAP_FALLBACK_CHAIN: readonly ModelName[] = [ROSTER.primary, ROSTER.fallback];
export const REASONING_FALLBACK_CHAIN: readonly ModelName[] = [
  ROSTER.reasoning,
  ROSTER.fallback,
  ROSTER.primary,
];

// The spend-cap clamp (ADR-0051) is budget, not failure — it applies BEFORE L1 (ADR-0069 §4).
export const FALLBACK_LADDER = [
  'spend_cap_clamp',
  'configured_model',
  'gateway_chain',
  'template',
  'skip',
] as const;

// Clamp order at the tier spend threshold — cheapest lever first (ADR-0069 §3).
export const SPEND_CLAMP_ORDER = [
  'dynamic_escalation_off',
  'structural_sonnet_deferred',
  'primary_only_floor',
] as const;

// Distinct code paths stay distinct in the journal (ADR-0051 split): budget degrade is
// never an injection signal, and the abuse breaker is independent of both.
export const routingLogEventSchema = z.enum([
  'escalation_budget_exhausted',
  'spend_cap_degrade',
  'abuse_cooldown',
  'p6_degraded',
]);
export type RoutingLogEvent = z.infer<typeof routingLogEventSchema>;

// Journal field and gateway header carrying every L2 rung; renaming either is contract
// drift (ADR-0069 §4).
export const FALLBACK_STEP_FIELD = 'fallback_step';
export const GATEWAY_STEP_HEADER = 'cf-aig-step';

// Gateway exact-match cache TTL, set only on identical-prompt aux routes — per-user
// prompts are unique, so their routes never cache (ADR-0069 §5).
export const AUX_CACHE_TTL_HEADER = 'cf-aig-cache-ttl';
export const AUX_CACHE_TTL_SECONDS = 300;

// Production guard on THE knob: rolling 7-day aggregate reasoning share from run-journal
// metering — flag at 5%; page + fleet-wide auto-clamp of dynamic escalation at 7%
// (ADR-0069 §3).
export const REASONING_SHARE_FLAG_THRESHOLD = 0.05;
export const REASONING_SHARE_PAGE_THRESHOLD = 0.07;

// Deterministic, PRE-CALL, class-agnostic ceiling: manufactured loop failures or injected
// "deep reasoning" asks can at most spend the ceiling, never lift it (ADR-0069 §3).
export function boundDynamicEscalation(
  ceiling: EscalationCeiling,
  escalationsUsedToday: number,
): { model: ModelName; log: RoutingLogEvent | null } {
  const exhausted = ceiling.daily_count !== null && escalationsUsedToday >= ceiling.daily_count;
  return exhausted
    ? { model: ROSTER.primary, log: 'escalation_budget_exhausted' }
    : { model: ROSTER.reasoning, log: null };
}

export const P6_MAX_CONSECUTIVE_DEFERRALS = 7;

// Never-consolidating is worse than cheaply-consolidating: after 7 consecutive clamp
// deferrals the next one runs consolidation once on the primary instead (ADR-0069 §3).
export function p6ClampAction(
  consecutiveDeferrals: number,
):
  | { action: 'defer'; log: null }
  | { action: 'run_degraded'; model: ModelName; log: 'p6_degraded' } {
  return consecutiveDeferrals >= P6_MAX_CONSECUTIVE_DEFERRALS
    ? { action: 'run_degraded', model: ROSTER.primary, log: 'p6_degraded' }
    : { action: 'defer', log: null };
}

const step = (model: ModelName, cache: GatewayCache = 'none'): GatewayStep => ({
  provider: PROVIDER_OF[model],
  model,
  cache,
});

// ADR-0069 §2, keyed by trigger. Rows absent from ESCALATION_RULES never escalate. Only
// brief, fetch, and chat carry an L2 rung in §2; patrol and the P1–P5 dreaming default
// fall straight to their L4 floor, every other trigger straight to the template.
export const ROUTING_TABLE: Readonly<Record<TriggerType, ModelRoute>> = {
  brief: {
    trigger: 'brief',
    primary: step(ROSTER.primary),
    fallback: [step(ROSTER.fallback)],
    floor: 'template',
  },
  fetch_alert: {
    trigger: 'fetch_alert',
    primary: step(ROSTER.primary),
    fallback: [step(ROSTER.fallback)],
    floor: 'template',
  },
  patrol: { trigger: 'patrol', primary: step(ROSTER.primary), fallback: [], floor: 'skip' },
  pre_brief_sweep: {
    trigger: 'pre_brief_sweep',
    primary: step(ROSTER.primary),
    fallback: [],
    floor: 'template',
  },
  handoff_explore: {
    trigger: 'handoff_explore',
    primary: step(ROSTER.primary),
    fallback: [],
    floor: 'template',
  },
  handoff_plan: {
    trigger: 'handoff_plan',
    primary: step(ROSTER.primary),
    fallback: [],
    floor: 'template',
  },
  handoff_act: {
    trigger: 'handoff_act',
    primary: step(ROSTER.primary),
    fallback: [],
    floor: 'template',
  },
  handoff_replan: {
    trigger: 'handoff_replan',
    primary: step(ROSTER.primary),
    fallback: [],
    floor: 'template',
  },
  intervention: {
    trigger: 'intervention',
    primary: step(ROSTER.primary),
    fallback: [],
    floor: 'template',
  },
  user_message: {
    trigger: 'user_message',
    primary: step(ROSTER.primary),
    fallback: [step(ROSTER.fallback)],
    floor: 'template',
  },
  dreaming_mode: {
    trigger: 'dreaming_mode',
    primary: step(ROSTER.primary),
    fallback: [],
    floor: 'defer',
  },
  pre_activity_spot: {
    trigger: 'pre_activity_spot',
    primary: step(ROSTER.primary),
    fallback: [],
    floor: 'template',
  },
};

// Dreaming P6 + constellation is the structural reasoning route, not a dynamic escalation:
// the reasoning model with its stable prefix cached provider-side, degrading fallback →
// primary because degrade beats template for consolidation (ADR-0069 §2, §4).
export const DREAMING_P6_ROUTE: ModelRoute = {
  trigger: 'dreaming_mode',
  primary: step(ROSTER.reasoning, 'anthropic_native'),
  fallback: [step(ROSTER.fallback), step(ROSTER.primary)],
  floor: 'defer',
};

// P6 is a structural route, not a broad model-family heuristic. A future dreaming
// Sonnet row must not silently inherit the P6 liveness rule unless it carries this
// exact reasoning-chain shape.
export function isStructuralP6Route(route: ModelRoute): boolean {
  const [haikuFallback, primaryFallback] = route.fallback;
  return (
    route.trigger === 'dreaming_mode' &&
    route.floor === 'defer' &&
    route.primary.provider === 'anthropic' &&
    route.primary.model === ROSTER.reasoning &&
    route.primary.cache === 'anthropic_native' &&
    route.fallback.length === 2 &&
    haikuFallback?.provider === 'anthropic' &&
    haikuFallback.model === ROSTER.fallback &&
    haikuFallback.cache === 'none' &&
    primaryFallback?.provider === 'workers_ai' &&
    primaryFallback.model === ROSTER.primary &&
    primaryFallback.cache === 'none'
  );
}

// The §2 judge/classifier rows are roster roles, not trigger types — they key their own
// table. Aux runs never escalate and never compete with delivery: the production judge
// sheds to off-peak backfill, a harness-judge failure aborts the run, and the classifier
// falls back to its rule lexicon (ADR-0069 §2).
export const auxRouteKeySchema = z.enum(['judge_production', 'judge_harness', 'classifier']);
export type AuxRouteKey = z.infer<typeof auxRouteKeySchema>;

export const AUX_ROUTES: Readonly<Record<AuxRouteKey, GatewayStep>> = {
  judge_production: step(ROSTER.auxiliary),
  judge_harness: step(ROSTER.harness_judge),
  classifier: step(ROSTER.auxiliary),
};
