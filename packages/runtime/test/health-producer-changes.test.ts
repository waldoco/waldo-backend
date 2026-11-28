import { describe, expect, it } from 'vitest';
import { healthChangesV1Schema } from '../../contracts/src/app/health-ingest';
import { dailyScoresFor } from '../src/health/scores';
import { goldenProducerCases, producerPayloads, SYNTHETIC_TARGET, syntheticAddDays } from './support/health-golden';

// What the producer writes of the day's changes: behind its switch, on today's row only, from the same run's yesterday and the
// owner's stored days read once with their parts. Synthetic owners only.
type Row = Record<string, any> & { day: string };
const historyOf = (days: number) => ({
  history: { from: syntheticAddDays(SYNTHETIC_TARGET, -days), to: SYNTHETIC_TARGET, days: Array.from({ length: days }, (_, i) => {
    const day = syntheticAddDays(SYNTHETIC_TARGET, -(days - i)), score = 60 + (i % 2);
    return { day, recovery: { score, zone: 'good', algorithm_version: 'recovery.v5' }, form: { score, zone: 'good', algorithm_version: 'form.v9' }, weight: { score, zone: 'moderate', algorithm_version: 'weight.v3' } };
  }) },
});
const run = async (extra: Parameters<typeof producerPayloads>[2], name = 'apple_mature_with_calendar') => {
  const asked: unknown[][] = [];
  const written = (await producerPayloads(dailyScoresFor('1'), goldenProducerCases[name]!, {
    readHistory: async (...args) => { asked.push(args); return historyOf(20); }, ...extra,
  })).map(payload => JSON.parse(payload) as Row);
  return { written, asked };
};

describe('producer: what changed today', () => {
  it('writes nothing new with the switch off, and every row byte for byte as before', async () => {
    const off = await run({});
    const plain = await run({ changes: false });
    expect(plain.written).toEqual(off.written);
    expect(JSON.stringify(off.written)).not.toContain('"changes"');
    // With the switch off the history read is called exactly as before this list existed: the window alone.
    expect(off.asked.length).toBeGreaterThan(0);
    expect(off.asked.every(args => args.length === 1)).toBe(true);
  });
  it('writes the list on today\'s row only, in the contract\'s shape, and the rest of each row as it was', async () => {
    const off = (await run({})).written, { written, asked } = await run({ changes: true });
    const today = written.find(row => row.day === SYNTHETIC_TARGET)!;
    expect(healthChangesV1Schema.safeParse(today.changes).success).toBe(true);
    expect(today.changes.length).toBeGreaterThan(0);
    expect(written.filter(row => row.day !== SYNTHETIC_TARGET).every(row => !('changes' in row))).toBe(true);
    expect(written.map(({ changes: _changes, ...rest }) => rest)).toEqual(off);
    // The stored days are read once, with their parts, and the backfill reads the same answer.
    expect(asked).toEqual([[90, true]]);
  });
  it('compares today with yesterday from the same run, and judges the moves against the stored days', async () => {
    const { written } = await run({ changes: true });
    const today = written.find(row => row.day === SYNTHETIC_TARGET)!, yesterday = written.find(row => row.day !== SYNTHETIC_TARGET)!;
    const recovery = today.changes.find((change: any) => change.subject.tier === 1 && change.subject.key === 'recovery');
    expect(recovery).toMatchObject({ from: yesterday.recovery.score, to: today.recovery.score, against: 'yesterday' });
  });
  it('writes the readings against their bands when the stored days cannot be read, and no score change is significant', async () => {
    const { written } = await run({ changes: true, readHistory: async () => { throw new Error('down'); } });
    const today = written.find(row => row.day === SYNTHETIC_TARGET)!;
    expect(today.recovery).toBeDefined();
    for (const change of today.changes ?? []) if (change.subject.tier < 3) expect(change.significant).toBe(false);
  });
  it('leaves a first night\'s row without a list rather than an empty one', async () => {
    const { written } = await run({ changes: true }, 'whoop_first_night');
    expect(written.every(row => !('changes' in row) || row.changes.length > 0)).toBe(true);
  });
  it('carries no figure the contract does not, and nothing but its closed words', async () => {
    const { written } = await run({ changes: true });
    const today = written.find(row => row.day === SYNTHETIC_TARGET)!;
    for (const change of today.changes) expect(Object.keys(change).sort()).toEqual(['against', 'from', 'pillar', 'significant', 'subject', 'to', 'unit', 'verdict']);
  });
});
