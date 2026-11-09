import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { iMessageBindingSchema, iMessageEventSchema, iMessageCommandSchema, iMessageCapabilitiesSchema, iMessageResultSchema, opaqueIMessageIdSchema as id, type IMessageBinding, type IMessageCommand, type IMessageFeature, type IMessageResult } from '@waldo/contracts';
import { RelayStore, type RelayState } from './store';
import type { IMessageTransport } from './transport';
const headerSchema = z.strictObject({ version: z.literal(1), bridgeId: id, accountId: id, atMs: z.int().nonnegative(), nonce: id, signature: z.string().regex(/^[a-f0-9]{64}$/) });
export type RelayHeaders = z.infer<typeof headerSchema>;
const policySchema = z.strictObject({ maxRecords: z.int().positive(), maxSpoolBytes: z.int().positive(), maxRequestBytes: z.int().positive(), signatureMaxAgeMs: z.int().positive(), heartbeatExpiryMs: z.int().positive(), mutationDeadlineMs: z.int().positive(), source: id });
export type RelayPolicy = z.infer<typeof policySchema>;
export type TrustedRelayAccount = Readonly<{ binding: IMessageBinding; key: string }>;
const hash = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');
const signedBytes = (body: string, h: Omit<RelayHeaders, 'signature'>) => Buffer.concat([Buffer.from(JSON.stringify([h.version, h.bridgeId, h.accountId, h.atMs, h.nonce]) + '\n'), Buffer.from(body, 'utf8')]);
export const signRelayRequest = (body: string, h: Omit<RelayHeaders, 'signature'>, key: string): RelayHeaders => ({ version: h.version, bridgeId: h.bridgeId, accountId: h.accountId, atMs: h.atMs, nonce: h.nonce, signature: createHmac('sha256', key).update(signedBytes(body, h)).digest('hex') });
const sameAccount = (row: { bridgeId: string; accountId: string }, h: { bridgeId: string; accountId: string }) => row.bridgeId === h.bridgeId && row.accountId === h.accountId;
const identity = (...parts: string[]) => JSON.stringify(parts);
const boundState = (state: RelayState, policy: RelayPolicy, bytes = 0) => {
  if (state.events.length + state.commands.length + state.heartbeats.length + state.nonces.length >= policy.maxRecords || [...state.events, ...state.commands].reduce((sum, e) => sum + e.bytes, 0) + bytes > policy.maxSpoolBytes) throw new Error('relay backpressure');
};
export class SignedRelay {
  private policy: RelayPolicy;
  constructor(private store: RelayStore, policy: RelayPolicy, private account: (bridgeId: string, accountId: string) => TrustedRelayAccount | null, private now = () => Date.now()) {
    this.policy = policySchema.parse(policy);
    this.store.transaction(state => {
      for (const row of state.commands.filter(c => c.state === 'started')) {
        row.state = 'quarantined';
        row.result = { version: 1, commandId: row.command.commandId, target: row.command.target, state: 'unknown', disposition: 'still_in_flight', reason: 'recovered_started_mutation' };
      }
    });
  }
  private authenticate(body: string, headers: unknown) {
    if (Buffer.byteLength(body, 'utf8') + Buffer.byteLength(JSON.stringify(headers), 'utf8') > this.policy.maxRequestBytes) throw new Error('relay request too large');
    const h = headerSchema.parse(headers);
    const trusted = this.account(h.bridgeId, h.accountId);
    if (!trusted || trusted.binding.bridgeId !== h.bridgeId || trusted.binding.accountId !== h.accountId || !trusted.key) throw new Error('relay authentication failed');
    const expected = Buffer.from(signRelayRequest(body, h, trusted.key).signature, 'hex');
    if (!timingSafeEqual(expected, Buffer.from(h.signature, 'hex'))) throw new Error('relay authentication failed');
    if (h.atMs > this.now() || this.now() - h.atMs > this.policy.signatureMaxAgeMs) throw new Error('relay stale signature');
    return { h, trusted, digest: hash(body) };
  }
  private nonceAvailable(state: RelayState, h: RelayHeaders) {
    state.nonces = state.nonces.filter(n => n.expiresAtMs >= this.now());
    if (state.nonces.some(row => sameAccount(row, h) && row.nonce === h.nonce)) throw new Error('relay nonce replay');
    boundState(state, this.policy);
    state.nonces.push({ bridgeId: h.bridgeId, accountId: h.accountId, nonce: h.nonce, expiresAtMs: h.atMs + this.policy.signatureMaxAgeMs });
  }
  admit(body: string, headers: unknown) {
    const { h, digest } = this.authenticate(body, headers);
    const event = iMessageEventSchema.parse(JSON.parse(body));
    if (!sameAccount(event, h)) throw new Error('relay account mismatch');
    const key = identity(h.bridgeId, h.accountId, event.cursor.databaseGeneration, event.eventId);
    return this.store.transaction(state => {
      const prior = state.events.find(e => e.identity === key);
      if (prior) {
        if (prior.digest !== digest) throw new Error('relay event conflict');
        return { state: 'duplicate' as const, eventId: event.eventId, digest };
      }
      this.nonceAvailable(state, h);
      boundState(state, this.policy, Buffer.byteLength(body, 'utf8'));
      let stream = state.streams.find(s => sameAccount(s, h));
      if (stream && stream.generation !== event.cursor.databaseGeneration) throw new Error('relay database generation mismatch');
      if (!stream) { stream = { bridgeId: h.bridgeId, accountId: h.accountId, generation: event.cursor.databaseGeneration }; state.streams.push(stream); }
      state.events.push({ identity: key, bridgeId: h.bridgeId, accountId: h.accountId, generation: event.cursor.databaseGeneration, eventId: event.eventId, nonce: h.nonce, digest, body, bytes: Buffer.byteLength(body, 'utf8'), state: 'pending' });
      stream.cursor = event.cursor.value;
      return { state: 'admitted' as const, eventId: event.eventId, digest };
    });
  }
  cursor(bridgeId: string, accountId: string, generation: string): string | null {
    return this.store.snapshot().streams.find(s => s.bridgeId === bridgeId && s.accountId === accountId && s.generation === generation)?.cursor ?? null;
  }
  async flush(admitCloud: (body: string, headers: RelayHeaders) => Promise<{ admitted: true; eventId: string; digest: string }>) {
    for (const event of this.store.snapshot().events.filter(e => e.state === 'pending')) {
      const trusted = this.account(event.bridgeId, event.accountId);
      if (!trusted || !trusted.key || trusted.binding.bridgeId !== event.bridgeId || trusted.binding.accountId !== event.accountId) throw new Error('relay account unavailable');
      const headers = signRelayRequest(event.body!, { version: 1, bridgeId: event.bridgeId, accountId: event.accountId, atMs: this.now(), nonce: randomUUID() }, trusted.key);
      const receipt = await this.deadline(admitCloud(event.body!, headers));
      if (receipt.admitted !== true || receipt.eventId !== event.eventId || receipt.digest !== event.digest) throw new Error('relay admission receipt mismatch');
      this.store.transaction(state => {
        const row = state.events.find(e => e.identity === event.identity)!;
        row.state = 'acknowledged'; row.body = undefined; row.bytes = 0;
      });
    }
  }
  heartbeat(body: string, headers: unknown) {
    const { h } = this.authenticate(body, headers);
    const beat = z.strictObject({ version: z.literal(1), bridgeId: id, accountId: id, databaseGeneration: id, status: z.enum(['online', 'offline']) }).parse(JSON.parse(body));
    if (!sameAccount(beat, h)) throw new Error('relay account mismatch');
    this.store.transaction(state => {
      this.nonceAvailable(state, h);
      let prior = state.heartbeats.find(b => sameAccount(b, h));
      if (prior && h.atMs <= prior.atMs) throw new Error('relay heartbeat replay');
      if (!prior) { boundState(state, this.policy); prior = { bridgeId: h.bridgeId, accountId: h.accountId, atMs: h.atMs, nonce: h.nonce, status: beat.status }; state.heartbeats.push(prior); }
      Object.assign(prior, { atMs: h.atMs, nonce: h.nonce, status: beat.status });
      const stream = state.streams.find(s => sameAccount(s, h));
      if (stream && stream.generation !== beat.databaseGeneration) { stream.generation = beat.databaseGeneration; stream.cursor = undefined; }
    });
  }
  online(bridgeId: string, accountId: string) {
    const beat = this.store.snapshot().heartbeats.find(b => b.bridgeId === bridgeId && b.accountId === accountId);
    return !!beat && this.now() >= beat.atMs && beat.status === 'online' && this.now() - beat.atMs <= this.policy.heartbeatExpiryMs;
  }
  async execute(body: string, headers: unknown, transport: IMessageTransport): Promise<IMessageResult> {
    const { h, trusted, digest } = this.authenticate(body, headers);
    const command = iMessageCommandSchema.parse(JSON.parse(body));
    const binding = iMessageBindingSchema.parse(trusted.binding);
    if (JSON.stringify(command.binding) !== JSON.stringify(binding)) throw new Error('relay command binding mismatch');
    const key = identity(h.bridgeId, h.accountId, command.commandId);
    const prior = this.store.snapshot().commands.find(c => c.identity === key);
    if (prior) {
      if (prior.digest !== digest) throw new Error('relay command conflict');
      if (prior.state === 'started') return { version: 1, commandId: command.commandId, target: command.target, state: 'unknown', disposition: 'still_in_flight', reason: 'concurrent_in_flight' };
      return prior.result;
    }
    const rejected = (reason: string): IMessageResult => ({ version: 1, commandId: command.commandId, target: command.target, state: 'rejected', disposition: 'not_started', reason });
    if (binding.conversationKind !== 'direct') return rejected('group_audience_unavailable');
    if (!this.online(h.bridgeId, h.accountId)) return rejected('relay_offline');
    let caps;
    try {
      const probe = await this.deadline(transport.probe());
      if (Buffer.byteLength(JSON.stringify(probe), 'utf8') > this.policy.maxRequestBytes) return rejected('probe_unavailable');
      caps = iMessageCapabilitiesSchema.parse(probe);
    } catch { return rejected('probe_unavailable'); }
    if (!this.online(h.bridgeId, h.accountId)) return rejected('relay_offline');
    const current = this.account(h.bridgeId, h.accountId);
    if (!current || current.key !== trusted.key || JSON.stringify(iMessageBindingSchema.parse(current.binding)) !== JSON.stringify(binding)) return rejected('relay_binding_changed');
    const feature: IMessageFeature = ({ send: 'text', react: command.operation === 'react' && command.reaction.kind === 'custom' ? 'custom_reactions' : 'standard_reactions', edit: 'edit', unsend: 'unsend', typing: 'typing', read: 'read_receipts' } as const)[command.operation];
    const required: IMessageFeature[] = [feature];
    if (command.operation === 'send') {
      if (command.attachments.length) required.push('files');
      if (command.attachments.some(a => a.kind === 'sticker')) required.push('stickers');
      if (command.attachments.some(a => a.nativeVoice)) required.push('native_voice');
      if (command.formatting?.length) required.push('formatting');
      if (command.effect) required.push('effects');
      if (command.target.messageGuid) required.push('replies');
    }
    if (!sameAccount(caps, h) || caps.readiness !== 'ready' || required.some(f => !caps.features[f].send || !caps.features[f].verified || (command.target.messageGuid !== undefined && !caps.features[f].exactTarget))) return rejected('capability_unverified');
    const admission = this.store.transaction(state => {
      const existing = state.commands.find(c => c.identity === key);
      if (existing) {
        if (existing.digest !== digest) throw new Error('relay command conflict');
        const result: IMessageResult = existing.state === 'started' ? { version: 1, commandId: command.commandId, target: command.target, state: 'unknown', disposition: 'still_in_flight', reason: 'concurrent_in_flight' } : existing.result;
        return { execute: false as const, result };
      }
      if (state.commands.some(c => sameAccount(c, h) && c.state === 'quarantined')) return { execute: false as const, result: rejected('mutation_lane_poisoned') };
      if (state.commands.some(c => sameAccount(c, h) && c.state === 'started')) return { execute: false as const, result: rejected('mutation_lane_busy') };
      this.nonceAvailable(state, h); boundState(state, this.policy, Buffer.byteLength(body, 'utf8'));
      state.commands.push({ identity: key, bridgeId: h.bridgeId, accountId: h.accountId, nonce: h.nonce, digest, body, bytes: Buffer.byteLength(body, 'utf8'), command, state: 'started', result: { version: 1, commandId: command.commandId, target: command.target, state: 'started' } });
      return { execute: true as const };
    });
    if (!admission.execute) return admission.result;
    try {
      const receipt = await this.deadline(transport.execute(command));
      if (Buffer.byteLength(JSON.stringify(receipt), 'utf8') > this.policy.maxRequestBytes) throw new Error('relay receipt too large');
      const result = iMessageResultSchema.parse(receipt);
      if (result.commandId !== command.commandId || JSON.stringify(result.target) !== JSON.stringify(command.target) || ['queued', 'started'].includes(result.state)) throw new Error('relay mutation receipt mismatch');
      return this.store.transaction(state => {
        const row = state.commands.find(c => c.identity === key)!;
        if (row.state === 'quarantined') return row.result;
        row.state = result.state === 'unknown' ? 'quarantined' : 'settled'; row.result = result;
        return result;
      });
    } catch {
      return this.quarantine(key, command, 'transport_result_unavailable');
    }
  }
  private async deadline<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('relay operation deadline')), this.policy.mutationDeadlineMs); });
      return await Promise.race([work, deadline]);
    } finally { if (timer) clearTimeout(timer); }
  }
  private quarantine(key: string, command: IMessageCommand, reason: string): IMessageResult {
    const result: IMessageResult = { version: 1, commandId: command.commandId, target: command.target, state: 'unknown', disposition: 'still_in_flight', reason };
    this.store.transaction(state => { const row = state.commands.find(c => c.identity === key)!; row.state = 'quarantined'; row.result = result; });
    return result;
  }
}
