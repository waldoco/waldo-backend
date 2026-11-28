import { OUTSIDE } from './drivers';
import { BASELINE_DAYS, type Component } from './stats';
import type { Absent, GroupRow, PartBasis, PartBaseline, PartDirection, PartRow } from './types';

// The parts of one pillar's score. A pillar's score is the weighted mean of the components that had a reading, so each part's
// share is its weight over the weights present and its points are its score times that share: the points add up to the
// pillar's score before it is rounded. Direction describes which way a reading stood against the owner's usual; it is
// not a verdict.
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

export const directionOf = (z: number | null): PartDirection | null => (z === null ? null : z >= OUTSIDE ? 'above_usual' : z <= -OUTSIDE ? 'below_usual' : 'usual');

const baselineOf = (own: number | null, ownShare: number | null): PartBaseline | null =>
  own === null || ownShare === null ? null : { state: own >= BASELINE_DAYS ? 'personal' : 'provisional', own_days: Math.min(own, 30), own_share: round6(ownShare), days_until_personal: Math.max(0, BASELINE_DAYS - Math.min(own, 30)) };

// Form's night share: Recovery's parts as scaled into Form, shown as one row whose score is the Recovery basis they make up.
// It stands on the least settled of them.
export const fromTheNight = (scaled: readonly Component[]): Component => {
  const weight = scaled.reduce((sum, component) => sum + component.weight, 0);
  const owned = scaled.flatMap(component => (component.basis?.own != null && component.basis.ownShare != null ? [{ own: component.basis.own, share: component.basis.ownShare }] : []));
  return {
    name: 'from_the_night', weight, score: scaled.reduce((sum, component) => sum + component.score * component.weight, 0) / weight,
    basis: {
      z: null, own: owned.length ? Math.min(...owned.map(entry => entry.own)) : null, ownShare: owned.length ? Math.min(...owned.map(entry => entry.share)) : null,
      signals: [...new Set(scaled.flatMap(component => component.basis?.signals ?? []))],
    },
  };
};

// The pillar's rows in the contract's order: each part that had a reading with its share, and each that had none with why.
export const partRows = (order: readonly string[], present: readonly Component[], absent: ReadonlyMap<string, Absent>): PartRow[] => {
  const total = present.reduce((sum, component) => sum + component.weight, 0);
  return order.flatMap((key): PartRow[] => {
    const component = present.find(entry => entry.name === key);
    if (component) {
      const share = component.weight / total;
      const basis: PartBasis = component.basis ?? { z: null, own: null, ownShare: null, signals: [] };
      return [{
        key, state: 'available', score: round6(component.score), share: round6(share), points: round6(component.score * share),
        direction: directionOf(basis.z), signals: basis.signals, baseline: baselineOf(basis.own, basis.ownShare),
        ...(basis.need ? { need_minutes: Math.round(basis.need.minutes), need_basis: basis.need.basis } : {}),
      }];
    }
    const reason = absent.get(key);
    return reason ? [{ key, state: 'unavailable', reason }] : [];
  });
};

export const PART_ORDER = {
  recovery: ['sleep', 'hrv', 'resting_heart_rate'],
  form: ['from_the_night', 'sleep_midpoint', 'daylight', 'movement', 'stress'],
  weight: ['calendar', 'tasks', 'messages', 'physical_load'],
} as const;

// The two rows the app's screens show, each the sum of two fine parts of one pillar. Their score is the weighted mean of the two
// by the weights the pillar's own formula already gives them, so the group's share and points are the sums of its parts' and
// the points still add up to the pillar. A group needs both parts: with one missing it is unavailable, for the same reason.
// Direction is the one both parts share, and null when they differ: two different readings (HRV and resting heart rate, a
// late midpoint and little daylight) have no common direction to average, and a score cannot stand in for one, since it says
// better or worse and not which way.
export const GROUPS = [
  { key: 'resting_state', pillar: 'recovery', parts: ['hrv', 'resting_heart_rate'] },
  { key: 'circadian', pillar: 'form', parts: ['sleep_midpoint', 'daylight'] },
] as const;

export const groupRows = (byPillar: Readonly<Partial<Record<'recovery' | 'form', readonly PartRow[]>>>): GroupRow[] =>
  GROUPS.flatMap((group): GroupRow[] => {
    const rows = byPillar[group.pillar];
    const members = rows ? group.parts.map(key => rows.find(row => row.key === key)) : [];
    if (!rows || members.some(member => member === undefined)) return [];
    const unavailable = members.flatMap(member => (member!.state === 'unavailable' ? [member!.reason] : []));
    if (unavailable.length) return [{ key: group.key, pillar: group.pillar, state: 'unavailable', reason: unavailable.includes('no_reading') ? 'no_reading' : 'baseline_immature' }];
    const available = members as Extract<PartRow, { state: 'available' }>[];
    const share = available.reduce((sum, member) => sum + member.share, 0), points = available.reduce((sum, member) => sum + member.points, 0);
    const directions = new Set(available.map(member => member.direction));
    const baselines = available.map(member => member.baseline);
    const least = baselines.every(baseline => baseline !== null) ? (baselines as PartBaseline[]).reduce((a, b) => (b.own_days < a.own_days ? b : a)) : null;
    return [{
      key: group.key, pillar: group.pillar, state: 'available', score: round6(points / share), share: round6(share), points: round6(points),
      direction: directions.size === 1 ? [...directions][0]! : null, parts: group.parts,
      signals: [...new Set(available.flatMap(member => member.signals))],
      baseline: least && { ...least, own_share: Math.min(...(baselines as PartBaseline[]).map(baseline => baseline.own_share)) },
    }];
  });
