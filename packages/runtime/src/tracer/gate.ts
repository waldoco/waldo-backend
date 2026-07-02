import type { Admission, ClassState, FetchAlertPolicy } from '@waldo/contracts';

const MS_PER_MINUTE = 60_000;

export interface DeliveryCandidate {
  push_class: 'fetch_alert';
  now: number;
}

// Deterministic fetch_alert admission. fetch_alert is budget-exempt, so this NEVER reads the daily
// push budget; it gates only on the per-class cap (count < daily_cap) AND the cooldown
// (now - last_sent_at >= cooldown_min). Pure: no I/O, no clock read — `now` is injected via the
// candidate so a crash/resume replays to the same verdict.
export function computeVerdict(
  candidate: DeliveryCandidate,
  classState: ClassState,
  policy: FetchAlertPolicy,
): Admission {
  const { count, last_sent_at } = classState.fetch_alert;
  const underCap = count < policy.daily_cap;
  const cooldownElapsed =
    last_sent_at === null || candidate.now - last_sent_at >= policy.cooldown_min * MS_PER_MINUTE;

  return {
    verdict: underCap && cooldownElapsed ? 'send' : 'hold',
    stamped: {
      push_class: policy.push_class,
      is_standalone: false,
      budget_exempt: policy.budget_exempt,
    },
  };
}
