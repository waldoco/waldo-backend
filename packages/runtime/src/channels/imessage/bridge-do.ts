import { DurableObject } from 'cloudflare:workers';
import {
  iMessageBindingSchema, iMessageCapabilitiesSchema, iMessageCommandSchema, iMessageEventSchema,
  type IMessageBinding, type IMessageCapabilities, type IMessageCommand, type IMessageEvent, type IMessageResult, type IMessageStandardReaction,
} from '@waldo/contracts';
import { armAlarm } from '../../scheduler/alarm-slot';
import { linkCodeHash, ownerDirectory, type OwnerDirectoryEnv } from '../../identity/owner-directory';
import type { OwnerTurnEnvelope } from '../owner-turn-envelope';
import { admitIMessageOwnerTurn, type IMessageAdmissionGrant } from './admission';
import { BridgeStore, BridgeStoreError, parseStoredEvent, type DeliveryRow } from './bridge-store';
import { mintHostKey, sha256Hex, signCommitment, signS2, unwrapCredential, verifyS2, type S2Headers } from './crypto';
import { iMessageDirectory, IMessageDirectoryUnavailable, type BridgeAuthority, type SenderAuthority } from './directory';
import { parseIMessageConnectorPolicy, type IMessageConnectorPolicy } from './policy';
import { HEALTH_SPAN_MARKER, redactNumericHealth } from '../../scribe/sanitiser';
import { PhotonTokens, photonConfig, photonDoName, type PhotonEnv, type PhotonFinish, type PhotonStatus } from './photon';
import { iMessageMediaOf, type IMessageMedia, type PhotonMediaEnv } from './photon-media';
import type { IMessageTapback } from './final-outbox';
import { heartbeatBodySchema, parseJson, pullBodySchema, resultBodySchema } from './wire';

export type IMessageEnv = OwnerDirectoryEnv & PhotonEnv & Readonly<{
  WALDO_ENVIRONMENT?: string;
  IMESSAGE_CONNECTOR_ENABLED?: string;
  IMESSAGE_CONNECTOR_POLICY?: string;
  IMESSAGE_CREDENTIAL_WRAPPING_KEY?: string;
  IMESSAGE_BRIDGE_DO?: DurableObjectNamespace;
  OWNER_DO?: DurableObjectNamespace;
  RESPONSIBILITY_RATE_LIMITER?: RateLimit;
  /** Shared Waldo number: where a sender with no Waldo is sent (https only). Unset = strangers get no reply. */
  IMESSAGE_ONBOARDING_URL?: string;
  /** Shared Waldo number: the address owners text "waldo CODE" to, shown in the console. */
  IMESSAGE_WALDO_ADDRESS?: string;
  /** Shared Waldo number on Photon: the console page an enrolled but unlinked sender is sent to (https only). */
  IMESSAGE_CONSOLE_URL?: string;
  /** "1": photos and files on Photon are fetched for the model. Otherwise each gets one reply that it was not opened. */
  IMESSAGE_MEDIA?: string;
}> & PhotonMediaEnv;

/** Composition gate: every piece must be present, otherwise the connector is disabled (no fallback). */
export const iMessageComposition = (env: IMessageEnv): { policy: IMessageConnectorPolicy; environment: string; wrappingKey: string } | null => {
  if (env.IMESSAGE_CONNECTOR_ENABLED !== '1' || !env.IMESSAGE_BRIDGE_DO || !env.OWNER_DO) return null;
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

/** Inbound turn handed to the owner DO. The owner inbox deduplicates on dedupKey + digest. Files cross as references only. */
export type IMessageTurnHandoff = Readonly<{
  dedupKey: string; digest: string; envelope: OwnerTurnEnvelope; binding: IMessageBinding; revision: string;
  environment: string; bridgeDoName: string; ownerDoName: string; occurredAt: number; media?: IMessageMedia;
}>;
export type IMessageResultReport = Readonly<{ replyRef: string; commandId: string; result: IMessageResult }>;
/** subject: the sender the reply answers; on a shared bridge it selects that sender's own authority. */
// reaction: a tapback instead of text, on a message in the bound chat.
export type ReplyHandoff = Readonly<{ replyRef: string; commandId: string; text: string; ownerDoName: string; revision: string; bindingDigest: string; subject?: string; reaction?: IMessageTapback }>;
// busy: the one mailbox slot holds another command; the slot frees within a host pull and a send, so retry soon.
export type ReplyHandoffOutcome = { kind: 'queued' | 'retry' | 'busy' } | { kind: 'terminal'; result: IMessageResult };
/** The owner's tapback on a message Waldo sent them, with the opening of that message's text. Never a turn. */
export type IMessageReactionHandoff = Readonly<{
  binding: IMessageBinding; revision: string; environment: string; bridgeDoName: string; ownerDoName: string;
  action: 'add' | 'remove'; type: IMessageStandardReaction; target: Readonly<{ messageGuid: string; partIndex: number }>; quoted: string;
}>;
export interface OwnerIMessagePort {
  admitIMessageTurn(input: IMessageTurnHandoff): Promise<'admitted' | 'duplicate' | 'conflict' | 'capacity' | 'refused'>;
  noteIMessageReaction(input: IMessageReactionHandoff): Promise<'noted' | 'refused'>;
  recordIMessageResult(input: IMessageResultReport): Promise<boolean>;
}

const reply = (status: number, body: unknown): HostReply => ({ status, json: JSON.stringify(body) });
const fixed = (status: number, error: string): HostReply => reply(status, { error });
const invalid = (): HostReply => fixed(401, 'invalid_request');
const RETRY_MS = 5_000;
/** System replies (onboarding, link results) have no owner: the bridge answers them itself. */
const SYSTEM_REPLY_PREFIX = 'system:';
// How long a reply that met a busy slot keeps notes off it: past the owner's 1 s retry, with room for its alarm.
const REPLY_WAITING_MS = 5_000;
const PROGRESS = 'progress:';
// How much of the reacted-to message the owner's next turn reads with the tapback.
const REACTION_QUOTE_CHARS = 80;
export const SYSTEM_OWNER_ID = 'waldo-system';
/** "waldo CODE": the one-time link code from the console (same alphabet as Telegram and WhatsApp codes). */
const LINK_TEXT = /^waldo\s+([A-HJ-NP-Za-hj-np-z2-9]{10})$/i;
export const LINK_REPLIES = {
  redeemed: 'Linked. Texts from this number now go to your own Waldo.',
  rejected: 'That code did not work. Get a new one from your Waldo console.',
  claimed: 'This number is already linked to a Waldo account, so it was not moved. To link it here, unlink it in that account\'s console first, then text a new code.',
  uncertain: 'Linking could not be confirmed. Check your Waldo console before trying a new code.',
} as const;
export const enrolledReply = (url: string) =>
  `Hi, I'm Waldo. This number is set up for your Waldo account but not linked yet. Open ${url} and tap Open Messages to finish.`;
export const onboardingReply = (url: string) =>
  `Hi, I'm Waldo. This number only talks to people with their own Waldo. To get yours, join here: ${url} - already have one? Text waldo followed by the code from your Waldo console.`;
const onboardingUrl = (raw: string | undefined): string | null => {
  try { const u = new URL(raw ?? ''); return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : null; } catch { return null; }
};
type SharedStrangerOutcome = 'link_redeemed' | 'link_claimed' | 'link_failed' | 'link_throttled' | 'stranger_onboarded' | 'stranger_throttled' | 'stranger_ignored';
const isSenderAuthority = (a: SenderAuthority | null): a is BridgeAuthority => !!a && a.state !== 'unknown_sender';

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
  // Until then a reply is waiting for the slot, so no progress note takes it. Memory only: an evicted bridge forgets it,
  // and the waiting reply still takes the slot back from a note the host has not pulled.
  private replyWaitingUntil = 0;
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
    let authority: BridgeAuthority | null;
    try { authority = await this.directory().authority(c.environment, headers.bridgeId, headers.accountId); }
    catch { return fixed(503, 'unavailable'); }
    // No storage is opened for an unknown tuple: an unsigned request for a made-up bridge leaves nothing behind.
    if (!authority) return invalid();
    if (authority.state !== 'pending' && authority.state !== 'active') {
      // Revoked/expired: record it locally, but the host always gets the 401 that tells it to stop.
      try { this.applyRevocation(this.store(c.policy), authority.revision); } catch { console.error('imessage revoke record deferred'); }
      return invalid();
    }
    const key = await this.key(authority, c.environment, c.wrappingKey);
    if (!key || !(await verifyS2(body, headers, key))) return invalid();
    const now = Date.now();
    if (headers.atMs > now || now - headers.atMs > c.policy.signatureMaxAgeMs) return invalid();
    const store = this.store(c.policy);
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
      if (event.kind !== 'message' || event.isFromMe || event.isGroup || event.service !== 'iMessage' || event.attachments.length || event.photonAttachments?.length
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
    // Notes come last in this one-slot mailbox. A note goes only into a free slot no reply is waiting for, and never after its
    // own owner's reply for that turn (turn ids are per owner). Every other message takes the slot from a note the host has
    // not pulled; one already pulled goes out first, as the mailbox sends in order. The slot is read before any directory or
    // signing work, so a reply waiting on it costs no lookup per retry.
    const [kind, turn] = input.replyRef.split(':');
    const progress = kind === 'progress';
    const holder = store.outstanding();
    if (holder && (progress || !queuedNote(holder))) {
      if (progress) return { kind: 'terminal', result: replyNotStarted(input.commandId, null, 'progress_busy') };
      this.replyWaitingUntil = Date.now() + REPLY_WAITING_MS;
      return { kind: 'busy' };
    }
    if (progress && Date.now() < this.replyWaitingUntil) return { kind: 'terminal', result: replyNotStarted(input.commandId, null, 'progress_yields') };
    let found: SenderAuthority | null;
    try {
      found = input.subject !== undefined ? await this.directory().senderAuthority(environment, bridgeId, accountId, input.subject)
        : await this.directory().authority(environment, bridgeId, accountId);
    } catch { return { kind: 'retry' }; }
    const authority = isSenderAuthority(found) ? found : null;
    const binding = authority ? bindingFromAuthority(authority) : null;
    // Fresh authority immediately before outbound publication: same owner DO, same revision, same exact binding.
    if (!authority || !binding || authority.doName !== input.ownerDoName || authority.revision !== input.revision || await bindingDigest(binding) !== input.bindingDigest) {
      // A sender that unlinked never revokes a shared bridge; only a bridge-level loss does.
      if (authority && authority.state !== 'active' && authority.state !== 'pending' && (authority.kind === 'owner' || !authority.subject)) this.applyRevocation(store, authority.revision);
      return { kind: 'terminal', result: replyNotStarted(input.commandId, binding ?? null, 'authority_changed') };
    }
    if (input.reaction && input.reaction.chatGuid !== binding.chatGuid) return { kind: 'terminal', result: replyNotStarted(input.commandId, binding, 'target_not_in_chat') };
    const caps = store.capabilities(bridgeId, accountId);
    if (!store.online() || !caps || caps.readiness !== 'ready' || (!input.reaction && !sends(caps, 'text'))) return { kind: 'retry' };
    // A host that reports itself but not verified tapbacks will not send this one later either.
    if (input.reaction && !sends(caps, 'standard_reactions')) return { kind: 'terminal', result: replyNotStarted(input.commandId, binding, 'tapbacks_unverified') };
    const key = await this.key(authority, environment, c.wrappingKey);
    if (!key) return { kind: 'retry' };
    let command: IMessageCommand;
    try { command = input.reaction ? buildTapback(binding, input.commandId, input.reaction) : buildTextReply(binding, input.commandId, input.text); }
    catch { return { kind: 'terminal', result: replyNotStarted(input.commandId, binding, 'reply_invalid') }; }
    const body = JSON.stringify(command), commandDigest = await sha256Hex(body), now = Date.now(), deliveryId = crypto.randomUUID();
    const headers = await signS2(body, { version: 1, bridgeId, accountId, atMs: now, nonce: crypto.randomUUID() }, key);
    const commitment = await signCommitment({ bridgeId, accountId, deliveryId, commandId: command.commandId, commandDigest, expiresAtMs: now + c.policy.commitmentMaxAgeMs }, key);
    // Checked with no await before the enqueue, so a reply that landed during this call's awaits is seen.
    if (progress && store.deliveriesFor(input.ownerDoName, `reply:${turn}`).length) return { kind: 'terminal', result: replyNotStarted(input.commandId, binding, 'progress_superseded') };
    if (progress && Date.now() < this.replyWaitingUntil) return { kind: 'terminal', result: replyNotStarted(input.commandId, binding, 'progress_yields') };
    try {
      if (!progress) this.takeFromNote(store, input.ownerDoName, `${PROGRESS}${turn}:`);
      store.enqueue({ deliveryId, body, headers, commitment, commandDigest, ownerDoName: input.ownerDoName, replyRef: input.replyRef });
    } catch (error) {
      if (error instanceof BridgeStoreError && error.code === 'lane_quarantined') return { kind: 'terminal', result: replyNotStarted(input.commandId, binding, 'mutation_lane_poisoned') };
      if (error instanceof BridgeStoreError && error.code === 'command_conflict') return { kind: 'terminal', result: replyNotStarted(input.commandId, binding, 'command_conflict') };
      if (error instanceof BridgeStoreError && error.code === 'outstanding_command') {
        if (progress) return { kind: 'terminal', result: replyNotStarted(input.commandId, binding, 'progress_busy') };
        this.replyWaitingUntil = Date.now() + REPLY_WAITING_MS;
        return { kind: 'busy' };
      }
      return { kind: 'retry' };
    }
    await this.rearm(store);
    return { kind: 'queued' };
  }

  // A note the host has not pulled gives up the slot. It settles not_started for its own owner: superseded when it is this
  // owner's note for this turn, preempted otherwise. Nothing else of that owner's is read or touched.
  private takeFromNote(store: BridgeStore, owner: string, turnNotes: string | null): void {
    const holder = store.outstanding();
    if (!holder || !queuedNote(holder)) return;
    store.withdraw(holder.deliveryId, turnNotes !== null && holder.ownerDoName === owner && holder.replyRef.startsWith(turnNotes) ? 'progress_superseded' : 'progress_preempted');
  }

  /** Whether this bridge's host sends standard tapbacks now: online, ready, and the flag sent, verified and exact. */
  async tapbacksReady(): Promise<boolean> {
    const c = this.composition();
    return !!c && this.tapbacks(this.store(c.policy));
  }
  private tapbacks(store: BridgeStore): boolean {
    const caps = store.capabilities(store.meta('bridge_id') ?? '', store.meta('account_id') ?? '');
    return store.online() && !!caps && caps.readiness === 'ready' && sends(caps, 'standard_reactions');
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
  /** Photon OAuth custody lives on one instance per environment; every other instance refuses. */
  private photonTokens(): PhotonTokens | null {
    const c = this.composition(), config = photonConfig(this.env);
    if (!c || !config || !this.env.IMESSAGE_BRIDGE_DO?.idFromName(photonDoName(c.environment)).equals(this.ctx.id)) return null;
    return new PhotonTokens(this.ctx.storage.kv, config);
  }
  async photonBegin(owner: string, redirectUri: string): Promise<{ nonce: string; url: string } | null> {
    const tokens = this.photonTokens();
    return tokens ? tokens.begin(owner, redirectUri) : null;
  }
  /**
   * Token work is serialized (a refresh spends the refresh token it uses). Failures are caught inside the serialized
   * section and rethrown after it: a throw inside blockConcurrencyWhile would reset the object.
   */
  private async serialized<T>(work: () => Promise<T>): Promise<T> {
    const outcome = await this.ctx.blockConcurrencyWhile(async () => { try { return { ok: true as const, value: await work() }; } catch { return { ok: false as const }; } });
    if (!outcome.ok) throw new Error('photon_unavailable');
    return outcome.value;
  }
  async photonFinish(nonce: string, query: string): Promise<PhotonFinish> {
    const tokens = this.photonTokens();
    if (!tokens) return 'failed';
    try { return await this.serialized(() => tokens.finish(nonce, new URLSearchParams(query))); } catch { return 'failed'; }
  }
  /** null = not connected. Throws when Photon's answer is unknown (the stored token is kept). */
  async photonAccessToken(): Promise<string | null> {
    const tokens = this.photonTokens();
    return tokens ? this.serialized(() => tokens.accessToken()) : null;
  }
  async photonDropAccess(): Promise<void> { this.photonTokens()?.dropAccess(); }
  async photonKeepAlive(): Promise<'fresh' | 'refreshed' | 'disconnected' | 'unconfigured'> {
    const tokens = this.photonTokens();
    return tokens ? this.serialized(() => tokens.keepAlive()) : 'unconfigured';
  }
  async photonStatus(): Promise<PhotonStatus | null> { return this.photonTokens()?.status() ?? null; }

  async status(): Promise<{ online: boolean; textReady: boolean; tapbacksReady: boolean; quarantine: string | null; events: Record<string, number>; outstanding: number; revoked: boolean }> {
    const c = this.composition();
    if (!c) return { online: false, textReady: false, tapbacksReady: false, quarantine: null, events: {}, outstanding: 0, revoked: false };
    const store = this.store(c.policy), bridgeId = store.meta('bridge_id') ?? '', accountId = store.meta('account_id') ?? '';
    const caps = store.capabilities(bridgeId, accountId);
    return { online: store.online(), textReady: !!caps && caps.readiness === 'ready' && caps.features.text.send && caps.features.text.verified, tapbacksReady: this.tapbacks(store),
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
    const ns = this.env.OWNER_DO!;
    return ns.get(ns.idFromName(doName)) as unknown as OwnerIMessagePort;
  }

  /** At-least-once terminal result report to the owner outbox; the owner side is idempotent. */
  private async reportResults(store: BridgeStore): Promise<boolean> {
    for (const row of store.unreportedResults()) {
      if (row.replyRef.startsWith(SYSTEM_REPLY_PREFIX)) { store.markReported(row.deliveryId); continue; }
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
      if (event.kind === 'reaction') {
        const outcome = await this.noteReaction(event, authority, environment, bridgeId, accountId, store);
        if (outcome === 'retry') return false;
        settle('acknowledged', outcome);
        continue;
      }
      if (event.kind !== 'message') { settle('acknowledged', 'non_turn_evidence'); continue; }
      if (event.isFromMe || event.isGroup || event.service !== 'iMessage') { settle('acknowledged', event.isFromMe ? 'echo' : event.isGroup ? 'group' : 'non_imessage_service'); continue; }
      if (authority.kind === 'shared') {
        // Shared Waldo number: a sender reaches only their own Waldo, through their own presence.
        if (authority.state !== 'active') { settle('acknowledged', 'shared_bridge_pending'); continue; }
        if (event.chatGuid !== `iMessage;-;${event.senderHandle}`) { settle('acknowledged', 'not_sender_direct_chat'); continue; }
        const outcome = await this.routeSharedSender(event, pending.digest, environment, bridgeId, accountId, store);
        if (outcome === 'retry') return false;
        settle(outcome === 'handed' ? 'handed' : outcome === 'held' ? 'held' : 'acknowledged', outcome);
        continue;
      }
      const binding = bindingFromAuthority(authority);
      if (!binding) { settle('held', 'binding_unavailable'); continue; }
      const outcome = await this.handToOwner(event, pending.digest, authority, binding, environment, store);
      if (outcome === 'retry') return false;
      settle(outcome === 'handed' ? 'handed' : outcome === 'held' ? 'held' : 'acknowledged', outcome);
    }
    return true;
  }

  private async handToOwner(event: IMessageEvent, digest: string, authority: BridgeAuthority, binding: IMessageBinding, environment: string, store: BridgeStore,
    refresh: () => Promise<SenderAuthority | null> = () => this.directory().authority(environment, binding.bridgeId, binding.accountId))
    : Promise<'handed' | 'not_admitted' | 'held' | 'retry'> {
    let latest = authority;
    const grant: IMessageAdmissionGrant = { binding, revision: authority.revision, doName: authority.doName };
    try {
      // No bytes cross here: a host's files go to the owner as references beside the admitted words.
      const media = event.kind === 'message' ? iMessageMediaOf(event) : undefined;
      const handoff = await admitIMessageOwnerTurn(event.kind === 'message' ? { ...event, attachments: [] } : event, {
        authority: {
          // Unknown senders and other chats resolve to no grant: no directory lookup, no owner context.
          resolve: (e) => e.senderHandle === binding.subject && e.chatGuid === binding.chatGuid && e.bridgeId === binding.bridgeId && e.accountId === binding.accountId ? grant : null,
          current: (g) => latest.state === 'active' && latest.revision === g.revision && latest.doName === g.doName,
        },
        directory: {
          byPresence: async (provider, subject) => {
            const [route, refreshed] = await Promise.all([
              ownerDirectory(this.env).byPresence(provider, subject),
              refresh(),
            ]);
            if (!isSenderAuthority(refreshed)) throw new Error('iMessage turn not admitted');
            latest = refreshed;
            return route;
          },
        },
      }, (_route, turn): IMessageTurnHandoff => ({
        dedupKey: JSON.stringify(['imessage', binding.bridgeId, binding.accountId, event.cursor.databaseGeneration, event.eventId]),
        digest, envelope: turn, binding, revision: grant.revision, environment,
        bridgeDoName: iMessageBridgeName(environment, binding.bridgeId, binding.accountId), ownerDoName: grant.doName, occurredAt: Date.parse(event.occurredAt),
        ...(media ? { media } : {}),
      }));
      const admitted = await this.owner(authority.doName).admitIMessageTurn(handoff);
      if (admitted === 'admitted' || admitted === 'duplicate') return 'handed';
      if (admitted === 'capacity') return 'retry';
      return 'held';
    } catch (error) {
      if (error instanceof IMessageDirectoryUnavailable) return 'retry';
      if (error instanceof Error && error.message === 'iMessage turn not admitted') {
        if (latest.state !== 'active') { if (authority.kind === 'owner') this.applyRevocation(store, latest.revision); return 'held'; }
        return 'not_admitted';
      }
      return 'retry';
    }
  }

  /**
   * The owner's standard tapback, in their own bound direct chat, on a message Waldo sent there: handed to their owner DO as a
   * line for their next turn. It never starts a turn and never reaches approval code. Anything else is evidence only.
   */
  private async noteReaction(event: Extract<IMessageEvent, { kind: 'reaction' }>, authority: BridgeAuthority, environment: string, bridgeId: string, accountId: string, store: BridgeStore)
    : Promise<'reaction_noted' | 'reaction_refused' | 'reaction_ignored' | 'reaction_untracked' | 'retry'> {
    if (event.isFromMe || event.isGroup || event.service !== 'iMessage' || event.reaction.kind !== 'standard' || event.actorHandle !== event.senderHandle) return 'reaction_ignored';
    let sender: SenderAuthority | null = authority;
    if (authority.kind === 'shared') {
      if (event.chatGuid !== `iMessage;-;${event.senderHandle}`) return 'reaction_ignored';
      try { sender = await this.directory().senderAuthority(environment, bridgeId, accountId, event.senderHandle); } catch { return 'retry'; }
    }
    const owner = isSenderAuthority(sender) ? sender : null, binding = owner ? bindingFromAuthority(owner) : null;
    if (!owner || !binding || binding.subject !== event.actorHandle || binding.chatGuid !== event.chatGuid) return 'reaction_ignored';
    const commandId = store.sentCommandFor(event.target.messageGuid!), sent = commandId ? store.delivery({ commandId }) : null;
    const command = sent ? iMessageCommandSchema.parse(JSON.parse(sent.body)) : null;
    if (!sent || command?.operation !== 'send' || sent.ownerDoName !== owner.doName || command.target.chatGuid !== event.chatGuid) return 'reaction_untracked';
    const words = [...redactNumericHealth(command.text, HEALTH_SPAN_MARKER)];
    try {
      const noted = await this.owner(owner.doName).noteIMessageReaction({ binding, revision: owner.revision, environment, bridgeDoName: iMessageBridgeName(environment, bridgeId, accountId),
        ownerDoName: owner.doName, action: event.action, type: event.reaction.type, target: { messageGuid: event.target.messageGuid!, partIndex: event.target.partIndex ?? 0 },
        quoted: words.length > REACTION_QUOTE_CHARS ? `${words.slice(0, REACTION_QUOTE_CHARS).join('')}…` : words.join('') });
      return noted === 'noted' ? 'reaction_noted' : 'reaction_refused';
    } catch { return 'retry'; }
  }

  /** Shared bridge: the sender's own authority decides; no linked Waldo means the stranger path. */
  private async routeSharedSender(event: IMessageEvent, digest: string, environment: string, bridgeId: string, accountId: string, store: BridgeStore)
    : Promise<'handed' | 'not_admitted' | 'held' | 'retry' | SharedStrangerOutcome> {
    // "waldo CODE" is always a link action, never a turn. It links a new sender and moves the code owner's
    // own handle (for example off their per-owner Mac bridge); a handle another owner holds is refused.
    if (event.kind === 'message' && LINK_TEXT.test(event.text.trim())) return this.answerStranger(event, environment, bridgeId, accountId, store);
    const read = () => this.directory().senderAuthority(environment, bridgeId, accountId, event.senderHandle);
    let sender: SenderAuthority | null;
    try { sender = await read(); } catch { return 'retry'; }
    if (!sender) return 'held';
    if (sender.state === 'unknown_sender') return this.answerStranger(event, environment, bridgeId, accountId, store);
    if (sender.state !== 'active') return 'held';
    const binding = bindingFromAuthority(sender);
    if (!binding || binding.subject !== event.senderHandle) return 'held';
    return this.handToOwner(event, digest, sender, binding, environment, store, read);
  }

  /** A "waldo CODE" link attempt from anyone, or one throttled onboarding reply to a sender with no Waldo. Never a turn. */
  private async answerStranger(event: IMessageEvent, environment: string, bridgeId: string, accountId: string, store: BridgeStore)
    : Promise<'retry' | 'held' | SharedStrangerOutcome> {
    if (event.kind !== 'message') return 'stranger_ignored';
    const ready = this.systemReplyReady(store, bridgeId, accountId);
    if (ready === 'retry') return 'retry';
    const subjectHash = await sha256Hex(JSON.stringify([bridgeId, event.senderHandle]));
    const directory = this.directory();
    const code = LINK_TEXT.exec(event.text.trim())?.[1];
    try {
      if (code) {
        if (!(await directory.throttle(`imlink.sender.${subjectHash}`, 5, 3600))) return 'link_throttled';
        const redeemHashed = ownerDirectory(this.env).redeemHashed;
        const outcome = redeemHashed ? await redeemHashed('imessage', event.senderHandle, await linkCodeHash(code)) : { kind: 'uncertain' as const };
        await this.enqueueSystemReply(store, event, environment, bridgeId, accountId, LINK_REPLIES[outcome.kind]);
        return outcome.kind === 'redeemed' ? 'link_redeemed' : outcome.kind === 'claimed' ? 'link_claimed' : 'link_failed';
      }
      // A number its owner enrolled on Photon but has not linked: point them at their console, never at a Waldo.
      // Only Photon enrolls numbers: without it there is nothing to look up (and no enrollment table to depend on).
      const finish = photonConfig(this.env) ? onboardingUrl(this.env.IMESSAGE_CONSOLE_URL) : null;
      if (finish && ready !== 'unavailable' && await directory.enrolledHandle(environment, event.senderHandle)) {
        const enrolledHash = await sha256Hex(JSON.stringify([bridgeId, 'enrolled', event.senderHandle]));
        if (!(await directory.onboardingAllowed(environment, bridgeId, accountId, enrolledHash))) return 'stranger_throttled';
        await this.enqueueSystemReply(store, event, environment, bridgeId, accountId, enrolledReply(finish));
        return 'stranger_onboarded';
      }
      const url = onboardingUrl(this.env.IMESSAGE_ONBOARDING_URL);
      if (!url || ready === 'unavailable') return 'stranger_ignored';
      if (!(await directory.onboardingAllowed(environment, bridgeId, accountId, subjectHash))) return 'stranger_throttled';
      await this.enqueueSystemReply(store, event, environment, bridgeId, accountId, onboardingReply(url));
      return 'stranger_onboarded';
    } catch (error) {
      return error instanceof IMessageDirectoryUnavailable ? 'retry' : 'held';
    }
  }

  /** A system reply needs a ready host and a free lane; 'unavailable' = the host cannot send text at all. */
  private systemReplyReady(store: BridgeStore, bridgeId: string, accountId: string): 'ready' | 'retry' | 'unavailable' {
    if (store.quarantined()) return 'unavailable';
    const caps = store.capabilities(bridgeId, accountId);
    if (!store.online() || !caps || caps.readiness !== 'ready' || !caps.features.text.send || !caps.features.text.verified || !caps.features.text.exactTarget) return 'unavailable';
    return store.deliveries().some(d => d.state === 'queued' || d.state === 'delivered') ? 'retry' : 'ready';
  }

  /** Enqueues one fixed reply to the sender's own direct chat; identity is derived from the event, so a redrain never duplicates it. */
  private async enqueueSystemReply(store: BridgeStore, event: IMessageEvent, environment: string, bridgeId: string, accountId: string, text: string): Promise<void> {
    const c = this.composition();
    if (!c) return;
    const authority = await this.directory().authority(environment, bridgeId, accountId);
    if (!authority || authority.kind !== 'shared' || authority.state !== 'active') return;
    const key = await this.key(authority, environment, c.wrappingKey);
    if (!key) return;
    const binding = iMessageBindingSchema.parse({ ownerId: SYSTEM_OWNER_ID, presenceId: SYSTEM_OWNER_ID, subject: event.senderHandle, bridgeId, accountId,
      chatGuid: `iMessage;-;${event.senderHandle}`, verified: true, conversationKind: 'direct', service: 'iMessage' });
    const commandId = `wsys_${(await sha256Hex(JSON.stringify(['imessage-system', bridgeId, accountId, event.cursor.databaseGeneration, event.eventId]))).slice(0, 40)}`;
    if (store.delivery({ commandId })) return;
    const command = buildTextReply(binding, commandId, text);
    const body = JSON.stringify(command), commandDigest = await sha256Hex(body), now = Date.now(), deliveryId = crypto.randomUUID();
    const headers = await signS2(body, { version: 1, bridgeId, accountId, atMs: now, nonce: crypto.randomUUID() }, key);
    const commitment = await signCommitment({ bridgeId, accountId, deliveryId, commandId, commandDigest, expiresAtMs: now + c.policy.commitmentMaxAgeMs }, key);
    // A lane taken in the meantime (or a full store) means no system reply: never a retry that could resend.
    try { this.takeFromNote(store, '', null); store.enqueue({ deliveryId, body, headers, commitment, commandDigest, ownerDoName: '', replyRef: `${SYSTEM_REPLY_PREFIX}${commandId}` }); }
    catch (error) { if (error instanceof BridgeStoreError) return; throw error; }
    await this.rearm(store);
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

/** A standard tapback on an exact message and part in the bound chat; added, never removed. */
export const buildTapback = (binding: IMessageBinding, commandId: string, tapback: IMessageTapback): IMessageCommand => {
  const b = iMessageBindingSchema.parse(binding);
  return iMessageCommandSchema.parse({ version: 1, commandId, ownerId: b.ownerId, binding: b,
    target: { bridgeId: b.bridgeId, accountId: b.accountId, chatGuid: b.chatGuid, messageGuid: tapback.messageGuid, partIndex: tapback.partIndex }, service: 'iMessage', allowSMSFallback: false,
    operation: 'react', reaction: { kind: 'standard', type: tapback.type }, action: 'add' });
};
// A feature the host sends with probe evidence, on an exact target.
const sends = (caps: IMessageCapabilities, feature: 'text' | 'standard_reactions') => caps.features[feature].send && caps.features[feature].verified && caps.features[feature].exactTarget;

const replyNotStarted = (commandId: string, binding: IMessageBinding | null, reason: string): IMessageResult => ({
  version: 1, commandId, target: { bridgeId: binding?.bridgeId ?? 'unbound', accountId: binding?.accountId ?? 'unbound', chatGuid: binding?.chatGuid ?? 'unbound' },
  state: 'rejected', disposition: 'not_started', reason,
});

const queuedNote = (d: DeliveryRow) => d.state === 'queued' && d.replyRef.startsWith(PROGRESS);
const deliveryWire = (d: DeliveryRow) => ({ deliveryId: d.deliveryId, attempt: d.attempt, body: d.body, headers: d.headers, commitment: d.commitment });

// Exported for the HTTP layer and tests; the host never chooses a key.
export const mintBridgeIdentity = () => {
  const hex = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { bridgeId: `imb_${hex()}`, accountId: `ima_${hex()}`, key: mintHostKey() };
};
