import type { SanitiseInput } from '@waldo/contracts';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sanitise } from '../src/scribe/sanitiser';
// @ts-ignore Vitest bundles the checked-in synthetic corpus as JSON.
import calibrationBenignFixture from './fixtures/scribe-injection/calibration-benign.json';
// @ts-ignore Vitest bundles the checked-in synthetic corpus as JSON.
import calibrationHostileFixture from './fixtures/scribe-injection/calibration-hostile.json';
// @ts-ignore Vitest bundles the checked-in synthetic corpus as JSON.
import heldOutBenignFixture from './fixtures/scribe-injection/held-out-benign.json';
// @ts-ignore Vitest bundles the checked-in synthetic corpus as JSON.
import heldOutHostileFixture from './fixtures/scribe-injection/held-out-hostile.json';
// @ts-ignore Vitest bundles the checked-in synthetic corpus as JSON.
import manifestFixture from './fixtures/scribe-injection/manifest.json';

const CANARIES = ['1111111111111111', '2222222222222222', '3333333333333333'];
const RUNS = 300;

type GuardDecision = 'allow' | 'review' | 'block';

interface InjectionFixture {
  id: string;
  input: string;
  expected: GuardDecision;
}

interface InjectionFixtureSet {
  partition: 'calibration' | 'heldOut';
  kind: 'hostile' | 'benign';
  cases: InjectionFixture[];
}

interface InjectionFixtureManifest {
  schemaVersion: number;
  source: {
    url: string;
    license: string;
    noCopyConclusion: string;
  };
  syntheticDerivation: string;
  seed: string;
  partitions: {
    calibration: Record<'hostile' | 'benign', { file: string; caseIds: string[] }>;
    heldOut: Record<'hostile' | 'benign', { file: string; caseIds: string[] }>;
  };
}

const corpusManifest = manifestFixture as InjectionFixtureManifest;
const calibrationHostile = calibrationHostileFixture as InjectionFixtureSet;
const calibrationBenign = calibrationBenignFixture as InjectionFixtureSet;
const heldOutHostile = heldOutHostileFixture as InjectionFixtureSet;
const heldOutBenign = heldOutBenignFixture as InjectionFixtureSet;
const corpusSets = [
  {
    partition: 'calibration' as const,
    kind: 'hostile' as const,
    file: 'calibration-hostile.json',
    expectedCount: 80,
    fixture: calibrationHostile,
  },
  {
    partition: 'calibration' as const,
    kind: 'benign' as const,
    file: 'calibration-benign.json',
    expectedCount: 50,
    fixture: calibrationBenign,
  },
  {
    partition: 'heldOut' as const,
    kind: 'hostile' as const,
    file: 'held-out-hostile.json',
    expectedCount: 20,
    fixture: heldOutHostile,
  },
  {
    partition: 'heldOut' as const,
    kind: 'benign' as const,
    file: 'held-out-benign.json',
    expectedCount: 50,
    fixture: heldOutBenign,
  },
] as const;

function normaliseFixtureInput(input: string): string {
  return input.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

const metricArbitrary = fc.constantFrom(
  'hrv',
  'heart_rate',
  'resting-heart-rate',
  'spo2',
  'blood_pressure',
  'bodyWeightKg',
  'sleep_minutes',
  'crs',
  'recovery_score',
  'steps',
  'motion',
  'circadian',
  'sleep_stage',
  'sleep_efficiency',
  'body_temperature',
  'respiratory_rate',
  'glucose',
  'provider_payload',
);
const unitArbitrary = fc.constantFrom('ms', 'bpm', '%', 'mmHg', 'kg', 'minutes');
const numericArbitrary = fc.integer({ min: 1, max: 240 });
const categoricalHealthArbitrary = fc.tuple(
  fc.constantFrom('motion', 'circadian', 'sleep_stage'),
  fc.stringMatching(/^[a-z]{1,12}(?:[-_][a-z]{1,12})?$/),
);

function inspect(payload: SanitiseInput['payload']) {
  return sanitise({
    payload,
    destination: 'internal_context',
    canary_tokens: CANARIES,
    source_taint: null,
  });
}

function inspectExternal(payload: SanitiseInput['payload']) {
  return sanitise({
    payload,
    destination: 'internal_context',
    canary_tokens: CANARIES,
    source_taint: 'external',
  });
}

function unicodeEscape(text: string): string {
  return [...text]
    .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .join('');
}

function percentEscape(text: string): string {
  return [...text]
    .map((character) => `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .join('');
}

function wrapAtDepth(value: SanitiseInput['payload'], depth: number): SanitiseInput['payload'] {
  let wrapped = value;
  for (let index = 0; index < depth; index += 1) {
    wrapped = index % 2 === 0 ? { context: wrapped } : ['safe', wrapped];
  }
  return wrapped;
}

describe('Scribe sanitiser properties', () => {
  it('denies generated health aliases in nested structured keys and values', () => {
    fc.assert(
      fc.property(
        metricArbitrary,
        numericArbitrary,
        fc.integer({ min: 0, max: 6 }),
        fc.boolean(),
        (metric, value, depth, useKey) => {
          const hostile = useKey
            ? { [metric]: value }
            : { metric, measurement: value };
          expect(inspectExternal(wrapAtDepth(hostile, depth))).toMatchObject({
            ok: false,
            check: 'health_value',
            reason: 'health_value_leak',
          });
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('denies encoded health discriminators with arbitrary numeric sibling keys', () => {
    fc.assert(
      fc.property(
        metricArbitrary,
        numericArbitrary,
        fc.stringMatching(/^[a-z]{1,12}$/).filter((key) => key !== 'metric'),
        fc.integer({ min: 0, max: 6 }),
        fc.constantFrom('plain', 'percent', 'base64', 'unicode'),
        (metric, value, numericKey, depth, encoding) => {
          const encoded = (() => {
            switch (encoding) {
              case 'plain':
                return metric;
              case 'percent':
                return percentEscape(metric);
              case 'base64':
                return btoa(metric);
              case 'unicode':
                return unicodeEscape(metric);
            }
          })();
          expect(inspectExternal(wrapAtDepth({ metric: encoded, [numericKey]: value }, depth))).toMatchObject({
            ok: false,
            check: 'health_value',
            reason: 'health_value_leak',
          });
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('denies generated encoded numeric siblings, encoded health keys, and split correlations', () => {
    fc.assert(
      fc.property(
        metricArbitrary,
        numericArbitrary,
        fc.stringMatching(/^[a-z]{1,12}$/).filter((key) => key !== 'metric'),
        fc.integer({ min: 0, max: 6 }),
        fc.constantFrom('percent', 'base64', 'unicode'),
        fc.constantFrom('numeric', 'key', 'split'),
        (metric, value, numericKey, depth, encoding, shape) => {
          const encode = (text: string): string => {
            switch (encoding) {
              case 'percent':
                return percentEscape(text);
              case 'base64':
                return btoa(text);
              case 'unicode':
                return unicodeEscape(text);
            }
          };
          const encodedMetric = encode(metric);
          const encodedNumeric = encode(String(value));
          const hostile = (() => {
            switch (shape) {
              case 'numeric':
                return { metric, [numericKey]: encodedNumeric };
              case 'key':
                return { [encodedMetric]: value };
              case 'split':
                return [{ metric: encodedMetric }, { [numericKey]: encodedNumeric }];
            }
          })();
          expect(inspectExternal(wrapAtDepth(hostile, depth))).toMatchObject({
            ok: false,
            check: 'health_value',
            reason: 'health_value_leak',
          });
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('denies generated numeric health aliases with semantic measurement suffixes', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('hrv', 'heart_rate', 'spo2'),
        fc.constantFrom('reading', 'value', 'sample', 'datum'),
        numericArbitrary,
        fc.integer({ min: 0, max: 6 }),
        (metric, suffix, value, depth) => {
          expect(inspectExternal(wrapAtDepth({ [`${metric}_${suffix}`]: value }, depth))).toMatchObject({
            ok: false,
            check: 'health_value',
            reason: 'health_value_leak',
          });
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('denies generated quoted scientific health values', () => {
    fc.assert(
      fc.property(
        metricArbitrary,
        numericArbitrary,
        fc.integer({ min: 0, max: 6 }),
        (metric, value, depth) => {
          for (const scientific of [`+${value}.5e1`, '.58e2', `-${value}E-1`]) {
            for (const hostile of [
              { [metric]: scientific },
              { metric, measurement: scientific },
            ]) {
              expect(inspectExternal(wrapAtDepth(hostile, depth))).toMatchObject({
                ok: false,
                check: 'health_value',
                reason: 'health_value_leak',
              });
            }
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('denies generated signed scientific health text across encodings', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('hrv', 'heart_rate', 'spo2', 'steps', 'glucose'),
        fc.constantFrom('+.58e2', '-.58E+2', '+5.8e1'),
        fc.integer({ min: 0, max: 4 }),
        fc.constantFrom('text', 'percent', 'base64', 'unicode'),
        (metric, scientific, depth, encoding) => {
          const text = `${metric}: ${scientific}`;
          const encoded = (() => {
            switch (encoding) {
              case 'text':
                return text;
              case 'percent':
                return percentEscape(text);
              case 'base64':
                return btoa(text);
              case 'unicode':
                return unicodeEscape(text);
            }
          })();
          // Owner decision 2026-09-28 (direction A): free-text scans pin at provider-payload
          // taint; owner/model conversation at null taint may carry these at the conversation
          // destinations.
          const result = inspectExternal(wrapAtDepth(encoded, depth));
          if (encoding === 'text') {
            if (depth === 0) {
              expect(result).toMatchObject({ ok: false, check: 'size_cap', reason: 'invalid_payload' });
            } else {
              expect(result).toMatchObject({ ok: true, redactions: [{ kind: 'health_value' }] });
              if (result.ok) expect(JSON.stringify(result.payload)).toContain('[health value withheld]');
            }
          } else {
            expect(result).toMatchObject({ ok: false, check: 'health_value', reason: 'health_value_leak' });
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('denies generated free text, CSV, JSON, percent, Base64, and Unicode-escape forms', () => {
    fc.assert(
      fc.property(
        metricArbitrary,
        numericArbitrary,
        unitArbitrary,
        fc.integer({ min: 0, max: 4 }),
        fc.constantFrom('text', 'csv', 'json', 'percent', 'base64', 'unicode'),
        (metric, value, unit, depth, encoding) => {
          const textMetric = metric === 'bodyWeightKg' ? 'body_weight' : metric;
          const text = `${textMetric}: ${value} ${unit}`;
          const encoded = (() => {
            switch (encoding) {
              case 'text':
                return text;
              case 'csv':
                return `${textMetric},${value},${unit}`;
              case 'json':
                return JSON.stringify({ [metric]: value, unit });
              case 'percent':
                return percentEscape(text);
              case 'base64':
                return btoa(text);
              case 'unicode':
                return unicodeEscape(text);
            }
          })();
          const result = inspectExternal(wrapAtDepth(encoded, depth));
          if (encoding === 'text' || encoding === 'csv') {
            if (depth === 0) {
              expect(result).toMatchObject({ ok: false, check: 'size_cap', reason: 'invalid_payload' });
            } else {
              expect(result).toMatchObject({ ok: true, redactions: [{ kind: 'health_value' }] });
              if (result.ok) expect(JSON.stringify(result.payload)).toContain('[health value withheld]');
            }
          } else {
            expect(result).toMatchObject({ ok: false, check: 'health_value', reason: 'health_value_leak' });
          }
          // Nested-JSON free text is parsed and still denied as structured correlation at any taint.
          if (encoding === 'json') {
            expect(inspectExternal(wrapAtDepth(encoded, depth))).toMatchObject({
              ok: false,
              check: 'health_value',
              reason: 'health_value_leak',
            });
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('allows owner conversation health text at null taint (owner decision 2026-09-28, direction A)', () => {
    fc.assert(
      fc.property(
        metricArbitrary,
        numericArbitrary,
        unitArbitrary,
        fc.integer({ min: 0, max: 4 }),
        (metric, value, unit, depth) => {
          const textMetric = metric === 'bodyWeightKg' ? 'body_weight' : metric;
          const sentence = `owner said their ${textMetric} was ${value} ${unit} last night`;
          expect(inspect(wrapAtDepth({ note: sentence }, depth))).toMatchObject({ ok: true });
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('allows generated ordinary numbers when no health indicator is present', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: 0, max: 6 }),
        (value, depth) => {
          expect(
            inspect(wrapAtDepth({ count: value, item_index: Math.abs(value) }, depth)),
          ).toMatchObject({ ok: true });
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('denies generated categorical health in structured and encoded forms', () => {
    fc.assert(
      fc.property(
        categoricalHealthArbitrary,
        fc.integer({ min: 0, max: 6 }),
        fc.constantFrom('text', 'percent', 'base64', 'unicode'),
        fc.constantFrom(':', '=', ',', ' is ', ' was '),
        ([metric, value], depth, encoding, separator) => {
          const textMetric = metric === 'circadian' ? 'circadian rhythm' : metric;
          const text = `${textMetric}${separator}${value}`;
          const encoded = (() => {
            switch (encoding) {
              case 'text':
                return text;
              case 'percent':
                return percentEscape(text);
              case 'base64':
                return btoa(text);
              case 'unicode':
                return unicodeEscape(text);
            }
          })();
          // Structured categorical values stay denied at every taint; the free-text/encoded
          // form pins at provider-payload taint (owner decision 2026-09-28, direction A).
          expect(inspectExternal(wrapAtDepth({ [metric]: value }, depth))).toMatchObject({
            ok: false,
            check: 'health_value',
            reason: 'health_value_leak',
          });
          const result = inspectExternal(wrapAtDepth(encoded, depth));
          if (encoding === 'text') {
            if (depth === 0) {
              expect(result).toMatchObject({ ok: false, check: 'size_cap', reason: 'invalid_payload' });
            } else {
              expect(result).toMatchObject({ ok: true, redactions: [{ kind: 'health_value' }] });
              if (result.ok) expect(JSON.stringify(result.payload)).toContain('[health value withheld]');
            }
          } else {
            expect(result).toMatchObject({ ok: false, check: 'health_value', reason: 'health_value_leak' });
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('denies generated raw sample envelopes with health units', () => {
    fc.assert(
      fc.property(
        numericArbitrary,
        fc.oneof(unitArbitrary, fc.constantFrom('°C', '°F', 'steps')),
        fc.integer({ min: 0, max: 6 }),
        fc.constantFrom('array', 'object', 'map'),
        (value, unit, depth, shape) => {
          const sample = { timestamp: '2026-07-11T00:00:00.000Z', datum: value, unit };
          const hostile = {
            samples:
              shape === 'array'
                ? [sample]
                : shape === 'map'
                  ? { '2026-07-11T00:00:00.000Z': sample }
                  : sample,
          };
          expect(inspectExternal(wrapAtDepth(hostile, depth))).toMatchObject({
            ok: false,
            check: 'health_value',
            reason: 'health_value_leak',
          });
        },
      ),
      { numRuns: RUNS },
    );
  });
});
