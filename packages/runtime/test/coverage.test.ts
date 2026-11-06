import { describe, expect, it } from 'vitest';
import { coverageFacts, type CoverageDeps } from '../src/channels/coverage';
import { coverageSection } from '../src/prompt/day-shaping';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { updateBook } from '../src/channels/update-cards';

// The coverage facts are counts and times the model judges; code decides nothing about whether the calendar is thin.
const NOW = Date.parse('2026-11-09T06:00:00Z');
const account = { id: 'acct-1', email: 'owner@example.test', error: null, calendar: true };
const deps = (over: Partial<CoverageDeps> = {}): CoverageDeps => ({
  now: NOW, timezone: 'Asia/Kolkata', accounts: async () => [account], readAt: () => NOW - 7 * 60_000,
  pastEvents: async () => [], phone: null, ...over,
});

describe('coverage facts', () => {
  it('a thin calendar is two events in two weeks, stated, never judged', async () => {
    const facts = await coverageFacts(deps({ pastEvents: async () => [
      { start: '2026-11-03T04:30:00Z', all_day: false }, // Tuesday 10:00 in Kolkata
      { start: '2026-11-06', all_day: true }, // Friday
    ] }));
    expect(facts.weekdays).toEqual({ counts: [0, 1, 0, 0, 1, 0, 0], days: 14 });
    expect(facts.accounts).toEqual([{ email: 'owner@example.test', calendar: true, failing: false, read_minutes_ago: 7 }]);
    expect(facts.phone).toEqual({ state: 'off' });
  });

  it('counts an event on the owner\'s local weekday, across a DST change and in another zone', async () => {
    // 23:30 on Saturday 31 October in New York is Sunday 03:30Z; 23:30 on Sunday 1 November (after the fall back) is Monday 04:30Z.
    const events = [{ start: '2026-11-01T03:30:00Z', all_day: false }, { start: '2026-11-02T04:30:00Z', all_day: false }];
    expect((await coverageFacts(deps({ timezone: 'America/New_York', pastEvents: async () => events }))).weekdays!.counts).toEqual([0, 0, 0, 0, 0, 1, 1]);
    expect((await coverageFacts(deps({ timezone: 'Asia/Kolkata', pastEvents: async () => events }))).weekdays!.counts).toEqual([1, 0, 0, 0, 0, 0, 1]);
  });

  it('a read that fails or fills its page leaves the weekdays unknown rather than short', async () => {
    expect((await coverageFacts(deps({ pastEvents: async () => null }))).weekdays).toBeNull();
    expect((await coverageFacts(deps({ pastEvents: async () => Array.from({ length: 250 }, () => ({ start: '2026-11-03T04:30:00Z', all_day: false })) }))).weekdays).toBeNull();
    expect((await coverageFacts(deps({ accounts: async () => [] }))).weekdays).toBeNull();
  });

  it('says whether the phone calendar is shared, from what each phone sent', async () => {
    const stored = { devices: [{ device_id: '0c9d6a7e-1f2b-4c3d-8e9f-0a1b2c3d4e5f', platform: 'android' as const, received_at: '2026-11-09T05:00:00.000Z', observed_at: '2026-11-09T05:00:00.000Z',
      times_only: false, complete: true, calendars: [{ calendar_id: '7', name: 'Work', account_type: 'exchange' as const }], events: 12 }] };
    const shared = await coverageFacts(deps({ phone: { stored: () => stored } }));
    expect(shared.phone).toEqual({ state: 'shared', phones: [{ age_minutes: 60, times_only: false, complete: true, calendars: ['Work (exchange)'] }] });
    expect(coverageSection(shared)).toContain('Phone calendar: shared from 1 phone; read 60 minutes ago: Work (exchange).');
    expect((await coverageFacts(deps({ phone: { stored: () => ({ devices: [] }) } }))).phone).toEqual({ state: 'not_shared' });
  });

  it('a failing account is named as failing and not read', async () => {
    let reads = 0;
    const facts = await coverageFacts(deps({ accounts: async () => [{ ...account, error: 'invalid_grant' }], pastEvents: async () => { reads += 1; return []; } }));
    expect(facts.accounts[0]).toMatchObject({ failing: true });
    expect(reads).toBe(0);
  });

  it('reads the past fortnight once per local day and set of accounts', async () => {
    const kept = new Map<string, unknown>();
    const cache = { get: <T,>(key: string) => kept.get(key) as T | undefined, put: (key: string, value: unknown) => { kept.set(key, value); } };
    let reads = 0;
    const read = async () => { reads += 1; return [{ start: '2026-11-03T04:30:00Z', all_day: false }]; };
    await coverageFacts(deps({ cache, pastEvents: read }));
    await coverageFacts(deps({ cache, pastEvents: read, now: NOW + 3_600_000 }));
    expect(reads).toBe(1);
    await coverageFacts(deps({ cache, pastEvents: read, now: NOW + 24 * 3_600_000 }));
    await coverageFacts(deps({ cache, pastEvents: read, accounts: async () => [account, { ...account, id: 'acct-2', email: 'work@example.test' }] }));
    expect(reads).toBe(4);
  });
});

describe('when each account was last read', () => {
  it('with the delta reads, an account with no read of its own is not read yet; without them the shared watermark stands', () => runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`coverage-read-${crypto.randomUUID()}`)), async (_i, state) => {
    const book = updateBook(state.storage.sql);
    expect(book.calendarReadAt('acct-1')).toBeNull();
    book.mark('calendar_since', NOW);
    expect(book.calendarReadAt('acct-1')).toBe(NOW);
    book.markRead('cal:acct-1:primary', NOW - 60_000, null);
    book.markRead('cal:acct-1:work', NOW - 30_000, null);
    expect(book.calendarReadAt('acct-1')).toBe(NOW - 30_000);
    expect(book.calendarReadAt('acct-2')).toBeNull();
  }));
});
