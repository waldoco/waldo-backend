import { describe, expect, it } from 'vitest';
import { dailyScoresFor } from '../src/health/scores';
import type { DailyScores } from '../src/health/scores/types';
import { goldenProducerCases, producerPayloads, type GoldenProducerCase } from './support/health-golden';

// The derived row the producer writes with provisional scores on: the label and provenance on each available pillar, the
// confidence from coverage and the chosen source, and the sleep debt as its second version. Synthetic owners only.
type Row = Record<string, Record<string, unknown>> & { day: string; basis: { source: string }[] };
const rows = async (spec: GoldenProducerCase, flag: string | undefined = '1'): Promise<Row[]> =>
  (await producerPayloads(dailyScoresFor(flag), spec)).map(payload => JSON.parse(payload) as Row);
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const SOURCE_CONFIDENCE = { apple: 1, oura: 0.85, whoop: 0.8, health_connect: 0.6, samsung: 0.6 } as const;
const PILLARS = ['recovery', 'form', 'weight'] as const;

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
      const payloads = await producerPayloads(input => { const out = base(input); computed.set(input.targetDay, out); return out; }, { nights: 25, source, calendar: true });
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
      const row = (await rows({ nights: 25, source, calendar: false })).at(-1)!;
      expect(row.recovery!.confidence).toBe(factor);
      expect((row as unknown as { confidence: number }).confidence).toBe(factor);
    }
  });
  it('write a first-night row from one night of the owner, labelled provisional', async () => {
    const row = (await rows(goldenProducerCases.whoop_first_night!)).at(-1)!;
    expect(row.recovery!.baseline).toEqual({ state: 'provisional', personal_days: 0, needed: 14, prior: 'adults' });
    expect(row.recovery!.algorithm_version).toBe('recovery.v5');
    const off = (await rows(goldenProducerCases.whoop_first_night!, undefined)).at(-1)!;
    expect(off.recovery).toEqual({ reason: 'baseline_immature' });
  });
  it('stay well inside the writer\'s size limit', async () => {
    for (const row of await rows(goldenProducerCases.apple_mature_with_calendar!)) expect(new TextEncoder().encode(JSON.stringify(row)).length).toBeLessThan(8192);
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
    expect(['own_average', 'owner_confirmed']).toContain(debt.need_basis ?? 'own_average');
  });
});

describe('provisional rows: what does not change', () => {
  it('keeps the row\'s own keys and their order, adding none at the top level', async () => {
    const on = (await rows(goldenProducerCases.apple_mature_with_calendar!)).at(-1)!;
    const off = (await rows(goldenProducerCases.apple_mature_with_calendar!, undefined)).at(-1)!;
    expect(Object.keys(on)).toEqual(Object.keys(off));
  });
});
