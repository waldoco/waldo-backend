import type { GovernorVerdict } from '@waldo/contracts';

// One deterministic admit verdict, outside the LLM. The priority arbiter, per-loop budgets,
// kill flag, within-run dedup, and cross-run no-progress guard are Phase D.
export function admit(policy: { admit: boolean; name?: string }): GovernorVerdict {
  return policy.admit ? 'admit' : 'deny';
}
