import type { FormZone, LoadZone, RecoveryZone } from '../../../../contracts/src/health/crs';

// Candidate bands from the app's own readiness bands, inclusive at the lower edge. Not accepted:
// every result carries activation 'candidate_unaccepted' until the owner ratifies them.
export const recoveryZone = (score: number): RecoveryZone => (score >= 80 ? 'excellent' : score >= 60 ? 'solid' : score >= 40 ? 'mixed' : 'compromised');
export const formZone = (score: number): FormZone => (score >= 80 ? 'energized' : score >= 60 ? 'steady' : score >= 40 ? 'flagging' : 'depleted');
// The same edges read in the demand direction: a heavier day gets a heavier word.
export const weightZone = (score: number): LoadZone => (score <= 20 ? 'light' : score <= 40 ? 'moderate' : score <= 60 ? 'heavy' : 'peak');
// A move of this many score points or fewer is steady: the trend reads it as no change, and a zone holds through it.
export const STEADY_SCORE_MOVE = 5;
// A pillar keeps the zone it had until its score moves more than a steady move past that zone, so a score wavering on an
// edge is one zone, not a change at every upload. With no zone before, it is the score's own band.
export const heldZone = <Zone extends string>(band: (score: number) => Zone, score: number, before: Zone | null): Zone =>
  before !== null && (band(score + STEADY_SCORE_MOVE) === before || band(score - STEADY_SCORE_MOVE) === before) ? before : band(score);
