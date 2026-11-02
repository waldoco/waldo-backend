import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { CalendarChange, CalendarDelta, CalendarDeltaEvent, GoogleClient, MailDelta, MailItem } from '../src/connectors/google';
import { updateBook, type Change, type UpdateBook } from '../src/channels/update-cards';
import { updateSweepCheck } from '../src/channels/update-sweep';
import { jobBook, type JobRow } from '../src/tasks/jobs';

// The update sweep with exact deltas: Gmail history from the stored history id and each read calendar's changes from its
// sync token. Pushes are only hints; the cursors the sweep commits are the truth, written with the record and watermarks.
// Every person, address and event is synthetic.
const T0 = Date.parse('2026-11-03T09:00:00Z');
const DAY = '2026-11-03';
const mailItem = (id: string, subject = `Subject ${id}`): MailItem => ({ id, thread_id: `t-${id}`, from: `Sender <${id}@example.test>`, subject, snippet: `About ${subject}`, at: '2026-11-03T08:59:00Z' });
const event = (id: string, extra: Partial<CalendarDeltaEvent> = {}): CalendarDeltaEvent => ({ id, title: `Event ${id}`, start: '2026-11-04T10:00:00Z', end: '2026-11-04T11:00:00Z', all_day: false,
  etag: `"${id}-1"`, status: 'confirmed', created: '2026-10-01T00:00:00Z', ...extra });

type Fakes = {
  mail: (cursor: string | null) => Promise<MailDelta>;
  calendar: (id: string, token: string | null) => Promise<CalendarDelta>;
  newMail: MailItem[];
  window: Record<string, CalendarChange[] | Error>;
  calls: string[];
};
type Harness = Readonly<{ updates: UpdateBook; fakes: Fakes; storage: DurableObjectStorage; settle(): void;
  check(calendars?: readonly string[]): ReturnType<typeof updateSweepCheck>;
  jobs(): JobRow[]; rows(): Change[][]; cursor(key: string): string | null }>;
let seq = 0;
const h_account = { value: 'conn-1' };
const withDelta = <T,>(work: (h: Harness) => Promise<T>): Promise<T> =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`update-delta-${seq += 1}`)), async (_instance, state) => {
    const sql = state.storage.sql;
    let n = 0;
    const book = jobBook(sql, { now: () => T0, newId: () => (n += 1).toString(16).padStart(12, '0'), newToken: () => `tok-${n += 1}` });
    const updates = updateBook(sql);
    updates.mark('mail_since', T0 - 600_000);
    updates.mark('calendar_since', T0 - 600_000);
    const fakes: Fakes = { calls: [], newMail: [], window: {},
      mail: async () => ({ state: 'delta', history_id: '101', added: [], labels: [], left_out: 0 }),
      calendar: async (_id, token) => ({ state: 'delta', sync_token: `${token}+`, events: [] }) };
    const google = {
      mailDelta: (cursor: string | null) => { fakes.calls.push(`mailDelta:${cursor}`); return fakes.mail(cursor); },
      calendarDelta: (id: string, token: string | null) => { fakes.calls.push(`calendarDelta:${id}:${token}`); return fakes.calendar(id, token); },
      newMail: async () => { fakes.calls.push('newMail'); return [...fakes.newMail]; },
      changedEvents: async () => { throw new Error('the delta path reads calendars one by one'); },
      changedEventsPage: async (id: string) => {
        fakes.calls.push(`window:${id}`);
        const found = fakes.window[id] ?? [];
        if (found instanceof Error) throw found;
        return { events: found, next_page_token: null, fetched_count: found.length, calendar_id: id, account: { connection_id: null, email: null }, observed_at: '' };
      },
    } as unknown as GoogleClient;
    return work({ updates, fakes, storage: state.storage,
      // The judged job settles, so the next tick reads again.
      settle: () => { sql.exec("UPDATE task_jobs SET status = 'applied', settled_at = 1"); },
      check: (calendars = ['primary']) => updateSweepCheck({
        updates, jobs: book, google, now: T0, day: DAY, timezone: 'UTC', surface: 'app', sourceFollowups: false, delta: { calendars, account: h_account.value },
        gate: () => null, providerDown: () => false, transaction: work => state.storage.transactionSync(work),
        enqueued: () => undefined, held: () => [], dayChanged: async () => undefined,
      }),
      jobs: () => sql.exec<JobRow>('SELECT * FROM task_jobs ORDER BY created_at').toArray(),
      rows: () => sql.exec<{ changes: string }>('SELECT changes FROM update_cards ORDER BY id').toArray().map(row => JSON.parse(row.changes) as Change[]),
      cursor: (key) => updates.cursor(key),
    });
  });
const seed = (h: Harness, cursors: Record<string, string>) => h.storage.transactionSync(() => { h.updates.moveCursor('account', h.updates.cursor('account'), h_account.value); for (const [key, value] of Object.entries(cursors)) h.updates.moveCursor(key, h.updates.cursor(key), value); });

describe('exact deltas', () => {
  it('golden: one batch from the mail history and each calendar, recorded with the moved cursors in one write', async () => {
    await withDelta(async (h) => {
      seed(h, { mail: '100', 'cal:primary': 's1', 'cal:team@group.example.test': 't1' });
      h.fakes.mail = async () => ({ state: 'delta', history_id: '140', added: [mailItem('m1')], labels: [], left_out: 2 });
      h.fakes.calendar = async (id) => id === 'primary'
        ? { state: 'delta', sync_token: 's2', events: [event('invite', { invite: true }), event('far', { start: '2027-06-01T10:00:00Z', end: '2027-06-01T11:00:00Z' })] }
        : { state: 'delta', sync_token: 't2', events: [event('weekly', { series: true, start: '2026-01-05T09:00:00Z', end: '2026-01-05T09:30:00Z' }), { ...event('gone'), status: 'cancelled', start: '', end: '' }] };
      const result = await h.check(['primary', 'team@group.example.test']);
      expect(result.code).toBe('enqueued');
      const [changes] = h.rows();
      // The far-off event and the cancellation of an event the owner was never shown are not news; the series is.
      expect(changes!.map(change => [change.source, change.kind, change.ref])).toEqual([
        ['calendar', 'changed', 'event:invite'], ['calendar', 'changed', 'event:weekly'], ['mail', 'new', 'message:m1'], ['mail', 'more', undefined]]);
      expect(JSON.parse(changes![0]!.detail)).toMatchObject({ title: 'Event invite', invite: true });
      expect(JSON.parse(changes![1]!.detail)).toMatchObject({ series: true });
      expect(JSON.parse(changes![3]!.detail)).toEqual({ more_messages: 2 });
      expect([h.cursor('mail'), h.cursor('cal:primary'), h.cursor('cal:team@group.example.test')]).toEqual(['140', 's2', 't2']);
      expect(h.fakes.calls).not.toContain('newMail');
    });
  });

  it('starts every source from a baseline and reports nothing from it', async () => {
    await withDelta(async (h) => {
      h.fakes.mail = async () => ({ state: 'rebased', history_id: '500' });
      h.fakes.calendar = async () => ({ state: 'rebased', sync_token: 'base' });
      expect((await h.check()).code).toBe('unchanged');
      expect([h.cursor('mail'), h.cursor('cal:primary')]).toEqual(['500', 'base']);
      expect(h.fakes.calls).toEqual(['calendarDelta:primary:null', 'window:primary', 'mailDelta:null', 'newMail']);
    });
  });

  it('re-bases a history id Google no longer knows and reads the gap once the older way', async () => {
    await withDelta(async (h) => {
      seed(h, { mail: '1' });
      h.fakes.mail = async () => ({ state: 'rebased', history_id: '900' });
      h.fakes.newMail = [mailItem('gap')];
      expect((await h.check()).code).toBe('enqueued');
      expect(h.rows()[0]!.map(change => change.ref)).toEqual(['message:gap']);
      expect(h.cursor('mail')).toBe('900');
    });
  });

  it('dedupes by message id and by event etag: an overlapping gap read and a second calendar give one change each', async () => {
    await withDelta(async (h) => {
      seed(h, { mail: '100', 'cal:primary': 's1', 'cal:shared': 'x1' });
      h.fakes.mail = async () => ({ state: 'delta', history_id: '110', added: [mailItem('m1')], labels: [], left_out: 0 });
      h.fakes.calendar = async (id) => ({ state: 'delta', sync_token: `${id}-2`, events: [event('same')] });
      await h.check(['primary', 'shared']);
      expect(h.rows()[0]!.map(change => change.ref)).toEqual(['event:same', 'message:m1']);
      h.settle();
      // The mail cursor is lost (re-based) and the gap read finds the same message; the calendar returns the same version.
      h.fakes.mail = async () => ({ state: 'rebased', history_id: '120' });
      h.fakes.newMail = [mailItem('m1')];
      expect((await h.check(['primary', 'shared'])).code).toBe('unchanged');
      expect(h.rows()).toHaveLength(1);
      // A new version of the event is news again.
      h.fakes.calendar = async (id) => ({ state: 'delta', sync_token: `${id}-3`, events: [event('same', { etag: '"same-2"' })] });
      h.fakes.mail = async () => ({ state: 'delta', history_id: '121', added: [], labels: [], left_out: 0 });
      await h.check(['primary', 'shared']);
      expect(h.rows()[1]!.map(change => change.ref)).toEqual(['event:same']);
    });
  });

  it('a read, archive or star of a mail already seen rides along as context but never starts a judgment alone', async () => {
    await withDelta(async (h) => {
      seed(h, { mail: '100' });
      h.fakes.mail = async () => ({ state: 'delta', history_id: '110', added: [mailItem('m1', 'Invoice due')], labels: [], left_out: 0 });
      await h.check();
      expect(h.jobs()).toHaveLength(1);
      h.settle();
      h.fakes.mail = async () => ({ state: 'delta', history_id: '111', added: [], labels: [{ message_id: 'm1', thread_id: 't-m1', change: 'read' }, { message_id: 'never-seen', thread_id: 't-x', change: 'archived' }], left_out: 0 });
      expect((await h.check()).code).toBe('unchanged');
      const read = h.rows()[1]!;
      expect(read.map(change => [change.kind, change.ref])).toEqual([['read', 'message:m1']]);
      expect(JSON.parse(read[0]!.detail)).toMatchObject({ subject: 'Invoice due' });
      expect(h.jobs()).toHaveLength(1);
    });
  });

  it('a delta read that fails falls back to the older read for that source and leaves its cursor where it was', async () => {
    await withDelta(async (h) => {
      seed(h, { mail: '100', 'cal:primary': 's1' });
      h.fakes.mail = async () => { throw new Error('unknown method'); };
      h.fakes.calendar = async () => { throw new Error('unknown method'); };
      h.fakes.newMail = [mailItem('m2')];
      h.fakes.window.primary = [{ ...event('moved'), status: 'confirmed' }];
      expect((await h.check()).code).toBe('enqueued');
      expect(h.rows()[0]!.map(change => change.ref)).toEqual(['event:moved', 'message:m2']);
      expect([h.cursor('mail'), h.cursor('cal:primary')]).toEqual(['100', 's1']);
      expect(h.updates.since('mail_since')).toBe(T0);
    });
  });

  it('one calendar that cannot be read keeps its cursor and does not hold the others back', async () => {
    await withDelta(async (h) => {
      seed(h, { mail: '100', 'cal:primary': 's1', 'cal:gone': 'g1' });
      h.fakes.calendar = async (id) => { if (id === 'gone') throw new Error('google 404'); return { state: 'delta', sync_token: 's2', events: [event('kept')] }; };
      h.fakes.window.gone = new Error('google 404');
      expect((await h.check(['primary', 'gone'])).code).toBe('enqueued');
      expect([h.cursor('cal:primary'), h.cursor('cal:gone')]).toEqual(['s2', 'g1']);
    });
  });

  it('when every calendar read fails the tick fails as before, and nothing moves', async () => {
    await withDelta(async (h) => {
      seed(h, { mail: '100', 'cal:primary': 's1' });
      h.fakes.calendar = async () => { throw new Error('google 503'); };
      h.fakes.window.primary = new Error('google 503');
      await expect(h.check()).rejects.toThrow('google 503');
      expect([h.cursor('mail'), h.cursor('cal:primary'), h.updates.since('calendar_since')]).toEqual(['100', 's1', T0 - 600_000]);
    });
  });

  it('a cursor another read moved meanwhile rolls the whole write back', async () => {
    await withDelta(async (h) => {
      seed(h, { mail: '100' });
      h.fakes.mail = async () => {
        h.storage.transactionSync(() => h.updates.moveCursor('mail', '100', '150'));
        return { state: 'delta', history_id: '140', added: [mailItem('m1')], labels: [], left_out: 0 };
      };
      expect((await h.check()).code).toBe('held_cursor_moved');
      expect(h.rows()).toEqual([]);
      expect(h.cursor('mail')).toBe('150');
      expect(h.updates.since('mail_since')).toBe(T0 - 600_000);
    });
  });

  it('a calendar whose baseline is past the page cap is read the older way and tried again only a day later', async () => {
    await withDelta(async (h) => {
      seed(h, { mail: '100' });
      h.fakes.calendar = async () => ({ state: 'capped' });
      await h.check();
      expect(h.cursor('cal:primary')).toBe(`capped:${T0}`);
      expect(h.fakes.calls.filter(call => call.startsWith('calendarDelta'))).toHaveLength(1);
      expect(h.fakes.calls).toContain('window:primary');
      await h.check();
      expect(h.fakes.calls.filter(call => call.startsWith('calendarDelta')), 'held for a day').toHaveLength(1);
      expect(h.fakes.calls.filter(call => call === 'window:primary')).toHaveLength(2);
    });
  });

  it('cursors belong to one account: another account starts every source from a baseline', async () => {
    await withDelta(async (h) => {
      seed(h, { mail: '100', 'cal:primary': 's1' });
      h_account.value = 'conn-2';
      try {
        h.fakes.mail = async (cursor) => ({ state: 'rebased', history_id: cursor === null ? '7' : 'wrong' });
        h.fakes.calendar = async (_id, token) => ({ state: 'rebased', sync_token: token === null ? 'b2' : 'wrong' });
        expect((await h.check()).code).toBe('unchanged');
        expect([h.cursor('account'), h.cursor('mail'), h.cursor('cal:primary')]).toEqual(['conn-2', '7', 'b2']);
      } finally { h_account.value = 'conn-1'; }
    });
  });
});
