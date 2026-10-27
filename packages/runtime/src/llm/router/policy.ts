import { OPENAI_GPT_6_LUNA_MODEL, WALDO_CHAT_MODEL, WALDO_REASONING_MODEL, type ModelName } from '@waldo/contracts';

export type Tier = 'light' | 'standard' | 'deep';
export const TIER_MODEL: Readonly<Record<Tier, ModelName>> = { light: OPENAI_GPT_6_LUNA_MODEL, standard: WALDO_CHAT_MODEL, deep: WALDO_REASONING_MODEL };
const RANK: Readonly<Record<Tier, number>> = { light: 0, standard: 1, deep: 2 };

// What the router said about one turn, or null when it failed, refused, timed out or was not asked.
export type RouterVerdict = Readonly<{ tier: Tier; confidence: number }> | null;
// The model one conversation is on, and when its last turn ran.
export type RouteState = Readonly<{ tier: Tier; lastTurnAt: number }>;
// Whether each model's prompt cache is warm for this owner: a warm Terra turn costs less than a cold Luna one.
export type WarmCaches = Readonly<Record<Tier, boolean>>;
// Thresholds come from the labelled set, never from a guess here. coldAfterMs is how long a conversation's cache stays warm.
export type RouterPolicy = Readonly<{ escalateAt: number; lunaAt: number; coldAfterMs: number }>;
export type RouteReason = 'routed' | 'escalated' | 'sticky' | 'warm_cache' | 'low_confidence' | 'router_unavailable';
export type RoutedTurn = Readonly<{ tier: Tier; reason: RouteReason; state: RouteState }>;

const turn = (tier: Tier, reason: RouteReason, now: number): RoutedTurn => ({ tier, reason, state: { tier, lastTurnAt: now } });

// The model for one owner turn, chosen once before its tool loop and kept for the whole loop. A conversation only ever
// escalates: OpenAI caches per model and owner prompts are long, so flipping models turn by turn pays a cold cache each time.
// A conversation starts afresh once it has gone cold. Anything the router can't vouch for lands on Terra, or stays put.
export function routeTurn(state: RouteState | undefined, verdict: RouterVerdict, warm: WarmCaches, now: number, policy: RouterPolicy): RoutedTurn {
  const current = state && now - state.lastTurnAt <= policy.coldAfterMs ? state.tier : undefined;
  if (current !== undefined) {
    return verdict && RANK[verdict.tier] > RANK[current] && verdict.confidence >= policy.escalateAt
      ? turn(verdict.tier, 'escalated', now)
      : turn(current, 'sticky', now);
  }
  if (verdict === null) return turn('standard', 'router_unavailable', now);
  if (verdict.tier === 'deep') return verdict.confidence >= policy.escalateAt ? turn('deep', 'routed', now) : turn('standard', 'low_confidence', now);
  if (verdict.tier === 'light') {
    if (verdict.confidence < policy.lunaAt) return turn('standard', 'low_confidence', now);
    return warm.standard ? turn('standard', 'warm_cache', now) : turn('light', 'routed', now);
  }
  return turn('standard', 'routed', now);
}

// A trace label for the router's confidence: bounded, never the number itself.
export const confidenceBucket = (confidence: number | null): 'none' | 'lt50' | '50_70' | '70_90' | 'ge90' =>
  confidence === null ? 'none' : confidence >= 0.9 ? 'ge90' : confidence >= 0.7 ? '70_90' : confidence >= 0.5 ? '50_70' : 'lt50';
