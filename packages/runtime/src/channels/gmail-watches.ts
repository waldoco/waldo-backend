import { gmailWatchDue, type GmailPushConfig, type GmailWatch, type GmailWatchState } from '../connectors/google-push';
import type { GmailWatchMiss } from './gmail-push';

// GOOGLE_REALTIME_TRIAGE: one Gmail watch per connected mail account. Pushes are routed by mailbox through the connections
// table, which hands this object the account's connection: a push marks just that mailbox to be read. An account held the
// older way (a raw token here) has no connection row, so it cannot be watched and is read on the poll.
type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void }>;
type Stored = Readonly<{ historyId: string; startedAt: number; expiration: number }> | Readonly<{ failedAt: number; reason: GmailWatchMiss }>;
const KEY = 'gmail_watches_v1';

export const gmailWatchesBook = (kv: Kv) => {
  const read = (): Record<string, Stored> => kv.get<Record<string, Stored>>(KEY) ?? {};
  const put = (account: string, stored: Stored | null) => {
    const { [account]: _old, ...rest } = read();
    kv.put(KEY, stored === null ? rest : { ...rest, [account]: stored });
  };
  return {
    accounts: (): readonly string[] => Object.keys(read()),
    state: (account: string): GmailWatchState | null => {
      const stored = read()[account];
      return !stored ? null : 'failedAt' in stored ? { failedAt: stored.failedAt } : { startedAt: stored.startedAt, expiration: stored.expiration };
    },
    record: (account: string, watch: GmailWatch, now: number) => put(account, { historyId: watch.historyId, startedAt: now, expiration: watch.expiration }),
    fail: (account: string, now: number, reason: GmailWatchMiss = 'failed') => put(account, { failedAt: now, reason }),
    forget: (account: string) => put(account, null),
    misses: (): readonly Readonly<{ account: string; at: number; reason: GmailWatchMiss }>[] =>
      Object.entries(read()).flatMap(([account, stored]) => 'failedAt' in stored ? [{ account, at: stored.failedAt, reason: stored.reason }] : []),
    // The account a push is for. History ids only grow per mailbox: an equal or older one is a redelivery or out of order.
    admit: (connection: string, historyId: string): string | null => {
      const stored = read()[connection];
      if (!stored || 'failedAt' in stored || !/^\d{1,30}$/.test(historyId) || BigInt(historyId) <= BigInt(stored.historyId)) return null;
      put(connection, { ...stored, historyId });
      return connection;
    },
  };
};
export type GmailWatchesBook = ReturnType<typeof gmailWatchesBook>;

export type GmailWatchesOutcome = Readonly<{ started: number; failed: number; skipped: number; fresh: number }> | 'skipped';

export const ensureGmailWatches = async (deps: Readonly<{
  book: GmailWatchesBook; now: number; config: GmailPushConfig | null; doName: string | undefined;
  proxy: Readonly<{ gmailWatch(doName: string, connection: string, topic: string): Promise<GmailWatch> }> | null;
  // The mail-scoped accounts read, in connect order.
  accounts: readonly Readonly<{ id: string; local: boolean }>[];
}>): Promise<GmailWatchesOutcome> => {
  const { book, now } = deps;
  if (!deps.config || !deps.doName || !deps.proxy) return 'skipped';
  let started = 0, failed = 0, skipped = 0, fresh = 0;
  for (const account of deps.accounts) {
    if (!gmailWatchDue(book.state(account.id), now)) { fresh += 1; continue; }
    if (account.local) { book.fail(account.id, now, 'local_rail'); skipped += 1; continue; }
    try {
      book.record(account.id, await deps.proxy.gmailWatch(deps.doName, account.id, deps.config.topic), now);
      started += 1;
    } catch {
      book.fail(account.id, now);
      failed += 1;
    }
  }
  // A mailbox no longer read is forgotten, so its pushes wake nothing; Gmail lets its watch lapse within seven days.
  for (const account of book.accounts().filter(id => !deps.accounts.some(known => known.id === id))) book.forget(account);
  return { started, failed, skipped, fresh };
};
