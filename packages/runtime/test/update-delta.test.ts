import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { CalendarChange, CalendarDelta, CalendarDeltaEvent, GoogleClient, MailDelta, MailItem } from '../src/connectors/google';
import { SOURCE_POLL_MS, updateBook, type Change, type UpdateBook } from '../src/channels/update-cards';
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
  newMail: MailItem[] | Error;
  window: Record<string, CalendarChange[] | Error>;
  calls: string[];
};
type Account = Readonly<{ id: string; calendars?: readonly string[]; mail?: boolean }>;
type Harness = Readonly<{ updates: UpdateBook; fakes: Fakes; storage: DurableObjectStorage; settle(): void;
  // Another connected account with its own fakes; the first is 'a1'.
  account(id: string): Fakes;
  check(calendars?: readonly string[] | readonly Account[], options?: Readonly<{ followups?: string }>): ReturnType<typeof updateSweepCheck>;
  // Moves the clock on by one poll, so every source is due again.
  later(ms?: number): number;
  jobs(): JobRow[]; rows(): Change[][]; cursor(key: string): string | null }>;
let seq = 0;
const newFakes = (): Fakes => ({ calls: [], newMail: [], window: {},
  mail: async () => ({ state: 'delta', history_id: '101', added: [], labels: [], left_out: 0 }),
  calendar: async (_id, token) => ({ state: 'delta', sync_token: `${token}+`, events: [] }) });
const fakeClient = (fakes: Fakes) => ({
  mailDelta: (cursor: string | null) => { fakes.calls.push(`mailDelta:${cursor}`); return fakes.mail(cursor); },
  calendarDelta: (id: string, token: string | null) => { fakes.calls.push(`calendarDelta:${id}:${token}`); return fakes.calendar(id, token); },
  newMail: async () => { fakes.calls.push('newMail'); if (fakes.newMail instanceof Error) throw fakes.newMail; return [...fakes.newMail]; },
  changedEvents: async () => { throw new Error('the delta path reads calendars one by one'); },
  changedEventsPage: async (id: string) => {
    fakes.calls.push(`window:${id}`);
    const found = fakes.window[id] ?? [];
    if (found instanceof Error) throw found;
    return { events: found, next_page_token: null, fetched_count: found.length, calendar_id: id, account: { connection_id: null, email: null }, observed_at: '' };
  },
}) as unknown as GoogleClient;
const withDelta = <T,>(work: (h: Harness) => Promise<T>): Promise<T> =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`update-delta-${seq += 1}`)), async (_instance, state) => {
    const sql = state.storage.sql;
    let n = 0, clock = T0;
    const book = jobBook(sql, { now: () => clock, newId: () => (n += 1).toString(16).padStart(12, '0'), newToken: () => `tok-${n += 1}` });
    const updates = updateBook(sql);
    updates.mark('mail_since', T0 - 600_000);
    updates.mark('calendar_since', T0 - 600_000);
    const fakes = new Map([['a1', newFakes()]]);
    const account = (id: string) => { if (!fakes.has(id)) fakes.set(id, newFakes()); return fakes.get(id)!; };
    return work({ updates, fakes: fakes.get('a1')!, storage: state.storage, account,
      // The judged job settles, so the next tick reads again.
      settle: () => { sql.exec("UPDATE task_jobs SET status = 'applied', settled_at = 1"); },
      later: (ms = SOURCE_POLL_MS) => (clock += ms),
      check: (sources = ['primary'], options = {}) => {
        const accounts = (typeof sources[0] === 'string' || !sources.length ? [{ id: 'a1', calendars: sources as readonly string[] }] : sources as readonly Account[])
          .map(({ id, calendars = ['primary'], mail = true }) => ({ id, email: `${id}@example.test`, google: fakeClient(account(id)), calendars, mail }));
        return updateSweepCheck({
          updates, jobs: book, google: fakeClient(account('a1')), now: clock, day: DAY, timezone: 'UTC', surface: 'app', sourceFollowups: options.followups !== undefined,
          delta: { accounts, ...(options.followups === undefined ? {} : { followups: options.followups }) },
          gate: () => null, providerDown: () => false, transaction: work => state.storage.transactionSync(work),
          enqueued: () => undefined, held: () => [], dayChanged: async () => undefined,
        });
      },
      jobs: () => sql.exec<JobRow>('SELECT * FROM task_jobs ORDER BY created_at').toArray(),
      rows: () => sql.exec<{ changes: string }>('SELECT changes FROM update_cards ORDER BY id').toArray().map(row => JSON.parse(row.changes) as Change[]),
      cursor: (key) => updates.cursor(key),
    });
  });
const seed = (h: Harness, cursors: Record<string, string>) => h.storage.transactionSync(() => { for (const [key, value] of Object.entries(cursors)) h.updates.moveCursor(key, h.updates.cursor(key), value); });

describe('exact deltas', () => {
  it('golden: one batch from the mail history and each calendar, recorded with the moved cursors in one write', async () => {
    await withDelta(async (h) => {
      seed(h, { 'mail:a1': '100', 'cal:a1:primary': 's1', 'cal:a1:team@group.example.test': 't1' });
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
      expect(JSON.parse(changes![3]!.detail)).toEqual({ more_messages: 2, account: 'a1@example.test' });
      expect(JSON.parse(changes![2]!.detail)).toMatchObject({ account: 'a1@example.test' });
      expect([h.cursor('mail:a1'), h.cursor('cal:a1:primary'), h.cursor('cal:a1:team@group.example.test')]).toEqual(['140', 's2', 't2']);
      expect(h.fakes.calls).not.toContain('newMail');
    });
  });

  it('starts every source from a baseline and reports nothing from it', async () => {
    await withDelta(async (h) => {
      h.fakes.mail = async () => ({ state: 'rebased', history_id: '500' });
      h.fakes.calendar = async () => ({ state: 'rebased', sync_token: 'base' });
      expect((await h.check()).code).toBe('unchanged');
      expect([h.cursor('mail:a1'), h.cursor('cal:a1:primary')]).toEqual(['500', 'base']);
      expect(h.fakes.calls).toEqual(['calendarDelta:primary:null', 'window:primary', 'mailDelta:null', 'newMail']);
    });
  });

  it('re-bases a history id Google no longer knows and reads the gap once the older way', async () => {
    await withDelta(async (h) => {
      seed(h, { 'mail:a1': '1' });
      h.fakes.mail = async () => ({ state: 'rebased', history_id: '900' });
      h.fakes.newMail = [mailItem('gap')];
      expect((await h.check()).code).toBe('enqueued');
      expect(h.rows()[0]!.map(change => change.ref)).toEqual(['message:gap']);
      expect(h.cursor('mail:a1')).toBe('900');
    });
  });

  it('dedupes by message id and by event content: an overlapping gap read and a second calendar give one change each', async () => {
    await withDelta(async (h) => {
      seed(h, { 'mail:a1': '100', 'cal:a1:primary': 's1', 'cal:a1:shared': 'x1' });
      h.fakes.mail = async () => ({ state: 'delta', history_id: '110', added: [mailItem('m1')], labels: [], left_out: 0 });
      h.fakes.calendar = async (id) => ({ state: 'delta', sync_token: `${id}-2`, events: [event('same')] });
      await h.check(['primary', 'shared']);
      expect(h.rows()[0]!.map(change => change.ref)).toEqual(['event:same', 'message:m1']);
      h.settle();
      h.later();
      // The mail cursor is lost (re-based) and the gap read finds the same message; the calendar returns the same version.
      h.fakes.mail = async () => ({ state: 'rebased', history_id: '120' });
      h.fakes.newMail = [mailItem('m1')];
      expect((await h.check(['primary', 'shared'])).code).toBe('unchanged');
      expect(h.rows()).toHaveLength(1);
      // A new etag that changes nothing the owner is shown is not news; a moved meeting is.
      h.later();
      h.fakes.calendar = async (id) => ({ state: 'delta', sync_token: `${id}-3`, events: [event('same', { etag: '"same-2"' })] });
      expect((await h.check(['primary', 'shared'])).code).toBe('unchanged');
      h.later();
      h.fakes.calendar = async (id) => ({ state: 'delta', sync_token: `${id}-4`, events: [event('same', { etag: '"same-3"', start: '2026-11-04T12:00:00Z', end: '2026-11-04T13:00:00Z' })] });
      h.fakes.mail = async () => ({ state: 'delta', history_id: '121', added: [], labels: [], left_out: 0 });
      await h.check(['primary', 'shared']);
      expect(h.rows()[1]!.map(change => change.ref)).toEqual(['event:same']);
    });
  });

  it('a read, archive or star of a mail already seen rides along as context but never starts a judgment alone', async () => {
    await withDelta(async (h) => {
      seed(h, { 'mail:a1': '100' });
      h.fakes.mail = async () => ({ state: 'delta', history_id: '110', added: [mailItem('m1', 'Invoice due')], labels: [], left_out: 0 });
      await h.check();
      expect(h.jobs()).toHaveLength(1);
      h.settle();
      h.later();
      h.fakes.mail = async () => ({ state: 'delta', history_id: '111', added: [], labels: [{ message_id: 'm1', thread_id: 't-m1', change: 'read' }, { message_id: 'never-seen', thread_id: 't-x', change: 'archived' }], left_out: 0 });
      expect((await h.check()).code).toBe('unchanged');
      const read = h.rows()[1]!;
      expect(read.map(change => [change.kind, change.ref])).toEqual([['read', 'message:m1']]);
      expect(JSON.parse(read[0]!.detail)).toMatchObject({ subject: 'Invoice due' });
      expect(h.jobs()).toHaveLength(1);
    });
  });

  it('an event that goes back to an earlier state is news each time: moved, then moved back', async () => {
    await withDelta(async (h) => {
      const at = (start: string, end: string) => event('standup', { start, end });
      const tick = async (version: CalendarDeltaEvent) => {
        h.fakes.calendar = async (_id, token) => ({ state: 'delta', sync_token: `${token}+`, events: [version] });
        h.settle();
        h.later();
        return (await h.check()).code;
      };
      expect(await tick(at('2026-11-04T10:00:00Z', '2026-11-04T11:00:00Z'))).toBe('enqueued');
      expect(await tick(at('2026-11-04T12:00:00Z', '2026-11-04T13:00:00Z'))).toBe('enqueued');
      expect(await tick(at('2026-11-04T10:00:00Z', '2026-11-04T11:00:00Z')), 'back to 10:00').toBe('enqueued');
      expect(await tick(at('2026-11-04T10:00:00Z', '2026-11-04T11:00:00Z')), 'the same again is not news').toBe('unchanged');
      expect(h.rows().map(row => (JSON.parse(row[0]!.detail) as { start: string }).start)).toEqual(['2026-11-04T10:00:00Z', '2026-11-04T12:00:00Z', '2026-11-04T10:00:00Z']);
    });
  });

  it('a meeting cancelled and then restored is said both times', async () => {
    await withDelta(async (h) => {
      const meeting = event('review');
      h.updates.see({ event_id: 'review', start: meeting.start, end: meeting.end, all_day: false, title_digest: 'shown' }, T0);
      const tick = async (version: CalendarDeltaEvent) => {
        h.fakes.calendar = async (_id, token) => ({ state: 'delta', sync_token: `${token}+`, events: [version] });
        h.settle();
        h.later();
        return (await h.check()).code;
      };
      expect(await tick(meeting)).toBe('enqueued');
      expect(await tick({ ...meeting, status: 'cancelled', etag: '"review-2"' })).toBe('enqueued');
      expect(await tick({ ...meeting, etag: '"review-3"' }), 'back on').toBe('enqueued');
      expect(h.rows().map(row => row[0]!.kind)).toEqual(['changed', 'cancelled', 'changed']);
    });
  });

  it('a mailbox read past the page cap moves to its current history id and reads the gap the older way', async () => {
    await withDelta(async (h) => {
      seed(h, { 'mail:a1': '100' });
      h.fakes.mail = async () => ({ state: 'capped', history_id: '9000' });
      h.fakes.newMail = [mailItem('after-bulk-archive')];
      const result = await h.check();
      expect(result.code).toBe('enqueued');
      expect(result.delta).toContain('mail_capped');
      expect(h.rows()[0]!.map(change => change.ref)).toEqual(['message:after-bulk-archive']);
      expect(h.cursor('mail:a1')).toBe('9000');
    });
  });

  it('a delta read that fails falls back to the older read for that source and leaves its cursor where it was', async () => {
    await withDelta(async (h) => {
      seed(h, { 'mail:a1': '100', 'cal:a1:primary': 's1' });
      h.fakes.mail = async () => { throw new Error('unknown method'); };
      h.fakes.calendar = async () => { throw new Error('unknown method'); };
      h.fakes.newMail = [mailItem('m2')];
      h.fakes.window.primary = [{ ...event('moved'), status: 'confirmed' }];
      expect((await h.check()).code).toBe('enqueued');
      expect(h.rows()[0]!.map(change => change.ref)).toEqual(['event:moved', 'message:m2']);
      expect([h.cursor('mail:a1'), h.cursor('cal:a1:primary')]).toEqual(['100', 's1']);
      expect(h.updates.since('mail_since')).toBe(T0);
    });
  });

  it('one calendar that cannot be read keeps its cursor and does not hold the others back', async () => {
    await withDelta(async (h) => {
      seed(h, { 'mail:a1': '100', 'cal:a1:primary': 's1', 'cal:a1:gone': 'g1' });
      h.fakes.calendar = async (id) => { if (id === 'gone') throw new Error('google 404'); return { state: 'delta', sync_token: 's2', events: [event('kept')] }; };
      h.fakes.window.gone = new Error('google 404');
      expect((await h.check(['primary', 'gone'])).code).toBe('enqueued');
      expect([h.cursor('cal:a1:primary'), h.cursor('cal:a1:gone')]).toEqual(['s2', 'g1']);
    });
  });

  it('when every source due fails the tick fails as before, and nothing moves', async () => {
    await withDelta(async (h) => {
      seed(h, { 'mail:a1': '100', 'cal:a1:primary': 's1' });
      h.fakes.calendar = async () => { throw new Error('google 503'); };
      h.fakes.window.primary = new Error('google 503');
      h.fakes.mail = async () => { throw new Error('google 503'); };
      h.fakes.newMail = new Error('google 503');
      await expect(h.check()).rejects.toThrow('google 503');
      expect([h.cursor('mail:a1'), h.cursor('cal:a1:primary'), h.updates.since('calendar_since')]).toEqual(['100', 's1', T0 - 600_000]);
    });
  });

  it('a cursor another read moved meanwhile rolls the whole write back', async () => {
    await withDelta(async (h) => {
      seed(h, { 'mail:a1': '100' });
      h.fakes.mail = async () => {
        h.storage.transactionSync(() => h.updates.moveCursor('mail:a1', '100', '150'));
        return { state: 'delta', history_id: '140', added: [mailItem('m1')], labels: [], left_out: 0 };
      };
      expect((await h.check()).code).toBe('held_cursor_moved');
      expect(h.rows()).toEqual([]);
      expect(h.cursor('mail:a1')).toBe('150');
      expect(h.updates.since('mail_since')).toBe(T0 - 600_000);
    });
  });

  it('a calendar whose baseline is past the page cap is read the older way and tried again only a day later', async () => {
    await withDelta(async (h) => {
      seed(h, { 'mail:a1': '100' });
      h.fakes.calendar = async () => ({ state: 'capped' });
      await h.check();
      expect(h.cursor('cal:a1:primary')).toBe(`capped:${T0}`);
      expect(h.fakes.calls.filter(call => call.startsWith('calendarDelta'))).toHaveLength(1);
      expect(h.fakes.calls).toContain('window:primary');
      h.later();
      await h.check();
      expect(h.fakes.calls.filter(call => call.startsWith('calendarDelta')), 'held for a day').toHaveLength(1);
      expect(h.fakes.calls.filter(call => call === 'window:primary')).toHaveLength(2);
    });
  });

  it('a tick reads a source again only when a push marked it or its poll is due', async () => {
    await withDelta(async (h) => {
      await h.check();
      h.fakes.calls.length = 0;
      h.later(60_000);
      expect((await h.check()).code).toBe('unchanged');
      expect(h.fakes.calls, 'nothing due, nothing read').toEqual([]);
      h.updates.pend('cal:a1:primary', T0 + 60_000);
      await h.check();
      expect(h.fakes.calls).toEqual(['calendarDelta:primary:null+']);
      expect(h.updates.pendingAt('cal:a1:primary')).toBeNull();
    });
  });
});

describe('every connected account', () => {
  const both: readonly Account[] = [{ id: 'a1' }, { id: 'b2' }];

  it('reads each account from its own cursors and names the account each change came from', async () => {
    await withDelta(async (h) => {
      seed(h, { 'mail:a1': '100', 'cal:a1:primary': 's1', 'mail:b2': '900', 'cal:b2:primary': 'w1' });
      const b = h.account('b2');
      h.fakes.calendar = async () => ({ state: 'delta', sync_token: 's2', events: [event('standup')] });
      b.mail = async () => ({ state: 'delta', history_id: '901', added: [mailItem('offer')], labels: [], left_out: 0 });
      b.calendar = async () => ({ state: 'delta', sync_token: 'w2', events: [event('dinner')] });
      expect((await h.check(both)).code).toBe('enqueued');
      expect(h.rows()[0]!.map(change => [change.ref, (JSON.parse(change.detail) as { account: string }).account])).toEqual([
        ['event:standup', 'a1@example.test'], ['event:dinner', 'b2@example.test'], ['message:offer', 'b2@example.test']]);
      expect(['mail:a1', 'cal:a1:primary', 'mail:b2', 'cal:b2:primary'].map(h.cursor)).toEqual(['101', 's2', '901', 'w2']);
      expect(h.fakes.calls).toEqual(['calendarDelta:primary:s1', 'mailDelta:100']);
      expect(b.calls).toEqual(['calendarDelta:primary:w1', 'mailDelta:900']);
    });
  });

  it('one account that cannot be read keeps its cursors and does not hold the other back', async () => {
    await withDelta(async (h) => {
      seed(h, { 'mail:a1': '100', 'cal:a1:primary': 's1', 'mail:b2': '900', 'cal:b2:primary': 'w1' });
      h.fakes.calendar = async () => { throw new Error('invalid_grant'); };
      h.fakes.window.primary = new Error('invalid_grant');
      h.fakes.mail = async () => { throw new Error('invalid_grant'); };
      h.fakes.newMail = new Error('invalid_grant');
      h.account('b2').calendar = async () => ({ state: 'delta', sync_token: 'w2', events: [event('dinner')] });
      const result = await h.check(both);
      expect(result.code).toBe('enqueued');
      expect(result.delta).toEqual(expect.arrayContaining(['calendar_read_failed', 'mail_read_failed']));
      expect(h.rows()[0]!.map(change => change.ref)).toEqual(['event:dinner']);
      expect(['mail:a1', 'cal:a1:primary', 'cal:b2:primary'].map(h.cursor)).toEqual(['100', 's1', 'w2']);
      // The failed account keeps the watermark its gap is read from; the shared one moved on with the account that was read.
      expect([h.updates.readAt('cal:a1:primary'), h.updates.readAt('mail:a1'), h.updates.readAt('cal:b2:primary')]).toEqual([T0 - 600_000, T0 - 600_000, T0]);
      expect(h.updates.since('calendar_since')).toBe(T0);
      h.fakes.window.primary = [event('missed')];
      h.fakes.newMail = [];
      h.fakes.calls.length = 0;
      h.settle();
      h.later(60_000);
      await h.check(both);
      expect(h.fakes.calls, 'the failed account is due again, its gap read from where it stopped').toContain('window:primary');
      expect(h.rows()[1]!.map(change => change.ref)).toEqual(['event:missed']);
    });
  });

  it('a push for one account reads only that account, and a push that came during the read stays waiting', async () => {
    await withDelta(async (h) => {
      await h.check(both);
      const b = h.account('b2');
      h.fakes.calls.length = 0;
      b.calls.length = 0;
      const at = h.later(60_000);
      h.updates.pend('cal:b2:primary', at);
      const before = h.cursor('cal:a1:primary');
      b.calendar = async (_id, token) => {
        h.storage.transactionSync(() => h.updates.pend('cal:b2:primary', at + 1));
        return { state: 'delta', sync_token: `${token}+`, events: [event('moved')] };
      };
      expect((await h.check(both)).code).toBe('enqueued');
      expect(h.fakes.calls).toEqual([]);
      expect(b.calls).toEqual(['calendarDelta:primary:null+']);
      expect([h.cursor('cal:a1:primary'), h.cursor('cal:b2:primary')]).toEqual([before, 'null++']);
      expect(h.updates.pendingAt('cal:b2:primary'), 'the later push is read on the next tick').toBe(String(at + 1));
    });
  });

  it('a meeting on both accounts is said once, in the same tick or a later one', async () => {
    await withDelta(async (h) => {
      const b = h.account('b2');
      const owners = event('shared', { etag: '"a-copy"' });
      const guests = event('shared', { etag: '"b-copy"', invite: true });
      seed(h, { 'cal:a1:primary': 's1', 'cal:b2:primary': 'w1' });
      h.fakes.calendar = async () => ({ state: 'delta', sync_token: 's2', events: [owners] });
      b.calendar = async () => ({ state: 'delta', sync_token: 'w2', events: [guests] });
      await h.check(both);
      expect(h.rows()[0]!.filter(change => change.source === 'calendar').map(change => [change.ref, (JSON.parse(change.detail) as { account: string }).account]))
        .toEqual([['event:shared', 'b2@example.test']]);
      h.settle();
      // A copy arriving on its own push a minute later: the same meeting, not news.
      const at = h.later(60_000);
      h.updates.pend('cal:b2:primary', at);
      b.calendar = async () => ({ state: 'delta', sync_token: 'w3', events: [{ ...guests, etag: '"b-copy-2"' }] });
      expect((await h.check(both)).code).toBe('unchanged');
      expect(h.rows()).toHaveLength(1);
    });
  });

  it('a pending invite on the second account is the copy read, named for that account', async () => {
    await withDelta(async (h) => {
      h.fakes.calendar = async () => ({ state: 'delta', sync_token: 's2', events: [event('offsite', { etag: '"a-copy"' })] });
      h.account('b2').calendar = async () => ({ state: 'delta', sync_token: 'w2', events: [event('offsite', { etag: '"b-copy"', invite: true })] });
      await h.check(both);
      const calendar = h.rows()[0]!.filter(change => change.source === 'calendar');
      expect(calendar.map(change => JSON.parse(change.detail) as { invite?: true; account: string })).toEqual([expect.objectContaining({ invite: true, account: 'b2@example.test' })]);
    });
  });

  it('only mail from the account follow-ups read through can open a follow-up', async () => {
    await withDelta(async (h) => {
      seed(h, { 'mail:a1': '100', 'mail:b2': '900' });
      h.fakes.mail = async () => ({ state: 'delta', history_id: '101', added: [mailItem('work')], labels: [], left_out: 0 });
      h.account('b2').mail = async () => ({ state: 'delta', history_id: '901', added: [mailItem('home')], labels: [], left_out: 0 });
      await h.check(both, { followups: 'a1@example.test' });
      const mail = h.rows()[0]!.filter(change => change.source === 'mail');
      expect(mail.map(change => [JSON.parse(change.detail).subject, change.source_ref ?? null])).toEqual([['Subject work', 'mail:t-work'], ['Subject home', null]]);
    });
  });

  it('removing an account forgets only its sources', async () => {
    await withDelta(async (h) => {
      seed(h, { 'mail:a1': '100', 'cal:a1:primary': 's1', 'cal:a1:team': 't1', 'mail:b2': '900', 'cal:b2:primary': 'w1' });
      await h.check(both);
      h.updates.pend('cal:a1:team', T0);
      h.updates.dropAccount('a1');
      expect(['mail:a1', 'cal:a1:primary', 'cal:a1:team'].map(h.cursor)).toEqual([null, null, null]);
      expect([h.updates.readAt('mail:a1'), h.updates.pendingAt('cal:a1:team')]).toEqual([null, null]);
      expect([h.cursor('mail:b2'), h.updates.readAt('cal:b2:primary')]).toEqual(['101', T0]);
    });
  });
});
