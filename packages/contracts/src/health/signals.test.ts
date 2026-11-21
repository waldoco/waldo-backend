import { describe, expect, it } from 'vitest';
import { healthUsualSignalV1Schema } from '../app/health-ingest';
import { HEALTH_SIGNALS, HEALTH_SIGNAL_NAMES, HEALTH_USUAL_WORDS } from './signals';

describe('the registry links each kind to the usual band it is judged against', () => {
  const linked = HEALTH_SIGNAL_NAMES.flatMap((signal) => {
    const usual = (HEALTH_SIGNALS[signal] as { usual?: keyof typeof HEALTH_USUAL_WORDS }).usual;
    return usual === undefined ? [] : [[signal, usual] as const];
  });
  it('names each band from at most one kind, and every band but awake time from one', () => {
    const bands = linked.map(([, usual]) => usual);
    expect(new Set(bands).size).toBe(bands.length);
    expect(healthUsualSignalV1Schema.options.filter((usual) => !bands.includes(usual))).toEqual(['awake_time']);
  });
  it('gives each band its kind\'s words, so the two cannot drift', () => {
    for (const [signal, usual] of linked) expect(HEALTH_USUAL_WORDS[usual]).toBe(HEALTH_SIGNALS[signal].words);
    expect(HEALTH_USUAL_WORDS.awake_time).toBe('awake time in the night');
    expect(Object.values(HEALTH_USUAL_WORDS).every((words) => !/\d/.test(words))).toBe(true);
  });
});
