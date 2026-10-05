import { notificationScope } from './notify-policy';
import { sha256Hex } from './signing';
import { canonicalJson } from './canonical-json';
import { COMMAND_DEFAULT_TTL_SECONDS, COMMAND_MAX_TTL_SECONDS, CONTRACT_VERSION, MAX_DEVICE_COMMANDS, NOTIFY_ISSUE_LIMITS, type Capability } from './contract';
import { commandPayload, identifier, type Ack, type NotifyPayload, type QueryPayload, type Result } from './wire';
export type CommandInput = { owner_id: string; device_id: string; request_id: string; class: Capability; payload: QueryPayload | NotifyPayload; ttl_seconds?: number };
export type CommandSummary = { command_id: string; class: string; state: string; result_status: string | null; result_state: string | null; issued_at: number; expires_at: number };
type Row = CommandSummary & { owner_id: string; device_id: string; request_id: string; fingerprint: string; idempotency_key: string; message_id: string; wire: string | null; delivered_generation: string | null; result_message_id: string | null; result_fingerprint: string | null };
export type EnqueueResult = { accepted: true; command_id: string; state: string; duplicate: boolean } | { accepted: false; reason: 'invalid_shape' | 'idempotency_conflict' | 'rate_limited' | 'unavailable' };
export type Receipt = { contract_version: string; type: 'receipt'; message_id: string; device_id: string; owner_id: string; command_id: string; revision: 1; idempotency_key: string; payload: { result_message_id: string; received_at: number } };
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newMessageId(at: number): string {
  let time = BigInt(at) * 1000n, prefix = '';
  for (let n = 0; n < 10; n++) { prefix = CROCKFORD[Number(time % 32n)]! + prefix; time /= 32n; }
  return prefix + Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => CROCKFORD[byte & 31]).join('');
}
export class DeviceCommandStore {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS commands(command_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision=1), owner_id TEXT NOT NULL, device_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, message_id TEXT NOT NULL UNIQUE, class TEXT NOT NULL, delivered_generation TEXT, wire TEXT, notification_id TEXT UNIQUE, expires_at INTEGER NOT NULL, issued_at INTEGER NOT NULL, state TEXT NOT NULL, result_status TEXT, result_state TEXT, result_message_id TEXT UNIQUE, result_fingerprint TEXT)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS notify_issues(notification_id TEXT PRIMARY KEY, issued_at INTEGER NOT NULL)');
  }
  async enqueue(input: CommandInput, at: number, capabilities: readonly string[]): Promise<EnqueueResult> {
    // An owner request must remain inside the paired device's declared display/read capability.
    const ttl = input.ttl_seconds ?? COMMAND_DEFAULT_TTL_SECONDS;
    if (!identifier(input.owner_id) || !identifier(input.device_id) || !identifier(input.request_id) || !capabilities.includes(input.class) || !commandPayload(input.class, input.payload) || !Number.isInteger(ttl) || ttl < 1 || ttl > COMMAND_MAX_TTL_SECONDS) return { accepted: false, reason: 'invalid_shape' };
    if (input.class === 'notify_local' && !notificationScope(input.payload as NotifyPayload)) return { accepted: false, reason: 'invalid_shape' };
    const notification = input.class === 'notify_local' ? (input.payload as NotifyPayload).notification_id : null;
    const fingerprint = await sha256Hex(new TextEncoder().encode(canonicalJson({ owner_id: input.owner_id, device_id: input.device_id, class: input.class, payload: input.payload, ttl_seconds: ttl })));
    return this.storage.transactionSync(() => {
      if (this.storage.sql.exec("SELECT value FROM meta WHERE key='revoked'").toArray().length) return { accepted: false, reason: 'unavailable' };
      const previous = this.storage.sql.exec<Row>('SELECT * FROM commands WHERE request_id=? OR notification_id=?', input.request_id, notification).toArray();
      if (previous.length) {
        // Successful retries preserve both request and notification identities; no untracked request alias may later change meaning.
        if (previous.length !== 1 || previous[0]!.request_id !== input.request_id || previous[0]!.fingerprint !== fingerprint) return { accepted: false, reason: 'idempotency_conflict' };
        const row = previous[0]!;
        return { accepted: true, command_id: row.command_id, state: row.state, duplicate: true };
      }
      // Backpressure preserves lifelong receipt and command identity evidence instead of evicting it.
      if (Number(this.storage.sql.exec('SELECT count(*) AS count FROM commands').one().count) >= MAX_DEVICE_COMMANDS) return { accepted: false, reason: 'unavailable' };
      if (notification) {
        for (const profile of NOTIFY_ISSUE_LIMITS) {
          if (Number(this.storage.sql.exec('SELECT count(*) AS count FROM notify_issues WHERE issued_at > ?', at - profile.seconds).one().count) >= profile.limit) return { accepted: false, reason: 'rate_limited' };
        }
        this.storage.sql.exec('INSERT INTO notify_issues(notification_id,issued_at) VALUES(?,?)', notification, at);
      }
      const command_id = crypto.randomUUID(), idempotency_key = crypto.randomUUID(), message_id = newMessageId(at), expires_at = at + ttl;
      const wire = canonicalJson({ contract_version: CONTRACT_VERSION, type: 'command', device_id: input.device_id, owner_id: input.owner_id, command_id, revision: 1, idempotency_key, message_id, class: input.class, expires_at, payload: input.payload });
      this.storage.sql.exec('INSERT INTO commands(command_id,revision,owner_id,device_id,request_id,fingerprint,idempotency_key,message_id,class,wire,notification_id,expires_at,issued_at,state) VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,?)', command_id, input.owner_id, input.device_id, input.request_id, fingerprint, idempotency_key, message_id, input.class, wire, notification, expires_at, at, 'queued');
      return { accepted: true, command_id, state: 'queued', duplicate: false };
    });
  }
  pending(at: number): { command_id: string; wire: string; state: string; delivered_generation: string | null }[] {
    // Expired queued commands never enter the wire; possibly delivered work reuses its bytes for an expired ack or journaled result.
    this.storage.sql.exec("UPDATE commands SET state='expired',wire=NULL WHERE state='queued' AND expires_at<=?", at);
    return this.storage.sql.exec<{ command_id: string; wire: string; state: string; delivered_generation: string | null }>("SELECT command_id,wire,state,delivered_generation FROM commands WHERE state IN ('queued','sent','acked') ORDER BY issued_at,command_id").toArray();
  }
  hasInFlight(): boolean { return this.storage.sql.exec("SELECT command_id FROM commands WHERE state IN ('sent','acked') LIMIT 1").toArray().length > 0; }
  markSent(command: string, generation = ''): void { this.storage.sql.exec("UPDATE commands SET state=CASE WHEN state='queued' THEN 'sent' ELSE state END,delivered_generation=? WHERE command_id=? AND state IN ('queued','sent','acked')", generation, command); }
  private command(frame: Ack | Result): Row {
    const row = this.storage.sql.exec<Row>('SELECT * FROM commands WHERE command_id=?', frame.command_id).toArray()[0];
    // Never acknowledge or receipt a frame without trustworthy device, owner and command binding.
    if (!row) throw new Error('unknown_message');
    if (frame.revision !== 1 || row.device_id !== frame.device_id || row.owner_id !== frame.owner_id || row.idempotency_key !== frame.idempotency_key || row.state === 'queued' || row.state === 'cancelled') throw new Error('invalid_shape');
    return row;
  }
  acceptAck(frame: Ack): void {
    const row = this.command(frame);
    // Volatile late acks cannot overwrite an already committed terminal outcome.
    if (!['sent', 'acked'].includes(row.state)) return;
    this.storage.sql.exec('UPDATE commands SET state=? WHERE command_id=?', frame.payload.state === 'accepted' ? 'acked' : frame.payload.state, frame.command_id);
  }
  acceptResult(frame: Result, fingerprint: string, at: number): Receipt {
    return this.storage.transactionSync(() => {
      const row = this.command(frame);
      if (row.result_message_id) {
        if (row.result_message_id !== frame.message_id || row.result_fingerprint !== fingerprint) throw new Error('idempotency_conflict');
      } else {
        // Volatile expiry is not evidence against a durable result from work previously delivered.
        if (!['sent', 'acked'].includes(row.state) && !(row.state === 'expired' && row.delivered_generation !== null && row.wire !== null)) throw new Error('invalid_shape');
        const payload = row.wire ? JSON.parse(row.wire).payload as QueryPayload : null;
        const result = frame.payload;
        // Query answers echo exactly the requested kind/id; display results cannot impersonate answers.
        if (row.class === 'machine_state_query' ? result.status === 'delivered' || (result.status === 'failed' && result.reason !== 'processing_failed') || (result.status === 'answered' && (!payload || result.answer?.query_id !== payload.query_id || result.answer.query_kind !== payload.query_kind)) : result.status === 'answered' || (result.status === 'failed' && result.reason !== 'delivery_unknown')) throw new Error('invalid_shape');
        this.storage.sql.exec('UPDATE commands SET state=?,result_status=?,result_state=?,result_message_id=?,result_fingerprint=?,wire=NULL WHERE command_id=?', result.status, result.status, result.answer?.state ?? null, frame.message_id, fingerprint, frame.command_id);
      }
      // A receipt confirms committed result custody; every retry gets a fresh receipt identity.
      return { contract_version: CONTRACT_VERSION, type: 'receipt', message_id: newMessageId(at), device_id: row.device_id, owner_id: row.owner_id, command_id: row.command_id, revision: 1, idempotency_key: row.idempotency_key, payload: { result_message_id: frame.message_id, received_at: at } };
    });
  }
  cancelQueued(): void { this.storage.sql.exec("UPDATE commands SET state='cancelled',wire=NULL WHERE state='queued'"); }
  list(limit = 20): CommandSummary[] { return this.storage.sql.exec<CommandSummary>('SELECT command_id,class,state,result_status,result_state,issued_at,expires_at FROM commands ORDER BY issued_at DESC,command_id LIMIT ?', limit).toArray(); }
}
