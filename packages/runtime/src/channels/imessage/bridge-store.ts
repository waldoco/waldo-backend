import { iMessageCapabilitiesSchema, iMessageCommandSchema, iMessageEventSchema, iMessageResultSchema, type IMessageCapabilities, type IMessageEvent, type IMessageResult } from '@waldo/contracts';
import type { IMessageConnectorPolicy } from './policy';
import type { Commitment, S2Headers } from './crypto';

// Durable, transactional state of ONE bridge/account. Every mutation runs inside a single
// transactionSync; a thrown error (including backpressure) rolls the whole step back.
// Semantics mirror packages/imessage-relay (SignedRelay + CommandMailbox) with Worker storage.

export type EventState = 'pending' | 'handed' | 'acknowledged' | 'held';
export type DeliveryState = 'queued' | 'delivered' | 'resulted' | 'withdrawn';
export type DeliveryRow = {
  deliveryId: string; commandId: string; commandDigest: string; body: string; headers: S2Headers; commitment: Commitment;
  state: DeliveryState; attempt: number; result: IMessageResult | null; createdAtMs: number; deliveredAtMs: number | null;
  ownerDoName: string; replyRef: string; reported: boolean;
};
export type StoredEvent = { seq: number; generation: string; eventId: string; digest: string; body: string; state: EventState; kind: IMessageEvent['kind'] };

export class BridgeStoreError extends Error {
  constructor(readonly code: 'nonce_replay' | 'event_conflict' | 'generation_mismatch' | 'backpressure' | 'heartbeat_replay'
    | 'outstanding_command' | 'command_conflict' | 'result_mismatch' | 'result_conflict' | 'message_conflict' | 'lane_quarantined') { super(code); }
}

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS nonces(nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)',
  `CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, generation TEXT NOT NULL, event_id TEXT NOT NULL, digest TEXT NOT NULL,
    body TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','handed','acknowledged','held')), reason TEXT,
    created_at INTEGER NOT NULL, UNIQUE(generation, event_id))`,
  `CREATE TABLE IF NOT EXISTS deliveries(delivery_id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, command_digest TEXT NOT NULL, body TEXT NOT NULL,
    headers TEXT NOT NULL, commitment TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','delivered','resulted','withdrawn')), attempt INTEGER NOT NULL,
    result TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER, owner_do TEXT NOT NULL, reply_ref TEXT NOT NULL, reported INTEGER NOT NULL DEFAULT 0)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS one_outstanding ON deliveries((1)) WHERE state IN ('queued','delivered')",
  'CREATE TABLE IF NOT EXISTS result_conflicts(delivery_id TEXT NOT NULL, result_digest TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(delivery_id, result_digest))',
  'CREATE TABLE IF NOT EXISTS sent_messages(message_guid TEXT PRIMARY KEY, command_id TEXT NOT NULL, state TEXT NOT NULL)',
];

type Sql = SqlStorage;
type Row = Record<string, SqlStorageValue>;

export class BridgeStore {
  constructor(private storage: DurableObjectStorage, private policy: IMessageConnectorPolicy, private now: () => number = () => Date.now()) {
    for (const statement of SCHEMA) this.sql.exec(statement);
  }
  private get sql(): Sql { return this.storage.sql; }
  private rows(query: string, ...args: SqlStorageValue[]): Row[] { return this.sql.exec(query, ...args).toArray() as Row[]; }
  meta(key: string): string | null { return (this.rows('SELECT value FROM meta WHERE key=?', key)[0]?.value as string | undefined) ?? null; }
  private setMeta(key: string, value: string | null) {
    if (value === null) this.sql.exec('DELETE FROM meta WHERE key=?', key);
    else this.sql.exec('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value);
  }

  /** Runs one step atomically and enforces retained record/byte bounds before commit. */
  tx<T>(work: () => T): T {
    return this.storage.transactionSync(() => {
      const result = work();
      this.enforceBounds();
      return result;
    });
  }
  private enforceBounds() {
    const count = (table: string) => Number(this.rows(`SELECT count(*) AS n FROM ${table}`)[0]!.n);
    const records = ['nonces', 'events', 'deliveries', 'result_conflicts', 'sent_messages', 'meta'].reduce((n, t) => n + count(t), 0);
    const bytes = Number(this.rows(`SELECT
      coalesce((SELECT sum(length(CAST(body AS BLOB))) FROM events),0) +
      coalesce((SELECT sum(length(CAST(body AS BLOB)) + length(CAST(headers AS BLOB)) + length(CAST(coalesce(result,'') AS BLOB))) FROM deliveries),0) +
      coalesce((SELECT sum(length(CAST(result AS BLOB))) FROM result_conflicts),0) +
      coalesce((SELECT sum(length(CAST(value AS BLOB))) FROM meta),0) AS n`)[0]!.n);
    if (records > this.policy.maxRecords || bytes > this.policy.maxRetainedBytes) throw new BridgeStoreError('backpressure');
  }

  /** Consumes a fresh nonce inside the caller's transaction. Only expired nonces are pruned. */
  consumeNonce(h: S2Headers) {
    this.sql.exec('DELETE FROM nonces WHERE expires_at < ?', this.now());
    if (this.rows('SELECT 1 FROM nonces WHERE nonce=?', h.nonce).length) throw new BridgeStoreError('nonce_replay');
    this.sql.exec('INSERT INTO nonces(nonce,expires_at) VALUES(?,?)', h.nonce, h.atMs + this.policy.signatureMaxAgeMs);
  }

  // ---- inbound events -------------------------------------------------------------------
  /** Commits identity + raw digest + payload + processing state before ACK. Identical retry = same receipt. */
  admitEvent(h: S2Headers, body: string, digest: string, event: IMessageEvent): { duplicate: boolean } {
    return this.tx(() => {
      const prior = this.rows('SELECT digest FROM events WHERE generation=? AND event_id=?', event.cursor.databaseGeneration, event.eventId)[0];
      if (prior) {
        if (prior.digest !== digest) throw new BridgeStoreError('event_conflict');
        return { duplicate: true };
      }
      const generation = this.meta('generation');
      if (generation !== null && generation !== event.cursor.databaseGeneration) throw new BridgeStoreError('generation_mismatch');
      this.consumeNonce(h);
      if (generation === null) this.setMeta('generation', event.cursor.databaseGeneration);
      this.sql.exec("INSERT INTO events(generation,event_id,digest,body,kind,state,created_at) VALUES(?,?,?,?,?,'pending',?)",
        event.cursor.databaseGeneration, event.eventId, digest, body, event.kind, this.now());
      this.setMeta('cursor', event.cursor.value);
      return { duplicate: false };
    });
  }
  nextPendingEvent(): StoredEvent | null {
    // Held rows are retained evidence (media, revoked scope); they never block later events.
    const row = this.rows("SELECT seq,generation,event_id,digest,body,state,kind FROM events WHERE state='pending' ORDER BY seq LIMIT 1")[0];
    return row ? { seq: Number(row.seq), generation: String(row.generation), eventId: String(row.event_id), digest: String(row.digest), body: String(row.body), state: row.state as EventState, kind: row.kind as IMessageEvent['kind'] } : null;
  }
  /** Handed = durably given to the owner inbox (which dedups); acknowledged = classified non-turn evidence. */
  settleEvent(seq: number, state: Exclude<EventState, 'pending'>, reason: string | null) {
    this.tx(() => this.sql.exec('UPDATE events SET state=?, reason=? WHERE seq=?', state, reason, seq));
  }
  eventCounts(): Record<EventState, number> {
    const out: Record<EventState, number> = { pending: 0, handed: 0, acknowledged: 0, held: 0 };
    for (const r of this.rows('SELECT state, count(*) AS n FROM events GROUP BY state')) out[r.state as EventState] = Number(r.n);
    return out;
  }

  // ---- heartbeat and capabilities -------------------------------------------------------
  heartbeat(h: S2Headers, generation: string, status: 'online' | 'offline') {
    this.tx(() => {
      const last = Number(this.meta('heartbeat_at') ?? '-1');
      if (h.atMs <= last) throw new BridgeStoreError('heartbeat_replay');
      this.consumeNonce(h);
      this.setMeta('heartbeat_at', String(h.atMs));
      this.setMeta('heartbeat_received_at', String(this.now()));
      this.setMeta('heartbeat_status', status);
      const current = this.meta('generation');
      if (current !== null && current !== generation) {
        // Replacement: reset the cursor, keep old evidence, drop stale capabilities and
        // withdraw only never-delivered commands. Delivered/uncertain work is untouched.
        this.setMeta('cursor', null);
        this.setMeta('capabilities', null);
        this.sql.exec("UPDATE deliveries SET state='withdrawn', result=? WHERE state='queued'", null);
        this.markWithdrawnResults('generation_replaced');
      }
      this.setMeta('generation', generation);
    });
  }
  online(): boolean {
    const at = Number(this.meta('heartbeat_received_at') ?? NaN);
    return this.meta('heartbeat_status') === 'online' && Number.isFinite(at) && this.now() >= at && this.now() - at <= this.policy.heartbeatMaxAgeMs;
  }
  reportCapabilities(h: S2Headers, report: IMessageCapabilities) {
    this.tx(() => {
      this.consumeNonce(h);
      this.setMeta('capabilities', JSON.stringify({ report, receivedAtMs: this.now() }));
    });
  }
  /** Missing, stale or wrong-account reports are null (= offline, everything disabled). */
  capabilities(bridgeId: string, accountId: string): IMessageCapabilities | null {
    const raw = this.meta('capabilities');
    if (!raw) return null;
    const { report, receivedAtMs } = JSON.parse(raw) as { report: unknown; receivedAtMs: number };
    const parsed = iMessageCapabilitiesSchema.safeParse(report);
    if (!parsed.success || parsed.data.bridgeId !== bridgeId || parsed.data.accountId !== accountId) return null;
    if (this.now() < receivedAtMs || this.now() - receivedAtMs > this.policy.capabilityMaxAgeMs) return null;
    return parsed.data;
  }
  generation(): string | null { return this.meta('generation'); }

  // ---- outbound mailbox -----------------------------------------------------------------
  quarantined(): boolean { return this.meta('quarantine') !== null; }
  private quarantine(reason: string) { if (!this.quarantined()) this.setMeta('quarantine', JSON.stringify({ reason, atMs: this.now() })); }

  /** Frozen reply bytes enter once per commandId; an identical retry returns the same row. */
  enqueue(input: { deliveryId: string; body: string; headers: S2Headers; commitment: Commitment; commandDigest: string; ownerDoName: string; replyRef: string }): DeliveryRow {
    return this.tx(() => {
      const command = iMessageCommandSchema.parse(JSON.parse(input.body));
      const prior = this.delivery({ commandId: command.commandId });
      if (prior) {
        if (prior.commandDigest !== input.commandDigest) throw new BridgeStoreError('command_conflict');
        return prior;
      }
      if (this.quarantined()) throw new BridgeStoreError('lane_quarantined');
      if (this.rows("SELECT 1 FROM deliveries WHERE state IN ('queued','delivered')").length) throw new BridgeStoreError('outstanding_command');
      this.sql.exec("INSERT INTO deliveries(delivery_id,command_id,command_digest,body,headers,commitment,state,attempt,created_at,owner_do,reply_ref) VALUES(?,?,?,?,?,?,'queued',0,?,?,?)",
        input.deliveryId, command.commandId, input.commandDigest, input.body, JSON.stringify(input.headers), JSON.stringify(input.commitment), this.now(), input.ownerDoName, input.replyRef);
      return this.delivery({ deliveryId: input.deliveryId })!;
    });
  }
  delivery(by: { deliveryId?: string; commandId?: string }): DeliveryRow | null {
    const row = by.deliveryId !== undefined ? this.rows('SELECT * FROM deliveries WHERE delivery_id=?', by.deliveryId)[0] : this.rows('SELECT * FROM deliveries WHERE command_id=?', by.commandId!)[0];
    return row ? toDelivery(row) : null;
  }
  deliveries(): DeliveryRow[] { return this.rows('SELECT * FROM deliveries ORDER BY created_at, delivery_id').map(toDelivery); }

  /** Marks the single outstanding command delivered (attempt+1) and returns its unchanged bytes. */
  pull(h: S2Headers): DeliveryRow | null {
    return this.tx(() => {
      this.consumeNonce(h);
      const row = this.rows("SELECT * FROM deliveries WHERE state IN ('queued','delivered') LIMIT 1")[0];
      if (!row) return null;
      this.sql.exec("UPDATE deliveries SET state='delivered', attempt=attempt+1, delivered_at=coalesce(delivered_at, ?) WHERE delivery_id=?", this.now(), row.delivery_id);
      return this.delivery({ deliveryId: String(row.delivery_id) });
    });
  }
  /** Withdraws only a still-queued delivery; a pull that won the race keeps it uncertain. */
  withdraw(deliveryId: string, reason: string): boolean {
    return this.tx(() => {
      const row = this.delivery({ deliveryId });
      if (!row || row.state !== 'queued') return false;
      this.sql.exec("UPDATE deliveries SET state='withdrawn' WHERE delivery_id=?", deliveryId);
      this.setResult(row, notStarted(row, reason));
      return true;
    });
  }
  private markWithdrawnResults(reason: string) {
    for (const row of this.rows("SELECT * FROM deliveries WHERE state='withdrawn' AND result IS NULL").map(toDelivery)) this.setResult(row, notStarted(row, reason));
  }
  private setResult(row: DeliveryRow, result: IMessageResult) {
    this.sql.exec('UPDATE deliveries SET result=? WHERE delivery_id=?', JSON.stringify(iMessageResultSchema.parse(result)), row.deliveryId);
  }

  /** First terminal result is authoritative; identical repeats are idempotent; others retained as conflicts. */
  postResult(h: S2Headers, input: { deliveryId: string; commandId: string; commandDigest: string; result: IMessageResult }, resultDigest: string): 'accepted' | 'repeat' {
    const outcome = this.tx(() => {
      const row = this.delivery({ deliveryId: input.deliveryId });
      const target = row ? iMessageCommandSchema.parse(JSON.parse(row.body)).target : null;
      if (!row || row.state === 'queued' || row.state === 'withdrawn' || row.commandId !== input.commandId || row.commandDigest !== input.commandDigest
        || input.result.commandId !== row.commandId || JSON.stringify(input.result.target) !== JSON.stringify(target) || ['queued', 'started'].includes(input.result.state))
        throw new BridgeStoreError('result_mismatch');
      if (row.result && JSON.stringify(row.result) === JSON.stringify(input.result)) {
        if (!this.rows('SELECT 1 FROM nonces WHERE nonce=?', h.nonce).length) this.consumeNonce(h);
        return 'repeat' as const;
      }
      this.consumeNonce(h);
      if (row.result) {
        this.sql.exec('INSERT OR IGNORE INTO result_conflicts(delivery_id,result_digest,result,created_at) VALUES(?,?,?,?)', row.deliveryId, resultDigest, JSON.stringify(input.result), this.now());
        return 'conflict' as const;
      }
      this.sql.exec("UPDATE deliveries SET state='resulted', result=? WHERE delivery_id=?", JSON.stringify(input.result), row.deliveryId);
      if (input.result.state === 'unknown') this.quarantine('host_reported_unknown');
      if (input.result.state === 'local_recorded' || input.result.state === 'delivered') {
        const old = this.rows('SELECT command_id FROM sent_messages WHERE message_guid=?', input.result.messageGuid)[0];
        if (old && old.command_id !== row.commandId) throw new BridgeStoreError('message_conflict');
        if (!old) this.sql.exec('INSERT INTO sent_messages(message_guid,command_id,state) VALUES(?,?,?)', input.result.messageGuid, row.commandId, input.result.state);
      }
      return 'accepted' as const;
    });
    if (outcome === 'conflict') throw new BridgeStoreError('result_conflict');
    return outcome;
  }

  /**
   * Deadline sweep. Never-pulled commands past the delivery deadline become proved not_started.
   * Pulled commands without a terminal result past the mutation deadline become unknown and
   * permanently quarantine the lane. A late result cannot clear quarantine.
   */
  sweepDeadlines(): number | null {
    return this.tx(() => {
      const now = this.now();
      for (const row of this.rows("SELECT * FROM deliveries WHERE state IN ('queued','delivered')").map(toDelivery)) {
        if (row.state === 'queued' && now - row.createdAtMs >= this.policy.deliveryDeadlineMs) {
          this.sql.exec("UPDATE deliveries SET state='withdrawn' WHERE delivery_id=?", row.deliveryId);
          this.setResult(row, notStarted(row, 'host_not_pulled'));
        } else if (row.state === 'delivered' && now - (row.deliveredAtMs ?? row.createdAtMs) >= this.policy.mutationDeadlineMs) {
          this.sql.exec("UPDATE deliveries SET state='resulted' WHERE delivery_id=?", row.deliveryId);
          this.setResult(row, { version: 1, commandId: row.commandId, target: commandTarget(row), state: 'unknown', disposition: 'still_in_flight', reason: 'mutation_deadline' });
          this.quarantine('mutation_deadline');
        }
      }
      const due = this.rows("SELECT min(CASE state WHEN 'queued' THEN created_at + ? ELSE coalesce(delivered_at, created_at) + ? END) AS due FROM deliveries WHERE state IN ('queued','delivered')",
        this.policy.deliveryDeadlineMs, this.policy.mutationDeadlineMs)[0]?.due;
      return due === null || due === undefined ? null : Number(due);
    });
  }
  /** Terminal outcomes the owner outbox has not yet recorded (at-least-once report). */
  unreportedResults(): DeliveryRow[] { return this.rows("SELECT * FROM deliveries WHERE result IS NOT NULL AND reported=0").map(toDelivery); }
  markReported(deliveryId: string) { this.tx(() => this.sql.exec('UPDATE deliveries SET reported=1 WHERE delivery_id=?', deliveryId)); }
  sentCommandFor(messageGuid: string): string | null { return (this.rows('SELECT command_id FROM sent_messages WHERE message_guid=?', messageGuid)[0]?.command_id as string | undefined) ?? null; }

  /**
   * Revoke: cancel only never-delivered queued commands (proved not_started); retain delivered,
   * started and uncertain evidence and quarantine. Pending inbound events are held, never deleted.
   */
  revoke(revision: string) {
    this.tx(() => {
      this.setMeta('revoked_revision', revision);
      for (const row of this.rows("SELECT * FROM deliveries WHERE state='queued'").map(toDelivery)) {
        this.sql.exec("UPDATE deliveries SET state='withdrawn' WHERE delivery_id=?", row.deliveryId);
        this.setResult(row, notStarted(row, 'binding_revoked'));
      }
      this.sql.exec("UPDATE events SET state='held', reason='binding_revoked' WHERE state='pending'");
    });
  }
  revokedRevision(): string | null { return this.meta('revoked_revision'); }
  quarantineReason(): string | null { const raw = this.meta('quarantine'); return raw ? (JSON.parse(raw) as { reason: string }).reason : null; }
}

const commandTarget = (row: DeliveryRow) => iMessageCommandSchema.parse(JSON.parse(row.body)).target;
const notStarted = (row: DeliveryRow, reason: string): IMessageResult =>
  ({ version: 1, commandId: row.commandId, target: commandTarget(row), state: 'rejected', disposition: 'not_started', reason });

const toDelivery = (row: Row): DeliveryRow => ({
  deliveryId: String(row.delivery_id), commandId: String(row.command_id), commandDigest: String(row.command_digest), body: String(row.body),
  headers: JSON.parse(String(row.headers)) as S2Headers, commitment: JSON.parse(String(row.commitment)) as Commitment,
  state: row.state as DeliveryState, attempt: Number(row.attempt), result: row.result === null ? null : iMessageResultSchema.parse(JSON.parse(String(row.result))),
  createdAtMs: Number(row.created_at), deliveredAtMs: row.delivered_at === null ? null : Number(row.delivered_at),
  ownerDoName: String(row.owner_do), replyRef: String(row.reply_ref), reported: Number(row.reported) === 1,
});

export const parseStoredEvent = (e: StoredEvent): IMessageEvent => iMessageEventSchema.parse(JSON.parse(e.body));
