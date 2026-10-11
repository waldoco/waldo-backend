import type { FormZone, LoadZone, RecoveryZone } from '../../../../contracts/src/health/crs';

// Candidate bands from the app's own readiness bands, inclusive at the lower edge. Not accepted:
// every result carries activation 'candidate_unaccepted' until the owner ratifies them.
export const recoveryZone = (score: number): RecoveryZone => (score >= 80 ? 'excellent' : score >= 60 ? 'solid' : score >= 40 ? 'mixed' : 'compromised');
export const formZone = (score: number): FormZone => (score >= 80 ? 'energized' : score >= 60 ? 'steady' : score >= 40 ? 'flagging' : 'depleted');
// The same edges read in the demand direction: a heavier day gets a heavier word.
export const weightZone = (score: number): LoadZone => (score <= 20 ? 'light' : score <= 40 ? 'moderate' : score <= 60 ? 'heavy' : 'peak');
