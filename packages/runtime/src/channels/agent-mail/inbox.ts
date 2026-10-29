import { hex } from '../../identity/owner-directory';

// Owner-DO side of agent mail. One synchronous transaction decides each delivery: a message already admitted is a
// duplicate, mail that is neither from the owner's directory address nor in a thread Waldo knows is cold, and mail over the
// day's cap is counted. Only an admitted message is written: its row, its raw bytes (held until its turn closes), its
// thread-map entry and the wake. The alarm runs the turn; a running row found after a restart is closed, never run again.

export const AGENT_MAIL_DUE_KEY = 'agent_mail_due_v1';
// A cost and abuse bound on mail-started turns per owner per UTC day, not a judgment of which mail matters. No staging
// traffic exists yet to set it from; 50 is above a heavy cc day and far below a flood.
export const AGENT_MAIL_DAILY_TURNS = 50;
// Cloudflare Email Routing refuses inbound mail over 25 MiB, so nothing larger reaches the Worker.
export const AGENT_MAIL_RAW_MAX = 25 * 1024 * 1024;
// A SQLite row in a Durable Object holds at most 2 MB, so the raw message is kept in chunks under that.
const CHUNK = 1024 * 1024;
// An admitted row that cannot run (no surface to answer on, a directory that keeps failing) holds the mail's bytes; past
// this hold it expires and the bytes go. A day covers an outage; the owner's own inbox still has the mail.
export const AGENT_MAIL_HOLD_MS = 24 * 60 * 60_000;
// A finished row keeps only its dedup digest, for this long; a provider redelivers within hours.
export const AGENT_MAIL_RETENTION_MS = 30 * 24 * 60 * 60_000;
const COUNTS_KEY = 'agent_mail_counts_v1';
const COUNTS_KEPT_DAYS = 30;
// References can name a thread's whole history; the newest ids are the ones a reply names.
export const AGENT_MAIL_REFERENCES_MAX = 100;

export type AgentMailDelivery = Readonly<{
  handle: string;
  // Header Message-ID, In-Reply-To and References, angle brackets removed. Null when the header is absent.
  messageId: string | null;
  inReplyTo: readonly string[];
  references: readonly string[];
  // Every address in the From header. Mail with more than one is never the owner's.
  from: readonly string[];
  // The directory's confirmed sign-in address for this owner, or null when there is none.
  ownerEmail: string | null;
  raw: Uint8Array;
}>;
export type AgentMailBasis = 'owner_from' | 'thread';
export type AgentMailAdmission = 'admitted' | 'duplicate' | 'cold_dropped' | 'over_cap';
export type AgentMailRow = Readonly<{ id: string; handle: string; basis: AgentMailBasis; state: string; attempt: string | null; admitted_at: number }>;
type Counts = Record<string, Partial<Record<'admitted' | 'cold' | 'over_cap', number>>>;

const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);
const digest = async (bytes: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', bytes));

export const agentMailInbox = (storage: Pick<DurableObjectStorage, 'sql' | 'kv' | 'transactionSync'>, now = Date.now) => {
  const { sql, kv } = storage;
  sql.exec(`CREATE TABLE IF NOT EXISTS agent_mail_inbox (
    id TEXT PRIMARY KEY, dedup TEXT NOT NULL UNIQUE, handle TEXT NOT NULL, basis TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('admitted', 'running', 'completed', 'interrupted', 'closed', 'expired')),
    attempt TEXT, admitted_at INTEGER NOT NULL, closed_at INTEGER)`);
  sql.exec('CREATE TABLE IF NOT EXISTS agent_mail_raw (inbox_id TEXT NOT NULL, seq INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (inbox_id, seq))');
  // The thread map: which Message-IDs Waldo was sent or sent, and the thread each belongs to. No bodies, subjects or names.
  sql.exec(`CREATE TABLE IF NOT EXISTS agent_mail_threads (
    message_id TEXT PRIMARY KEY, direction TEXT NOT NULL CHECK (direction IN ('in', 'out')), at INTEGER NOT NULL, thread TEXT NOT NULL)`);

  const counts = (): Counts => kv.get<Counts>(COUNTS_KEY) ?? {};
  const count = (at: number, field: 'admitted' | 'cold' | 'over_cap') => {
    const all = counts(), day = dayOf(at);
    const kept = Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b)).slice(-COUNTS_KEPT_DAYS + 1));
    kv.put(COUNTS_KEY, { ...kept, [day]: { ...kept[day], [field]: (kept[day]?.[field] ?? 0) + 1 } });
  };
  const rearm = () => {
    const open = sql.exec("SELECT 1 FROM agent_mail_inbox WHERE state = 'admitted' LIMIT 1").toArray().length > 0;
    kv.put(AGENT_MAIL_DUE_KEY, open ? now() + 250 : null);
  };
  const close = (id: string, state: 'completed' | 'interrupted' | 'closed' | 'expired') => {
    sql.exec('UPDATE agent_mail_inbox SET state = ?, closed_at = ? WHERE id = ?', state, now(), id);
    sql.exec('DELETE FROM agent_mail_raw WHERE inbox_id = ?', id);
  };
  const knownThread = (ids: readonly string[]): string | null => {
    for (const id of ids) {
      const row = sql.exec<{ thread: string }>('SELECT thread FROM agent_mail_threads WHERE message_id = ?', id).toArray()[0];
      if (row) return row.thread;
    }
    return null;
  };

  return {
    async admit(mail: AgentMailDelivery): Promise<AgentMailAdmission> {
      if (mail.raw.byteLength > AGENT_MAIL_RAW_MAX) throw new Error('agent mail over the inbound limit');
      const dedup = mail.messageId === null ? `raw:${await digest(mail.raw)}` : `id:${await digest(new TextEncoder().encode(JSON.stringify([mail.handle, mail.messageId])))}`;
      const parents = [...mail.inReplyTo, ...mail.references.slice(-AGENT_MAIL_REFERENCES_MAX)];
      return storage.transactionSync(() => {
        const at = now();
        if (sql.exec('SELECT 1 FROM agent_mail_inbox WHERE dedup = ?', dedup).toArray().length) return 'duplicate';
        const ownerFrom = mail.ownerEmail !== null && mail.from.length === 1 && mail.from[0]!.toLowerCase() === mail.ownerEmail.toLowerCase();
        const thread = knownThread(parents);
        if (!ownerFrom && thread === null) { count(at, 'cold'); return 'cold_dropped'; }
        if ((counts()[dayOf(at)]?.admitted ?? 0) >= AGENT_MAIL_DAILY_TURNS) { count(at, 'over_cap'); return 'over_cap'; }
        sql.exec("DELETE FROM agent_mail_inbox WHERE state NOT IN ('admitted', 'running') AND closed_at < ?", at - AGENT_MAIL_RETENTION_MS);
        const id = `mail-${crypto.randomUUID()}`;
        sql.exec("INSERT INTO agent_mail_inbox (id, dedup, handle, basis, state, admitted_at) VALUES (?, ?, ?, ?, 'admitted', ?)",
          id, dedup, mail.handle, ownerFrom ? 'owner_from' : 'thread', at);
        for (let seq = 0, offset = 0; offset < mail.raw.byteLength; seq++, offset += CHUNK) {
          sql.exec('INSERT INTO agent_mail_raw (inbox_id, seq, bytes) VALUES (?, ?, ?)', id, seq, mail.raw.subarray(offset, offset + CHUNK));
        }
        if (mail.messageId !== null) {
          sql.exec('INSERT OR IGNORE INTO agent_mail_threads (message_id, direction, at, thread) VALUES (?, ?, ?, ?)',
            mail.messageId, 'in', at, thread ?? mail.references[0] ?? mail.inReplyTo[0] ?? mail.messageId);
        }
        count(at, 'admitted');
        kv.put(AGENT_MAIL_DUE_KEY, at + 250);
        return 'admitted';
      });
    },
    pending: (): AgentMailRow[] => sql.exec<AgentMailRow>("SELECT id, handle, basis, state, attempt, admitted_at FROM agent_mail_inbox WHERE state = 'admitted' ORDER BY admitted_at, id LIMIT 20").toArray(),
    get: (id: string): AgentMailRow | null => sql.exec<AgentMailRow>('SELECT id, handle, basis, state, attempt, admitted_at FROM agent_mail_inbox WHERE id = ?', id).toArray()[0] ?? null,
    // Intent before the turn: a row taken here is never run again, whatever happens to this attempt.
    claim(id: string): AgentMailRow | null {
      return storage.transactionSync(() => {
        const attempt = crypto.randomUUID();
        sql.exec("UPDATE agent_mail_inbox SET state = 'running', attempt = ? WHERE id = ? AND state = 'admitted'", attempt, id);
        const row = sql.exec<AgentMailRow>("SELECT id, handle, basis, state, attempt, admitted_at FROM agent_mail_inbox WHERE id = ? AND state = 'running' AND attempt = ?", id, attempt).toArray()[0] ?? null;
        rearm();
        return row;
      });
    },
    raw(id: string): Uint8Array {
      const chunks = sql.exec<{ bytes: ArrayBuffer }>('SELECT bytes FROM agent_mail_raw WHERE inbox_id = ? ORDER BY seq', id).toArray().map(row => new Uint8Array(row.bytes));
      const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
      return out;
    },
    // Called inside the transaction that queues the message the owner gets about this row.
    finish(row: AgentMailRow, state: 'completed' | 'interrupted' = 'completed'): void {
      const current = sql.exec("SELECT 1 FROM agent_mail_inbox WHERE id = ? AND state = 'running' AND attempt = ?", row.id, row.attempt).toArray().length;
      if (!current) throw new Error('agent mail row is no longer this attempt');
      close(row.id, state);
    },
    // A turn that said nothing, a turn that failed, or a handle that no longer routes here: the row closes with its bytes
    // gone and never runs again.
    end(row: AgentMailRow, state: 'completed' | 'interrupted' | 'closed'): void {
      storage.transactionSync(() => { if (sql.exec("SELECT 1 FROM agent_mail_inbox WHERE id = ? AND state IN ('admitted', 'running')", row.id).toArray().length) close(row.id, state); rearm(); });
    },
    // Rows left running by an attempt this process does not hold were cut off mid-turn: they may have acted, so they close.
    recover(live: ReadonlySet<string>): number {
      return storage.transactionSync(() => {
        const lost = sql.exec<{ id: string; attempt: string }>("SELECT id, attempt FROM agent_mail_inbox WHERE state = 'running'").toArray().filter(row => !live.has(row.attempt));
        for (const row of lost) close(row.id, 'interrupted');
        rearm();
        return lost.length;
      });
    },
    // Closes every admitted row past the hold, with its bytes. The wake is re-armed only when one closed, so a backoff set by
    // retryLater stands.
    expire(): number {
      return storage.transactionSync(() => {
        const old = sql.exec<{ id: string }>("SELECT id FROM agent_mail_inbox WHERE state = 'admitted' AND admitted_at <= ?", now() - AGENT_MAIL_HOLD_MS).toArray();
        for (const row of old) close(row.id, 'expired');
        if (old.length) rearm();
        return old.length;
      });
    },
    retryLater(ms: number): void { kv.put(AGENT_MAIL_DUE_KEY, now() + ms); },
    counts,
  };
};
export type AgentMailInbox = ReturnType<typeof agentMailInbox>;
