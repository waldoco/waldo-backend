import { describe, expect, it, vi } from 'vitest';
import { ensureGmailWatch, gmailPushBook } from '../src/channels/gmail-push';
import { gmailPush } from '../src/connectors/google-push';
import { McpConnectError } from '../src/tools/live/mcp';

const kv = () => { const map = new Map<string, unknown>(); return { get: <T>(key: string) => map.get(key) as T | undefined, put: (key: string, value: unknown) => { map.set(key, value); }, delete: (key: string) => map.delete(key) }; };
const DAY = 86_400_000;
const config = gmailPush('waldo-dev')!;

describe('Gmail push admission', () => {
  it('wakes only for a newer history point on the watched connection', () => {
    const book = gmailPushBook(kv());
    expect(book.admit('conn', '100')).toBe('ignore');
    book.record({ historyId: '100', expiration: 7 * DAY }, 'conn', 0);
    expect(book.admit('conn', '100')).toBe('ignore');
    expect(book.admit('conn', '99')).toBe('ignore');
    expect(book.admit('other', '500')).toBe('ignore');
    expect(book.admit('conn', '101')).toBe('wake');
    expect(book.admit('conn', '101')).toBe('ignore');
    expect(book.admit('conn', '18446744073709551615')).toBe('wake');
  });
});

describe('Gmail watch upkeep', () => {
  const deps = (over: Record<string, unknown> = {}) => {
    const proxy = { gmailWatch: vi.fn(async () => ({ historyId: '700', expiration: 7 * DAY })) };
    return { book: gmailPushBook(kv()), now: 0, config, doName: 'owner-a', resolve: async () => ({ mode: 'proxy' as const, connection: 'conn' }), proxy, ...over };
  };

  it('starts a watch into the push topic and keeps it for a day', async () => {
    const d = deps();
    expect(await ensureGmailWatch(d)).toBe('started');
    expect(d.proxy.gmailWatch).toHaveBeenCalledWith('owner-a', 'conn', config.topic);
    expect(await ensureGmailWatch({ ...d, now: DAY - 1 })).toBe('fresh');
    expect(await ensureGmailWatch({ ...d, now: DAY })).toBe('started');
    expect(d.book.admit('conn', '701')).toBe('wake');
  });

  it('stops no watch, on a renewal or a move to another mailbox, since another owner may share it', async () => {
    const d = deps();
    const stop = vi.fn();
    const proxy = { ...d.proxy, gmailStop: stop };
    d.book.record({ historyId: '1', expiration: 7 * DAY }, 'conn', -2 * DAY);
    expect(await ensureGmailWatch({ ...d, proxy })).toBe('started');
    d.book.record({ historyId: '1', expiration: 7 * DAY }, 'old-conn', -2 * DAY);
    expect(await ensureGmailWatch({ ...d, proxy })).toBe('started');
    expect(d.proxy.gmailWatch).toHaveBeenCalledTimes(2);
    expect(stop).not.toHaveBeenCalled();
    expect(d.book.admit('conn', '701')).toBe('wake');
  });

  it('without a Google account it waits before asking again, rather than on every sweep', async () => {
    const resolve = vi.fn(async () => null);
    const d = deps({ resolve });
    expect(await ensureGmailWatch(d)).toEqual({ skipped: 'no_mail_grant' });
    expect(await ensureGmailWatch({ ...d, now: 3_600_000 })).toBe('fresh');
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('a failed start leaves the poll in charge and waits six hours', async () => {
    const d = deps({ proxy: { gmailWatch: vi.fn(async () => { throw new Error('refused'); }) } });
    expect(await ensureGmailWatch(d)).toBe('failed');
    expect(await ensureGmailWatch({ ...d, now: 5 * 3_600_000 })).toBe('fresh');
  });

  it('skips, saying why, with no project named, no mail grant, or a locally held grant pushes cannot reach', async () => {
    const cases: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
      [{ config: null }, 'unconfigured'], [{ doName: undefined }, 'unconfigured'], [{ resolve: async () => null }, 'no_mail_grant'],
      [{ resolve: async () => { throw new McpConnectError('scope_missing', 'no connected Google grant covers mail', 'mail'); } }, 'no_mail_grant'],
      [{ resolve: async () => ({ mode: 'bearer' as const, token: 'ya29.t' }) }, 'local_rail'],
    ];
    for (const [over, reason] of cases) {
      const d = deps(over);
      expect(await ensureGmailWatch(d)).toEqual({ skipped: reason });
      expect(d.proxy.gmailWatch).not.toHaveBeenCalled();
    }
  });
});

describe('Gmail watch after a new grant', () => {
  const proxyTo = (connection: string) => async () => ({ mode: 'proxy' as const, connection });

  it('a reset forgets a live watch, so the next sweep watches the connection it now resolves and pushes follow it', async () => {
    const gmailWatch = vi.fn(async () => ({ historyId: '700', expiration: 7 * DAY }));
    const book = gmailPushBook(kv());
    const d = { book, now: 0, config, doName: 'owner-a', resolve: proxyTo('conn-1'), proxy: { gmailWatch } };
    expect(await ensureGmailWatch(d)).toBe('started');
    book.reset();
    expect(book.state()).toBeNull();
    expect(book.admit('conn-1', '701')).toBe('ignore');
    expect(await ensureGmailWatch({ ...d, now: 600_000, resolve: proxyTo('conn-2') })).toBe('started');
    expect(gmailWatch).toHaveBeenLastCalledWith('owner-a', 'conn-2', config.topic);
    expect(book.admit('conn-1', '702')).toBe('ignore');
    expect(book.admit('conn-2', '702')).toBe('wake');
  });

  it('a reset forgets a stored skip, so the next sweep tries at once instead of six hours later', async () => {
    const gmailWatch = vi.fn(async () => ({ historyId: '700', expiration: 7 * DAY }));
    const book = gmailPushBook(kv());
    const d = { book, now: 0, config, doName: 'owner-a', resolve: async () => ({ mode: 'bearer' as const, token: 'ya29.t' }), proxy: { gmailWatch } };
    expect(await ensureGmailWatch(d)).toEqual({ skipped: 'local_rail' });
    expect(await ensureGmailWatch({ ...d, now: 600_000, resolve: proxyTo('conn-2') })).toBe('fresh');
    book.reset();
    expect(await ensureGmailWatch({ ...d, now: 600_000, resolve: proxyTo('conn-2') })).toBe('started');
    expect(gmailWatch).toHaveBeenCalledWith('owner-a', 'conn-2', config.topic);
  });
});
