import { describe, expect, it } from 'vitest';
import { healthPartsV1Schema, healthUsualListV1Schema } from '../../contracts/src/app/health-ingest';
import { dailyScoresFor } from '../src/health/scores';
import { goldenProducerCases, producerPayloads } from './support/health-golden';

// What the producer writes of the parts and bands: each behind its own switch, beside the scores and never inside a pillar,
// on today's and yesterday's rows only, and never on a row that does not ask for them. Synthetic owners only.
type Row = Record<string, any> & { day: string };
const rows = async (flag: string | undefined, extra: Parameters<typeof producerPayloads>[2], name = 'apple_mature_with_calendar'): Promise<Row[]> =>
  (await producerPayloads(dailyScoresFor(flag), goldenProducerCases[name]!, extra)).map(payload => JSON.parse(payload) as Row);
const without = ({ components: _components, usual: _usual, ...rest }: Row) => rest;

describe('producer: parts and usual behind their switches', () => {
  it('writes exactly the rows it wrote before with both switches off, and with them absent', async () => {
    const plain = (await producerPayloads(dailyScoresFor('1'), goldenProducerCases.apple_mature_with_calendar!));
    expect(await producerPayloads(dailyScoresFor('1'), goldenProducerCases.apple_mature_with_calendar!, { scoreParts: false, usual: false })).toEqual(plain);
    expect(await producerPayloads(dailyScoresFor('1'), goldenProducerCases.apple_mature_with_calendar!, {})).toEqual(plain);
    expect(plain.join('')).not.toMatch(/"components"|"usual"/);
  });
  it('writes each column only for its own switch, and the rest of every row byte for byte as before', async () => {
    const plain = await rows('1', {});
    const only = (extra: Parameters<typeof producerPayloads>[2]) => rows('1', extra);
    const parts = await only({ scoreParts: true }), usual = await only({ usual: true }), both = await only({ scoreParts: true, usual: true });
    for (const [written, hasParts, hasUsual] of [[parts, true, false], [usual, false, true], [both, true, true]] as const) {
      expect(written.map(without)).toEqual(plain);
      for (const row of written) {
        expect('components' in row, row.day).toBe(hasParts);
        expect('usual' in row, row.day).toBe(hasUsual);
      }
    }
    expect(both.length).toBeGreaterThan(0);
  });
  it('puts them beside the pillars, as the last keys of the row, so a pillar is the object it was', async () => {
    const [plain, both] = [await rows('1', {}), await rows('1', { scoreParts: true, usual: true })];
    for (const [index, row] of both.entries()) {
      expect(row.recovery).toEqual(plain[index]!.recovery);
      expect(row.form).toEqual(plain[index]!.form);
      expect(row.weight).toEqual(plain[index]!.weight);
      expect(Object.keys(row).slice(-2)).toEqual(['components', 'usual']);
      for (const pillar of ['recovery', 'form', 'weight']) expect(JSON.stringify(row[pillar])).not.toMatch(/points|own_share|above_usual/);
    }
  });
  it('writes what the contract reads, for today and for yesterday', async () => {
    const written = await rows('1', { scoreParts: true, usual: true });
    expect(written.map(row => row.day)).toHaveLength(2);
    for (const row of written) {
      expect(healthPartsV1Schema.safeParse(row.components).success, row.day).toBe(true);
      expect(healthUsualListV1Schema.safeParse(row.usual).success, row.day).toBe(true);
      for (const pillar of ['recovery', 'form', 'weight'] as const) {
        const available = !('reason' in row[pillar]);
        expect(row.components?.[pillar] !== undefined, `${row.day} ${pillar}`).toBe(available);
      }
    }
  });
  it('asks the engine for them only when the row asks, and writes none when the earlier engine computed the scores', async () => {
    const earlier = await rows(undefined, { scoreParts: true, usual: true });
    expect(earlier.map(without)).toEqual(earlier);
    for (const row of earlier) expect(Object.keys(row)).not.toEqual(expect.arrayContaining(['components']));
    const plain = await rows(undefined, {});
    expect(earlier).toEqual(plain);
  });
  it('never writes them on a backfilled row, whatever the switches', async () => {
    const written = (await producerPayloads(dailyScoresFor('1'), goldenProducerCases.apple_mature_with_calendar!, { scoreParts: true, usual: true, readHistory: async () => ({ unavailable: 'no_readings' }) })).map(payload => JSON.parse(payload) as Row);
    const late = written.filter(row => row.backfilled === true), live = written.filter(row => row.backfilled === undefined);
    expect(late.length).toBeGreaterThan(5);
    for (const row of late) expect(Object.keys(row), row.day).not.toEqual(expect.arrayContaining(['components']));
    for (const row of late) expect('usual' in row, row.day).toBe(false);
    for (const row of live) expect('components' in row && 'usual' in row, row.day).toBe(true);
  });
  it('writes neither on a day whose pillars are all unavailable', async () => {
    const first = await rows('1', { scoreParts: true, usual: true }, 'whoop_first_night');
    for (const row of first) {
      if (['recovery', 'form', 'weight'].every(pillar => 'reason' in row[pillar])) expect('components' in row || 'usual' in row, row.day).toBe(false);
    }
  });
  it('stays under the writer\'s byte limit for every golden owner, with room to spare for the largest row', async () => {
    for (const name of Object.keys(goldenProducerCases)) for (const row of await rows('1', { scoreParts: true, usual: true }, name)) {
      expect(new TextEncoder().encode(JSON.stringify(row)).length, `${name} ${row.day}`).toBeLessThan(12_000);
    }
  });
  it('writes no value of the owner\'s readings: only scores, shares, bands, directions and counts', async () => {
    const [both] = [await rows('1', { scoreParts: true, usual: true })];
    for (const row of both) {
      expect(Object.keys(row.components)).toEqual(expect.arrayContaining(['recovery']));
      for (const parts of Object.values(row.components) as Record<string, unknown>[][]) for (const part of parts) {
        expect(Object.keys(part).every(key => ['key', 'state', 'reason', 'score', 'share', 'points', 'direction', 'signals', 'baseline', 'need_minutes', 'need_basis'].includes(key))).toBe(true);
      }
      for (const band of row.usual as Record<string, unknown>[]) expect(Object.keys(band).sort()).toEqual(['centre', 'estimator', 'high', 'low', 'method', 'own_days', 'own_share', 'signal', 'state', 'window_days']);
    }
  });
});
