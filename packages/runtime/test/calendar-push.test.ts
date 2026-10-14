import { describe, expect, it, vi } from 'vitest';
import { calendarPushBook, ensureCalendarWatch, wakeBriefSweep } from '../src/channels/calendar-push';
import { BRIEF_SWEEP_ID } from '../src/channels/event-briefs';
import { verifyCalendarChannel } from '../src/connectors/google-push';
import type { ScheduleEntry } from '@waldo/contracts';

const kv = () => { const map = new Map<string, unknown>(); return { get: <T>(key: string) => map.get(key) as T | undefined, put: (key: string, value: unknown) => { map.set(key, value); }, delete: (key: string) => map.delete(key), map }; };
const HOUR = 3_600_000;
const SECRET = 'router-secret-fixture-0000000000';

describe('push admission', () => {
  const active = () => { const store = kv(); const book = calendarPushBook(store); book.record({ channelId: 'chan-1', resourceId: 'res-1', expiration: 100 * HOUR }, 'conn'); return book; };
  it('wakes once per new message on the active channel', () => {
    const book = active();
    expect(book.admit('chan-1', 'exists', 2)).toBe('wake');
    expect(book.admit('chan-1', 'exists', 2)).toBe('ignore');
    expect(book.admit('chan-1', 'exists', 1)).toBe('ignore');
    expect(book.admit('chan-1', 'not_exists', 3)).toBe('wake');
  });
  it('the sync handshake and other channels never wake', () => {
    const book = active();
    expect(book.admit('chan-1', 'sync', 1)).toBe('ignore');
    expect(book.admit('chan-old', 'exists', 9)).toBe('ignore');
    expect(calendarPushBook(kv()).admit('chan-1', 'exists', 5)).toBe('ignore');
  });
});

describe('the wake pulls the existing update sweep forward', () => {
  const entry = (over: Partial<ScheduleEntry> = {}): ScheduleEntry => ({ id: BRIEF_SWEEP_ID, kind: 'pre_activity_spot', occurrence_at: 10 * 60_000, due_at: 10 * 60_000, recurrence: { type: 'interval', every_ms: 600_000, phase_ms: 0 }, payload_refs: { id: BRIEF_SWEEP_ID }, status: 'armed', attempts: 0, last_fired_at: null, quarantined_until: null, created_at: 0, updated_at: 0, ...over } as ScheduleEntry);
  const scheduler = (found: ScheduleEntry | null) => ({ lookup: vi.fn(() => found ? { state: 'entry' as const, entry: found } : { state: 'absent' as const }), pullForward: vi.fn(async () => true) });
  it('asks the scheduler to move only the next run, to now', async () => {
    const s = scheduler(entry());
    expect(await wakeBriefSweep(s, 1000)).toBe(true);
    expect(s.pullForward).toHaveBeenCalledWith(BRIEF_SWEEP_ID, 1000);
  });
  it('asks for no sooner than a minute after the last run', async () => {
    const recent = scheduler(entry({ last_fired_at: 900 }));
    await wakeBriefSweep(recent, 1000);
    expect(recent.pullForward).toHaveBeenCalledWith(BRIEF_SWEEP_ID, 60_900);
  });
  it('does nothing when the owner has no sweep (opted out, or a zone not confirmed) or it is quarantined', async () => {
    const absent = scheduler(null);
    expect(await wakeBriefSweep(absent, 1000)).toBe(false);
    const held = scheduler(entry({ status: 'quarantined' }));
    expect(await wakeBriefSweep(held, 1000)).toBe(false);
    expect(held.pullForward).not.toHaveBeenCalled();
  });
});

describe('the watch is kept fresh on the sweep', () => {
  const deps = (over: Record<string, unknown> = {}) => {
    const store = kv();
    const calls: string[] = [];
    const base = {
      book: calendarPushBook(store), now: 0, origin: 'https://w.test', secret: SECRET, doName: 'owner-a', newId: () => 'chan-new',
      resolve: async () => ({ mode: 'proxy' as const, connection: 'conn' }),
      proxy: {
        calendarWatch: vi.fn(async (_d: string, _c: string, input: { channelId: string; token: string; address: string }) => { calls.push(`watch:${input.address}`); return { channelId: input.channelId, resourceId: 'res-new', expiration: 168 * HOUR }; }),
        stopChannel: vi.fn(async (_d: string, _c: string, channel: { channelId: string }) => { calls.push(`stop:${channel.channelId}`); }),
      },
      fetcher: vi.fn(async () => { throw new Error('bearer path not expected'); }) as unknown as typeof fetch,
      ...over,
    };
    return { base, store, calls };
  };

  it('starts a watch whose token routes back to this owner and records it', async () => {
    const { base, calls } = deps();
    expect(await ensureCalendarWatch(base)).toBe('started');
    expect(calls).toEqual(['watch:https://w.test/events/gcal']);
    const token = (base.proxy.calendarWatch.mock.calls[0] as unknown as [string, string, { token: string }])[2].token;
    expect(await verifyCalendarChannel(SECRET, token, 'chan-new')).toBe('owner-a');
    expect(base.book.state()).toEqual({ channelId: 'chan-new', resourceId: 'res-new', expiration: 168 * HOUR });
    expect(await ensureCalendarWatch({ ...base, now: HOUR })).toBe('fresh');
  });

  it('renews a day before expiry and stops the old channel', async () => {
    const { base, calls } = deps();
    base.book.record({ channelId: 'chan-old', resourceId: 'res-old', expiration: 20 * HOUR }, 'conn');
    expect(await ensureCalendarWatch(base)).toBe('started');
    expect(calls).toEqual(['watch:https://w.test/events/gcal', 'stop:chan-old']);
    expect(base.book.admit('chan-old', 'exists', 5)).toBe('ignore');
  });

  it('a failed start leaves the poll in charge and waits before trying again', async () => {
    const { base } = deps({ proxy: { calendarWatch: vi.fn(async () => { throw Object.assign(new Error('insufficient scopes'), { status: 403 }); }), stopChannel: vi.fn() } });
    expect(await ensureCalendarWatch(base)).toBe('failed');
    expect(await ensureCalendarWatch({ ...base, now: HOUR })).toBe('fresh');
    expect(base.proxy.calendarWatch).toHaveBeenCalledTimes(1);
  });

  it('a failed stop of the old channel does not undo the new watch', async () => {
    const { base } = deps();
    base.proxy.stopChannel.mockRejectedValueOnce(new Error('gone'));
    base.book.record({ channelId: 'chan-old', resourceId: 'res-old', expiration: 1 }, 'conn');
    expect(await ensureCalendarWatch(base)).toBe('started');
    expect(base.book.state()).toMatchObject({ channelId: 'chan-new' });
  });

  it('skips without a public origin, the router secret or a Google account', async () => {
    for (const over of [{ origin: null }, { secret: undefined }, { resolve: async () => null }]) {
      const { base } = deps(over);
      expect(await ensureCalendarWatch(base)).toBe('skipped');
      expect(base.proxy.calendarWatch).not.toHaveBeenCalled();
    }
  });

  it('without a Google account it waits before asking again, rather than on every sweep', async () => {
    const resolve = vi.fn(async () => null);
    const { base } = deps({ resolve });
    expect(await ensureCalendarWatch(base)).toBe('skipped');
    expect(await ensureCalendarWatch({ ...base, now: HOUR })).toBe('fresh');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(await ensureCalendarWatch({ ...base, now: 7 * HOUR })).toBe('skipped');
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('a locally held grant starts the watch with a bearer minted for this call', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => Response.json({ id: JSON.parse(String(init.body)).id, resourceId: 'res-b', expiration: String(168 * HOUR) }));
    const { base } = deps({ resolve: async () => ({ mode: 'bearer' as const, token: 'ya29.fixture' }), fetcher });
    expect(await ensureCalendarWatch(base)).toBe('started');
    expect(new Headers((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].headers).get('authorization')).toBe('Bearer ya29.fixture');
    expect(base.proxy.calendarWatch).not.toHaveBeenCalled();
  });
});

describe('Calendar watch after a new grant', () => {
  it('clearing failures lets the next sweep retry a failed watch at once', () => {
    const book = calendarPushBook(kv());
    book.fail(0);
    book.clearFailure();
    expect(book.state()).toBeNull();
  });

  it('clearing failures leaves a live channel and its connection alone, so no second channel is started', () => {
    const book = calendarPushBook(kv());
    const live = { channelId: 'chan-1', resourceId: 'res-1', expiration: 100 * HOUR };
    book.record(live, 'conn-1');
    book.clearFailure();
    expect(book.state()).toEqual(live);
    expect(book.connection()).toBe('conn-1');
  });
});
