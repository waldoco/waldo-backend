import { DeviceCommandStore, type CommandInput, type CommandSummary, type EnqueueResult } from './command-store';
import { DurableObject } from 'cloudflare:workers';
import { armAlarm } from '../scheduler/alarm-slot';
import { canonicalJson, parseStrictJson } from './canonical-json';
import type { DeviceBridgeEnv } from './connect-route';
import { CLOCK_SKEW_SECONDS, CONTRACT_VERSION, FRAME_BYTES, MAX_DEVICE_FRAME_FINGERPRINTS, ONLINE_SECONDS } from './contract';
import { deviceDirectory, type DeviceAuth } from './device-directory';
import { deviceDiagnostic, genericReject } from './generic-reject';
import { httpSigningFields } from './redeem-route';
import { frameSignatureBase, httpSignatureBase, sha256Hex, verifyEd25519 } from './signing';
import { ackFrame, resultFrame, connectDeclaration, heartbeatFrame, identifier, record } from './wire';
type Binding = DeviceAuth & { device_id: string; declared_capabilities: string[]; last_heartbeat_at: number | null; generation: string; outbox_depth?: number | null };
export class DeviceBridgeDO extends DurableObject<DeviceBridgeEnv> {
  constructor(ctx: DurableObjectState, env: DeviceBridgeEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS nonces(nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS frames(message_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, type TEXT NOT NULL, command_id TEXT, revision INTEGER, idempotency_key TEXT, created_at INTEGER NOT NULL)');
      ctx.storage.sql.exec("INSERT OR IGNORE INTO meta(key,value) VALUES('schema_version','1')");
      new DeviceCommandStore(ctx.storage);
    });
  }
  private revoked(): boolean { return this.ctx.storage.sql.exec("SELECT value FROM meta WHERE key='revoked'").toArray().length > 0; }
  private active(socket: WebSocket, binding: Binding): boolean {
    const generation = this.ctx.storage.sql.exec("SELECT value FROM meta WHERE key='socket_generation'").toArray()[0]?.value;
    // Replaced sockets cannot finish awaited verification using the new socket's authority.
    return !this.revoked() && socket.readyState === WebSocket.OPEN && generation === binding.generation;
  }
  admitNonce(nonce: string, timestamp: number): boolean {
    return this.ctx.storage.transactionSync(() => {
      // Awaited verification can cross the clock window; admission checks the clock atomically.
      if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > CLOCK_SKEW_SECONDS) return false;
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO nonces(nonce,expires_at) VALUES(?,?)', nonce, timestamp + CLOCK_SKEW_SECONDS * 2);
      return this.ctx.storage.sql.exec('SELECT changes() AS count').one().count === 1;
    });
  }
  private async rearm(): Promise<void> {
    const next = this.ctx.storage.sql.exec('SELECT min(expires_at) AS next FROM nonces').one().next;
    const revokedAt = this.ctx.storage.sql.exec("SELECT value FROM meta WHERE key='revoked'").toArray()[0]?.value;
    const due = revokedAt ? Number(revokedAt) + CLOCK_SKEW_SECONDS : next === null ? null : Number(next);
    if (due !== null) await armAlarm(this.ctx.storage, (due + 1) * 1000);
  }
  override async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url), device = request.headers.get('x-waldo-device-id');
      // Device naming and the signed path bind admission to exactly this isolated DO.
      if (this.revoked() || request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket' || !identifier(device) || !this.env.DEVICE_BRIDGE_DO || !this.env.DEVICE_BRIDGE_DO.idFromName(device).equals(this.ctx.id)) return genericReject();
      const declared = connectDeclaration(url.pathname + url.search), fields = httpSigningFields(request);
      if (!declared || !fields) return genericReject();
      const auth = await deviceDirectory(this.env).deviceForAuth(device);
      if (!auth || declared.some((capability) => !auth.capabilities.includes(capability))) return genericReject();
      const base = httpSignatureBase(fields.timestamp, fields.nonce, 'GET', url.pathname + url.search, await sha256Hex(new Uint8Array()));
      if (!await verifyEd25519(auth.pubkey, fields.signature, base) || this.revoked() || !this.admitNonce(fields.nonce, Number(fields.timestamp))) return genericReject();
      await this.rearm();
      // Revocation can settle while alarm registration awaits; no socket may escape that fence.
      if (this.revoked()) return genericReject();
      const pair = new WebSocketPair(), client = pair[0], server = pair[1];
      const binding: Binding = { ...auth, device_id: device, declared_capabilities: declared, last_heartbeat_at: null, generation: crypto.randomUUID() };
      server.serializeAttachment(binding);
      for (const previous of this.ctx.getWebSockets()) previous.close(1008);
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta(key,value) VALUES('socket_generation',?)", binding.generation);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    } catch { deviceDiagnostic('infrastructure_unavailable'); return genericReject(); }
  }
  override async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer): Promise<void> {
    try {
      if (this.revoked() || socket.readyState !== WebSocket.OPEN || typeof data !== 'string') throw new Error('invalid_shape');
      const bytes = new TextEncoder().encode(data);
      if (bytes.length > FRAME_BYTES) throw new Error('invalid_shape');
      const parsed = parseStrictJson(bytes, true), frame = heartbeatFrame(parsed) ?? ackFrame(parsed) ?? resultFrame(parsed);
      const binding = socket.deserializeAttachment() as Binding;
      if (record(parsed) && parsed.contract_version !== CONTRACT_VERSION) { deviceDiagnostic('version_mismatch'); socket.close(1008); return; }
      if (!frame || !binding || !this.active(socket, binding) || frame.device_id !== binding.device_id || frame.owner_id !== binding.owner_id || Math.abs(Math.floor(Date.now() / 1000) - frame.timestamp) > CLOCK_SKEW_SECONDS || (frame.type === 'heartbeat' && frame.payload.declared_capabilities.join(',') !== binding.declared_capabilities.join(','))) throw new Error('invalid_shape');
      const { signature, ...unsigned } = frame;
      const base = frameSignatureBase(frame.timestamp, frame.type, frame.message_id, frame.nonce, await sha256Hex(new TextEncoder().encode(canonicalJson(unsigned))));
      if (!await verifyEd25519(binding.pubkey, signature, base) || !this.active(socket, binding)) throw new Error('invalid_shape');
      const { timestamp: _timestamp, nonce: _nonce, ...logical } = unsigned;
      const fingerprint = await sha256Hex(new TextEncoder().encode(canonicalJson(logical)));
      // Deleted principals cannot publish results, consume new commands or revive stale transport.
      const principal = await deviceDirectory(this.env).deviceForAuth(binding.device_id);
      if (!principal || principal.owner_id !== binding.owner_id || principal.pubkey !== binding.pubkey || !this.active(socket, binding)) { socket.close(1008); return; }
      let receipt: unknown;
      const admitted = this.ctx.storage.transactionSync(() => {
        if (!this.active(socket, binding) || !this.admitNonce(frame.nonce, frame.timestamp)) return false;
        const previous = this.ctx.storage.sql.exec('SELECT fingerprint FROM frames WHERE message_id=?', frame.message_id).toArray()[0]?.fingerprint;
        if (previous !== undefined && previous !== fingerprint) return false;
        // Bound durable identity custody without evicting evidence that could permit conflicts.
        if (previous === undefined && Number(this.ctx.storage.sql.exec('SELECT count(*) AS count FROM frames').one().count) >= MAX_DEVICE_FRAME_FINGERPRINTS) return false;
        const commands = new DeviceCommandStore(this.ctx.storage);
        if (frame.type === 'ack') commands.acceptAck(frame);
        if (frame.type === 'result') receipt = commands.acceptResult(frame, fingerprint, Math.floor(Date.now() / 1000));
        if (previous === undefined) this.ctx.storage.sql.exec('INSERT INTO frames(message_id,fingerprint,type,command_id,revision,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?)', frame.message_id, fingerprint, frame.type, frame.type === 'heartbeat' ? null : frame.command_id, frame.type === 'heartbeat' ? null : frame.revision, frame.type === 'heartbeat' ? null : frame.idempotency_key, Math.floor(Date.now() / 1000));
        return true;
      });
      if (!admitted) { deviceDiagnostic('idempotency_conflict'); socket.close(1008); return; }
      if (frame.type === 'heartbeat') {
        if (!await deviceDirectory(this.env).touchDevice(binding.device_id) || !this.active(socket, binding)) { socket.close(1008); return; }
        const at = Math.floor(Date.now() / 1000);
        binding.last_heartbeat_at = at; binding.outbox_depth = frame.payload.outbox_depth; socket.serializeAttachment(binding);
        this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta(key,value) VALUES('last_heartbeat_at',?)", String(at));
        this.deliver(socket, binding);
      } else if (receipt) {
        // Receipt delivery is not proof of application; wait for a later reconciliation heartbeat.
        binding.outbox_depth = null; socket.serializeAttachment(binding);
        socket.send(canonicalJson(receipt));
      }
      await this.rearm();
    } catch (error) {
      const code = error instanceof Error && ['unknown_message', 'idempotency_conflict'].includes(error.message) ? error.message as 'unknown_message' | 'idempotency_conflict' : 'invalid_shape';
      deviceDiagnostic(code); socket.close(1008);
    }
  }
  async enqueueCommand(input: CommandInput): Promise<EnqueueResult> {
    // The binding is internal-only; re-read principal custody rather than trusting caller-supplied ids.
    if (this.revoked() || !identifier(input.device_id) || !this.env.DEVICE_BRIDGE_DO?.idFromName(input.device_id).equals(this.ctx.id)) return { accepted: false, reason: 'unavailable' };
    const auth = await deviceDirectory(this.env).deviceForAuth(input.device_id);
    if (!auth || auth.owner_id !== input.owner_id || this.revoked()) return { accepted: false, reason: 'unavailable' };
    const result = await new DeviceCommandStore(this.ctx.storage).enqueue(input, Math.floor(Date.now() / 1000), auth.capabilities);
    if (result.accepted && !this.revoked()) for (const socket of this.ctx.getWebSockets()) {
      const binding = socket.deserializeAttachment() as Binding | null;
      if (binding) this.deliver(socket, binding);
    }
    return result;
  }
  private deliver(socket: WebSocket, binding: Binding): void {
    // A new socket drains old results and reconciles accepted work before receiving new effects.
    if (!this.active(socket, binding) || binding.last_heartbeat_at === null || binding.outbox_depth !== 0) return;
    const commands = new DeviceCommandStore(this.ctx.storage), pending = commands.pending(Math.floor(Date.now() / 1000));
    const inFlight = commands.hasInFlight();
    for (const command of pending) {
      if (command.delivered_generation === binding.generation) continue;
      if (command.state === 'queued' && inFlight) continue;
      const frame = JSON.parse(command.wire) as { class: string };
      // A reconnect may narrow its declaration; never send an unnegotiated class.
      if (!binding.declared_capabilities.includes(frame.class)) continue;
      commands.markSent(command.command_id, binding.generation); socket.send(command.wire);
      if (command.state === 'queued') break;
    }
  }
  async listCommands(): Promise<CommandSummary[]> { return new DeviceCommandStore(this.ctx.storage).list(); }
  async revoke(): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      new DeviceCommandStore(this.ctx.storage).cancelQueued();
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta(key,value) VALUES('revoked',?)", String(Math.floor(Date.now() / 1000)));
    });
    for (const socket of this.ctx.getWebSockets()) socket.close(1008);
    await this.rearm();
  }
  override async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    // Complete the close handshake so hibernated transport cannot remain half-open.
    socket.close(code === 1005 || code === 1006 ? 1000 : code);
    const binding = socket.deserializeAttachment() as Binding | null;
    if (binding && this.ctx.storage.sql.exec("SELECT value FROM meta WHERE key='socket_generation'").toArray()[0]?.value === binding.generation) this.ctx.storage.sql.exec("DELETE FROM meta WHERE key='socket_generation'");
  }
  override async webSocketError(socket: WebSocket): Promise<void> {
    deviceDiagnostic('invalid_shape'); socket.close(1008);
  }
  async status(): Promise<{ online: boolean; last_heartbeat_at: number | null }> {
    const last = this.ctx.storage.sql.exec("SELECT value FROM meta WHERE key='last_heartbeat_at'").toArray()[0]?.value;
    const now = Math.floor(Date.now() / 1000);
    const online = !this.revoked() && this.ctx.getWebSockets().some((socket) => {
      const binding = socket.deserializeAttachment() as Binding | null;
      return !!binding && this.active(socket, binding) && binding.last_heartbeat_at !== null && now - binding.last_heartbeat_at <= ONLINE_SECONDS;
    });
    return { online, last_heartbeat_at: last === undefined ? null : Number(last) };
  }
  override async alarm(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const revokedAt = this.ctx.storage.sql.exec("SELECT value FROM meta WHERE key='revoked'").toArray()[0]?.value;
    if (revokedAt !== undefined && now > Number(revokedAt) + CLOCK_SKEW_SECONDS) { await this.ctx.storage.deleteAll(); return; }
    this.ctx.storage.sql.exec('DELETE FROM nonces WHERE expires_at < ?', now);
    await this.rearm();
  }
}
