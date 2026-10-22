import { iMessageBindingSchema } from '@waldo/contracts';
import { createOwnerTurnContext, type OwnerContextSources } from '../../context-composer/owner-turn';
import { surfaceOwnerAdmission } from '../../identity/surface-owner-admission';
import { ClosedRunError, type RunEffectScope } from '../run-effect-scope';
import { bindingDigest, bindingFromAuthority, iMessageComposition, type IMessageBridgeDO, type IMessageEnv, type IMessageTurnHandoff } from './bridge-do';
import { sha256Hex } from './crypto';
import { iMessageDirectory, type BridgeAuthority } from './directory';
import { IMESSAGE_BUSY_RETRY_MS, IMessageFinalOutbox, type IMessageOutboxRecord } from './final-outbox';
import { IMessageOwnerInbox, type IMessageInboxRecord } from './owner-inbox';

// Small adapters the physical owner DO composes; the brain (responder, memory, tools, effect
// scopes) is the existing owner runtime, never a second agent.

export type OwnerHost = Readonly<{ storage: DurableObjectStorage; id: DurableObjectId; env: IMessageEnv; ownerNamespace?: DurableObjectNamespace }>;

/** Fresh canonical authority for an inbox record: same owner DO, same revision, same exact binding. */
// The sender's own authority: on an owner bridge it is the bridge authority for its bound sender; on a
// shared bridge it comes from that sender's own presence. Another owner's Waldo is never reachable.
export const currentIMessageAuthority = async (env: IMessageEnv, record: Pick<IMessageInboxRecord, 'environment' | 'binding' | 'revision' | 'ownerDoName' | 'bindingDigest'>): Promise<BridgeAuthority> => {
  const found = await iMessageDirectory(env).senderAuthority(record.environment, record.binding.bridgeId, record.binding.accountId, record.binding.subject);
  const a = found && found.state !== 'unknown_sender' ? found : null;
  const binding = a ? bindingFromAuthority(a) : null;
  if (!a || !binding || a.revision !== record.revision || a.doName !== record.ownerDoName || await bindingDigest(binding) !== record.bindingDigest) throw new ClosedRunError();
  return a;
};

/** Bridge -> owner handoff. Physical DO, fresh authority and exact binding precede the durable write. */
export const admitIMessageHandoff = async (host: OwnerHost, input: IMessageTurnHandoff)
  : Promise<'admitted' | 'duplicate' | 'conflict' | 'capacity' | 'refused'> => {
  const c = iMessageComposition(host.env);
  if (!c || !host.ownerNamespace || host.ownerNamespace.idFromName(input.ownerDoName).toString() !== host.id.toString()) return 'refused';
  const known = host.storage.kv.get<string>('do_name');
  if (known !== undefined && known !== input.ownerDoName) return 'refused';
  const binding = iMessageBindingSchema.safeParse(input.binding);
  if (!binding.success || binding.data.conversationKind !== 'direct' || input.envelope.surface !== 'imessage'
    || input.envelope.conversationRef !== JSON.stringify(['imessage', binding.data.bridgeId, binding.data.accountId, binding.data.chatGuid])
    || typeof input.envelope.text !== 'string' || !input.envelope.text.trim() || input.envelope.attachments?.length || input.envelope.attachmentRefs?.length) return 'refused';
  const digestOfBinding = await bindingDigest(binding.data);
  const record = { environment: input.environment, binding: binding.data, revision: input.revision, ownerDoName: input.ownerDoName, bindingDigest: digestOfBinding };
  try { await currentIMessageAuthority(host.env, record); } catch { return 'refused'; }
  if (known === undefined) host.storage.kv.put('do_name', input.ownerDoName);
  const commandId = `wrc_${(await sha256Hex(input.dedupKey)).slice(0, 40)}`;
  const result = await new IMessageOwnerInbox(host.storage).admit({
    ...record, dedupKey: input.dedupKey, digest: input.digest, text: input.envelope.text, conversationRef: input.envelope.conversationRef,
    bridgeDoName: input.bridgeDoName, commandId, occurredAt: Math.min(input.occurredAt, Date.now()),
  });
  return result.kind;
};

/** Owner context for one running iMessage record: surfaceOwnerAdmission re-reads authority whenever its last matching read has aged out. */
export const iMessageOwnerContext = async (host: OwnerHost, record: IMessageInboxRecord, scope: RunEffectScope, sources: Pick<OwnerContextSources, 'ownerProfile'> = {}) => {
  const lookup = async () => {
    scope.admit();
    const a = await currentIMessageAuthority(host.env, record);
    scope.admit();
    return { ownerId: a.ownerId, bindingRef: a.presenceId ?? a.bridgeId, revision: a.revision, physicalDoId: host.id.toString() };
  };
  const context = createOwnerTurnContext(await surfaceOwnerAdmission({ scope, lookup, expectedPhysicalDoId: host.id.toString(), surface: 'imessage',
    subject: record.binding.subject, occurrenceKey: record.dedupKey, occurredAt: Math.min(record.occurredAt, record.admittedAt), text: record.text }), { conversationRef: record.conversationRef, ...sources });
  if (context.conversationRef !== record.conversationRef) throw new ClosedRunError();
  return context;
};

const handOff = (host: OwnerHost, row: IMessageOutboxRecord) => {
  const ns = host.env.IMESSAGE_BRIDGE_DO as unknown as DurableObjectNamespace<IMessageBridgeDO> | undefined;
  if (!ns) return Promise.resolve({ kind: 'retry' } as const);
  return ns.get(ns.idFromName(row.bridgeDoName)).enqueueReply({ replyRef: row.replyRef, commandId: row.commandId, text: row.text,
    ownerDoName: row.ownerDoName, revision: row.revision, bindingDigest: row.bindingDigest, ...(row.subject !== undefined ? { subject: row.subject } : {}) });
};

// The bridge's one slot frees within a host pull and a send, so a drain polls it for about 4 s before leaving the reply to
// its retry. A retry runs in the owner's serial queue, where it would wait behind the next turn. The polls are counted
// rather than timed, so the wait ends even when the clock does not move.
const BUSY_POLL_MS = 500, BUSY_POLLS = 8;

/** Hands frozen replies to their bridge mailbox; the bridge rechecks authority before publication. */
export const drainIMessageOutbox = async (host: OwnerHost, maxAgeMs: number): Promise<void> => {
  const outbox = new IMessageFinalOutbox(host.storage);
  // A drain runs only between turns, so a progress note still frozen here lost its turn and is never handed over again.
  outbox.dropProgress('progress_stale');
  // A bridge has one slot, so once a reply is still waiting after its polls the replies behind it on that bridge keep their
  // order and wait for the same retry, and a drain holds the owner's queue for one wait at most.
  const waiting = new Set<string>();
  for (const row of outbox.due()) {
    if (waiting.has(row.bridgeDoName)) { outbox.retryLater(row.replyRef, maxAgeMs, IMESSAGE_BUSY_RETRY_MS); continue; }
    let outcome;
    try {
      outcome = await handOff(host, row);
      for (let polls = 0; outcome.kind === 'busy' && polls < BUSY_POLLS; polls++) {
        await new Promise(resolve => setTimeout(resolve, BUSY_POLL_MS));
        outcome = await handOff(host, row);
      }
    } catch { outbox.retryLater(row.replyRef, maxAgeMs); continue; }
    if (outcome.kind === 'queued') outbox.markQueued(row.replyRef);
    else if (outcome.kind === 'terminal') outbox.settle(row.replyRef, row.commandId, outcome.result);
    else {
      if (outcome.kind === 'busy') waiting.add(row.bridgeDoName);
      outbox.retryLater(row.replyRef, maxAgeMs, outcome.kind === 'busy' ? IMESSAGE_BUSY_RETRY_MS : undefined);
    }
  }
};

/**
 * One attempt to hand a running turn's progress note to the bridge, from inside that turn. Anything but queued settles it on
 * the spot: a note is never retried, so it wakes nothing and cannot land after the reply. A call that threw may still have
 * reached the bridge, so that note settles may_have_completed; a bridge that answered without taking it proves not_started.
 */
export const handOffIMessageProgress = async (host: OwnerHost, replyRef: string): Promise<boolean> => {
  const outbox = new IMessageFinalOutbox(host.storage), row = outbox.get(replyRef), turn = replyRef.split(':')[1];
  if (!row || row.state !== 'frozen') return false;
  let outcome;
  try { outcome = await handOff(host, row); } catch { outbox.dropProgress('progress_handoff_uncertain', turn); return false; }
  if (outcome.kind === 'queued') { outbox.markQueued(replyRef); return true; }
  if (outcome.kind === 'terminal') outbox.settle(replyRef, row.commandId, outcome.result);
  else outbox.dropProgress('progress_unsent', turn, true);
  return false;
};
