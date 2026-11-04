import { describe, expect, it } from 'vitest';
import { APP_CONTROLS_DAY_HISTORY_REVISION, APP_DAY_HISTORY_DAYS_V1, APP_NIGHT_RUNS_MAX_V1, appControlProjectionV1Schema, appControlQueryV1Schema } from './controls';
import fixture from './fixtures/day-history.v1.json';

const revision = 'f'.repeat(64);
const projection = (data: unknown) => ({ version: 1, state: 'available', revision, view: 'days', data });
const latest = { message_id: 'scheduled-a1', delivered_at: 1_790_000_000_000, excerpt: 'Your morning is clear until noon.' };
const card = { id: 'card:brief', name: 'The Brief', state: 'sent', latest };
const list = { timezone: 'Asia/Kolkata', today: '2026-10-28', history_since: '2026-10-28', days: [{ date: '2026-10-28', complete: false, cards: [card], updates_total: 0 }] };
const night = { from: 1_789_990_000_000, to: 1_790_000_000_000, complete: true, runs: [{ id: 'bg:abc', kind: 'nightly', status: 'completed', summary: 'memory pass finished', started_at: 1_789_995_000_000, ended_at: 1_789_995_060_000 }], total: 1 };
const day = { timezone: 'Asia/Kolkata', date: '2026-10-28', complete: true, cards: [card], updates: { items: [latest], total: 2 }, night };

describe('controls revision 6: day history', () => {
  it('is revision 6, fourteen days, fifty night runs', () => {
    expect([APP_CONTROLS_DAY_HISTORY_REVISION, APP_DAY_HISTORY_DAYS_V1, APP_NIGHT_RUNS_MAX_V1]).toEqual([6, 14, 50]);
  });

  it('takes date only with view=days, as a calendar day', () => {
    expect(appControlQueryV1Schema.safeParse({ view: 'days' }).success).toBe(true);
    expect(appControlQueryV1Schema.safeParse({ view: 'days', date: '2026-10-28' }).success).toBe(true);
    for (const query of [{ view: 'day', date: '2026-10-28' }, { view: 'days', date: '2026-10-28T08:00' }, { view: 'days', date: '28-10-2026' }, { view: 'days', date: '' }])
      expect(appControlQueryV1Schema.safeParse(query).success).toBe(false);
  });

  it('reads the fourteen-day list and one day, with an empty day and a card whose row is gone', () => {
    expect(appControlProjectionV1Schema.safeParse(projection(list)).success).toBe(true);
    expect(appControlProjectionV1Schema.safeParse(projection({ ...list, history_since: null, days: [] })).success).toBe(true);
    expect(appControlProjectionV1Schema.safeParse(projection(day)).success).toBe(true);
    expect(appControlProjectionV1Schema.safeParse(projection({ ...day, cards: [], updates: { items: [], total: 0 }, night: { ...night, runs: [], total: 0, complete: false } })).success).toBe(true);
    expect(appControlProjectionV1Schema.safeParse(projection({ ...day, cards: [{ ...card, latest: null }, { id: 'card:close', name: 'The Close', state: 'not_sent' }] })).success).toBe(true);
  });

  it('refuses more than fourteen days, more than fifty runs, an unknown state, a count below the items and extra keys', () => {
    const days = Array.from({ length: 15 }, (_, index) => ({ ...list.days[0]!, date: `2026-10-${String(index + 1).padStart(2, '0')}` }));
    const runs = Array.from({ length: 51 }, () => night.runs[0]!);
    for (const data of [
      { ...list, days }, { ...day, night: { ...night, runs, total: 51 } }, { ...day, cards: [{ ...card, state: 'held' }] },
      { ...day, updates: { items: [latest], total: 0 } }, { ...day, night: { ...night, total: 0 } }, { ...day, actions: [] }, { ...list, date: '2026-10-28' },
      { ...day, cards: [{ ...card, latest: { ...latest, excerpt: 'x'.repeat(281) } }] },
    ]) expect(appControlProjectionV1Schema.safeParse(projection(data)).success).toBe(false);
  });

  it('parses every example the app builds against', () => {
    for (const example of [fixture.list, fixture.day, fixture.day_before_history]) expect(appControlProjectionV1Schema.safeParse(example).success).toBe(true);
    for (const query of fixture.queries) expect(appControlQueryV1Schema.safeParse(query).success).toBe(true);
  });
});
