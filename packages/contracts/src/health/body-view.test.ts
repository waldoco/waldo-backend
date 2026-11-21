import { describe, expect, it } from 'vitest';
import { derivedBodySchema, derivedHealthDestinationViewSchema } from './crs';

// The body read's words beside the model's health view: closed words and clock ranges only. Synthetic values only.
const compared = (direction: string, far?: true) => ({ state: 'compared', direction, ...(far ? { far } : {}) });
const body = {
  readings: [{ signal: 'breathing_rate', standing: compared('above', true) }, { signal: 'sleep_midpoint', standing: compared('later') }, { signal: 'spo2', standing: { state: 'forming' } }],
  parts: [
    { pillar: 'recovery', key: 'sleep', need_tenths: 8 },
    { pillar: 'recovery', key: 'hrv', standing: compared('below') },
    { pillar: 'form', key: 'daylight', standing: compared('within') },
    { pillar: 'load', key: 'calendar', unavailable: 'no_reading' },
  ],
  day_load: { state: 'compared', direction: 'above', approximate: true },
  strain_hours: [{ start: '10:00', end: '12:00' }],
};
const view = {
  authority: 'backend', provenance_refs: ['hpr_0123456789abcdef0123456789abcdef'], destination_eligibility: ['trigger_prompt'],
  trend: 'steady', freshness: 'fresh', confidence_band: 'high', algorithm_version: 'recovery.v5', recovery_zone: 'solid', missing_components: [],
};

describe('the body words in the model\'s health view', () => {
  it('admits readings, parts, the day\'s load and strain hours in closed words', () => {
    expect(derivedBodySchema.safeParse(body).success).toBe(true);
    expect(derivedBodySchema.safeParse({ readings: [], parts: [] }).success).toBe(true);
    expect(derivedHealthDestinationViewSchema.safeParse({ ...view, body }).success).toBe(true);
  });
  it.each([
    ['a value', { ...body, readings: [{ signal: 'breathing_rate', standing: compared('above'), value: 16.2 }] }],
    ['a direction outside the words', { ...body, readings: [{ signal: 'breathing_rate', standing: compared('higher') }] }],
    ['far within the band', { ...body, readings: [{ signal: 'breathing_rate', standing: compared('within', true) }] }],
    ['a reading twice', { ...body, readings: [body.readings[0], body.readings[0]] }],
    ['a signal with no band', { ...body, readings: [{ signal: 'body_mass', standing: compared('above') }] }],
    ['a part of another pillar', { ...body, parts: [{ pillar: 'recovery', key: 'daylight', standing: compared('within') }] }],
    ['a need above all of it', { ...body, parts: [{ pillar: 'recovery', key: 'sleep', need_tenths: 11 }] }],
    ['a need for a part that is not sleep', { ...body, parts: [{ pillar: 'recovery', key: 'hrv', need_tenths: 8 }] }],
    ['a part twice', { ...body, parts: [body.parts[1], body.parts[1]] }],
    ['a load score', { ...body, day_load: { state: 'compared', direction: 'above', approximate: true, score: 70 } }],
    ['a strain hour as free text', { ...body, strain_hours: [{ start: 'ten', end: '12:00' }] }],
    ['a strain hour past midnight', { ...body, strain_hours: [{ start: '24:00', end: '01:00' }] }],
  ])('refuses %s', (_label, candidate) => {
    expect(derivedBodySchema.safeParse(candidate).success).toBe(false);
  });
  it('refuses a view whose body is not the contract\'s', () => {
    expect(derivedHealthDestinationViewSchema.safeParse({ ...view, body: { readings: 'breathing up', parts: [] } }).success).toBe(false);
  });
});
