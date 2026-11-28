import { describe, expect, it } from 'vitest';
import { healthContextBook } from '../src/channels/health-context';
import { parseSeries, type Series } from '../src/health/producer';
import { whoopScoresView } from '../src/health/providers/whoop-context';

// WHOOP's own scores in the standing block: in words against the owner's own WHOOP days, never a value. Synthetic values only.
const NOW = Date.parse('2026-11-26T09:00:00Z');
const clock = { timezone: 'UTC', now: () => new Date(NOW) };
const dayBack = (n: number) => new Date(NOW - n * 86_400_000).toISOString().slice(0, 10);
const at = (n: number) => ({ day: dayBack(n), start_at: `${dayBack(n + 1)}T23:00:00.000Z`, end_at: `${dayBack(n)}T06:30:00.000Z`, utc_offset_minutes: 0, timezone: 'UTC' });
const recoveries = (today: number, history: number[], calibrating = false) => [
  { ...at(0), signal: 'provider_recovery', value: today, method: 'whoop', provider: { calibrating } },
  ...history.map((value, i) => ({ ...at(i + 1), signal: 'provider_recovery', value, method: 'whoop', provider: { calibrating: false } })),
];
const series = (samples: Record<string, unknown>[]): Series => {
  const parsed = parseSeries({ access: 'granted', read_at: new Date(NOW).toISOString(), sources: [{ source: 'whoop', consent_epoch: 1, truncated: false, samples }] });
  if (parsed.kind !== 'series') throw new Error('fixture');
  return parsed.series;
};
const usual = Array.from({ length: 20 }, (_, i) => 50 + (i % 5) * 2);

describe('WHOOP scores in words', () => {
  it.each([[80, 'above_usual'], [54, 'usual'], [30, 'below_usual']] as const)('places a recovery of %s against the owner\'s own WHOOP days: %s', (today, word) => {
    expect(whoopScoresView(series(recoveries(today, usual)), clock)?.recovery).toEqual({ as_of_day: 'today', freshness: 'fresh', against_usual: word, calibrating: false });
  });
  it('names no usual under fourteen earlier WHOOP days, and carries the calibrating flag', () => {
    expect(whoopScoresView(series(recoveries(80, usual.slice(0, 13), true)), clock)?.recovery).toMatchObject({ against_usual: 'no_usual_yet', calibrating: true });
  });
  it('sets the night against the need WHOOP set for it, and says when that need includes sleep debt', () => {
    const night = (asleep: number, debt: number) => series([
      { ...at(0), signal: 'provider_sleep_need', value: 490, method: 'whoop', provider: { debt_minutes: debt } },
      { ...at(0), signal: 'sleep_duration', value: asleep, method: 'asleep_duration' },
    ]);
    expect(whoopScoresView(night(430, 35), clock)?.sleep).toEqual({ as_of_day: 'today', freshness: 'fresh', against_need: 'short', need_counts_debt: true });
    expect(whoopScoresView(night(495, 0), clock)?.sleep).toMatchObject({ against_need: 'met', need_counts_debt: false });
    // A need with no night of WHOOP's own sleep beside it names nothing.
    expect(whoopScoresView(series([{ ...at(0), signal: 'provider_sleep_need', value: 490, method: 'whoop', provider: {} }]), clock)).toBeNull();
  });
  it('compares the open cycle\'s strain with closed ones only, and ages a reading from yesterday as yesterday\'s', () => {
    const strains = [{ ...at(0), signal: 'provider_day_strain', value: 3, method: 'whoop', provider: { open: true } },
      ...usual.map((value, i) => ({ ...at(i + 1), signal: 'provider_day_strain', value: value / 5, method: 'whoop', provider: { open: false } }))];
    expect(whoopScoresView(series(strains), clock)?.strain).toEqual({ as_of_day: 'today', freshness: 'fresh', against_usual: 'below_usual', open: true });
    expect(whoopScoresView(series(recoveries(54, []).map(r => ({ ...r, ...at(1) }))), clock)?.recovery).toMatchObject({ as_of_day: 'yesterday', freshness: 'fresh' });
  });
  it('gives nothing for an owner without WHOOP', () => {
    const parsed = parseSeries({ access: 'granted', read_at: new Date(NOW).toISOString(), sources: [{ source: 'apple', consent_epoch: 1, truncated: false, samples: recoveries(61, usual) }] });
    expect(parsed.kind === 'series' && whoopScoresView(parsed.series, clock)).toBeNull();
  });
});

describe('the WHOOP scores read', () => {
  const inventory = (signals: string[], source = 'whoop') => ({ sources: [{ source, kinds: signals.map(signal => ({ signal, newest_at: new Date(NOW - 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'), days: 20 })) }] });
  const book = (answers: Record<string, unknown>) => {
    const asked: string[] = [];
    const errors: unknown[] = [];
    const call = async (fn: string, _message: string, args: Record<string, string | number>) => {
      asked.push(fn === 'health_series_read' ? `${fn} ${args.p_payload}` : fn);
      const answer = answers[fn];
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new Error(`unexpected rpc ${fn}`);
      return answer;
    };
    return { asked, errors, book: healthContextBook(call, 'owner-w', clock, error => errors.push(error), undefined, { partial: true, inventory: true }) };
  };
  it('reads WHOOP\'s kinds for the last thirty days only when the inventory shows WHOOP\'s own scores', async () => {
    const whoop = book({ health_context_read: null, health_inventory_read: inventory(['provider_recovery', 'sleep_duration']), health_series_read: { access: 'granted', read_at: new Date(NOW).toISOString(), sources: [{ source: 'whoop', consent_epoch: 1, truncated: false, samples: recoveries(80, usual) }] } });
    const material = await whoop.book.latest();
    expect(material !== null && material !== 'unreadable' && material.view.whoop).toEqual({ recovery: { as_of_day: 'today', freshness: 'fresh', against_usual: 'above_usual', calibrating: false } });
    expect(whoop.asked).toContain(`health_series_read ${JSON.stringify({ from: dayBack(29), to: dayBack(0), signals: ['provider_recovery', 'provider_day_strain', 'provider_sleep_need', 'sleep_duration', 'workout'] })}`);
    for (const answers of [{ health_inventory_read: inventory(['sleep_duration', 'overnight_hrv']) }, { health_inventory_read: inventory(['provider_recovery'], 'apple') }]) {
      const other = book({ health_context_read: null, ...answers });
      await other.book.latest();
      expect(other.asked.some(fn => fn.startsWith('health_series_read'))).toBe(false);
    }
  });
  it('keeps the block, without WHOOP\'s line, when that read fails, and says so in the read errors', async () => {
    const failing = book({ health_context_read: null, health_inventory_read: inventory(['provider_recovery']), health_series_read: new Error('plane away') });
    const material = await failing.book.latest();
    expect(material !== null && material !== 'unreadable' && 'inventory' in material.view && material.view.inventory).toHaveLength(1);
    expect(material !== null && material !== 'unreadable' && material.view.whoop).toBeUndefined();
    expect(String(failing.errors[0])).toMatch(/whoop scores read failed/);
  });
});
