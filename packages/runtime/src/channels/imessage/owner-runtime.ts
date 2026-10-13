import { iMessageBindingSchema } from '@waldo/contracts';
import { createOwnerTurnContext } from '../../context-composer/owner-turn';
import { surfaceOwnerAdmission } from '../../identity/surface-owner-admission';
import { ClosedRunError, type RunEffectScope } from '../run-effect-scope';
import { bindingDigest, bindingFromAuthority, iMessageComposition, type IMessageBridgeDO, type IMessageEnv, type IMessageTurnHandoff } from './bridge-do';
import { sha256Hex } from './crypto';
import { iMessageDirectory, type BridgeAuthority } from './directory';
import { IMessageFinalOutbox } from './final-outbox';
import { IMessageOwnerInbox, type IMessageInboxRecord } from './owner-inbox';

// Small adapters the physical owner DO composes; the brain (responder, memory, tools, effect
// scopes) is the existing owner runtime, never a second agent.

export type OwnerHost = Readonly<{ storage: DurableObjectStorage; id: DurableObjectId; env: IMessageEnv; ownerNamespace?: DurableObjectNamespace }>;

/** Fresh canonical authority for an inbox record: same owner DO, same revision, same exact binding. */
export const currentIMessageAuthority = async (env: IMessageEnv, record: Pick<IMessageInboxRecord, 'environment' | 'binding' | 'revision' | 'ownerDoName' | 'bindingDigest'>): Promise<BridgeAuthority> => {
  const a = await iMessageDirectory(env).authority(record.environment, record.binding.bridgeId, record.binding.accountId);
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

/** Owner context for one running iMessage record: surfaceOwnerAdmission re-reads authority on every check. */
export const iMessageOwnerContext = async (host: OwnerHost, record: IMessageInboxRecord, scope: RunEffectScope) => {
  const lookup = async () => {
    scope.admit();
    const a = await currentIMessageAuthority(host.env, record);
    scope.admit();
    return { ownerId: a.ownerId, bindingRef: a.presenceId ?? a.bridgeId, revision: a.revision, physicalDoId: host.id.toString() };
  };
  const context = createOwnerTurnContext(await surfaceOwnerAdmission({ scope, lookup, expectedPhysicalDoId: host.id.toString(), surface: 'imessage',
    subject: record.binding.subject, occurrenceKey: record.dedupKey, occurredAt: Math.min(record.occurredAt, record.admittedAt), text: record.text }), { conversationRef: record.conversationRef });
  if (context.conversationRef !== record.conversationRef) throw new ClosedRunError();
  return context;
};

/** Hands frozen replies to their bridge mailbox; the bridge rechecks authority before publication. */
export const drainIMessageOutbox = async (host: OwnerHost, maxAgeMs: number): Promise<void> => {
  const ns = host.env.IMESSAGE_BRIDGE_DO as unknown as DurableObjectNamespace<IMessageBridgeDO> | undefined;
  const outbox = new IMessageFinalOutbox(host.storage);
  for (const row of outbox.due()) {
    if (!ns) { outbox.retryLater(row.replyRef, maxAgeMs); continue; }
    let outcome;
    try {
      outcome = await ns.get(ns.idFromName(row.bridgeDoName)).enqueueReply({ replyRef: row.replyRef, commandId: row.commandId, text: row.text,
        ownerDoName: row.ownerDoName, revision: row.revision, bindingDigest: row.bindingDigest });
    } catch { outbox.retryLater(row.replyRef, maxAgeMs); continue; }
    if (outcome.kind === 'queued') outbox.markQueued(row.replyRef);
    else if (outcome.kind === 'terminal') outbox.settle(row.replyRef, row.commandId, outcome.result);
    else outbox.retryLater(row.replyRef, maxAgeMs);
  }
};
