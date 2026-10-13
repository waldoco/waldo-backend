import { describe, expect, it, vi } from 'vitest';
import { ensureGmailWatch, gmailPushBook } from '../src/channels/gmail-push';
import { gmailPush } from '../src/connectors/google-push';

const kv = () => { const map = new Map<string, unknown>(); return { get: <T>(key: string) => map.get(key) as T | undefined, put: (key: string, value: unknown) => { map.set(key, value); } }; };
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
    expect(await ensureGmailWatch(d)).toBe('skipped');
    expect(await ensureGmailWatch({ ...d, now: 3_600_000 })).toBe('fresh');
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('a failed start leaves the poll in charge and waits six hours', async () => {
    const d = deps({ proxy: { gmailWatch: vi.fn(async () => { throw new Error('refused'); }) } });
    expect(await ensureGmailWatch(d)).toBe('failed');
    expect(await ensureGmailWatch({ ...d, now: 5 * 3_600_000 })).toBe('fresh');
  });

  it('skips with no project named, no Google account, or a locally held grant pushes cannot reach', async () => {
    for (const over of [{ config: null }, { resolve: async () => null }, { resolve: async () => ({ mode: 'bearer' as const, token: 'ya29.t' }) }, { doName: undefined }]) {
      const d = deps(over);
      expect(await ensureGmailWatch(d)).toBe('skipped');
      expect(d.proxy.gmailWatch).not.toHaveBeenCalled();
    }
  });
});
