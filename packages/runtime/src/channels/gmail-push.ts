import { gmailWatchDue, type GmailPushConfig, type GmailWatch, type GmailWatchState } from '../connectors/google-push';
import type { McpGoogleResolution } from '../tools/live/mcp';

// The owner's Gmail watch. A push only pulls the existing update sweep forward (wakeBriefSweep), like a
// Calendar push. Pushes are routed through the connections table, so only a Vault-backed grant is watched.
type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void }>;
type Stored = Readonly<{ connection: string; historyId: string; startedAt: number; expiration: number }> | Readonly<{ failedAt: number }>;
const KEY = 'gmail_push';

export const gmailPushBook = (kv: Kv) => {
  const read = () => kv.get<Stored>(KEY) ?? null;
  return {
    state: (): GmailWatchState | null => { const stored = read(); return stored === null ? null : 'failedAt' in stored ? { failedAt: stored.failedAt } : { startedAt: stored.startedAt, expiration: stored.expiration }; },
    record: (watch: GmailWatch, connection: string, now: number) => kv.put(KEY, { connection, historyId: watch.historyId, startedAt: now, expiration: watch.expiration }),
    fail: (now: number) => kv.put(KEY, { failedAt: now }),
    // History ids only grow per mailbox: an equal or older one is a redelivery or an out-of-order push.
    admit: (connection: string, historyId: string): 'wake' | 'ignore' => {
      const stored = read();
      if (!stored || 'failedAt' in stored || stored.connection !== connection || !/^\d{1,30}$/.test(historyId) || BigInt(historyId) <= BigInt(stored.historyId)) return 'ignore';
      kv.put(KEY, { ...stored, historyId });
      return 'wake';
    },
  };
};
export type GmailPushBook = ReturnType<typeof gmailPushBook>;

type WatchProxy = Readonly<{
  gmailWatch(doName: string, connection: string, topic: string): Promise<GmailWatch>;
}>;

export const ensureGmailWatch = async (deps: Readonly<{
  book: GmailPushBook; now: number; config: GmailPushConfig | null; doName: string | undefined;
  resolve(): Promise<McpGoogleResolution | null>; proxy: WatchProxy | null;
}>): Promise<'fresh' | 'started' | 'failed' | 'skipped'> => {
  const { book, now } = deps;
  if (!gmailWatchDue(book.state(), now)) return 'fresh';
  if (!deps.config || !deps.doName || !deps.proxy) return 'skipped';
  try {
    const route = await deps.resolve();
    // Nothing to watch with: wait as after a failure, instead of looking up the grant on every sweep.
    if (route === null || route.mode !== 'proxy') { book.fail(now); return 'skipped'; }
    // A previous mailbox's watch is left to lapse within seven days: Gmail keeps one watch per mailbox, which
    // another owner of the same mailbox may still rely on.
    book.record(await deps.proxy.gmailWatch(deps.doName, route.connection, deps.config.topic), route.connection, now);
    return 'started';
  } catch {
    book.fail(now);
    return 'failed';
  }
};
