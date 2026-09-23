import type {
  Admission,
  ClassState,
  DeliveryClassCounter,
  DeliveryBudgetTier,
  DeliveryCandidate,
  DeliveryGateReason,
  DeliveryPolicyRow,
  PushClass,
} from '@waldo/contracts';
import { DAILY_PUSH_BUDGET, DELIVERY_POLICY, TRIGGER_PUSH_CLASSES } from '@waldo/contracts';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

export type GateDecisionInput = {
  candidate: DeliveryCandidate;
  classState: ClassState;
  subKindState?: DeliveryClassCounter;
  countedSends: number;
  tier?: DeliveryBudgetTier;
  now: number;
};

export function computeAdmission(input: GateDecisionInput): Admission {
  const candidate = input.candidate;
  const policy = DELIVERY_POLICY[candidate.push_class];
  assertTriggerCanEmit(candidate);

  if (
    candidate.expires_at !== undefined &&
    candidate.expires_at !== null &&
    candidate.expires_at <= input.now
  ) {
    return dropAdmission(
      candidate.push_class,
      policy,
      candidate.expires_at,
      'candidate_expired',
    );
  }

  const classCounter = input.classState[candidate.push_class] ?? { count: 0, last_sent_at: null };
  const counter =
    candidate.push_class === 'adjustment' && candidate.sub_kind !== undefined
      ? (input.subKindState ?? { count: 0, last_sent_at: null })
      : classCounter;
  const cap =
    candidate.push_class === 'adjustment' && candidate.sub_kind !== undefined
      ? policy.sub_caps?.[candidate.sub_kind].daily_cap
      : policy.daily_cap;
  const cooldownMin =
    candidate.push_class === 'adjustment' && candidate.sub_kind !== undefined
      ? policy.sub_caps?.[candidate.sub_kind].cooldown_min
      : policy.cooldown_min;
  const underClassCap = cap === null || cap === undefined || counter.count < cap;
  const cooldownElapsed =
    cooldownMin === null ||
    cooldownMin === undefined ||
    counter.last_sent_at === null ||
    input.now - counter.last_sent_at >= cooldownMin * MS_PER_MINUTE;

  if (!underClassCap && policy.cap_scope === 'lifetime') {
    return dropAdmission(
      candidate.push_class,
      policy,
      candidate.expires_at ?? null,
      'once_ever_already_sent',
    );
  }

  if (!underClassCap) {
    return holdAdmission(
      candidate.push_class,
      policy,
      nextUtcDayStart(input.now),
      candidate.expires_at ?? null,
      'class_cap_exhausted',
    );
  }

  if (!cooldownElapsed) {
    return holdAdmission(
      candidate.push_class,
      policy,
      nextCooldownAt(counter, cooldownMin),
      candidate.expires_at ?? null,
      'cooldown_active',
    );
  }

  const channels = channelsFor(policy);
  const canChargeBudget =
    policy.budget === 'counted' &&
    policy.apns &&
    input.countedSends < DAILY_PUSH_BUDGET[input.tier ?? 'pro'];

  if (policy.budget === 'counted' && policy.apns && !canChargeBudget) {
    return {
      verdict: 'degrade',
      reason: 'budget_cap_exhausted',
      channels: channels.filter((channel) => channel !== 'apns'),
      collapse_id: collapseIdFor(candidate.push_class, candidate.event_id),
      budget_charged: false,
      stamped: stamp(candidate.push_class, policy, candidate.expires_at ?? null),
    };
  }

  return {
    verdict: 'send',
    reason: null,
    channels,
    collapse_id: collapseIdFor(candidate.push_class, candidate.event_id),
    budget_charged: canChargeBudget,
    stamped: stamp(candidate.push_class, policy, candidate.expires_at ?? null),
  };
}

function assertTriggerCanEmit(candidate: DeliveryCandidate): void {
  const policy = DELIVERY_POLICY[candidate.push_class];
  if (!policy.agent_invocable) return;
  if (!TRIGGER_PUSH_CLASSES[candidate.trigger].includes(candidate.push_class)) {
    throw new Error(`trigger ${candidate.trigger} cannot emit ${candidate.push_class}`);
  }
}

function holdAdmission(
  pushClass: PushClass,
  policy: DeliveryPolicyRow,
  holdUntil: number,
  expiresAt: number | null,
  reason: DeliveryGateReason,
): Admission {
  return {
    verdict: 'hold',
    reason,
    hold_until: holdUntil,
    channels: [],
    collapse_id: null,
    budget_charged: false,
    stamped: stamp(pushClass, policy, expiresAt),
  };
}

function nextCooldownAt(
  counter: DeliveryClassCounter,
  cooldownMin: number | null | undefined,
): number {
  if (counter.last_sent_at === null || cooldownMin === null || cooldownMin === undefined) {
    throw new Error('cooldown hold requires a prior send and cooldown');
  }
  return counter.last_sent_at + cooldownMin * MS_PER_MINUTE;
}

function nextUtcDayStart(now: number): number {
  const day = new Date(now);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) + MS_PER_DAY;
}

function dropAdmission(
  pushClass: PushClass,
  policy: DeliveryPolicyRow,
  expiresAt: number | null,
  reason: DeliveryGateReason,
): Admission {
  return {
    verdict: 'drop',
    reason,
    channels: [],
    collapse_id: null,
    budget_charged: false,
    stamped: stamp(pushClass, policy, expiresAt),
  };
}

function channelsFor(policy: DeliveryPolicyRow): Admission['channels'] {
  const channels: Admission['channels'] = [];
  if (policy.apns) channels.push('apns');
  if (policy.telegram) channels.push('telegram');
  if (policy.feed) channels.push('in_app');
  return channels;
}

function collapseIdFor(pushClass: PushClass, eventId: string): string {
  return DELIVERY_POLICY[pushClass].is_standalone ? `evt:${eventId}` : 'stack';
}

function stamp(
  pushClass: PushClass,
  policy: DeliveryPolicyRow,
  expiresAt: number | null,
): Admission['stamped'] {
  return {
    push_class: pushClass,
    is_standalone: policy.is_standalone,
    budget_exempt: policy.budget === 'exempt',
    expires_at: expiresAt,
  };
}
