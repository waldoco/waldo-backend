import { describe, expect, it } from 'vitest';
import { computeDailyScores, dailyScoresFor } from '../src/health/scores';
import golden from './fixtures/health-flag-off-golden.json';
import { goldenProducerCases, goldenScoreInputs, producerPayloads } from './support/health-golden';

// The golden was written from the engine and the producer as they stood before provisional scores existed. With the
// switch off, or set to anything but "1", every byte of the scores and of each signed derived-row payload must match it.
describe('provisional scores off: identity with the earlier engine and producer', () => {
  it.each(Object.keys(golden.scores))('scores %s are byte-identical, with the switch absent, false or unset', name => {
    const input = goldenScoreInputs()[name]!;
    const expected = (golden.scores as Record<string, string>)[name]!;
    expect(JSON.stringify(computeDailyScores(input))).toBe(expected);
    expect(JSON.stringify(computeDailyScores({ ...input, provisional: false }))).toBe(expected);
  });

  it.each(Object.keys(golden.rows))('row payloads %s are byte-identical through the default compute and an unset switch', async name => {
    const spec = goldenProducerCases[name]!;
    const expected = (golden.rows as Record<string, string[]>)[name]!;
    expect(await producerPayloads(computeDailyScores, spec)).toEqual(expected);
    for (const flag of [undefined, '', '0', 'true', 'on', ' 1']) expect(await producerPayloads(dailyScoresFor(flag), spec)).toEqual(expected);
  });

  it('only the exact value "1" turns the switch on', () => {
    expect(dailyScoresFor('1')).not.toBe(computeDailyScores);
    for (const flag of [undefined, '', '0', 'true', 'on', ' 1', '01']) expect(dailyScoresFor(flag)).toBe(computeDailyScores);
  });
});
