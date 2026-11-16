import { describe, expect, it } from 'vitest';
import { produceHealthScores } from '../src/health/producer';
import { dailyScoresFor } from '../src/health/scores';
import { USED_SIGNALS } from '../src/health/scores/types';

// waldo.health_context_write refuses a whole derived row when a pillar's used.signals names anything outside its closed list.
// form.v10 began naming steps without the migration that admits it, and every Health Connect owner's recompute failed as
// invalid_request. The engine's names are typed to USED_SIGNALS, so a new name cannot compile without joining it; these
// tests keep USED_SIGNALS inside the list of the newest migration that defines the writer.

// Vite replaces a literal import.meta.glob call at build time; this package carries no vite client types, hence the directive.
// @ts-expect-error import.meta.glob is provided by vite at test time
const migrations: Record<string, string> = import.meta.glob('../../../supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true });
const [newest, definition] = Object.entries(migrations).filter(([, sql]) => /create or replace function waldo\.health_context_write\(/.test(sql)).sort(([a], [b]) => a.localeCompare(b)).at(-1) ?? ['', ''];
const body = definition.slice(definition.indexOf('function waldo.health_context_write('));
const ADMITTED = [...(/\(s #>> '\{\}'\) not in \(([^)]+)\)/.exec(body)?.[1] ?? '').matchAll(/'([a-z_0-9]+)'/g)].map(match => match[1]!);

// A Galaxy Watch through Health Connect: nights, heart-rate hours and hourly steps, and no movement minutes. Synthetic values.
const TODAY = '2026-11-01', HOUR = 3_600_000;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const at = (day: string, hour: number) => Date.parse(`${day}T00:00:00Z`) + hour * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const hourOf = (day: string, h: number, signal: string, value: number) => ({ day, signal, value, start_at: iso(at(day, h)), end_at: iso(at(day, h) + HOUR), timezone: 'UTC', samsung_writer: true });
const dayOf = (day: string, i: number, lastHour: number) => {
  const night = { day, start_at: iso(at(addDays(day, -1), 23)), end_at: iso(at(day, 6) + HOUR / 2), timezone: 'UTC', samsung_writer: true };
  const hours = Array.from({ length: lastHour + 1 }, (_, h) => h);
  return [
    { ...night, signal: 'sleep_duration', method: 'asleep_duration', value: 435 + ((i * 7) % 21) - 10 },
    { ...night, signal: 'sleep_midpoint', method: 'sleep_midpoint', value: 165 + ((i * 5) % 13) - 6 },
    ...hours.map(h => hourOf(day, h, 'heart_rate_window', h < 7 ? 54 + (h % 3) : 76 + ((h + i) % 5))),
    ...hours.filter(h => h >= 7).map(h => hourOf(day, h, 'steps_window', 400 + 37 * ((h * 13 + i * 7) % 11))),
  ];
};
const samples = Array.from({ length: 25 }, (_, i) => dayOf(addDays(TODAY, -i), i, i === 0 ? 17 : 23)).flat();

// A writer that answers the way the newest waldo.health_context_write does for a pillar's used signals.
const writer = () => {
  const named: string[][] = [];
  const write = async (payload: string) => {
    const row = JSON.parse(payload) as Record<string, { used?: { signals: string[] } }>;
    const used = (['recovery', 'form', 'weight'] as const).flatMap(pillar => (row[pillar]?.used ? [row[pillar]!.used!.signals] : []));
    named.push(...used);
    return used.flat().every(name => ADMITTED.includes(name)) ? { written: true, changed: [] } : { error: 'invalid_request' };
  };
  return { named, write };
};

describe('the signals a score names are ones the derived-row writer admits', () => {
  it('reads the closed list from the newest migration that defines the writer', () => {
    expect(newest).toMatch(/\d{14}_[a-z_0-9]+\.sql$/);
    expect(ADMITTED.length).toBeGreaterThanOrEqual(11);
    expect(new Set(ADMITTED).size).toBe(ADMITTED.length);
  });

  it('keeps every name the score engine can use inside that list', () => {
    expect(USED_SIGNALS.filter(name => !ADMITTED.includes(name))).toEqual([]);
  });

  it('writes a Health Connect owner\'s Form read on steps, so their recompute does not fail', async () => {
    const { named, write } = writer();
    const outcome = await produceHealthScores({
      readSeries: async range => ({ access: 'granted', read_at: iso(at(TODAY, 18)).replace('Z', '000Z'), sources: [{ source: 'health_connect', consent_epoch: 1, truncated: false, samples: samples.filter(s => range.signals.includes(s.signal)) }] }),
      writeContext: write,
      compute: dailyScoresFor('1'),
    }, { now: at(TODAY, 18), timezone: 'UTC' });
    expect(named.flat()).toContain('steps');
    expect(outcome).toBe('written');
  });
});
