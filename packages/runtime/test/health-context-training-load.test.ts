import { describe, expect, it } from 'vitest';
import { toContextHealthMaterial, type HealthContextRow } from '../src/channels/health-context';
import { TRAINING_LOAD_PHRASES } from '../src/health/scores/training-load';

// The candidate training load in the model's health context (ADR-0081 amendment of 31 Oct 2026, §2): words only, labelled a
// candidate, and only in the closed vocabulary the row writer admits. Every value here is synthetic.
const NOW = new Date('2026-09-28T10:00:00Z');
const clock = { timezone: 'Asia/Kolkata', now: () => NOW };
const row = (training_load?: unknown): HealthContextRow => ({
  context: {
    id: 'ctx-1', day: '2026-09-28', form: { score: 72, zone: 'good', confidence: 0.8 }, recovery: { score: 70, zone: 'good' }, weight: { score: 45, zone: 'moderate' },
    drivers: [], confidence: 0.8, freshness: 'fresh', tags: [], compiled_at: '2026-09-28T04:30:00.000Z',
    ...(training_load === undefined ? {} : { training_load }),
  },
  previous: null,
});
const load = (over: Record<string, unknown> = {}) => ({ state: 'available', phrase: 'heavier than usual', method: 'hr_zones', algorithm_version: 'training-load.candidate.v1', activation: 'candidate_unaccepted', ...over });
const summary = (training_load?: unknown) => toContextHealthMaterial(row(training_load), clock)!.narrative.day_summary;

describe('health context: candidate training load', () => {
  it('says the week against the owner\'s usual, the method in words and that it is a candidate', () => {
    expect(summary(load())).toContain('Training load this week (candidate, from time in heart-rate zones): heavier than usual against your own usual.');
    expect(summary(load({ method: 'effort', phrase: 'about usual' }))).toContain('(candidate, from session effort): about usual against');
    expect(summary(load({ method: 'minutes', phrase: 'much lighter than usual' }))).toContain('(candidate, from workout minutes): much lighter than usual against');
  });

  it('words each phrase the producer writes', () => {
    for (const phrase of TRAINING_LOAD_PHRASES) expect(summary(load({ phrase }))).toContain(`: ${phrase} against your own usual.`);
  });

  it('says why when there is no load, and says nothing when the row has none', () => {
    expect(summary({ state: 'unavailable', reason: 'baseline_immature' })).toContain('Training load: not enough days yet.');
    expect(summary({ state: 'unavailable', reason: 'no_readings' })).toContain('Training load: no workouts in the last four weeks.');
    expect(summary()).not.toContain('Training load');
  });

  it('drops anything outside the closed vocabulary rather than passing it on', () => {
    for (const bad of [load({ phrase: 'heavier than usual (1.4x)' }), load({ method: 'trimp' }), load({ activation: 'accepted' }), { state: 'unavailable', reason: 'hostile 99' }, 'heavier', null, 7]) {
      const text = summary(bad);
      expect(text, JSON.stringify(bad)).not.toContain('Training load');
      expect(text).not.toMatch(/[0-9]/);
    }
  });
});
