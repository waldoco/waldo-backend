import { armAlarm } from '../scheduler/alarm-slot';

// Telegram ingress spool (durable-before-ack): the webhook acks only after the update is
// durably recorded here; processing drains the spool asynchronously. One key per update_id
// so Telegram redeliveries dedupe at write time; the offset check stays the processed-side
// dedupe. The retry wake composes with the scheduler alarm: an existing earlier alarm is
// never pushed out, and the alarm handler re-asserts the wake after dispatchDue's rearm.
export const TELEGRAM_SPOOL_PREFIX = 'tg_spool:';
const SPOOL_RETRY_MS = 30_000;
const OFFSET_KEY = 'offset';

// Bounds: at most SPOOL_MAX_ENTRIES queued updates and SPOOL_MAX_BODY_BYTES per update - the
// spool is durable owner storage, not an unbounded ingest buffer. A failed entry is retried
// with an attempt counter and DROPPED (body included) after SPOOL_MAX_ATTEMPTS: a poison update
// must not pin its raw body in storage forever.
export const SPOOL_MAX_ENTRIES = 100;
export const SPOOL_MAX_BODY_BYTES = 64 * 1024;
export const SPOOL_MAX_ATTEMPTS = 5;
type SpoolEntry = Readonly<{ body: string; attempts: number }>;

export type SpoolRecord = 'spooled' | 'duplicate' | 'processed' | 'full' | 'too_large';

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
    if ((await storage.get<SpoolEntry>(key)) !== undefined) return 'duplicate';
    // Oversize bodies are never stored: acked and dropped by the caller with a typed log, so a
    // malformed update cannot pin storage or loop forever.
    if (body.length > SPOOL_MAX_BODY_BYTES) return 'too_large';
    // Queue bound: refuse before writing; the caller does NOT ack, so Telegram redelivers after
    // the drain makes room.
    if ((await storage.list({ prefix: TELEGRAM_SPOOL_PREFIX, limit: SPOOL_MAX_ENTRIES })).size >= SPOOL_MAX_ENTRIES) return 'full';
    await storage.put(key, { body, attempts: 0 } satisfies SpoolEntry);
    return 'spooled';
  },

  // Oldest-first; a failed entry stays and stops the pass so ordering holds. The caller
  // (ingress wake or alarm handler) is responsible for the retry wake.
  async drain() {
    const entries = [...(await storage.list<SpoolEntry>({ prefix: TELEGRAM_SPOOL_PREFIX }))]
      .map(([key, value]) => ({ key, id: Number(key.slice(TELEGRAM_SPOOL_PREFIX.length)), value }))
      .sort((a, b) => a.id - b.id);
    for (const entry of entries) {
      try {
        await process(JSON.parse(entry.value.body));
        await storage.delete(entry.key);
      } catch (error) {
        // Bounded retries with an attempt counter; the final failure deletes the entry, body
        // included, and logs the drop - a failed raw body never stays in storage past that.
        console.log(JSON.stringify({ trace: `tg-${entry.id}`, hop: 'spool_drain', ok: false, error: String(error) }));
        const attempts = entry.value.attempts + 1;
        if (attempts >= SPOOL_MAX_ATTEMPTS) {
          await storage.delete(entry.key);
          console.log(JSON.stringify({ trace: `tg-${entry.id}`, hop: 'spool_drop', ok: false, detail: `dropped after ${attempts} attempts` }));
        } else {
          await storage.put(entry.key, { body: entry.value.body, attempts } satisfies SpoolEntry);
        }
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
