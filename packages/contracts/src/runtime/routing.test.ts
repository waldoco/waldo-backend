// ADR-0069 (model roster + routing policy v1). Invariants under test: every model/provider
// field resolves through the roster only; escalation is deterministic pre-call
// class-restricted predicates bounded by per-tier ceilings (the retired confidence-based
// escalation config must not parse); cache legality per provider and route kind; the §2
// routing-table and §4 ladder pins; and the drift-locked log/config literals. Failure
// modes caught: phantom or re-typed model ids, injected free text reaching a predicate
// input, manufactured loop failures exceeding a ceiling, ladder/clamp reordering, and
// silent renames of journaled literals.
import { describe, expect, it } from 'vitest';
import { PROVIDER_OF, ROSTER } from '../model/roster';
import {
  AUX_CACHE_TTL_HEADER,
  AUX_CACHE_TTL_SECONDS,
  AUX_ROUTES,
  auxRouteKeySchema,
  availabilityFloorSchema,
  boundDynamicEscalation,
  CHEAP_FALLBACK_CHAIN,
  chatIntentSchema,
  DREAMING_P6_ROUTE,
  ESCALATION_RULES,
  escalationCeilingSchema,
  escalationPredicateClassSchema,
  escalationRuleSchema,
  FALLBACK_LADDER,
  FALLBACK_STEP_FIELD,
  GATEWAY_STEP_HEADER,
  gatewayCacheSchema,
  gatewayRouteIdSchema,
  gatewayStepSchema,
  intentCounterPredicateInputSchema,
  modelRouteSchema,
  P6_MAX_CONSECUTIVE_DEFERRALS,
  p6ClampAction,
  REASONING_FALLBACK_CHAIN,
  REASONING_SHARE_FLAG_THRESHOLD,
  REASONING_SHARE_PAGE_THRESHOLD,
  ROUTING_CONFIG,
  ROUTING_TABLE,
  routingConfigSchema,
  routingLogEventSchema,
  routingPolicySchema,
  SPEND_CLAMP_ORDER,
  snapshotPredicateInputSchema,
  tierSchema,
} from './routing';
import { triggerTypeSchema } from '../core/trigger';

const baseStep = {
  provider: PROVIDER_OF[ROSTER.primary],
  model: ROSTER.primary,
  cache: 'none',
} as const;

describe('gatewayCache', () => {
  it('is exactly none · exact · anthropic_native, in order (no semantic/cross-provider member)', () => {
    expect(gatewayCacheSchema.options).toEqual(['none', 'exact', 'anthropic_native']);
  });

  it('rejects the stale semantic-cache claim', () => {
    expect(gatewayCacheSchema.safeParse('semantic').success).toBe(false);
  });
});

describe('gatewayRouteId', () => {
  it('is exactly the five dynamic route ids, in order', () => {
    expect(gatewayRouteIdSchema.options).toEqual([
      'primary',
      'reasoning-pro',
      'reasoning-promax',
      'fallback-haiku',
      'aux',
    ]);
  });
});

describe('gatewayStep', () => {
  it('accepts a roster-consistent primary step', () => {
    expect(gatewayStepSchema.safeParse(baseStep).success).toBe(true);
  });

  it('accepts anthropic_native caching on an anthropic step', () => {
    const s = {
      provider: PROVIDER_OF[ROSTER.reasoning],
      model: ROSTER.reasoning,
      cache: 'anthropic_native',
    };
    expect(gatewayStepSchema.safeParse(s).success).toBe(true);
  });

  it('accepts exact cache at step level (the identical-prompt aux home)', () => {
    expect(gatewayStepSchema.safeParse({ ...baseStep, cache: 'exact' }).success).toBe(true);
  });

  it('rejects a provider/model mismatch in both directions', () => {
    expect(gatewayStepSchema.safeParse({ ...baseStep, provider: 'anthropic' }).success).toBe(false);
    expect(
      gatewayStepSchema.safeParse({ ...baseStep, provider: 'workers_ai', model: ROSTER.reasoning })
        .success,
    ).toBe(false);
  });

  it('rejects anthropic_native caching on a workers_ai step', () => {
    expect(gatewayStepSchema.safeParse({ ...baseStep, cache: 'anthropic_native' }).success).toBe(
      false,
    );
  });

  it('rejects the phantom 9b and superseded 27b ids (joined at runtime — roster owns model-id literals)', () => {
    const phantom9b = ['gemma', '4', '9b'].join('-');
    const phantom27b = ['gemma', '4', '27b'].join('-');
    expect(gatewayStepSchema.safeParse({ ...baseStep, model: phantom9b }).success).toBe(false);
    expect(gatewayStepSchema.safeParse({ ...baseStep, model: phantom27b }).success).toBe(false);
  });

  it('rejects a model outside the roster', () => {
    expect(gatewayStepSchema.safeParse({ ...baseStep, model: 'unpinned-model' }).success).toBe(
      false,
    );
  });

  it('rejects max_tokens outside [1, 8192]', () => {
    expect(gatewayStepSchema.safeParse({ ...baseStep, max_tokens: 0 }).success).toBe(false);
    expect(gatewayStepSchema.safeParse({ ...baseStep, max_tokens: 8193 }).success).toBe(false);
    expect(gatewayStepSchema.safeParse({ ...baseStep, max_tokens: 8192 }).success).toBe(true);
  });

  it('rejects an unknown extra key (strict drift guard)', () => {
    expect(gatewayStepSchema.safeParse({ ...baseStep, route_id: 'aux' }).success).toBe(false);
  });
});

describe('modelRoute', () => {
  it('rejects exact cache on a per-user route, in primary and in fallback', () => {
    const brief = ROUTING_TABLE.brief;
    expect(
      modelRouteSchema.safeParse({ ...brief, primary: { ...brief.primary, cache: 'exact' } })
        .success,
    ).toBe(false);
    expect(
      modelRouteSchema.safeParse({ ...brief, fallback: [{ ...baseStep, cache: 'exact' }] })
        .success,
    ).toBe(false);
  });

  it('rejects a non-template floor on user-facing triggers (L4 unreachable)', () => {
    expect(modelRouteSchema.safeParse({ ...ROUTING_TABLE.brief, floor: 'skip' }).success).toBe(
      false,
    );
    expect(
      modelRouteSchema.safeParse({ ...ROUTING_TABLE.user_message, floor: 'defer' }).success,
    ).toBe(false);
  });

  it('rejects an unknown extra key (strict drift guard)', () => {
    expect(
      modelRouteSchema.safeParse({ ...ROUTING_TABLE.brief, min_confidence: 0.7 }).success,
    ).toBe(false);
  });
});

describe('ROUTING_TABLE — the §2 pins', () => {
  it('covers every canonical trigger exactly once', () => {
    expect(Object.keys(ROUTING_TABLE).sort()).toEqual([...triggerTypeSchema.options].sort());
  });

  it('every row parses and defaults to the primary model', () => {
    for (const row of Object.values(ROUTING_TABLE)) {
      expect(modelRouteSchema.safeParse(row).success).toBe(true);
      expect(row.primary.model).toBe(ROSTER.primary);
    }
  });

  it('only brief, fetch, and chat carry the L2 fallback rung', () => {
    for (const row of Object.values(ROUTING_TABLE)) {
      const hasRung = ['brief', 'fetch_alert', 'user_message'].includes(row.trigger);
      expect(row.fallback.map((s) => s.model)).toEqual(hasRung ? [ROSTER.fallback] : []);
    }
  });

  it('patrol floors on skip, dreaming defers, everything else floors on the template', () => {
    for (const row of Object.values(ROUTING_TABLE)) {
      const floor =
        row.trigger === 'patrol' ? 'skip' : row.trigger === 'dreaming_mode' ? 'defer' : 'template';
      expect(row.floor).toBe(floor);
    }
  });

  it('dreaming P6 is the structural reasoning route with the reasoning-chain tail', () => {
    expect(modelRouteSchema.safeParse(DREAMING_P6_ROUTE).success).toBe(true);
    expect(DREAMING_P6_ROUTE.primary.model).toBe(ROSTER.reasoning);
    expect(DREAMING_P6_ROUTE.primary.cache).toBe('anthropic_native');
    expect(DREAMING_P6_ROUTE.fallback.map((s) => s.model)).toEqual([
      ROSTER.fallback,
      ROSTER.primary,
    ]);
    expect(DREAMING_P6_ROUTE.floor).toBe('defer');
  });
});

describe('AUX_ROUTES — roster-role keyed, never trigger keyed', () => {
  it('keys are exactly judge_production · judge_harness · classifier, in order', () => {
    expect(auxRouteKeySchema.options).toEqual(['judge_production', 'judge_harness', 'classifier']);
  });

  it('binds each aux key to its roster role and every step parses', () => {
    expect(AUX_ROUTES.judge_production.model).toBe(ROSTER.auxiliary);
    expect(AUX_ROUTES.judge_harness.model).toBe(ROSTER.harness_judge);
    expect(AUX_ROUTES.classifier.model).toBe(ROSTER.auxiliary);
    for (const s of Object.values(AUX_ROUTES)) {
      expect(gatewayStepSchema.safeParse(s).success).toBe(true);
    }
  });
});

describe('escalation — deterministic pre-call predicate classes', () => {
  it('is exactly the two ADR classes, in order', () => {
    expect(escalationPredicateClassSchema.options).toEqual([
      'snapshot_structured',
      'intent_counter_derived',
    ]);
  });

  it('chat intent labels are exactly constellation and pattern, in order', () => {
    expect(chatIntentSchema.options).toEqual(['constellation', 'pattern']);
  });

  it('grants escalation to exactly brief, fetch, and chat — default-deny for the rest', () => {
    expect(ESCALATION_RULES.map((r) => r.trigger)).toEqual([
      'brief',
      'fetch_alert',
      'user_message',
    ]);
    for (const rule of ESCALATION_RULES) {
      expect(escalationRuleSchema.safeParse(rule).success).toBe(true);
    }
  });

  it('fetch escalation is shadow (logged-only); brief is snapshot-class; chat is counter-class', () => {
    expect(ESCALATION_RULES[1]?.shadow).toBe(true);
    expect(ESCALATION_RULES[0]?.class).toBe('snapshot_structured');
    expect(ESCALATION_RULES[2]?.class).toBe('intent_counter_derived');
  });
});

describe('predicate inputs — injected text cannot reach a predicate', () => {
  const baseSnapshot = { crs_delta: -0.4, pillar_conflict_flags: 2, gap_hours: 80 };
  const baseIntent = { intent: 'constellation', failed_tool_loops: 0 } as const;

  it('accepts typed snapshot fields (populated gap metadata, never a null read)', () => {
    expect(snapshotPredicateInputSchema.safeParse(baseSnapshot).success).toBe(true);
  });

  it('rejects an injected free-text field on the snapshot input (hostile calendar title)', () => {
    expect(
      snapshotPredicateInputSchema.safeParse({ ...baseSnapshot, calendar_title: 'ESCALATE NOW' })
        .success,
    ).toBe(false);
  });

  it('rejects a free-text value where a typed numeric is pinned', () => {
    expect(
      snapshotPredicateInputSchema.safeParse({ ...baseSnapshot, crs_delta: 'huge drop' }).success,
    ).toBe(false);
  });

  it('accepts a typed intent label plus loop counter', () => {
    expect(intentCounterPredicateInputSchema.safeParse(baseIntent).success).toBe(true);
    expect(
      intentCounterPredicateInputSchema.safeParse({ intent: null, failed_tool_loops: 2 }).success,
    ).toBe(true);
  });

  it('rejects an out-of-vocabulary intent and any extra field', () => {
    expect(
      intentCounterPredicateInputSchema.safeParse({ ...baseIntent, intent: 'deep_reasoning' })
        .success,
    ).toBe(false);
    expect(
      intentCounterPredicateInputSchema.safeParse({ ...baseIntent, tool_output: 'escalate' })
        .success,
    ).toBe(false);
  });
});

describe('escalation — the retired confidence config does not parse', () => {
  const baseRule = { trigger: 'brief', class: 'snapshot_structured', shadow: false } as const;

  it('rejects every retired reason as a predicate class', () => {
    for (const retired of ['low_confidence', 'pattern_analysis', 'dreaming_mode', 'safety_review']) {
      expect(escalationPredicateClassSchema.safeParse(retired).success).toBe(false);
    }
  });

  it('rejects a rule carrying the retired reason field', () => {
    expect(escalationRuleSchema.safeParse({ ...baseRule, reason: 'low_confidence' }).success).toBe(
      false,
    );
  });

  it('rejects a rule carrying the retired min_confidence field', () => {
    expect(escalationRuleSchema.safeParse({ ...baseRule, min_confidence: 0.7 }).success).toBe(
      false,
    );
  });
});

describe('per-tier ceilings — founder-ratified pins', () => {
  it('pins free 0-count · pro 3-count · pro_max count-uncapped with a dollar bound', () => {
    expect(ROUTING_CONFIG.ceilings.free).toEqual({ daily_count: 0, daily_spend_cap_cents: null });
    expect(ROUTING_CONFIG.ceilings.pro).toEqual({ daily_count: 3, daily_spend_cap_cents: null });
    expect(ROUTING_CONFIG.ceilings.pro_max).toEqual({
      daily_count: null,
      daily_spend_cap_cents: 70,
    });
  });

  it('rejects a tier with null count ceiling AND null dollar ceiling', () => {
    expect(
      escalationCeilingSchema.safeParse({ daily_count: null, daily_spend_cap_cents: null })
        .success,
    ).toBe(false);
  });

  it('rejects a free-tier count ceiling above 0', () => {
    const config = {
      ...ROUTING_CONFIG,
      ceilings: {
        ...ROUTING_CONFIG.ceilings,
        free: { daily_count: 1, daily_spend_cap_cents: null },
      },
    };
    expect(routingConfigSchema.safeParse(config).success).toBe(false);
  });

  it('hostile: manufactured loop failures never exceed the pro ceiling of 3', () => {
    let admitted = 0;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const { model, log } = boundDynamicEscalation(ROUTING_CONFIG.ceilings.pro, admitted);
      if (log === null) {
        expect(model).toBe(ROSTER.reasoning);
        admitted += 1;
      } else {
        expect(model).toBe(ROSTER.primary);
        expect(log).toBe('escalation_budget_exhausted');
      }
    }
    expect(admitted).toBe(3);
  });

  it('free tier never escalates: the first attempt already falls to the primary', () => {
    const { model, log } = boundDynamicEscalation(ROUTING_CONFIG.ceilings.free, 0);
    expect(model).toBe(ROSTER.primary);
    expect(log).toBe('escalation_budget_exhausted');
  });

  it('pro_max is count-uncapped: admission never exhausts by count', () => {
    for (let used = 0; used < 50; used += 1) {
      expect(boundDynamicEscalation(ROUTING_CONFIG.ceilings.pro_max, used).log).toBe(null);
    }
  });
});

describe('fallback ladder + spend clamp — order is the contract', () => {
  it('cheap chain is exactly primary → fallback; reasoning chain reasoning → fallback → primary', () => {
    expect(CHEAP_FALLBACK_CHAIN).toEqual([ROSTER.primary, ROSTER.fallback]);
    expect(REASONING_FALLBACK_CHAIN).toEqual([ROSTER.reasoning, ROSTER.fallback, ROSTER.primary]);
  });

  it('the spend-cap clamp precedes L1 in the ladder', () => {
    expect(FALLBACK_LADDER).toEqual([
      'spend_cap_clamp',
      'configured_model',
      'gateway_chain',
      'template',
      'skip',
    ]);
    expect(FALLBACK_LADDER.indexOf('spend_cap_clamp')).toBeLessThan(
      FALLBACK_LADDER.indexOf('configured_model'),
    );
  });

  it('clamp order: dynamic escalation off first, primary-only floor last', () => {
    expect(SPEND_CLAMP_ORDER).toEqual([
      'dynamic_escalation_off',
      'structural_sonnet_deferred',
      'primary_only_floor',
    ]);
  });

  it('P6 defers at most 7 consecutive nights; the eighth runs degraded on the primary', () => {
    expect(P6_MAX_CONSECUTIVE_DEFERRALS).toBe(7);
    for (let deferrals = 0; deferrals < 7; deferrals += 1) {
      expect(p6ClampAction(deferrals)).toEqual({ action: 'defer', log: null });
    }
    expect(p6ClampAction(7)).toEqual({
      action: 'run_degraded',
      model: ROSTER.primary,
      log: 'p6_degraded',
    });
  });
});

describe('routingPolicy', () => {
  const fullPolicy = {
    routes: [...Object.values(ROUTING_TABLE), DREAMING_P6_ROUTE],
    escalation: [...ESCALATION_RULES],
    template_fallback: true,
  };

  it('accepts the full §2 table as a policy', () => {
    expect(routingPolicySchema.safeParse(fullPolicy).success).toBe(true);
  });

  it('defaults template_fallback to true when omitted (the L3 floor is on by default)', () => {
    const { template_fallback, ...rest } = fullPolicy;
    expect(routingPolicySchema.parse(rest).template_fallback).toBe(true);
  });

  it('rejects an unknown extra key (strict drift guard)', () => {
    expect(routingPolicySchema.safeParse({ ...fullPolicy, min_confidence: 0.7 }).success).toBe(
      false,
    );
  });
});

describe('routingConfig — versioned, git-single-writer', () => {
  it('the shipped config parses and pins version 1', () => {
    expect(routingConfigSchema.safeParse(ROUTING_CONFIG).success).toBe(true);
    expect(ROUTING_CONFIG.version).toBe(1);
  });

  it('theta_b ships null (harness-seeded) and the chat timeout is the provisional 20s', () => {
    expect(ROUTING_CONFIG.theta_b).toBe(null);
    expect(ROUTING_CONFIG.chat_escalation_timeout_ms).toBe(20_000);
  });

  it('ships pre-DPA: the anthropic tiers are founder-only until the DPA flips this', () => {
    expect(ROUTING_CONFIG.anthropic_dpa_signed).toBe(false);
  });

  it('rejects a config without a version and an unknown extra key', () => {
    const { version, ...unversioned } = ROUTING_CONFIG;
    expect(routingConfigSchema.safeParse(unversioned).success).toBe(false);
    expect(routingConfigSchema.safeParse({ ...ROUTING_CONFIG, min_confidence: 0.7 }).success).toBe(
      false,
    );
  });
});

describe('drift-locked literals', () => {
  it('log events are exactly the four journal literals, in order', () => {
    expect(routingLogEventSchema.options).toEqual([
      'escalation_budget_exhausted',
      'spend_cap_degrade',
      'abuse_cooldown',
      'p6_degraded',
    ]);
  });

  it('journal field and gateway header names are stable', () => {
    expect(FALLBACK_STEP_FIELD).toBe('fallback_step');
    expect(GATEWAY_STEP_HEADER).toBe('cf-aig-step');
    expect(AUX_CACHE_TTL_HEADER).toBe('cf-aig-cache-ttl');
    expect(AUX_CACHE_TTL_SECONDS).toBe(300);
  });

  it('reasoning-share guard thresholds are 5% flag and 7% page', () => {
    expect(REASONING_SHARE_FLAG_THRESHOLD).toBe(0.05);
    expect(REASONING_SHARE_PAGE_THRESHOLD).toBe(0.07);
  });

  it('availability floors are exactly template · skip · defer, in order', () => {
    expect(availabilityFloorSchema.options).toEqual(['template', 'skip', 'defer']);
  });

  it('tiers are exactly free · pro · pro_max, in order', () => {
    expect(tierSchema.options).toEqual(['free', 'pro', 'pro_max']);
  });
});
