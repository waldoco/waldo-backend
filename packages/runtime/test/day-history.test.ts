import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { appControlProjectionV1Schema } from '../../contracts/src/app/controls';
import { HEALTH_TRIGGER_RUN, MAX_RUN_ROWS, NIGHTLY_RUN, recordedRun, runBook } from '../src/channels/background-runs';
import { dayPlanBook } from '../src/channels/day-cards';
import { DAY_HISTORY_SINCE_KEY, dayHistoryDay, dayHistoryList, historyDays, startDayHistory, type DayHistoryDeps } from '../src/channels/day-history';
import { localToEpoch } from '../src/channels/reminders';
import { updateBook } from '../src/channels/update-cards';
import { linkingAppRows } from '../src/channels/proactive-surface';
import type { OutboxRoute } from '../src/channels/delivery-routes';
import type { FinalRecord } from '../src/channels/telegram-final-outbox';
import type { OwnerClock } from '../src/tools/live/get-context';

const TZ = 'Asia/Kolkata';
const at = (local: string, timezone = TZ) => localToEpoch(local, timezone);
const NOW = at('2026-10-28T12:00');

const inOwner = (name: string, check: (state: DurableObjectState) => Promise<void> | void) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => { await check(state); });

const clockAt = (time: { now: number }): OwnerClock => ({ now: () => new Date(time.now), timezone: TZ } as OwnerClock);
let ids = 0;
const depsFor = (state: DurableObjectState, rows: Readonly<Record<string, string>> | null = {}, timezone = TZ, now = NOW) => {
  const time = { now };
  const shown = vi.fn(async () => rows === null ? null : new Map(Object.entries(rows)));
  const deps: DayHistoryDeps = {
    book: dayPlanBook(state.storage.sql), updates: updateBook(state.storage.sql), kv: state.storage.kv, timezone, now,
    runs: runBook(state.storage.sql, clockAt(time), () => String((ids += 1))), shown,
  };
  return { deps, shown, time };
};
const asProjection = (data: unknown) => appControlProjectionV1Schema.parse({ version: 1, state: 'available', revision: 'f'.repeat(64), view: 'days', data });

describe('day_plan keeps each day\'s delivery', () => {
  it('adds the pointer columns to a table written before them, and keeps the rows', async () => {
    await inOwner('history-plan-migrate', state => {
      state.storage.sql.exec(`CREATE TABLE day_plan (day TEXT NOT NULL, card TEXT NOT NULL, time TEXT, reason TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, card))`);
      state.storage.sql.exec(`INSERT INTO day_plan (day, card, time, reason, sent) VALUES ('2026-10-20', 'card:brief', '08:00', 'planned', 1)`);
      const book = dayPlanBook(state.storage.sql);
      expect(book.read('2026-10-20')).toEqual([{ card: 'card:brief', time: '08:00', reason: 'planned', sent: true }]);
      expect(book.deliveries('2026-10-20').size).toBe(0);
      dayPlanBook(state.storage.sql);
    });
  });

  it('records a delivery before the plan row exists, leaves the card unfinished, and a Try again replaces it', async () => {
    await inOwner('history-plan-delivered', state => {
      const book = dayPlanBook(state.storage.sql);
      book.delivered('2026-10-28', 'card:brief', 'row-1', 100);
      expect(book.read('2026-10-28')).toEqual([{ card: 'card:brief', time: null, reason: 'sent', sent: false, state: 'pending' }]);
      book.sent('2026-10-28', 'card:brief');
      book.delivered('2026-10-28', 'card:brief', 'row-2', 200);
      book.skipped('2026-10-28', 'card:brief');
      expect(book.read('2026-10-28')[0]?.state).toBe('sent');
      expect([...book.deliveries('2026-10-28')]).toEqual([['card:brief', { message_id: 'row-2', delivered_at: 200 }]]);
      expect(book.deliveries('2026-10-27').size).toBe(0);
    });
  });
});

describe('update cards keep when they were delivered and their app row', () => {
  it('lists a day\'s delivered cards newest first; an undelivered one and an older table\'s rows are not listed', async () => {
    await inOwner('history-updates', state => {
      state.storage.sql.exec(`CREATE TABLE update_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, changes TEXT NOT NULL, text TEXT, pushed INTEGER NOT NULL DEFAULT 0, folded INTEGER NOT NULL DEFAULT 0)`);
      state.storage.sql.exec(`INSERT INTO update_cards (at, day, changes, text, pushed) VALUES (1, '2026-10-28', '[]', 'old', 1)`);
      const updates = updateBook(state.storage.sql);
      const first = updates.record('2026-10-28', 10, [], null), second = updates.record('2026-10-28', 20, [], null), unsent = updates.record('2026-10-28', 30, [], null);
      updates.pushed(first, 'first', 110);
      updates.linked(first, 'row-a');
      updates.pushed(second, 'second', 120);
      expect(updates.delivered('2026-10-28')).toEqual([{ app_row: null, delivered_at: 120 }, { app_row: 'row-a', delivered_at: 110 }]);
      expect(unsent).toBeGreaterThan(second);
      expect(updates.delivered('2026-10-27')).toEqual([]);
    });
  });
});

describe('an app route links the Main chat row each card became', () => {
  it('links a delivered update card and a day card, and nothing for a held send or a send with no app row', () => {
    const acks: unknown[] = ['delivered', 'held', 'delivered'];
    const route = { receipt: () => acks.shift() } as unknown as OutboxRoute;
    const card = vi.fn(), update = vi.fn();
    const linked = linkingAppRows(route, { card, update });
    const record = (extra: Partial<FinalRecord>) => ({ payload: { chat_id: 1, text: 'x' }, ...extra }) as FinalRecord;
    linked.receipt!({ app_row_id: 'row-u' }, record({ update: { recordId: 4 } }));
    linked.receipt!({ app_row_id: 'row-held' }, record({ update: { recordId: 5 } }));
    linked.receipt!({}, record({ dayCard: { day: '2026-10-28', card: 'card:brief', foldUpTo: 1 } }));
    expect(update.mock.calls).toEqual([[4, 'row-u']]);
    expect(card).not.toHaveBeenCalled();
    acks.push('delivered');
    linked.receipt!({ app_row_id: 'row-c' }, record({ dayCard: { day: '2026-10-28', card: 'card:brief', foldUpTo: 1 } }));
    expect(card.mock.calls).toEqual([[{ day: '2026-10-28', card: 'card:brief', foldUpTo: 1 }, 'row-c']]);
  });
});

describe('runBook.between', () => {
  it('lists the runs started in [from, to) oldest first, at most limit, and counts them all', async () => {
    await inOwner('history-runs-between', state => {
      const time = { now: 1_000 };
      const runs = runBook(state.storage.sql, clockAt(time), () => String((ids += 1)));
      for (const started of [1_000, 2_000, 3_000, 4_000]) { time.now = started; runs.start('heartbeat', null); }
      const window = runs.between(2_000, 4_000, 1);
      expect(window.rows.map(run => run.started_at)).toEqual([2_000]);
      expect([window.total, window.complete]).toEqual([2, true]);
      expect(runs.between(5_000, 6_000, 10)).toEqual({ rows: [], total: 0, complete: true });
    });
  });

  it('says a window is incomplete once trimming removed runs after it opened', async () => {
    await inOwner('history-runs-trimmed', state => {
      const time = { now: 0 };
      const runs = runBook(state.storage.sql, clockAt(time), () => String((ids += 1)));
      for (let index = 1; index <= MAX_RUN_ROWS + 1; index += 1) { time.now = index * 1_000; runs.start('heartbeat', null); }
      expect(runs.between(1_000, 3_000, 10)).toMatchObject({ total: 1, complete: false });
      expect(runs.between(2_000, 3_000, 10).complete).toBe(true);
    });
  });

  it('records a scheduled job as one run, settled by its outcome: a pass that did not finish is failed, one that threw is failed and still throws', async () => {
    await inOwner('history-recorded-run', async state => {
      const time = { now: 5_000 };
      const runs = runBook(state.storage.sql, clockAt(time), () => String((ids += 1)));
      for (const outcome of ['done', 'more', 'capped', 'failed'] as const) { time.now += 1; await recordedRun(runs, 'nightly', NIGHTLY_RUN, async () => outcome)({ id: 'nightly-memory' }); }
      time.now += 1;
      await expect(recordedRun(runs, 'nightly', NIGHTLY_RUN, async () => { throw new Error('boom'); })({ id: 'nightly-catch-up' })).rejects.toThrow('boom');
      time.now += 1;
      await recordedRun(runs, 'health_trigger', HEALTH_TRIGGER_RUN, async () => {})({ id: 'health-trigger' });
      expect([...runs.list(10)].reverse().map(run => [run.kind, run.status, run.summary, run.parent_id])).toEqual([
        ['nightly', 'completed', 'memory pass finished', 'nightly-memory'],
        ['nightly', 'completed', 'memory pass read part of the backlog; a catch-up follows', 'nightly-memory'],
        ['nightly', 'completed', 'memory pass stopped at the day\'s limit; the rest waits', 'nightly-memory'],
        ['nightly', 'failed', 'memory pass did not finish; a catch-up follows', 'nightly-memory'],
        ['nightly', 'failed', 'memory pass failed', 'nightly-catch-up'],
        ['health_trigger', 'completed', 'health check ran', 'health-trigger'],
      ]);
    });
  });
});

describe('dayHistory', () => {
  it('lists fourteen local days, today first; a day with no cards has none and reads no chat', async () => {
    await inOwner('history-empty', async state => {
      startDayHistory(state.storage.kv, at('2026-10-20T10:00'));
      const { deps, shown } = depsFor(state);
      const list = await dayHistoryList(deps);
      expect(list.days.map(day => day.date)).toEqual(historyDays(NOW, TZ));
      expect(list.days[0]?.date).toBe('2026-10-28');
      expect(list.days.at(-1)?.date).toBe('2026-10-15');
      expect(list.history_since).toBe('2026-10-20');
      expect(list.days.every(day => day.cards.length === 0 && day.updates_total === 0)).toBe(true);
      expect(list.days.filter(day => day.complete).map(day => day.date)).toEqual(['2026-10-28', '2026-10-27', '2026-10-26', '2026-10-25', '2026-10-24', '2026-10-23', '2026-10-22', '2026-10-21']);
      expect(shown).not.toHaveBeenCalled();
      asProjection(list);
    });
  });

  it('says how each card finished: sent, skipped, unknown, pending today and not_sent before', async () => {
    await inOwner('history-states', async state => {
      startDayHistory(state.storage.kv, 0);
      const { deps } = depsFor(state, { 'row-brief': 'Your morning is clear until noon.' });
      const book = deps.book;
      book.save('2026-10-27', { card: 'card:brief', time: '08:00', reason: 'planned' });
      book.save('2026-10-27', { card: 'card:midday', time: '14:00', reason: 'planned' });
      book.skipped('2026-10-27', 'card:midday');
      state.storage.sql.exec(`INSERT INTO day_plan (day, card, time, reason, sent) VALUES ('2026-10-27', 'card:close', '21:30', 'planned', 1)`);
      book.save('2026-10-28', { card: 'card:brief', time: '08:00', reason: 'planned' });
      book.delivered('2026-10-28', 'card:brief', 'row-brief', at('2026-10-28T08:01'));
      book.sent('2026-10-28', 'card:brief');
      book.save('2026-10-28', { card: 'card:close', time: '21:30', reason: 'planned' });
      const list = await dayHistoryList(deps);
      const states = (date: string) => list.days.find(day => day.date === date)!.cards.map(card => [card.id, card.state]);
      expect(states('2026-10-27')).toEqual([['card:brief', 'not_sent'], ['card:midday', 'skipped'], ['card:close', 'unknown']]);
      expect(states('2026-10-28')).toEqual([['card:brief', 'sent'], ['card:close', 'pending']]);
      expect(list.days[0]!.cards[0]!.latest).toEqual({ message_id: 'row-brief', delivered_at: at('2026-10-28T08:01'), excerpt: 'Your morning is clear until noon.' });
      expect(list.days[0]!.cards[1]!.latest).toBeNull();
      asProjection(list);
    });
  });

  it('names no row for a card whose chat row is gone, and leaves latest out when the chat cannot be read', async () => {
    await inOwner('history-gone', async state => {
      const { deps } = depsFor(state, {});
      deps.book.delivered('2026-10-27', 'card:close', 'row-gone', at('2026-10-27T21:31'));
      expect((await dayHistoryDay(deps, '2026-10-27'))!.cards).toEqual([{ id: 'card:close', name: 'The Close', state: 'sent', latest: null }]);
      const unreadable = depsFor(state, null).deps;
      expect((await dayHistoryDay(unreadable, '2026-10-27'))!.cards).toEqual([{ id: 'card:close', name: 'The Close', state: 'sent' }]);
    });
  });

  it('reads today\'s cards delivered before the deploy from the old one-day pointer', async () => {
    await inOwner('history-legacy', async state => {
      state.storage.kv.put('day_card_delivery_v1', { day: '2026-10-28', cards: { 'card:brief': { message_id: 'row-old', delivered_at: 7 } } });
      const { deps } = depsFor(state, { 'row-old': 'Morning.' });
      expect((await dayHistoryDay(deps, '2026-10-28'))!.cards[0]).toEqual({ id: 'card:brief', name: 'The Brief', state: 'sent', latest: { message_id: 'row-old', delivered_at: 7, excerpt: 'Morning.' } });
      expect((await dayHistoryDay(deps, '2026-10-27'))!.cards).toEqual([]);
    });
  });

  it('reads one day with its delivered update cards and the night before it, from the Close to the Brief', async () => {
    await inOwner('history-day', async state => {
      startDayHistory(state.storage.kv, 0);
      const { deps, time } = depsFor(state, { 'row-close': 'Done today.', 'row-brief': 'Morning.', 'row-update': 'Your 3pm moved to 4pm.' });
      deps.book.delivered('2026-10-26', 'card:close', 'row-close', at('2026-10-26T21:40'));
      deps.book.delivered('2026-10-27', 'card:brief', 'row-brief', at('2026-10-27T07:50'));
      const updates = updateBook(state.storage.sql);
      const linked = updates.record('2026-10-27', 1, [], null), elsewhere = updates.record('2026-10-27', 2, [], null);
      updates.pushed(linked, 'Your 3pm moved to 4pm.', at('2026-10-27T10:00'));
      updates.linked(linked, 'row-update');
      updates.pushed(elsewhere, 'sent on WhatsApp', at('2026-10-27T11:00'));
      const runs = runBook(state.storage.sql, clockAt(time), () => String((ids += 1)));
      for (const local of ['2026-10-26T21:00', '2026-10-27T03:00', '2026-10-27T05:30', '2026-10-27T07:55']) { time.now = at(local); runs.start(local.endsWith('03:00') ? 'nightly' : 'heartbeat', null); }
      const day = (await dayHistoryDay(deps, '2026-10-27'))!;
      expect([day.night.from, day.night.to]).toEqual([at('2026-10-26T21:40'), at('2026-10-27T07:50')]);
      expect(day.night.runs.map(run => [run.kind, run.started_at])).toEqual([['nightly', at('2026-10-27T03:00')], ['heartbeat', at('2026-10-27T05:30')]]);
      expect([day.night.total, day.night.complete, day.complete]).toEqual([2, true, true]);
      expect(day.updates).toEqual({ items: [{ message_id: 'row-update', delivered_at: at('2026-10-27T10:00'), excerpt: 'Your 3pm moved to 4pm.' }], total: 2 });
      expect((await dayHistoryList(deps)).days.find(entry => entry.date === '2026-10-27')!.updates_total).toBe(2);
      asProjection(day);
    });
  });

  it('bounds a night by the planned times when no card went out, and ends today\'s night now', async () => {
    await inOwner('history-night-planned', async state => {
      const early = at('2026-10-28T06:00');
      const { deps } = depsFor(state, {}, TZ, early);
      deps.book.save('2026-10-27', { card: 'card:close', time: '22:15', reason: 'planned' });
      const day = (await dayHistoryDay(deps, '2026-10-28'))!;
      expect([day.night.from, day.night.to]).toEqual([at('2026-10-27T22:15'), early]);
      const yesterday = (await dayHistoryDay(deps, '2026-10-27'))!;
      expect([yesterday.night.from, yesterday.night.to]).toEqual([at('2026-10-26T21:30'), at('2026-10-27T08:00')]);
    });
  });

  it('marks a day and a night incomplete before history began and past run retention, and refuses a date outside the fourteen', async () => {
    await inOwner('history-incomplete', async state => {
      startDayHistory(state.storage.kv, at('2026-10-27T12:00'));
      startDayHistory(state.storage.kv, at('2026-10-28T00:00'));
      expect(state.storage.kv.get(DAY_HISTORY_SINCE_KEY)).toBe(at('2026-10-27T12:00'));
      const { deps, time } = depsFor(state);
      expect((await dayHistoryDay(deps, '2026-10-27'))!.complete).toBe(false);
      const today = (await dayHistoryDay(deps, '2026-10-28'))!;
      expect([today.complete, today.night.complete]).toEqual([true, true]);
      const runs = runBook(state.storage.sql, clockAt(time), () => String((ids += 1)));
      for (let index = 0; index <= MAX_RUN_ROWS; index += 1) { time.now = at('2026-10-28T07:00') + index; runs.start('heartbeat', null); }
      expect((await dayHistoryDay(deps, '2026-10-28'))!.night.complete).toBe(false);
      for (const date of ['2026-10-14', '2026-10-29', '2026-02-30']) expect(await dayHistoryDay(deps, date)).toBeNull();
      expect(await dayHistoryDay(deps, '2026-10-15')).not.toBeNull();
    });
  });

  it('counts days by the calendar across a DST change, and follows a zone change by the dates it kept', async () => {
    await inOwner('history-dst', async state => {
      const zone = 'America/New_York', now = at('2026-11-08T09:00', zone);
      const days = historyDays(now, zone);
      expect(new Set(days).size).toBe(14);
      expect(days.slice(6, 9)).toEqual(['2026-11-02', '2026-11-01', '2026-10-31']);
      startDayHistory(state.storage.kv, 0);
      const { deps } = depsFor(state, {}, zone, now);
      deps.book.save('2026-11-01', { card: 'card:brief', time: '08:00', reason: 'planned' });
      deps.book.save('2026-11-02', { card: 'card:close', time: '21:30', reason: 'planned' });
      deps.book.delivered('2026-11-01', 'card:close', 'row-x', at('2026-11-01T21:30', zone));
      const night = (await dayHistoryDay(deps, '2026-11-02'))!.night;
      expect(night.to - night.from).toBe(at('2026-11-02T08:00', zone) - at('2026-11-01T21:30', zone));
      expect(night.to - night.from).toBe((10 * 60 + 30) * 60_000);
      const moved = depsFor(state, {}, 'Asia/Tokyo', at('2026-11-09T01:00', 'Asia/Tokyo')).deps;
      const list = await dayHistoryList(moved);
      expect(list.today).toBe('2026-11-09');
      expect(list.days.find(day => day.date === '2026-11-01')!.cards.map(card => card.id)).toEqual(['card:brief', 'card:close']);
    });
  });
});
