// A response derived from consented health context stays in volatile owner delivery.
// Its currentness callback is a host capability and must never be serialized.
export type OwnerTurnResponse = Readonly<{
  text: string;
  custody: Readonly<{ kind: 'durable' }> | Readonly<{
    kind: 'volatile_owner_health';
    assertCurrent(): Promise<void>;
    // Health epochs only: the delivery host adds its fresh owner/session/conversation
    // check independently of the now-completed execution effect scope.
    assertHealthCurrent(): Promise<void>;
  }>;
}>;
export const PROTECTED_HEALTH_HISTORY_NOTICE = '[Protected health response is not retained. Ask for current health context again.]';

export class ProtectedOwnerResponseRequiredError extends Error {
  constructor() { super('Protected owner response requires an authorized volatile delivery adapter.'); }
}

// String-only consumers cannot prove protected custody. Their callers must move
// to the typed receipt and dispatch it with a fresh owner/source check.
export const ownerResponseText = (response: OwnerTurnResponse): string => {
  if (response.custody.kind !== 'durable') throw new ProtectedOwnerResponseRequiredError();
  return response.text;
};


export type OwnerResponseRetention = 'durable' | 'volatile_owner_health';
export const retainOwnerConversationEntries = (
  entries: readonly import('@waldo/contracts').ConversationEntry[], retention: OwnerResponseRetention = 'durable',
): readonly import('@waldo/contracts').ConversationEntry[] => retention === 'durable' ? entries : entries.map(entry =>
  entry.role === 'assistant' ? { ...entry, modelPayload: PROTECTED_HEALTH_HISTORY_NOTICE, appPayload: PROTECTED_HEALTH_HISTORY_NOTICE, modelProjection: { mode: 'omit' } } : entry);
