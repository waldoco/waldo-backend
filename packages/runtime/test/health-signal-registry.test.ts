import { HEALTH_SCORE_INPUTS, HEALTH_SIGNAL_NAMES, HEALTH_SIGNALS } from '@waldo/contracts';
import { healthSampleV1Schema } from '../../contracts/src/app/health-ingest';
import { describe, expect, it } from 'vitest';
import { SIGNALS as READ_SIGNALS } from '../src/tools/live/health';
import { INGEST_SIGNALS, INGEST_UNITS, SAMPLE_CHECK_SIGNALS, SERIES_READ_SIGNALS, WRITER_USED_SIGNALS } from './support/migration-lists';

// One registry of health signal names (packages/contracts/src/health/signals.ts). Every list elsewhere either types against it
// or is checked here: a kind the phone may send but the database refuses, or a score name the writer refuses, stops uploads or
// scores for every owner who has it, and nothing but a failed write says so.
const sorted = (names: readonly string[]) => [...names].sort();
const contractUnit = new Map(healthSampleV1Schema.options.map(option => [option.shape.signal.value, option.shape.unit.value] as const));

describe('the health signal registry', () => {
  it.each([
    ['health_samples check', SAMPLE_CHECK_SIGNALS],
    ['health_ingest', INGEST_SIGNALS],
    ['health_series_read', SERIES_READ_SIGNALS],
  ])('%s holds exactly the registry\'s kinds', (_list, names) => {
    expect(names.file).toMatch(/^\d{14}_[a-z_0-9]+\.sql$/);
    expect(sorted(names)).toEqual(sorted(HEALTH_SIGNAL_NAMES));
  });

  it('gives each kind the database\'s unit the app contract\'s unit, and a window only to an hourly kind', () => {
    expect(sorted([...INGEST_UNITS.keys()])).toEqual(sorted(HEALTH_SIGNAL_NAMES));
    for (const signal of HEALTH_SIGNAL_NAMES) {
      expect({ signal, unit: INGEST_UNITS.get(signal)?.unit }).toEqual({ signal, unit: contractUnit.get(signal) });
      expect({ signal, windowed: INGEST_UNITS.get(signal)?.windowed }).toEqual({ signal, windowed: HEALTH_SIGNALS[signal].grain === 'hour' });
    }
  });

  it('is what the derived-row writer admits as a score\'s used signals', () => {
    expect(sorted(WRITER_USED_SIGNALS)).toEqual(sorted(Object.keys(HEALTH_SCORE_INPUTS)));
  });

  it('leaves no stored kind the read tool cannot read', () => {
    const readable = new Set(Object.values(READ_SIGNALS).map(spec => spec.stored));
    expect(HEALTH_SIGNAL_NAMES.filter(signal => !readable.has(signal))).toEqual([]);
  });
});
