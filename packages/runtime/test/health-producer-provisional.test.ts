import { describe, expect, it } from 'vitest';
import { dailyScoresFor } from '../src/health/scores';
import type { DailyScores } from '../src/health/scores/types';
import { goldenProducerCases, producerPayloads, type GoldenProducerCase } from './support/health-golden';

// The derived row the producer writes with provisional scores on: the label and provenance on each available pillar, the
// confidence from coverage and the chosen source, and the sleep debt as its second version. Synthetic owners only.
type Row = Record<string, Record<string, unknown>> & { day: string; basis: { source: string }[] };
const rowsWith = async (spec: GoldenProducerCase, flag: string | undefined): Promise<Row[]> =>
  (await producerPayloads(dailyScoresFor(flag), spec)).map(payload => JSON.parse(payload) as Row);
const rows = (spec: GoldenProducerCase) => rowsWith(spec, '1');
const rowsOff = (spec: GoldenProducerCase) => rowsWith(spec, undefined);
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const SOURCE_CONFIDENCE = { apple: 1, oura: 0.85, whoop: 0.8, health_connect: 0.6, samsung: 0.6 } as const;
const PILLARS = ['recovery', 'form', 'weight'] as const;
// Health Connect is a transport: its readings count as a source's only from Samsung Health.
const writerFor = (source: string): { writer?: 'samsung_health' } => (source === 'health_connect' ? { writer: 'samsung_health' } : {});

describe('provisional rows: pillars', () => {
  it('carry the baseline label and the signals and days each used, in new trailing keys', async () => {
    const written = await rows(goldenProducerCases.apple_mature_with_calendar!);
    expect(written.length).toBeGreaterThan(0);
    for (const row of written) for (const pillar of PILLARS) {
      const p = row[pillar]!;
      if ('reason' in p) { expect(Object.keys(p)).toEqual(['reason']); continue; }
      expect(Object.keys(p)).toEqual(['score', 'zone', 'confidence', 'algorithm_version', 'activation', 'hrv_method', 'baseline', 'used']);
      expect(p.activation).toBe('accepted');
      expect(p.baseline).toMatchObject({ needed: 14 });
      const used = p.used as { signals: string[]; days: string[] };
      expect(Object.keys(used)).toEqual(['signals', 'days']);
      expect(used.signals.every(s => /^[a-z_.]+$/.test(s))).toBe(true);
      expect(used.days.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
    }
    expect(written.find(r => r.recovery!.algorithm_version)!.recovery!.algorithm_version).toBe('recovery.v5');
  });
  it('write confidence as coverage times the confidence of the source the row was computed from', async () => {
    for (const [source, factor] of Object.entries(SOURCE_CONFIDENCE)) {
      const computed = new Map<string, DailyScores>();
      const base = dailyScoresFor('1');
      const payloads = await producerPayloads(input => { const out = base(input); computed.set(input.targetDay, out); return out; }, { nights: 25, source, calendar: true, ...writerFor(source) });
      expect(payloads.length).toBeGreaterThan(0);
      for (const row of payloads.map(payload => JSON.parse(payload) as Row)) {
        expect(row.basis[0]!.source).toBe(source);
        for (const pillar of PILLARS) {
          const stored = row[pillar]!, result = computed.get(row.day)![pillar];
          if (result.state === 'unavailable') { expect(stored).toEqual({ reason: result.reason }); continue; }
          expect(stored.confidence).toBe(round3(result.coverage * factor));
        }
      }
    }
  });
  it('write Recovery\'s full coverage as exactly the source confidence', async () => {
    for (const [source, factor] of Object.entries(SOURCE_CONFIDENCE)) {
      const row = (await rows({ nights: 25, source, calendar: false, ...writerFor(source) })).at(-1)!;
      expect(row.recovery!.confidence).toBe(factor);
      expect((row as unknown as { confidence: number }).confidence).toBe(factor);
    }
  });
  it('write a first-night row from one night of the owner, labelled provisional', async () => {
    const row = (await rows(goldenProducerCases.whoop_first_night!)).at(-1)!;
    expect(row.recovery!.baseline).toEqual({ state: 'provisional', personal_days: 0, needed: 14, prior: 'adults' });
    expect(row.recovery!.algorithm_version).toBe('recovery.v5');
    const off = (await rowsOff(goldenProducerCases.whoop_first_night!)).at(-1)!;
    expect(off.recovery).toEqual({ reason: 'baseline_immature' });
  });
  it('stay well inside the writer\'s size limit', async () => {
    for (const row of await rows(goldenProducerCases.apple_mature_with_calendar!)) expect(new TextEncoder().encode(JSON.stringify(row)).length).toBeLessThan(8192);
  });
});

describe('provisional rows: which sources may be accepted', () => {
  const pillarsOf = (row: Row) => [row.recovery!, row.form!, row.weight!].filter(p => !('reason' in p));
  const captured = async (spec: GoldenProducerCase) => {
    const computed = new Map<string, DailyScores>();
    const base = dailyScoresFor('1');
    const payloads = await producerPayloads(input => { const out = base(input); computed.set(input.targetDay, out); return out; }, spec);
    return { rows: payloads.map(payload => JSON.parse(payload) as Row), computed };
  };
  it('accepts Health Connect readings only when every writer is Samsung Health, at the Samsung confidence', async () => {
    const { rows: written, computed } = await captured({ nights: 25, source: 'health_connect', calendar: true, writer: 'samsung_health' });
    expect(written.length).toBeGreaterThan(0);
    for (const row of written) {
      expect(pillarsOf(row).length).toBeGreaterThan(0);
      for (const pillar of ['recovery', 'form', 'weight'] as const) {
        const stored = row[pillar]!, result = computed.get(row.day)![pillar];
        if (result.state === 'unavailable') continue;
        expect(stored.activation).toBe('accepted');
        expect(stored.confidence).toBe(round3(result.coverage * 0.6));
      }
      expect((row.sleep_debt as { activation: string }).activation).toBe('accepted');
    }
  });
  // A candidate is computed the same, but from a source or writer nothing has validated, so it never reads as more confident
  // than an accepted row from the lowest source: its confidence is its coverage times the lowest source factor.
  it.each([
    ['no Samsung Health writer recorded', {}],
    ['one reading not from Samsung Health among Samsung Health ones', { writer: 'samsung_health', stray: true }],
  ] as const)('computes Health Connect readings from %s the same, but never accepts them', async (_name, extra) => {
    const { rows: written, computed } = await captured({ nights: 25, source: 'health_connect', calendar: true, ...extra });
    const accepted = await captured({ nights: 25, source: 'health_connect', calendar: true, writer: 'samsung_health' });
    expect(written.length).toBeGreaterThan(0);
    for (const row of written) {
      for (const pillar of ['recovery', 'form', 'weight'] as const) {
        const stored = row[pillar]!, result = computed.get(row.day)![pillar];
        if (result.state === 'unavailable') { expect(stored).toEqual({ reason: result.reason }); continue; }
        expect(stored.activation).toBe('candidate_unaccepted');
        expect(stored.confidence).toBe(round3(result.coverage * 0.6));
        expect(stored.baseline).toBeDefined();
        const same = accepted.rows.find(r => r.day === row.day)![pillar]!;
        expect([stored.score, stored.zone, stored.algorithm_version]).toEqual([same.score, same.zone, same.algorithm_version]);
        expect(stored.confidence).toBeLessThanOrEqual(same.confidence as number);
      }
      expect((row.sleep_debt as { activation: string }).activation).toBe('candidate_unaccepted');
    }
  });
  it('does not look at the writer of an Apple, Samsung or WHOOP reading', async () => {
    for (const source of ['apple', 'samsung', 'whoop']) {
      const { rows: written } = await captured({ nights: 25, source, calendar: true });
      for (const row of written) for (const pillar of pillarsOf(row)) expect(pillar.activation).toBe('accepted');
    }
  });
  it('never accepts a source the writer does not know', async () => {
    const { rows: written, computed } = await captured({ nights: 25, source: 'fitbit', calendar: true });
    expect(written.length).toBeGreaterThan(0);
    for (const row of written) for (const name of ['recovery', 'form', 'weight'] as const) {
      const stored = row[name]!, result = computed.get(row.day)![name];
      if (result.state === 'unavailable') continue;
      expect(stored.activation).toBe('candidate_unaccepted');
      expect(stored.confidence).toBe(round3(result.coverage * 0.6));
    }
  });
});

describe('provisional rows: sleep debt', () => {
  it('is written as the second version, accepted, in the shape the app reads', async () => {
    const row = (await rows(goldenProducerCases.apple_mature_with_calendar!)).at(-1)!;
    const debt = row.sleep_debt as Record<string, unknown>;
    expect(debt.algorithm_version).toBe('sleep-debt.v2');
    expect(debt.activation).toBe('accepted');
    expect(['available', 'partial']).toContain(debt.state);
    if (debt.state === 'available') expect(Object.keys(debt)).toEqual(['state', 'debt_minutes', 'need_basis', 'algorithm_version', 'activation']);
    // The need is the owner's own mean shrunk toward eight hours, so the row says so rather than calling it their own average.
    if (debt.state === 'available') expect(debt.need_basis).toBe('blended_average');
  });
});

describe('provisional rows: a confidence that is not a number', () => {
  it('is refused, never written as a null', async () => {
    const base = dailyScoresFor('1');
    const nan = (input: Parameters<typeof base>[0]) => { const out = base(input); return out.recovery.state === 'available' ? { ...out, recovery: { ...out.recovery, coverage: Number.NaN } } : out; };
    const payloads = await producerPayloads(nan, goldenProducerCases.apple_mature_with_calendar!);
    expect(payloads).toEqual([]);
  });
});

describe('provisional rows: what does not change', () => {
  it('keeps the row\'s own keys and their order, adding none at the top level', async () => {
    const on = (await rows(goldenProducerCases.apple_mature_with_calendar!)).at(-1)!;
    const off = (await rowsOff(goldenProducerCases.apple_mature_with_calendar!)).at(-1)!;
    expect(Object.keys(on)).toEqual(Object.keys(off));
  });
});
