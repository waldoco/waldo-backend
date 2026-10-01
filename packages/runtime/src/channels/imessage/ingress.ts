import { iMessageBindingSchema, iMessageEventSchema } from '@waldo/contracts';
import type { OwnerTurnEnvelope } from '../owner-turn-envelope';

export const admittedIMessageTurn = (input: unknown, admittedBinding: unknown): OwnerTurnEnvelope => {
  const binding = iMessageBindingSchema.parse(admittedBinding);
  const event = iMessageEventSchema.parse(input);
  if (event.kind !== 'message' || event.service !== 'iMessage' || event.isFromMe || event.isGroup ||
    event.senderHandle !== binding.subject || event.bridgeId !== binding.bridgeId ||
    event.accountId !== binding.accountId || event.chatGuid !== binding.chatGuid) throw new Error('iMessage turn not admitted');
  const conversationRef = JSON.stringify(['imessage', event.bridgeId, event.accountId, event.chatGuid]);
  return {
    surface: 'imessage', service: event.service,
    traceId: JSON.stringify(['imessage', event.bridgeId, event.accountId, event.cursor.databaseGeneration, event.eventId]),
    conversationRef, text: event.text,
    messageRef: { id: event.messageGuid, conversationRef, bridgeRef: event.bridgeId, accountRef: event.accountId, partIndex: event.partIndex, ...(event.threadOriginatorGuid ? { threadOriginatorId: event.threadOriginatorGuid } : {}) },
    attachmentRefs: event.attachments.map(({ sourceMessageGuid, ...file }) => ({ ...file, sourceMessageId: sourceMessageGuid })),
    ...(event.replyToGuid ? { replyTo: { surface: 'imessage', messageId: event.replyToGuid, conversationRef, authorId: null, authorIsBot: null, text: '', truncated: false, sourceTaint: 'external' as const } } : {}),
  };
};
