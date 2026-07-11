// Owning ADRs: ADR-0011 (SAFTE-FAST grounding; HRV source confidence + device-priority
// amendments), ADR-0024 (zone descriptors), and ADR-0081 (strict nonnumeric destination view).
// Invariant under test: the Form mix covers exactly the four pillars and sums to 1; per-source
// confidence stays authoritative with Oura above WHOOP and enum order carrying device
// priority; CrsResult stays derived-only (strictObject rejects drifted-in raw sensor fields)
// and its zone always agrees with the band of its score.
// Failure mode caught: silent constant drift — a reweighted pillar, a reordered priority, a
// confidence flip back to WHOOP-over-Oura, a 'peak' Form band, a resized zone band — and
// raw-value leak-in on a persisted, re-derivable shape.
import { describe, expect, it } from 'vitest';
import {
  CRS_FORM_WEIGHTS,
  crsPillarSchema,
  crsResultSchema,
  crsScoreSchema,
  derivedHealthDestinationEligibilitySchema,
  derivedHealthDestinationViewSchema,
  formZoneOf,
  formZoneSchema,
  HRV_SOURCE_CONFIDENCE,
  hrvSourceSchema,
  loadZoneSchema,
  opaqueHealthProvenanceRefSchema,
  pillarBreakdownSchema,
  recoveryZoneSchema,
} from './crs';

const baseBreakdown = { pillar: 'sleep', weight: 0.5, contribution: 36 } as const;

const baseResult = {
  score: 85,
  zone: 'energized',
  computed_at: '2026-07-01T07:00:00Z',
  component_count: 4,
} as const;

const baseDestinationView = {
  authority: 'backend',
  algorithm_version: 'form.safte-fast.v1',
  form_zone: 'energized',
  trend: 'steady',
  freshness: 'fresh',
  missing_components: [],
  confidence_band: 'high',
  provenance_refs: ['hpr_0123456789abcdef0123456789abcdef'],
  destination_eligibility: ['trigger_prompt'],
} as const;

describe('derived health destination view', () => {
  it('accepts only a strict nonnumeric view with explicit destination eligibility', () => {
    expect(derivedHealthDestinationViewSchema.safeParse(baseDestinationView).success).toBe(true);
    expect(
      derivedHealthDestinationViewSchema.safeParse({
        ...baseDestinationView,
        destination_eligibility: [],
      }).success,
    ).toBe(false);
    expect(
      derivedHealthDestinationViewSchema.safeParse({
        ...baseDestinationView,
        form_score: 85,
      }).success,
    ).toBe(false);
  });

  it('pins the explicit destination eligibility vocabulary', () => {
    expect(derivedHealthDestinationEligibilitySchema.options).toEqual([
      'trigger_prompt',
      'volatile_run',
      'r2_today_summary',
      'r2_baselines_summary',
      'runtime_trace',
    ]);
  });

  it('accepts only bounded opaque provenance references', () => {
    expect(
      opaqueHealthProvenanceRefSchema.safeParse('hpr_0123456789abcdef0123456789abcdef')
        .success,
    ).toBe(true);
    expect(opaqueHealthProvenanceRefSchema.safeParse('user_123_oura').success).toBe(false);
    expect(
      derivedHealthDestinationViewSchema.safeParse({
        ...baseDestinationView,
        provenance_refs: [],
      }).success,
    ).toBe(false);
    expect(
      derivedHealthDestinationViewSchema.safeParse({
        ...baseDestinationView,
        provenance_refs: Array.from(
          { length: 5 },
          (_, index) => `hpr_${index.toString(16).padStart(32, '0')}`,
        ),
      }).success,
    ).toBe(false);
  });
});

describe('zone descriptors', () => {
  it("Form/CRS top band is 'energized' — 'peak' fails Form but stays valid for Load", () => {
    expect(formZoneSchema.options).toEqual(['energized', 'steady', 'flagging', 'depleted']);
    expect(formZoneSchema.safeParse('peak').success).toBe(false);
    expect(loadZoneSchema.safeParse('peak').success).toBe(true);
  });

  it('Recovery and Load descriptor tuples are exact, in order', () => {
    expect(recoveryZoneSchema.options).toEqual(['excellent', 'solid', 'mixed', 'compromised']);
    expect(loadZoneSchema.options).toEqual(['light', 'moderate', 'heavy', 'peak']);
  });

  it('formZoneOf maps the ADR band boundaries exactly', () => {
    expect(formZoneOf(100)).toBe('energized');
    expect(formZoneOf(80)).toBe('energized');
    expect(formZoneOf(79)).toBe('steady');
    expect(formZoneOf(60)).toBe('steady');
    expect(formZoneOf(59)).toBe('flagging');
    expect(formZoneOf(40)).toBe('flagging');
    expect(formZoneOf(39)).toBe('depleted');
  });
});

describe('crsScore', () => {
  it('accepts the scale endpoints and rejects either overshoot', () => {
    expect(crsScoreSchema.safeParse(0).success).toBe(true);
    expect(crsScoreSchema.safeParse(100).success).toBe(true);
    expect(crsScoreSchema.safeParse(-1).success).toBe(false);
    expect(crsScoreSchema.safeParse(101).success).toBe(false);
  });
});

describe('crsPillar', () => {
  it('is exactly the four SAFTE-FAST pillars, in mix order', () => {
    expect(crsPillarSchema.options).toEqual(['sleep', 'hrv', 'circadian', 'motion']);
  });

  it('rejects a pillar outside the mix', () => {
    expect(crsPillarSchema.safeParse('nutrition').success).toBe(false);
  });
});

describe('CRS_FORM_WEIGHTS', () => {
  it('pins the ADR-0011 mix verbatim', () => {
    expect(CRS_FORM_WEIGHTS).toEqual({ sleep: 0.5, hrv: 0.35, circadian: 0.075, motion: 0.075 });
  });

  it('keys are exactly the pillar tuple, in order', () => {
    expect(Object.keys(CRS_FORM_WEIGHTS)).toEqual([...crsPillarSchema.options]);
  });

  it('the mix sums to 1', () => {
    const sum = Object.values(CRS_FORM_WEIGHTS).reduce((acc, w) => acc + w, 0);
    expect(sum).toBeCloseTo(1, 15);
  });
});

describe('hrvSource', () => {
  it('is exactly the four sources in confirmed device-priority order Apple > Oura > WHOOP > Samsung', () => {
    expect(hrvSourceSchema.options).toEqual(['apple', 'oura', 'whoop', 'samsung']);
  });

  it("rejects the amendment's 'HealthKit' spelling — resolved to 'apple'", () => {
    expect(hrvSourceSchema.safeParse('healthkit').success).toBe(false);
  });

  it('rejects a source outside the vocabulary', () => {
    expect(hrvSourceSchema.safeParse('garmin').success).toBe(false);
  });
});

describe('HRV_SOURCE_CONFIDENCE', () => {
  it('pins the ADR-0011 amendment confidence table verbatim', () => {
    expect(HRV_SOURCE_CONFIDENCE).toEqual({ apple: 1, oura: 0.85, whoop: 0.8, samsung: 0.6 });
  });

  it('keys are exactly the source tuple, in priority order', () => {
    expect(Object.keys(HRV_SOURCE_CONFIDENCE)).toEqual([...hrvSourceSchema.options]);
  });

  it("Oura outranks WHOOP — the amendment's locked reconciliation", () => {
    expect(HRV_SOURCE_CONFIDENCE.oura).toBeGreaterThan(HRV_SOURCE_CONFIDENCE.whoop);
  });
});

describe('pillarBreakdown', () => {
  it('accepts a weighted contribution', () => {
    expect(pillarBreakdownSchema.safeParse(baseBreakdown).success).toBe(true);
  });

  it('accepts a negative contribution — drag is representable', () => {
    expect(
      pillarBreakdownSchema.safeParse({
        ...baseBreakdown,
        pillar: 'hrv',
        weight: 0.35,
        contribution: -12,
      }).success,
    ).toBe(true);
  });

  it('rejects a weight above 1', () => {
    expect(pillarBreakdownSchema.safeParse({ ...baseBreakdown, weight: 1.1 }).success).toBe(
      false,
    );
  });

  it('rejects a weight that disagrees with the pinned pillar mix', () => {
    expect(pillarBreakdownSchema.safeParse({ ...baseBreakdown, weight: 0.35 }).success).toBe(
      false,
    );
  });

  it('rejects a pillar outside the mix', () => {
    expect(pillarBreakdownSchema.safeParse({ ...baseBreakdown, pillar: 'caffeine' }).success).toBe(
      false,
    );
  });
});

describe('crsResult', () => {
  it('accepts a minimal result without optionals', () => {
    expect(crsResultSchema.safeParse(baseResult).success).toBe(true);
  });

  it('accepts a full result with breakdown, sources, and confidence', () => {
    expect(
      crsResultSchema.safeParse({
        ...baseResult,
        pillar_breakdown: [baseBreakdown, { pillar: 'hrv', weight: 0.35, contribution: -12 }],
        contributing_sources: ['apple', 'oura'],
        hrv_confidence: 0.85,
      }).success,
    ).toBe(true);
  });

  it('rejects a score above 100', () => {
    expect(crsResultSchema.safeParse({ ...baseResult, score: 101 }).success).toBe(false);
  });

  it('rejects a negative score', () => {
    expect(
      crsResultSchema.safeParse({ ...baseResult, score: -1, zone: 'depleted' }).success,
    ).toBe(false);
  });

  it("rejects zone 'peak' — a Load descriptor, never a Form zone", () => {
    expect(crsResultSchema.safeParse({ ...baseResult, zone: 'peak' }).success).toBe(false);
  });

  it('rejects a zone that disagrees with the band of score', () => {
    expect(crsResultSchema.safeParse({ ...baseResult, zone: 'steady' }).success).toBe(false);
  });

  it('rejects a zero component_count', () => {
    expect(crsResultSchema.safeParse({ ...baseResult, component_count: 0 }).success).toBe(false);
  });

  it('rejects an hrv_confidence above 1', () => {
    expect(crsResultSchema.safeParse({ ...baseResult, hrv_confidence: 1.1 }).success).toBe(false);
  });

  it('rejects an epoch number where the branded ISO datetime is required', () => {
    expect(
      crsResultSchema.safeParse({ ...baseResult, computed_at: 1_751_353_200_000 }).success,
    ).toBe(false);
  });

  it('rejects an empty contributing source ID', () => {
    expect(
      crsResultSchema.safeParse({ ...baseResult, contributing_sources: [''] }).success,
    ).toBe(false);
  });

  it('rejects a raw sensor field drifting onto the persisted shape (strictObject lockout)', () => {
    expect(crsResultSchema.safeParse({ ...baseResult, hrv_rmssd: 42 }).success).toBe(false);
  });
});
