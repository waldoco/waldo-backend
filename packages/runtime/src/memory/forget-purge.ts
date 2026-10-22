import { textFingerprint, type ClaimStore } from './claims';

// The background half of a forget. The forget itself deletes the owner's claims and keeps custody of every text it must
// still clean; from then on the forget barrier keeps those texts out of the model's view, so nothing waits on this job.
// The job is the one retry owner: it cleans each store outside the claims table, records a receipt per store, and settles
// a text (drops its custody row) only when every store reads back clean.

// One durable store a forget cleans. run removes the texts and returns how many copies it could not clean; a clean store
// returns 0, so running it again is safe.
export type ForgetStore = Readonly<{ name: string; run: (texts: readonly string[]) => number | Promise<number> }>;
export type ForgetHold = Readonly<{
  fingerprint: string;
  // The topic masked to its first character and length: the owner's own word, still in custody, shown without repeating it.
  label: string;
  started_at: string;
  stores: readonly Readonly<{ name: string; state: 'pending' | 'done'; attempts: number }>[];
}>;

export const FORGET_PURGE_ID = 'forget-purge';
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 60 * 60_000;
export const forgetPurgeDelay = (attempts: number): number => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));

export const FORGET_PURGE_STEPS_DDL = `CREATE TABLE IF NOT EXISTS forget_purge_steps (
  fingerprint TEXT NOT NULL, store TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending', 'done')),
  attempts INTEGER NOT NULL DEFAULT 0, last_code TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (fingerprint, store))`;

const mask = (topic: string): string => `${[...topic][0] ?? ''}${'·'.repeat(Math.min(8, Math.max(0, [...topic].length - 1)))} (${[...topic].length})`;

type Row = Readonly<{ fingerprint: string; topic: string; created_at: string }>;
type Step = Readonly<{ store: string; state: 'pending' | 'done'; attempts: number }>;

export const forgetPurge = ({ sql, store, stores, now, arm, log }: Readonly<{
  sql: Pick<SqlStorage, 'exec'>;
  store: Pick<ClaimStore, 'claims' | 'purge' | 'settle'>;
  stores: readonly ForgetStore[];
  now: () => number;
  arm: (at: number) => Promise<void>;
  // Content-free: a count, never a topic or an error text, which could quote the topic.
  log?: (event: Readonly<{ hop: 'forget_settled' | 'forget_pending'; detail: string }>) => void;
}>) => {
  sql.exec(FORGET_PURGE_STEPS_DDL);
  const held = (): Row[] => sql.exec<Row>('SELECT fingerprint, topic, created_at FROM topic_purge_pending ORDER BY created_at, fingerprint').toArray();
  const steps = (fingerprint: string): Step[] => sql.exec<Step>('SELECT store, state, attempts FROM forget_purge_steps WHERE fingerprint = ? ORDER BY store', fingerprint).toArray();
  const iso = () => new Date(now()).toISOString();

  const track = (texts: readonly string[]): void => {
    for (const text of new Set(texts.map((value) => value.trim()).filter(Boolean))) {
      sql.exec('INSERT OR IGNORE INTO topic_purge_pending (fingerprint, topic, created_at) VALUES (?, ?, ?)', textFingerprint(text), text, iso());
    }
  };

  return {
    // Keep custody of what a forget must still clean, then wake the job. Nothing is cleaned here.
    async track(texts: readonly string[]): Promise<void> {
      track(texts);
      await arm(now());
    },

    async run(): Promise<Readonly<{ settled: number; pending: number }>> {
      // Claims a nightly pass or the console marked for removal join as texts in custody; the claims go now.
      const purging = store.claims('purging').map((claim) => claim.id);
      if (purging.length) {
        const purged = store.purge(purging, iso());
        track(purged.texts);
        if (purged.ready) store.settle(purging);
      }
      let settled = 0, pending = 0, attempts = 0;
      for (const row of held()) {
        for (const each of stores) sql.exec("INSERT OR IGNORE INTO forget_purge_steps (fingerprint, store, state, updated_at) VALUES (?, ?, 'pending', ?)", row.fingerprint, each.name, now());
        for (const step of steps(row.fingerprint).filter((entry) => entry.state === 'pending')) {
          const each = stores.find((candidate) => candidate.name === step.store);
          let code: string | null = null;
          try { if (each && await each.run([row.topic]) > 0) code = 'remaining'; } catch { code = 'failed'; }
          if (code === null) sql.exec("UPDATE forget_purge_steps SET state = 'done', last_code = NULL, updated_at = ? WHERE fingerprint = ? AND store = ?", now(), row.fingerprint, step.store);
          else sql.exec('UPDATE forget_purge_steps SET attempts = attempts + 1, last_code = ?, updated_at = ? WHERE fingerprint = ? AND store = ?', code, now(), row.fingerprint, step.store);
        }
        const open = steps(row.fingerprint).filter((entry) => entry.state === 'pending');
        // The claims table and its derived rows are read back by the purge itself; it is the last store to agree.
        if (open.length === 0 && store.purge([], iso(), [row.topic]).ready) {
          store.settle([], [row.topic]);
          sql.exec('DELETE FROM forget_purge_steps WHERE fingerprint = ?', row.fingerprint);
          settled += 1;
        } else {
          pending += 1;
          attempts = Math.max(attempts, ...open.map((entry) => entry.attempts), 1);
        }
      }
      if (settled) log?.({ hop: 'forget_settled', detail: `topics=${settled}` });
      if (pending) {
        log?.({ hop: 'forget_pending', detail: `topics=${pending}` });
        await arm(now() + forgetPurgeDelay(attempts));
      }
      return { settled, pending };
    },

    status(): readonly ForgetHold[] {
      return held().map((row) => ({
        fingerprint: row.fingerprint, label: mask(row.topic), started_at: row.created_at,
        stores: steps(row.fingerprint).map((step) => ({ name: step.store, state: step.state, attempts: step.attempts })),
      }));
    },

    // The owner's retry: the held topic's stores start their back-off again and the job runs now.
    async retry(fingerprint: string): Promise<boolean> {
      if (!held().some((row) => row.fingerprint === fingerprint)) return false;
      sql.exec("UPDATE forget_purge_steps SET attempts = 0, updated_at = ? WHERE fingerprint = ? AND state = 'pending'", now(), fingerprint);
      await arm(now());
      return true;
    },
  };
};

export type ForgetPurge = ReturnType<typeof forgetPurge>;
