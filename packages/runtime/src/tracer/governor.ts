import { admit as admitByPolicy, lookupLoopPolicy } from '@waldo/contracts';
import type { GovernorVerdict, LoopType } from '@waldo/contracts';

// The tracer admits its one loop through the real ADR-0074 registry: lookupLoopPolicy(loopType) ->
// admit(policy | null). The per-run budget, kill flag, within-run dedup, and cross-run no-progress
// guard are the runtime Governor (deferred); this contract-layer admit applies only the fail-closed
// null guard (ADR-0074 §null: no policy -> deny).
export function admit(loopType: LoopType): GovernorVerdict {
  return admitByPolicy(lookupLoopPolicy(loopType));
}
