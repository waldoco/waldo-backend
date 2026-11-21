import { describe, expect, it } from 'vitest';
import { HEALTH_CHANGE_PILLAR_OF_SIGNAL_V1, HEALTH_CHANGE_UNIT_OF_SIGNAL_V1 } from '../../contracts/src/app/health-ingest';
import { bodyViewOf } from '../src/channels/health-body';
import { renderHealth } from '../src/context-composer/prompt';
import type { ContextHealthMaterial } from '../src/context-composer/types';

// The body read's stored pieces into closed words: which way and whether far against each band, parts, the sleep need in tenths,
// the load so far against a usual day and the hours of high strain at rest. Synthetic values only.
const TODAY = '2026-03-20';
const band = (signal: string, low: number, centre: number, high: number, over: object = {}) => ({
  signal, method: null, state: 'personal', low, centre, high, own_days: 20, own_share: 1, days_until_personal: 0, window_days: 30,
  estimator: ['overnight_hrv', 'resting_heart_rate', 'sleep_midpoint', 'daylight', 'movement', 'stress_heart_rate'].includes(signal) ? 'shrunk_predictive' : 'own_mean_sd', ...over,
});
// A tier-three change as the engine writes it, in the contract's own unit and pillar for its band; the unit argument is the reader's.
const reading = (key: string, _unit: string, from: number, to: number) => ({
  subject: { tier: 3, key, method: key === 'overnight_hrv' ? 'rmssd' : null }, pillar: HEALTH_CHANGE_PILLAR_OF_SIGNAL_V1[key as keyof typeof HEALTH_CHANGE_PILLAR_OF_SIGNAL_V1],
  from, to, unit: HEALTH_CHANGE_UNIT_OF_SIGNAL_V1[key as keyof typeof HEALTH_CHANGE_UNIT_OF_SIGNAL_V1], against: 'usual', verdict: 'neutral', significant: from !== to,
});
const view = (body: object, onError?: (error: Error) => void) => bodyViewOf({ body: { day: TODAY, ...body } }, TODAY, 'Asia/Kolkata', onError);
const standingOf = (body: object, signal: string) => view(body)?.readings.find(entry => entry.signal === signal)?.standing;

describe('a reading against its usual band', () => {
  it('is above, below or within the band, and far from two spreads out', () => {
    const usual = [band('breathing_rate', 13, 14, 15)];
    const at = (to: number) => standingOf({ usual, changes: [reading('breathing_rate', 'breaths_per_minute', 14, to)] }, 'breathing_rate');
    expect(at(14.9)).toEqual({ state: 'compared', direction: 'within' });
    expect(at(15)).toEqual({ state: 'compared', direction: 'within' });
    expect(at(15.5)).toEqual({ state: 'compared', direction: 'above' });
    expect(at(16)).toEqual({ state: 'compared', direction: 'above', far: true });
    expect(at(12.5)).toEqual({ state: 'compared', direction: 'below' });
    expect(at(11.9)).toEqual({ state: 'compared', direction: 'below', far: true });
  });
  it('reads each side of a band that is not symmetric against its own edge', () => {
    const usual = [band('walking_heart_rate', 90, 100, 120)];
    const at = (to: number) => standingOf({ usual, changes: [reading('walking_heart_rate', 'beats_per_minute', 100, to)] }, 'walking_heart_rate');
    expect(at(119)).toEqual({ state: 'compared', direction: 'within' });
    expect(at(85)).toEqual({ state: 'compared', direction: 'below' });
    expect(at(80)).toEqual({ state: 'compared', direction: 'below', far: true });
  });
  it('reads sleep timing round the clock, as later or earlier, across midnight', () => {
    const usual = [band('sleep_midpoint', 1410, 30, 90)];
    const at = (to: number) => standingOf({ usual, changes: [reading('sleep_midpoint', 'local_minute', 30, to)] }, 'sleep_midpoint');
    expect(at(1430)).toEqual({ state: 'compared', direction: 'within' });
    expect(at(120)).toEqual({ state: 'compared', direction: 'later' });
    expect(at(1380)).toEqual({ state: 'compared', direction: 'earlier' });
    expect(at(1300)).toEqual({ state: 'compared', direction: 'earlier', far: true });
  });
  it('takes any move off a flat history as far, as the engine\'s own bound does', () => {
    const usual = [band('spo2', 96, 96, 96)];
    expect(standingOf({ usual, changes: [reading('spo2', 'percent', 96, 95)] }, 'spo2')).toEqual({ state: 'compared', direction: 'below', far: true });
    expect(standingOf({ usual, changes: [reading('spo2', 'percent', 96, 96)] }, 'spo2')).toEqual({ state: 'compared', direction: 'within' });
  });
  it('says a band short of the owner\'s fourteen days is still forming, with no direction', () => {
    const usual = [band('daylight', 10, 20, 30, { state: 'provisional', own_days: 9, own_share: 0.4, days_until_personal: 5 })];
    expect(standingOf({ usual }, 'daylight')).toEqual({ state: 'forming' });
  });
  it('names no standing for a personal band that has no reading today', () => {
    expect(view({ usual: [band('spo2', 95, 96, 97)] })).toBeNull();
  });
});

const part = (key: string, over: object = {}) => ({
  key, state: 'available', score: 50, share: 0.5, points: 25, direction: 'usual', signals: [], baseline: { state: 'personal', own_days: 20, own_share: 1, days_until_personal: 0 }, ...over,
});
describe('the parts of each score', () => {
  const components = {
    recovery: [
      { ...part('sleep', { direction: null, score: 83, share: 0.5, points: 41.5, baseline: null }), need_minutes: 480, need_basis: 'owner_confirmed' },
      part('hrv', { direction: 'below_usual', signals: ['overnight_hrv'], share: 0.3, points: 15 }),
      { key: 'resting_heart_rate', state: 'unavailable', reason: 'no_reading' },
    ],
    form: [
      part('from_the_night', { direction: null, signals: ['overnight_hrv'] }),
      part('sleep_midpoint', { direction: 'above_usual', signals: ['sleep_midpoint'] }),
      part('movement', { direction: 'below_usual', signals: [] }),
      part('daylight', { direction: 'usual', signals: ['daylight'], baseline: { state: 'provisional', own_days: 10, own_share: 0.5, days_until_personal: 4 } }),
    ],
  };
  const usual = [band('overnight_hrv', 50, 60, 70, { method: 'rmssd' })];
  it('gives each part its direction, far only when today\'s reading of its band is far, and the sleep need in tenths', () => {
    const body = view({ components, usual, changes: [reading('overnight_hrv', 'milliseconds', 60, 35)] })!;
    expect(body.parts).toEqual([
      { pillar: 'recovery', key: 'sleep', need_tenths: 8 },
      { pillar: 'recovery', key: 'hrv', standing: { state: 'compared', direction: 'below', far: true } },
      { pillar: 'recovery', key: 'resting_heart_rate', unavailable: 'no_reading' },
      { pillar: 'form', key: 'sleep_midpoint', standing: { state: 'compared', direction: 'later' } },
      { pillar: 'form', key: 'movement', standing: { state: 'compared', direction: 'below' }, via: 'steps' },
      { pillar: 'form', key: 'daylight', standing: { state: 'forming' } },
    ]);
    // The band a part stands for is said once, with the part.
    expect(body.readings).toEqual([]);
  });
  it('never calls a part far when today\'s reading of its band stood the other way or within it', () => {
    const within = { recovery: [part('hrv', { direction: 'usual', signals: ['overnight_hrv'], share: 1, points: 50 })] };
    const body = view({ components: within, usual, changes: [reading('overnight_hrv', 'milliseconds', 60, 35)] })!;
    expect(body.parts).toEqual([{ pillar: 'recovery', key: 'hrv', standing: { state: 'compared', direction: 'within' } }]);
  });
  it('says the need was met at all of it, and never more', () => {
    const met = { recovery: [{ ...part('sleep', { direction: null, score: 100, share: 1, points: 100, baseline: null }), need_minutes: 480, need_basis: 'owner_confirmed' }] };
    expect(view({ components: met })!.parts).toEqual([{ pillar: 'recovery', key: 'sleep', need_tenths: 10 }]);
  });
});

describe('the day\'s load and the hours of strain at rest', () => {
  const load = (score: number, bandOver: object = {}) => ({
    state: 'available', version: 'day-load.candidate.v1', activation: 'candidate_unaccepted', score, method: 'hr_zones', approximate: false, window_days: 28,
    band: { state: 'personal', low: 30, centre: 40, high: 50, own_days: 20, days_until_personal: 0, ...bandOver },
  });
  it('reads the load so far against the owner\'s usual whole day', () => {
    expect(view({ day_load: load(45) })!.day_load).toEqual({ state: 'compared', direction: 'within', approximate: false });
    expect(view({ day_load: load(55) })!.day_load).toEqual({ state: 'compared', direction: 'above', approximate: false });
    expect(view({ day_load: load(10) })!.day_load).toEqual({ state: 'compared', direction: 'below', far: true, approximate: false });
    expect(view({ day_load: { ...load(10), band: { state: 'provisional', own_days: 6, days_until_personal: 8 } } })!.day_load).toEqual({ state: 'forming', approximate: false });
    expect(view({ day_load: { state: 'unavailable', reason: 'no_readings' } })).toBeNull();
  });
  it('joins the high hours into clock ranges in the owner\'s zone', () => {
    const hour = (at: string, value: number | null) => (value === null
      ? { at, value: null, band: null, reason: 'moving' } : { at, value, band: value >= 70 ? 'high' : value <= 30 ? 'low' : 'medium' });
    const stress_curve = { version: 'stress-curve.candidate.v1', hours: [
      hour('2026-03-20T03:30:00.000Z', 75), hour('2026-03-20T04:30:00.000Z', 80), hour('2026-03-20T05:30:00.000Z', 40),
      hour('2026-03-20T06:30:00.000Z', null), hour('2026-03-20T07:30:00.000Z', 90),
    ] };
    expect(view({ stress_curve })!.strain_hours).toEqual([{ start: '09:00', end: '11:00' }, { start: '13:00', end: '14:00' }]);
    const calm = { ...stress_curve, hours: [hour('2026-03-20T03:30:00.000Z', 40)] };
    expect(view({ stress_curve: calm })!.strain_hours).toEqual([]);
  });
});

describe('what the body read answers', () => {
  it('is nothing for another day\'s row, no row, or an unlinked owner, and only an unknown shape is logged', () => {
    const errors: string[] = [];
    const onError = (error: Error) => { errors.push(error.message); };
    const said = { usual: [band('breathing_rate', 13, 14, 15)], changes: [reading('breathing_rate', 'breaths_per_minute', 14, 16.2)] };
    expect(bodyViewOf({ body: { day: TODAY, ...said } }, TODAY, 'UTC', onError)).not.toBeNull();
    expect(bodyViewOf({ body: { day: '2026-03-19', ...said } }, TODAY, 'UTC', onError)).toBeNull();
    expect(bodyViewOf(null, TODAY, 'UTC', onError)).toBeNull();
    expect(bodyViewOf({ error: 'not_linked' }, TODAY, 'UTC', onError)).toBeNull();
    expect(errors).toEqual([]);
    expect(bodyViewOf({ rows: [] }, TODAY, 'UTC', onError)).toBeNull();
    expect(errors).toEqual(['health body read answered an unknown shape']);
  });
  it('leaves out a stored piece that is not the contract\'s shape, names it without its content, and keeps the rest', () => {
    const errors: string[] = [];
    const body = view({
      usual: [band('breathing_rate', 13, 14, 15)], changes: [reading('breathing_rate', 'breaths_per_minute', 14, 16.2)],
      components: { recovery: [{ key: 'hrv', state: 'available', score: 'high' }] },
      day_load: { state: 'available', score: 71.5 },
    }, (error) => { errors.push(error.message); })!;
    expect(body.readings).toEqual([{ signal: 'breathing_rate', standing: { state: 'compared', direction: 'above', far: true } }]);
    expect(body.parts).toEqual([]);
    expect(errors).toEqual(['health body read: stored parts is not the contract\'s shape', 'health body read: stored day load is not the contract\'s shape']);
    expect(errors.join(' ')).not.toMatch(/\d/);
  });
});

describe('the words the model is given', () => {
  const material = (body: object): ContextHealthMaterial => ({
    view: {
      authority: 'backend', provenance_refs: ['hpr_0123456789abcdef0123456789abcdef'], destination_eligibility: ['trigger_prompt'], trend: 'steady', freshness: 'fresh',
      confidence_band: 'high', algorithm_version: 'recovery.v5', recovery_zone: 'solid', missing_components: [], body,
    },
    narrative: { recovery_descriptor: 'solid', day_summary: '', active_goals: [], upcoming_high_stakes: [], compiled_at: '2026-03-20T10:00:00.000Z' },
    source: { source_key: 'health-context:2026-03-20', source_kind: 'derived_health_view', scope: 'principal', source_taint: null, produced_at: 0 },
  } as never);
  it('says each standing in words, in the block\'s one paragraph, and no figure but a clock time', () => {
    const text = renderHealth(material({
      readings: [{ signal: 'breathing_rate', standing: { state: 'compared', direction: 'above', far: true } }, { signal: 'spo2', standing: { state: 'forming' } }],
      parts: [{ pillar: 'recovery', key: 'sleep', need_tenths: 8 }, { pillar: 'form', key: 'sleep_midpoint', standing: { state: 'compared', direction: 'earlier' } },
        { pillar: 'form', key: 'movement', standing: { state: 'compared', direction: 'within' }, via: 'steps' }, { pillar: 'load', key: 'calendar', unavailable: 'no_reading' },
        { pillar: 'load', key: 'physical_load', standing: { state: 'compared', direction: 'below' } }],
      day_load: { state: 'compared', direction: 'above', far: true, approximate: true },
      strain_hours: [{ start: '09:00', end: '11:00' }],
    }));
    expect(text).toContain('Against your usual today: breathing rate: far above usual; blood oxygen: usual still forming.');
    expect(text).toContain('Recovery parts today: time asleep: about eight tenths of your need.');
    expect(text).toContain('Form parts today: sleep timing: earlier than usual; steps: within usual.');
    expect(text).toContain('Load parts today: calendar: no reading today; physical load so far today, against whole days: below usual.');
    expect(text).toContain('Day load so far: far above your usual day (candidate, from approximate heart-rate zones).');
    expect(text).toContain('High strain at rest today (candidate): 09:00-11:00.');
    expect(text).toContain('get_crs, where it is offered (among the health tools)');
    expect(text).not.toContain('\n\n');
    expect(text.replace(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/g, '').replace(/recovery\.v5/g, '')).not.toMatch(/\d/);
  });
});

import { parseJsonc } from '../../../scripts/jsonc.mjs';
import { flatConfig } from '../../../scripts/wrangler-vars.mjs';
import config from '../wrangler.jsonc?raw';
// The body read's readings stand on what changed today, so the switch that gives the model its body words is never on where the
// list is not written: there the model would hear the parts and no reading outside them.
describe('HEALTH_BODY_CONTEXT in the Worker config', () => {
  it('is on only where HEALTH_CHANGES is on', () => {
    type Vars = Readonly<Record<string, string>>;
    const parsed = flatConfig(parseJsonc(config)) as { vars: Vars; env: Readonly<Record<string, { vars?: Vars }>> };
    for (const [name, vars] of [['production', parsed.vars], ...Object.entries(parsed.env).map(([env, entry]) => [env, { ...parsed.vars, ...entry.vars }] as const)] as const) {
      if (vars.HEALTH_BODY_CONTEXT === '1') expect(vars.HEALTH_CHANGES, name).toBe('1');
    }
  });
});
