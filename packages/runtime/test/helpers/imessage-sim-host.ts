// SIMULATED host for backend tests. It is NOT Suyash's waldo-imessage-host implementation; it only
// exercises the waldo-imessage-http-v1 contract: S2-signed requests, commitment verification and a
// durable commandId+digest journal before a (fake) native send.
import { iMessageCommandSchema, type IMessageResult } from '@waldo/contracts';
import { S2_HEADER } from '../../src/channels/imessage/wire';
import { sha256Hex, signS2, verifyCommitment, verifyS2, type S2Headers } from '../../src/channels/imessage/crypto';

export type Call = (request: Request) => Promise<Response>;
export type Delivery = { deliveryId: string; attempt: number; body: string; headers: S2Headers; commitment: { version: 1; commandDigest: string; expiresAtMs: number; signature: string } };

export class SimulatedHost {
  bridgeId = ''; accountId = ''; key = '';
  generation = 'sim-generation-1';
  /** Durable journal: commandId -> {digest, result}. A journaled command is never sent natively twice. */
  readonly journal = new Map<string, { digest: string; result: IMessageResult }>();
  readonly nativeSends: { commandId: string; text: string }[] = [];
  private nonce = 0; private seq = 0;
  constructor(private call: Call, private origin = 'https://imessage.fixture.invalid') {}

  async redeem(code: string, overrides: Record<string, unknown> = {}): Promise<Response> {
    const response = await this.call(new Request(`${this.origin}/channels/imessage/v1/pair/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, code, hostVersion: 'sim-host-1', transportVersion: 'waldo-imessage-http-v1', databaseGeneration: this.generation, ...overrides }) }));
    if (response.status === 200) {
      const body = await response.clone().json() as { bridgeId: string; accountId: string; credential: { key: string } };
      this.bridgeId = body.bridgeId; this.accountId = body.accountId; this.key = body.credential.key;
    }
    return response;
  }
  async signed(path: string, body: string, opts: { atMs?: number; nonce?: string; key?: string; bridgeId?: string } = {}): Promise<Response> {
    const headers = await signS2(body, { version: 1, bridgeId: opts.bridgeId ?? this.bridgeId, accountId: this.accountId, atMs: opts.atMs ?? Date.now(), nonce: opts.nonce ?? `sim-nonce-${++this.nonce}-${crypto.randomUUID()}` }, opts.key ?? this.key);
    return this.call(new Request(`${this.origin}/channels/imessage/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', [S2_HEADER]: JSON.stringify(headers) }, body }));
  }
  scope() { return { version: 1 as const, bridgeId: this.bridgeId, accountId: this.accountId }; }
  heartbeat(status: 'online' | 'offline' = 'online') { return this.signed('/heartbeat', JSON.stringify({ ...this.scope(), databaseGeneration: this.generation, status })); }
  capabilities(text = true) {
    const flag = (on: boolean) => ({ receive: on, send: on, exactTarget: on, verified: on, ...(on ? { probeReference: 'sim-probe' } : {}) });
    const features = Object.fromEntries(['text', 'files', 'replies', 'standard_reactions', 'custom_reactions', 'formatting', 'url_preview', 'effects', 'native_voice', 'typing', 'read_receipts', 'edit', 'unsend', 'stickers', 'polls', 'groups', 'group_mutations', 'name_photo_sharing']
      .map((f) => [f, flag(f === 'text' && text)]));
    return this.signed('/capabilities', JSON.stringify({ ...this.scope(), transport: 'imsg', hostVersion: 'sim-host-1', transportVersion: 'sim', readiness: 'ready', features }));
  }
  message(text: string, o: Partial<{ eventId: string; senderHandle: string; chatGuid: string; isGroup: boolean; isFromMe: boolean; service: string; attachments: unknown[] }> = {}) {
    const n = ++this.seq, sender = o.senderHandle ?? 'owner@example.invalid', chat = o.chatGuid ?? `iMessage;-;${sender}`;
    return { version: 1, bridgeId: this.bridgeId, accountId: this.accountId, eventId: o.eventId ?? `sim-event-${n}`, cursor: { databaseGeneration: this.generation, value: String(n) },
      occurredAt: new Date(Date.now() - 1000).toISOString(), service: o.service ?? 'iMessage', senderHandle: sender, chatGuid: chat, participants: [sender], isGroup: o.isGroup ?? false,
      isFromMe: o.isFromMe ?? false, messageGuid: `sim-guid-${n}`, partIndex: 0, kind: 'message', text, attachments: o.attachments ?? [] };
  }
  send(event: unknown, opts: { atMs?: number; nonce?: string } = {}) { return this.signed('/events', JSON.stringify(event), opts); }
  async pull(): Promise<{ status: number; delivery: Delivery | null }> {
    const response = await this.signed('/commands/pull', JSON.stringify(this.scope()));
    return { status: response.status, delivery: response.status === 200 ? (await response.json() as { delivery: Delivery | null }).delivery : null };
  }
  /**
   * Host-side contract: verify S2 + commitment (digest, signature, expiry) immediately before any native
   * effect, journal commandId+digest first, never send a journaled command again.
   */
  async execute(d: Delivery, opts: { now?: number } = {}): Promise<IMessageResult> {
    const digest = await sha256Hex(d.body), command = iMessageCommandSchema.parse(JSON.parse(d.body));
    const prior = this.journal.get(command.commandId);
    if (prior) { if (prior.digest !== digest) throw new Error('journal conflict'); return prior.result; }
    const valid = await verifyS2(d.body, d.headers, this.key) && d.commitment.commandDigest === digest
      && await verifyCommitment({ bridgeId: this.bridgeId, accountId: this.accountId, deliveryId: d.deliveryId, commandId: command.commandId, commandDigest: digest, expiresAtMs: d.commitment.expiresAtMs }, d.commitment.signature, this.key);
    let result: IMessageResult;
    if (!valid || command.operation !== 'send' || command.allowSMSFallback !== false) result = { version: 1, commandId: command.commandId, target: command.target, state: 'rejected', disposition: 'not_started', reason: 'commitment_invalid' };
    else if ((opts.now ?? Date.now()) > d.commitment.expiresAtMs) result = { version: 1, commandId: command.commandId, target: command.target, state: 'rejected', disposition: 'not_started', reason: 'commitment_expired' };
    else { this.nativeSends.push({ commandId: command.commandId, text: command.text }); result = { version: 1, commandId: command.commandId, target: command.target, state: 'local_recorded', messageGuid: `sim-sent-${command.commandId}`, evidence: { kind: 'local_database', reference: `sim-row-${this.nativeSends.length}` } }; }
    this.journal.set(command.commandId, { digest, result });
    return result;
  }
  postResult(d: Delivery, result: IMessageResult, commandDigest?: string) {
    const command = iMessageCommandSchema.parse(JSON.parse(d.body));
    return (async () => this.signed('/commands/result', JSON.stringify({ ...this.scope(), deliveryId: d.deliveryId, commandId: command.commandId, commandDigest: commandDigest ?? await sha256Hex(d.body), result })))();
  }
}
