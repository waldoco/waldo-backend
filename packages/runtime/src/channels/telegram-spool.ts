import { armAlarm } from '../scheduler/alarm-slot';

// Telegram ingress spool (durable-before-ack): the webhook acks only after the update is
// durably recorded here; processing drains the spool asynchronously. One key per update_id
// so Telegram redeliveries dedupe at write time; the offset check stays the processed-side
// dedupe. The retry wake composes with the scheduler alarm: an existing earlier alarm is
// never pushed out, and the alarm handler re-asserts the wake after dispatchDue's rearm.
export const TELEGRAM_SPOOL_PREFIX = 'tg_spool:';
const SPOOL_RETRY_MS = 30_000;
const OFFSET_KEY = 'offset';

export type SpoolRecord = 'spooled' | 'duplicate' | 'processed';

export type TelegramSpool = {
  record: (updateId: number, body: string) => Promise<SpoolRecord>;
  drain: () => Promise<void>;
  pending: () => Promise<number>;
  ensureWake: () => Promise<void>;
};

export const telegramSpool = (
  storage: DurableObjectStorage,
  process: (update: unknown) => Promise<void>,
  now: () => number = Date.now,
): TelegramSpool => ({
  async record(updateId, body) {
    const offset = (await storage.get<number>(OFFSET_KEY)) ?? 0;
    if (updateId < offset) return 'processed';
    const key = `${TELEGRAM_SPOOL_PREFIX}${updateId}`;
    if ((await storage.get<string>(key)) !== undefined) return 'duplicate';
    await storage.put(key, body);
    return 'spooled';
  },

  // Oldest-first; a failed entry stays and stops the pass so ordering holds. The caller
  // (ingress wake or alarm handler) is responsible for the retry wake.
  async drain() {
    const entries = [...(await storage.list<string>({ prefix: TELEGRAM_SPOOL_PREFIX }))]
      .map(([key, body]) => ({ key, id: Number(key.slice(TELEGRAM_SPOOL_PREFIX.length)), body }))
      .sort((a, b) => a.id - b.id);
    for (const entry of entries) {
      try {
        await process(JSON.parse(entry.body));
        await storage.delete(entry.key);
      } catch (error) {
        console.log(JSON.stringify({ trace: `tg-${entry.id}`, hop: 'spool_drain', ok: false, error: String(error) }));
        return;
      }
    }
  },

  async pending() {
    return (await storage.list({ prefix: TELEGRAM_SPOOL_PREFIX, limit: 1 })).size;
  },

  async ensureWake() {
    const retryAt = now() + SPOOL_RETRY_MS;
    const current = await storage.getAlarm();
    if (current === null || current > retryAt) await armAlarm(storage, retryAt);
  },
});
