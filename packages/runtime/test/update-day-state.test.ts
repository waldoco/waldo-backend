import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { CalendarChange, CalendarItem, GoogleClient } from '../src/connectors/google';
import { touchesDay, updateBook, type Change, type UpdateBook } from '../src/channels/update-cards';
import { updateSweepCheck } from '../src/channels/update-sweep';
import { jobBook } from '../src/tasks/jobs';

// The day state: the sweep keeps what each calendar event last looked like, so a change says what it was as well as what it
// is now, and it reads two weeks ahead, so a meeting moved out of the next two days is still seen. With the state off the
// sweep reads as it did before: the next two days, no event read of its own, and nothing kept.
const DAY_MS = 24 * 60 * 60_000;
const T0 = Date.parse('2026-10-20T09:00:00Z');
const SYNC: CalendarItem = { id: 'e-sync', title: 'Sync with Krati', start: '2026-10-20T10:00:00Z', end: '2026-10-20T10:30:00Z', all_day: false, attendees: 3 };
const moved = (over: Partial<CalendarChange>): CalendarChange => ({ ...SYNC, status: 'confirmed', created: '2026-10-01T00:00:00Z', ...over });

type Harness = Readonly<{
  sql: SqlStorage; clock: { at: number }; updates: UpdateBook; listed: CalendarItem[]; changed: CalendarChange[];
  reads: { events: [string, string][]; changed: [number, number, number][] };
  check(dayState: boolean, day?: string): ReturnType<typeof updateSweepCheck>;
  recorded(): Change[][]; seen(): string[];
}>;
let seq = 0;
const withDay = <T,>(work: (h: Harness) => Promise<T>): Promise<T> =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`update-day-state-${seq += 1}`)), async (_instance, state) => {
    const sql = state.storage.sql;
    const clock = { at: T0 };
    let n = 0;
    const jobs = jobBook(sql, { now: () => clock.at, newId: () => (n += 1).toString(16).padStart(12, '0'), newToken: () => `tok-${n += 1}` });
    const updates = updateBook(sql);
    updates.mark('mail_since', T0 - 600_000);
    updates.mark('calendar_since', T0 - 600_000);
    const listed: CalendarItem[] = [], changed: CalendarChange[] = [];
    const reads = { events: [] as [string, string][], changed: [] as [number, number, number][] };
    const google = {
      events: async (from: string, to: string) => { reads.events.push([from, to]); return [...listed]; },
      changedEvents: async (since: number, from: number, to: number) => { reads.changed.push([since, from, to]); return [...changed]; },
      newMail: async () => [],
    } as unknown as GoogleClient;
    const check = (dayState: boolean, day = '2026-10-20') => updateSweepCheck({
      updates, jobs, google, now: clock.at, day, timezone: 'UTC', surface: 'app', sourceFollowups: false, dayState,
      gate: () => 'held_quiet', providerDown: () => false, transaction: w => state.storage.transactionSync(w),
      enqueued: () => undefined, held: () => [], dayChanged: async () => undefined,
    });
    return work({
      sql, clock, updates, listed, changed, reads, check,
      recorded: () => sql.exec<{ changes: string }>('SELECT changes FROM update_cards ORDER BY id').toArray().map(row => JSON.parse(row.changes) as Change[]),
      seen: () => sql.exec<{ event_id: string }>('SELECT event_id FROM calendar_last_seen ORDER BY event_id').toArray().map(row => row.event_id),
    });
  });

describe('the day state: what an event was', () => {
  it('golden: a meeting seen untouched, then moved, carries its earlier times', async () => {
    await withDay(async (h) => {
      h.listed.push(SYNC);
      await h.check(true);
      expect(h.recorded()).toEqual([]);
      h.clock.at += 10 * 60_000;
      h.changed.push(moved({ start: '2026-10-20T15:00:00Z', end: '2026-10-20T15:30:00Z' }));
      await h.check(true);
      const [change] = h.recorded().at(-1)!;
      expect(JSON.parse(change!.detail)).toMatchObject({ start: '2026-10-20T15:00:00Z', end: '2026-10-20T15:30:00Z' });
      expect(change!.before).toEqual({ start: '2026-10-20T10:00:00Z', end: '2026-10-20T10:30:00Z', all_day: false, title_changed: false, attendees: 3 });
    });
  });

  it('reads two weeks ahead and one day back, and seeds what it saw once a day', async () => {
    await withDay(async (h) => {
      await h.check(true);
      expect(h.reads.changed.at(-1)).toEqual([T0 - 600_000, T0 - DAY_MS, T0 + 14 * DAY_MS]);
      expect(h.reads.events).toEqual([[new Date(T0 - DAY_MS).toISOString(), new Date(T0 + 14 * DAY_MS).toISOString()]]);
      h.listed.push(SYNC);
      h.clock.at += 10 * 60_000;
      await h.check(true);
      expect(h.reads.events).toHaveLength(1);
      h.clock.at += DAY_MS;
      await h.check(true, '2026-10-21');
      expect(h.reads.events).toHaveLength(2);
      expect(h.seen()).toEqual(['e-sync']);
    });
  });

  it('with the state off, reads the next two days only, lists no events and keeps nothing', async () => {
    await withDay(async (h) => {
      h.listed.push(SYNC);
      h.changed.push(moved({ start: '2026-10-20T15:00:00Z', end: '2026-10-20T15:30:00Z' }));
      await h.check(false);
      expect(h.reads.changed).toEqual([[T0 - 600_000, T0, T0 + 2 * DAY_MS]]);
      expect(h.reads.events).toEqual([]);
      expect(h.recorded()[0]![0]!.before).toBeUndefined();
      expect(h.sql.exec<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE name = 'calendar_last_seen'").one().n).toBe(1);
      expect(h.seen()).toEqual([]);
    });
  });

  it('a renamed meeting says only that its title changed; a cancelled one keeps the times it had', async () => {
    await withDay(async (h) => {
      h.listed.push(SYNC, { ...SYNC, id: 'e-lunch', title: 'Lunch', start: '2026-10-21T07:00:00Z', end: '2026-10-21T08:00:00Z', attendees: undefined });
      await h.check(true);
      h.clock.at += 10 * 60_000;
      h.changed.push(moved({ title: 'Sync with Krati and Ben' }), { id: 'e-lunch', title: '', start: '', end: '', all_day: false, status: 'cancelled', created: '2026-10-01T00:00:00Z' });
      await h.check(true);
      const [renamed, cancelled] = h.recorded().at(-1)!;
      expect(renamed!.before).toMatchObject({ start: SYNC.start, title_changed: true });
      expect(JSON.stringify(renamed!.before)).not.toContain('Krati');
      expect(cancelled!.kind).toBe('cancelled');
      expect(cancelled!.before).toEqual({ start: '2026-10-21T07:00:00Z', end: '2026-10-21T08:00:00Z', all_day: false, title_changed: false });
      expect(h.seen()).toEqual(['e-sync']);
    });
  });

  it('forgets an event it has not seen for two weeks', async () => {
    await withDay(async (h) => {
      h.listed.push(SYNC);
      await h.check(true);
      h.listed.length = 0;
      h.clock.at += 15 * DAY_MS;
      await h.check(true, '2026-11-04');
      expect(h.seen()).toEqual([]);
    });
  });
});

describe('a change on the owner\'s day', () => {
  const detail = (start: string, end: string) => JSON.stringify({ id: 'e', title: 't', start, end, all_day: false });
  it('touches the day it left as well as the day it moved to', () => {
    const change: Change = { source: 'calendar', kind: 'changed', detail: detail('2026-10-22T10:00:00Z', '2026-10-22T10:30:00Z'),
      before: { start: '2026-10-20T10:00:00Z', end: '2026-10-20T10:30:00Z', all_day: false, title_changed: false } };
    expect(touchesDay(change, '2026-10-20', 'UTC')).toBe(true);
    expect(touchesDay(change, '2026-10-22', 'UTC')).toBe(true);
    expect(touchesDay(change, '2026-10-21', 'UTC')).toBe(false);
  });
});
