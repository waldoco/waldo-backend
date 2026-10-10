import { DurableObject } from 'cloudflare:workers';
import {
  iMessageBindingSchema, iMessageCapabilitiesSchema, iMessageCommandSchema, iMessageEventSchema,
  type IMessageBinding, type IMessageCommand, type IMessageEvent, type IMessageResult,
} from '@waldo/contracts';
import { armAlarm } from '../../scheduler/alarm-slot';
import { ownerDirectory, type OwnerDirectoryEnv } from '../../identity/owner-directory';
import type { OwnerTurnEnvelope } from '../owner-turn-envelope';
import { admitIMessageOwnerTurn, type IMessageAdmissionGrant } from './admission';
import { BridgeStore, BridgeStoreError, parseStoredEvent, type DeliveryRow } from './bridge-store';
import { mintHostKey, sha256Hex, signCommitment, signS2, unwrapCredential, verifyS2, type S2Headers } from './crypto';
import { iMessageDirectory, IMessageDirectoryUnavailable, type BridgeAuthority } from './directory';
import { parseIMessageConnectorPolicy, type IMessageConnectorPolicy } from './policy';
import { heartbeatBodySchema, parseJson, pullBodySchema, resultBodySchema } from './wire';

export type IMessageEnv = OwnerDirectoryEnv & Readonly<{
  WALDO_ENVIRONMENT?: string;
  IMESSAGE_CONNECTOR_ENABLED?: string;
  IMESSAGE_CONNECTOR_POLICY?: string;
  IMESSAGE_CREDENTIAL_WRAPPING_KEY?: string;
  IMESSAGE_BRIDGE_DO?: DurableObjectNamespace;
  TELEGRAM_OWNER_DO?: DurableObjectNamespace;
}>;

/** Composition gate: every piece must be present, otherwise the connector is disabled (no fallback). */
export const iMessageComposition = (env: IMessageEnv): { policy: IMessageConnectorPolicy; environment: string; wrappingKey: string } | null => {
  if (env.IMESSAGE_CONNECTOR_ENABLED !== '1' || !env.IMESSAGE_BRIDGE_DO || !env.TELEGRAM_OWNER_DO) return null;
  if (!env.SUPABASE_PROJECT_URL || !env.SUPABASE_PUBLISHABLE_KEY || !env.WALDO_ROUTER_HMAC_SECRET) return null;
  const environment = env.WALDO_ENVIRONMENT ?? '';
  const wrappingKey = env.IMESSAGE_CREDENTIAL_WRAPPING_KEY ?? '';
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(environment) || !/^[a-f0-9]{64}$/.test(wrappingKey)) return null;
  const policy = parseIMessageConnectorPolicy(parseJson(env.IMESSAGE_CONNECTOR_POLICY ?? ''));
  return policy ? { policy, environment, wrappingKey } : null;
};

export const iMessageBridgeName = (environment: string, bridgeId: string, accountId: string) => JSON.stringify(['imessage-bridge', environment, bridgeId, accountId]);

export type HostRoute = 'events' | 'heartbeat' | 'capabilities' | 'commands/pull' | 'commands/result';
/** JSON is serialized inside the DO so the RPC boundary carries only a status and a string. */
export type HostReply = { status: number; json: string };

/** Inbound turn handed to the owner DO. The owner inbox deduplicates on dedupKey + digest. */
export type IMessageTurnHandoff = Readonly<{
  dedupKey: string; digest: string; envelope: OwnerTurnEnvelope; binding: IMessageBinding; revision: string;
  environment: string; bridgeDoName: string; ownerDoName: string; occurredAt: number;
}>;
export type IMessageResultReport = Readonly<{ replyRef: string; commandId: string; result: IMessageResult }>;
export type ReplyHandoff = Readonly<{ replyRef: string; commandId: string; text: string; ownerDoName: string; revision: string; bindingDigest: string }>;
export type ReplyHandoffOutcome = { kind: 'queued' | 'retry' } | { kind: 'terminal'; result: IMessageResult };
export interface OwnerIMessagePort {
  admitIMessageTurn(input: IMessageTurnHandoff): Promise<'admitted' | 'duplicate' | 'conflict' | 'capacity' | 'refused'>;
  recordIMessageResult(input: IMessageResultReport): Promise<boolean>;
}

const reply = (status: number, body: unknown): HostReply => ({ status, json: JSON.stringify(body) });
const fixed = (status: number, error: string): HostReply => reply(status, { error });
const invalid = (): HostReply => fixed(401, 'invalid_request');
const RETRY_MS = 5_000;

export const bindingFromAuthority = (a: BridgeAuthority): IMessageBinding | null => {
  if (a.state !== 'active' || !a.subject || !a.chatGuid || !a.presenceId) return null;
  const parsed = iMessageBindingSchema.safeParse({ ownerId: a.ownerId, presenceId: a.presenceId, subject: a.subject, bridgeId: a.bridgeId, accountId: a.accountId,
    chatGuid: a.chatGuid, verified: true, conversationKind: 'direct', service: 'iMessage' });
  return parsed.success ? parsed.data : null;
};
export const bindingDigest = (b: IMessageBinding) => sha256Hex(JSON.stringify(iMessageBindingSchema.parse(b)));

export class IMessageBridgeDO extends DurableObject<IMessageEnv> {
  private storeCache: BridgeStore | null = null;
  private draining = false;
  constructor(ctx: DurableObjectState, env: IMessageEnv) { super(ctx, env); }

  private composition() { return iMessageComposition(this.env); }
  private store(policy: IMessageConnectorPolicy): BridgeStore { return this.storeCache ??= new BridgeStore(this.ctx.storage, policy); }
  private directory() { return iMessageDirectory(this.env); }
  /** The DO name is derived from the server-side tuple; a request for another tuple never runs here. */
  private owns(environment: string, bridgeId: string, accountId: string): boolean {
    return !!this.env.IMESSAGE_BRIDGE_DO && this.env.IMESSAGE_BRIDGE_DO.idFromName(iMessageBridgeName(environment, bridgeId, accountId)).equals(this.ctx.id);
  }
  private remember(environment: string, bridgeId: string, accountId: string, store: BridgeStore) {
    if (store.meta('bridge_id') === null) store.tx(() => {
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO meta(key,value) VALUES('environment',?),('bridge_id',?),('account_id',?)", environment, bridgeId, accountId);
    });
  }
  private async key(authority: BridgeAuthority, environment: string, wrappingKey: string): Promise<string | null> {
    return unwrapCredential(authority.wrappedCredential, { environment, bridgeId: authority.bridgeId, accountId: authority.accountId, revision: String(authority.credentialEpoch) }, wrappingKey);
  }

  /** One authenticated host request. Fresh canonical authority is read before any state change. */
  async hostRequest(route: HostRoute, body: string, headers: S2Headers): Promise<HostReply> {
    const c = this.composition();
    if (!c) return fixed(503, 'unavailable');
    if (!this.owns(c.environment, headers.bridgeId, headers.accountId)) return invalid();
    const store = this.store(c.policy);
    let authority: BridgeAuthority | null;
    try { authority = await this.directory().authority(c.environment, headers.bridgeId, headers.accountId); }
    catch { return fixed(503, 'unavailable'); }
    if (!authority || (authority.state !== 'pending' && authority.state !== 'active')) {
      if (authority) this.applyRevocation(store, authority.revision);
      return invalid();
    }
    const key = await this.key(authority, c.environment, c.wrappingKey);
    if (!key || !(await verifyS2(body, headers, key))) return invalid();
    const now = Date.now();
    if (headers.atMs > now || now - headers.atMs > c.policy.signatureMaxAgeMs) return invalid();
    this.remember(c.environment, headers.bridgeId, headers.accountId, store);
    const parsed = parseJson(body);
    try {
      if (route === 'events') return await this.admitEvent(store, authority, c.environment, body, headers, parsed);
      if (route === 'heartbeat') {
        const beat = heartbeatBodySchema.safeParse(parsed);
        if (!beat.success || beat.data.bridgeId !== headers.bridgeId || beat.data.accountId !== headers.accountId) return fixed(400, 'invalid_body');
        store.heartbeat(headers, beat.data.databaseGeneration, beat.data.status);
        return reply(200, { version: 1, accepted: true });
      }
      if (route === 'capabilities') {
        const report = iMessageCapabilitiesSchema.safeParse(parsed);
        if (!report.success || report.data.bridgeId !== headers.bridgeId || report.data.accountId !== headers.accountId) return fixed(400, 'invalid_body');
        store.reportCapabilities(headers, report.data);
        return reply(200, { version: 1, accepted: true });
      }
      // Pending credentials can never pull commands or post results.
      if (authority.state !== 'active') return invalid();
      if (route === 'commands/pull') {
        const pull = pullBodySchema.safeParse(parsed);
        if (!pull.success || pull.data.bridgeId !== headers.bridgeId || pull.data.accountId !== headers.accountId) return fixed(400, 'invalid_body');
        store.sweepDeadlines();
        const delivery = store.pull(headers);
        await this.rearm(store);
        return reply(200, { version: 1, delivery: delivery ? deliveryWire(delivery) : null });
      }
      const result = resultBodySchema.safeParse(parsed);
      if (!result.success || result.data.bridgeId !== headers.bridgeId || result.data.accountId !== headers.accountId) return fixed(400, 'invalid_body');
      store.postResult(headers, result.data, await sha256Hex(JSON.stringify(result.data.result)));
      await this.rearm(store, Date.now());
      return reply(200, { version: 1, accepted: true });
    } catch (error) {
      if (error instanceof BridgeStoreError) {
        if (error.code === 'backpressure') return fixed(503, 'backpressure');
        if (error.code === 'nonce_replay' || error.code === 'heartbeat_replay') return invalid();
        return fixed(409, error.code);
      }
      return fixed(503, 'unavailable');
    }
  }

  private async admitEvent(store: BridgeStore, authority: BridgeAuthority, environment: string, body: string, headers: S2Headers, parsed: unknown): Promise<HostReply> {
    const result = iMessageEventSchema.safeParse(parsed);
    if (!result.success || result.data.bridgeId !== headers.bridgeId || result.data.accountId !== headers.accountId) return fixed(400, 'invalid_body');
    const event = result.data, digest = await sha256Hex(body);
    if (authority.state === 'pending') {
      // Setup scope: only the exact challenge from the expected sender in the expected direct chat.
      if (event.kind !== 'message' || event.isFromMe || event.isGroup || event.service !== 'iMessage' || event.attachments.length
        || !authority.challengeHash || event.senderHandle !== authority.expectedSubject || event.chatGuid !== authority.expectedChatGuid
        || await sha256Hex(event.text.trim()) !== authority.challengeHash) return invalid();
      const accepted = await this.directory().recordChallenge({ environment, bridgeId: event.bridgeId, accountId: event.accountId, challengeHash: authority.challengeHash,
        subject: event.senderHandle, chatGuid: event.chatGuid, generation: event.cursor.databaseGeneration, eventId: event.eventId, digest });
      if (!accepted) return invalid();
      const admitted = store.admitEvent(headers, body, digest, event);
      if (!admitted.duplicate) { const pending = store.nextPendingEvent(); if (pending && pending.eventId === event.eventId) store.settleEvent(pending.seq, 'acknowledged', 'setup_challenge'); }
      return reply(200, { admitted: true, eventId: event.eventId, digest });
    }
    store.admitEvent(headers, body, digest, event);
    // ACK only after the durable commit above; the wake is persisted before we answer.
    await this.rearm(store, Date.now());
    return reply(200, { admitted: true, eventId: event.eventId, digest });
  }

  /** Owner DO hands a frozen reply. Bytes, identity and commitment are fixed at enqueue time. */
  async enqueueReply(input: ReplyHandoff): Promise<ReplyHandoffOutcome> {
    const c = this.composition();
    if (!c) return { kind: 'retry' };
    const store = this.store(c.policy);
    const prior = store.delivery({ commandId: input.commandId });
    if (prior) return prior.result ? { kind: 'terminal', result: prior.result } : { kind: 'queued' };
    const environment = store.meta('environment'), bridgeId = store.meta('bridge_id'), accountId = store.meta('account_id');
    if (!environment || !bridgeId || !accountId) return { kind: 'retry' };
    let authority: BridgeAuthority | null;
    try { authority = await this.directory().authority(environment, bridgeId, accountId); } catch { return { kind: 'retry' }; }
    const binding = authority ? bindingFromAuthority(authority) : null;
    // Fresh authority immediately before outbound publication: same owner DO, same revision, same exact binding.
    if (!authority || !binding || authority.doName !== input.ownerDoName || authority.revision !== input.revision || await bindingDigest(binding) !== input.bindingDigest) {
      if (authority && authority.state !== 'active' && authority.state !== 'pending') this.applyRevocation(store, authority.revision);
      return { kind: 'terminal', result: replyNotStarted(input.commandId, binding ?? null, 'authority_changed') };
    }
    const caps = store.capabilities(bridgeId, accountId);
    if (!store.online() || !caps || caps.readiness !== 'ready' || !caps.features.text.send || !caps.features.text.verified || !caps.features.text.exactTarget) return { kind: 'retry' };
    const key = await this.key(authority, environment, c.wrappingKey);
    if (!key) return { kind: 'retry' };
    let command: IMessageCommand;
    try { command = buildTextReply(binding, input.commandId, input.text); }
    catch { return { kind: 'terminal', result: replyNotStarted(input.commandId, binding, 'reply_invalid') }; }
    const body = JSON.stringify(command), commandDigest = await sha256Hex(body), now = Date.now(), deliveryId = crypto.randomUUID();
    const headers = await signS2(body, { version: 1, bridgeId, accountId, atMs: now, nonce: crypto.randomUUID() }, key);
    const commitment = await signCommitment({ bridgeId, accountId, deliveryId, commandId: command.commandId, commandDigest, expiresAtMs: now + c.policy.commitmentMaxAgeMs }, key);
    try {
      store.enqueue({ deliveryId, body, headers, commitment, commandDigest, ownerDoName: input.ownerDoName, replyRef: input.replyRef });
    } catch (error) {
      if (error instanceof BridgeStoreError && error.code === 'lane_quarantined') return { kind: 'terminal', result: replyNotStarted(input.commandId, binding, 'mutation_lane_poisoned') };
      if (error instanceof BridgeStoreError && error.code === 'command_conflict') return { kind: 'terminal', result: replyNotStarted(input.commandId, binding, 'command_conflict') };
      return { kind: 'retry' };
    }
    await this.rearm(store);
    return { kind: 'queued' };
  }

  /** Console revoke (after the canonical revision changed): cancel never-delivered work, keep evidence. */
  async revoke(): Promise<boolean> {
    const c = this.composition();
    if (!c) return false;
    this.applyRevocation(this.store(c.policy), 'console');
    return true;
  }
  private applyRevocation(store: BridgeStore, revision: string) {
    if (store.revokedRevision() !== null) return;
    store.revoke(revision);
    this.ctx.waitUntil(this.rearm(store, Date.now()));
  }

  /** Safe status for the owner console: no keys, bodies, handles or GUIDs. */
  async status(): Promise<{ online: boolean; textReady: boolean; quarantine: string | null; events: Record<string, number>; outstanding: number; revoked: boolean }> {
    const c = this.composition();
    if (!c) return { online: false, textReady: false, quarantine: null, events: {}, outstanding: 0, revoked: false };
    const store = this.store(c.policy), bridgeId = store.meta('bridge_id') ?? '', accountId = store.meta('account_id') ?? '';
    const caps = store.capabilities(bridgeId, accountId);
    return { online: store.online(), textReady: !!caps && caps.readiness === 'ready' && caps.features.text.send && caps.features.text.verified,
      quarantine: store.quarantineReason(), events: store.eventCounts(), outstanding: store.deliveries().filter(d => d.state === 'queued' || d.state === 'delivered').length,
      revoked: store.revokedRevision() !== null };
  }

  private async rearm(store: BridgeStore, at?: number) {
    const due = [at ?? null, store.sweepDeadlines(), store.nextPendingEvent() ? Date.now() + 250 : null, store.unreportedResults().length ? Date.now() + 250 : null]
      .filter((v): v is number => v !== null);
    if (!due.length) return;
    const existing = await this.ctx.storage.getAlarm();
    const next = Math.max(Date.now(), Math.min(...due));
    if (existing === null || next < existing) await armAlarm(this.ctx.storage, next);
  }

  override async alarm(): Promise<void> {
    const c = this.composition();
    if (!c || this.draining) return;
    this.draining = true;
    const store = this.store(c.policy);
    let retry = false;
    try {
      store.sweepDeadlines();
      retry = !(await this.reportResults(store)) || retry;
      retry = !(await this.drainEvents(store, c.environment)) || retry;
    } finally {
      this.draining = false;
      await this.rearm(store, retry ? Date.now() + RETRY_MS : undefined);
    }
  }

  private owner(doName: string): OwnerIMessagePort {
    const ns = this.env.TELEGRAM_OWNER_DO!;
    return ns.get(ns.idFromName(doName)) as unknown as OwnerIMessagePort;
  }

  /** At-least-once terminal result report to the owner outbox; the owner side is idempotent. */
  private async reportResults(store: BridgeStore): Promise<boolean> {
    for (const row of store.unreportedResults()) {
      try {
        if (await this.owner(row.ownerDoName).recordIMessageResult({ replyRef: row.replyRef, commandId: row.commandId, result: row.result! })) store.markReported(row.deliveryId);
        else return false;
      } catch { return false; }
    }
    return true;
  }

  /** Processes admitted events in order. Infrastructure failure leaves the event pending. */
  private async drainEvents(store: BridgeStore, environment: string): Promise<boolean> {
    const bridgeId = store.meta('bridge_id'), accountId = store.meta('account_id');
    if (!bridgeId || !accountId) return true;
    for (let pending = store.nextPendingEvent(); pending; pending = store.nextPendingEvent()) {
      const event = parseStoredEvent(pending);
      let authority: BridgeAuthority | null;
      try { authority = await this.directory().authority(environment, bridgeId, accountId); } catch { return false; }
      if (!authority || (authority.state !== 'active' && authority.state !== 'pending')) { if (authority || store.revokedRevision() === null) this.applyRevocation(store, authority?.revision ?? 'deleted'); return true; }
      const settle = (state: 'handed' | 'acknowledged' | 'held', reason: string) => store.settleEvent(pending!.seq, state, reason);
      if (event.kind === 'receipt') { settle('acknowledged', store.sentCommandFor(event.target.messageGuid!) ? 'receipt_correlated' : 'receipt_uncorrelated'); continue; }
      if (event.kind !== 'message') { settle('acknowledged', 'non_turn_evidence'); continue; }
      if (event.isFromMe || event.isGroup || event.service !== 'iMessage') { settle('acknowledged', event.isFromMe ? 'echo' : event.isGroup ? 'group' : 'non_imessage_service'); continue; }
      const binding = bindingFromAuthority(authority);
      if (!binding) { settle('held', 'binding_unavailable'); continue; }
      // Incoming media is retained as evidence and never treated as complete text.
      if (event.attachments.length) { settle('held', 'media_unsupported'); continue; }
      const outcome = await this.handToOwner(event, pending.digest, authority, binding, environment, store);
      if (outcome === 'retry') return false;
      settle(outcome === 'handed' ? 'handed' : outcome === 'held' ? 'held' : 'acknowledged', outcome);
    }
    return true;
  }

  private async handToOwner(event: IMessageEvent, digest: string, authority: BridgeAuthority, binding: IMessageBinding, environment: string, store: BridgeStore)
    : Promise<'handed' | 'not_admitted' | 'held' | 'retry'> {
    let latest = authority;
    const grant: IMessageAdmissionGrant = { binding, revision: authority.revision, doName: authority.doName };
    const directory = this.directory();
    try {
      const handoff = await admitIMessageOwnerTurn(event, {
        authority: {
          // Unknown senders and other chats resolve to no grant: no directory lookup, no owner context.
          resolve: (e) => e.senderHandle === binding.subject && e.chatGuid === binding.chatGuid && e.bridgeId === binding.bridgeId && e.accountId === binding.accountId ? grant : null,
          current: (g) => latest.state === 'active' && latest.revision === g.revision && latest.doName === g.doName,
        },
        directory: {
          byPresence: async (provider, subject) => {
            const [route, refreshed] = await Promise.all([
              ownerDirectory(this.env).byPresence(provider, subject),
              directory.authority(environment, binding.bridgeId, binding.accountId),
            ]);
            if (!refreshed) throw new Error('iMessage turn not admitted');
            latest = refreshed;
            return route;
          },
        },
      }, (_route, turn): IMessageTurnHandoff => ({
        dedupKey: JSON.stringify(['imessage', binding.bridgeId, binding.accountId, event.cursor.databaseGeneration, event.eventId]),
        digest, envelope: turn, binding, revision: grant.revision, environment,
        bridgeDoName: iMessageBridgeName(environment, binding.bridgeId, binding.accountId), ownerDoName: grant.doName, occurredAt: Date.parse(event.occurredAt),
      }));
      const admitted = await this.owner(authority.doName).admitIMessageTurn(handoff);
      if (admitted === 'admitted' || admitted === 'duplicate') return 'handed';
      if (admitted === 'capacity') return 'retry';
      return 'held';
    } catch (error) {
      if (error instanceof IMessageDirectoryUnavailable) return 'retry';
      if (error instanceof Error && error.message === 'iMessage turn not admitted') {
        if (latest.state !== 'active') { this.applyRevocation(store, latest.revision); return 'held'; }
        return 'not_admitted';
      }
      return 'retry';
    }
  }
}

/** Same semantics as the relay's buildSendCommand: exact binding, nonblank text, no rich features or SMS. */
export const buildTextReply = (binding: IMessageBinding, commandId: string, text: string): IMessageCommand => {
  if (!text.trim()) throw new Error('empty_text');
  const b = iMessageBindingSchema.parse(binding);
  return iMessageCommandSchema.parse({ version: 1, commandId, ownerId: b.ownerId, binding: b,
    target: { bridgeId: b.bridgeId, accountId: b.accountId, chatGuid: b.chatGuid }, service: 'iMessage', allowSMSFallback: false,
    operation: 'send', text, attachments: [] });
};

const replyNotStarted = (commandId: string, binding: IMessageBinding | null, reason: string): IMessageResult => ({
  version: 1, commandId, target: { bridgeId: binding?.bridgeId ?? 'unbound', accountId: binding?.accountId ?? 'unbound', chatGuid: binding?.chatGuid ?? 'unbound' },
  state: 'rejected', disposition: 'not_started', reason,
});

const deliveryWire = (d: DeliveryRow) => ({ deliveryId: d.deliveryId, attempt: d.attempt, body: d.body, headers: d.headers, commitment: d.commitment });

// Exported for the HTTP layer and tests; the host never chooses a key.
export const mintBridgeIdentity = () => {
  const hex = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { bridgeId: `imb_${hex()}`, accountId: `ima_${hex()}`, key: mintHostKey() };
};
