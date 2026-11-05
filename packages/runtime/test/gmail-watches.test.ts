import { describe, expect, it } from 'vitest';
import { ensureGmailWatches, gmailWatchesBook } from '../src/channels/gmail-watches';
import { watchStatusLine } from '../src/channels/watch-upkeep';
import { gmailPush, type GmailWatch } from '../src/connectors/google-push';

// GOOGLE_REALTIME_TRIAGE: one Gmail watch per connected mail account, and the host fact that names each one not watched.
// Every account and address is synthetic.
const HOUR = 3_600_000, DAY = 24 * HOUR;
const MAIL = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose'];
const CALENDAR = 'https://www.googleapis.com/auth/calendar.events';
const kv = () => { const map = new Map<string, unknown>(); return { get: <T>(key: string) => map.get(key) as T | undefined, put: (key: string, value: unknown) => { map.set(key, value); } }; };

const world = () => {
  const store = kv(), book = gmailWatchesBook(store), watched: string[] = [], refuse = new Set<string>();
  let now = 1_000 * HOUR;
  const proxy = { gmailWatch: async (_doName: string, connection: string): Promise<GmailWatch> => {
    if (refuse.has(connection)) throw new Error('gmail 403');
    watched.push(connection);
    return { historyId: '100', expiration: now + 7 * DAY };
  } };
  const run = (accounts: readonly Readonly<{ id: string; local: boolean }>[]) => ensureGmailWatches({ book, now, config: gmailPush('waldo-dev'), doName: 'owner-do', proxy, accounts });
  return { book, watched, refuse, run, at: (ms: number) => { now = ms; }, now: () => now };
};

describe('a Gmail watch per mail account', () => {
  it('watches each account, a push names its account, and a redelivery wakes nothing', async () => {
    const w = world();
    expect(await w.run([{ id: 'conn-1', local: false }, { id: 'conn-2', local: false }])).toEqual({ started: 2, failed: 0, skipped: 0, fresh: 0 });
    expect(w.watched).toEqual(['conn-1', 'conn-2']);
    expect(w.book.admit('conn-2', '101')).toBe('conn-2');
    expect(w.book.admit('conn-2', '101')).toBeNull();
    expect(w.book.admit('conn-1', '99')).toBeNull();
    expect(w.book.admit('conn-9', '500')).toBeNull();
    expect(await w.run([{ id: 'conn-1', local: false }, { id: 'conn-2', local: false }])).toMatchObject({ started: 0, fresh: 2 });
  });

  it('one account that fails, or is held the older way, is not watched; the other is', async () => {
    const w = world();
    w.refuse.add('conn-1');
    expect(await w.run([{ id: 'conn-1', local: false }, { id: 'local:old@example.test', local: true }, { id: 'conn-3', local: false }]))
      .toEqual({ started: 1, failed: 1, skipped: 1, fresh: 0 });
    expect(w.book.misses()).toEqual([{ account: 'conn-1', at: w.now(), reason: 'failed' }, { account: 'local:old@example.test', at: w.now(), reason: 'local_rail' }]);
    expect(w.book.admit('conn-1', '200')).toBeNull();
    w.refuse.clear();
    w.at(w.now() + 7 * HOUR);
    expect(await w.run([{ id: 'conn-1', local: false }, { id: 'conn-3', local: false }])).toMatchObject({ started: 1 });
    expect(w.book.misses()).toEqual([]);
  });

  it('a reconnect clears the account\'s failed watch, so the next upkeep tries it, and leaves a live one', async () => {
    const w = world();
    w.refuse.add('conn-1');
    await w.run([{ id: 'conn-1', local: false }, { id: 'conn-2', local: false }]);
    w.refuse.clear();
    w.book.clearFailure('conn-1');
    w.book.clearFailure('conn-2');
    expect(await w.run([{ id: 'conn-1', local: false }, { id: 'conn-2', local: false }])).toEqual({ started: 1, failed: 0, skipped: 0, fresh: 1 });
  });

  it('an account no longer read is forgotten, so its pushes wake nothing', async () => {
    const w = world();
    await w.run([{ id: 'conn-1', local: false }, { id: 'conn-2', local: false }]);
    await w.run([{ id: 'conn-2', local: false }]);
    expect(w.book.accounts()).toEqual(['conn-2']);
    expect(w.book.admit('conn-1', '300')).toBeNull();
  });

  it('starts nothing where pushes are not configured', async () => {
    const w = world();
    expect(await ensureGmailWatches({ book: w.book, now: w.now(), config: null, doName: 'owner-do', proxy: null, accounts: [{ id: 'conn-1', local: false }] })).toBe('skipped');
  });
});

describe('the host fact names each account not watched', () => {
  const accounts = [{ id: 'conn-1', email: 'work@example.test', scopes: [...MAIL, CALENDAR] }, { id: 'conn-2', email: 'home@example.test', scopes: [...MAIL, CALENDAR] },
    { id: 'local:old@example.test', email: 'old@example.test', scopes: MAIL, refresh_token: 'synthetic' }];
  const AT = Date.parse('2026-11-03T09:00:00Z');

  it('names the accounts whose mail or calendar push failed, and the older-way account, and no other', () => {
    const line = watchStatusLine({ accounts, gmail: null, calendar: null, timezone: 'UTC', perAccount: {
      gmail: [{ account: 'conn-1', at: AT, reason: 'failed' }, { account: 'local:old@example.test', at: AT, reason: 'local_rail' }],
      calendar: [{ account: 'conn-2', at: AT }] } });
    expect(line).toContain('Waldo is not getting new email pushed from "work@example.test" right now');
    expect(line).toContain('Waldo is not getting new email pushed from "old@example.test": that account is connected the older way');
    expect(line).toContain('Waldo is not getting calendar changes pushed from "home@example.test" right now');
    expect(line).not.toContain('new email pushed from "home@example.test"');
  });

  it('says nothing when every account is watched, or for an account no longer connected', () => {
    expect(watchStatusLine({ accounts, gmail: null, calendar: null, timezone: 'UTC', perAccount: { gmail: [], calendar: [{ account: 'conn-gone', at: AT }] } })).toBe('');
  });
});
