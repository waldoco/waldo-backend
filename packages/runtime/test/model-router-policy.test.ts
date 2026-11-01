import { describe, expect, it } from 'vitest';
import { OPENAI_GPT_6_1_SOL_MODEL, OPENAI_GPT_6_1_TERRA_MODEL, OPENAI_GPT_6_LUNA_MODEL } from '@waldo/contracts';
import { confidenceBucket, routeTurn, TIER_MODEL, type RouteState, type RouterPolicy } from '../src/llm/router/policy';

const policy: RouterPolicy = { escalateAt: 0.8, lunaAt: 0.9, coldAfterMs: 30 * 60_000 };
const at = 1_000_000_000;
const cold = { light: false, standard: false, deep: false };
const warmTerra = { ...cold, standard: true };

describe('the sticky, escalate-only route for one conversation', () => {
  it('maps tiers to the roster models', () => {
    expect(TIER_MODEL).toEqual({ light: OPENAI_GPT_6_LUNA_MODEL, standard: OPENAI_GPT_6_1_TERRA_MODEL, deep: OPENAI_GPT_6_1_SOL_MODEL });
  });

  it('starts a conversation on Terra when the router failed, refused, timed out or was unsure', () => {
    for (const verdict of [null, { tier: 'light' as const, confidence: 0.6 }, { tier: 'deep' as const, confidence: 0.5 }])
      expect(routeTurn(undefined, verdict, cold, at, policy)).toMatchObject({ tier: 'standard', reason: verdict === null ? 'router_unavailable' : 'low_confidence' });
  });

  it('starts on Luna only when the router is sure and Terra has no warm cache: a warm Terra turn costs less than a cold Luna one', () => {
    expect(routeTurn(undefined, { tier: 'light', confidence: 0.95 }, cold, at, policy)).toMatchObject({ tier: 'light', reason: 'routed' });
    expect(routeTurn(undefined, { tier: 'light', confidence: 0.95 }, warmTerra, at, policy)).toMatchObject({ tier: 'standard', reason: 'warm_cache' });
  });

  it('starts on Sol when the router is sure the turn is demanding', () => {
    expect(routeTurn(undefined, { tier: 'deep', confidence: 0.85 }, warmTerra, at, policy)).toMatchObject({ tier: 'deep', reason: 'routed' });
  });

  it('only escalates within a conversation: a cheaper verdict, a failed router or an unsure escalation keeps the current model', () => {
    const onTerra: RouteState = { tier: 'standard', lastTurnAt: at - 60_000 };
    expect(routeTurn(onTerra, { tier: 'light', confidence: 0.99 }, cold, at, policy)).toMatchObject({ tier: 'standard', reason: 'sticky' });
    expect(routeTurn(onTerra, null, cold, at, policy)).toMatchObject({ tier: 'standard', reason: 'sticky' });
    expect(routeTurn(onTerra, { tier: 'deep', confidence: 0.7 }, cold, at, policy)).toMatchObject({ tier: 'standard', reason: 'sticky' });
    expect(routeTurn(onTerra, { tier: 'deep', confidence: 0.85 }, cold, at, policy)).toMatchObject({ tier: 'deep', reason: 'escalated' });
    const onSol: RouteState = { tier: 'deep', lastTurnAt: at - 60_000 };
    expect(routeTurn(onSol, { tier: 'standard', confidence: 0.99 }, warmTerra, at, policy)).toMatchObject({ tier: 'deep', reason: 'sticky' });
  });

  it('starts afresh once the conversation has gone cold, since no model\'s cache is warm for it any more', () => {
    const stale: RouteState = { tier: 'deep', lastTurnAt: at - policy.coldAfterMs - 1 };
    expect(routeTurn(stale, null, cold, at, policy)).toMatchObject({ tier: 'standard', reason: 'router_unavailable' });
    expect(routeTurn(stale, { tier: 'light', confidence: 0.95 }, cold, at, policy)).toMatchObject({ tier: 'light', reason: 'routed' });
  });

  it('records the turn on the state it returns', () => {
    expect(routeTurn(undefined, null, cold, at, policy).state).toEqual({ tier: 'standard', lastTurnAt: at });
    expect(routeTurn({ tier: 'standard', lastTurnAt: at - 1 }, { tier: 'deep', confidence: 0.9 }, cold, at, policy).state).toEqual({ tier: 'deep', lastTurnAt: at });
  });

  it('labels a confidence with a bounded bucket, never the number', () => {
    expect([0.2, 0.5, 0.75, 0.9, 1].map(confidenceBucket)).toEqual(['lt50', '50_70', '70_90', 'ge90', 'ge90']);
    expect(confidenceBucket(null)).toBe('none');
  });
});
