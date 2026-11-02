import { OUTSIDE } from './drivers';
import { BASELINE_DAYS, type Component } from './stats';
import type { Absent, PartBasis, PartDirection, PartRow } from './types';

// The parts of one pillar's score. A pillar's score is the weighted mean of the components that had a reading, so each part's
// share is its weight over the weights present and its points are its score times that share: the points add up to the
// pillar's score before it is rounded. Direction describes which way a reading stood against the owner's usual; it is
// not a verdict.
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

export const directionOf = (z: number | null): PartDirection | null => (z === null ? null : z >= OUTSIDE ? 'above_usual' : z <= -OUTSIDE ? 'below_usual' : 'usual');

const baselineOf = (own: number | null, ownShare: number | null): Extract<PartRow, { state: 'available' }>['baseline'] =>
  own === null || ownShare === null ? null : { state: own >= BASELINE_DAYS ? 'personal' : 'provisional', own_days: own, own_share: round6(ownShare) };

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
