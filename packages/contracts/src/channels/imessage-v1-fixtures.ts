import { iMessageEventSchema, iMessageCommandSchema, type IMessageBinding } from './imessage-v1';
export const syntheticIMessageBinding: IMessageBinding = {
  ownerId: 'fixture-owner', presenceId: 'fixture-presence', subject: 'owner@example.invalid',
  bridgeId: 'fixture-bridge', accountId: 'fixture-account', chatGuid: 'iMessage;-;fixture-chat', verified: true, conversationKind: 'direct', service: 'iMessage',
};
const base = {
  version: 1, bridgeId: 'fixture-bridge', accountId: 'fixture-account',
  cursor: { databaseGeneration: 'fixture-generation', value: '1' }, occurredAt: '2026-10-01T00:00:00Z',
  service: 'iMessage', senderHandle: 'owner@example.invalid', chatGuid: 'iMessage;-;fixture-chat',
  participants: ['owner@example.invalid'], isGroup: false, isFromMe: false, messageGuid: 'fixture-message', partIndex: 0,
};
const attachment = (reference: string, kind: string, filename: string, mimeType: string) => ({
  reference, sourceMessageGuid: base.messageGuid, filename, mimeType, byteLength: 16,
  sha256: '0'.repeat(64), kind, nativeVoice: false,
});
export const syntheticIMessageEvents = {
  text: { ...base, eventId: 'fixture-text', kind: 'message', text: 'Hello', attachments: [] },
  urlBalloon: { ...base, eventId: 'fixture-url-update', kind: 'update', update: 'url_balloon', text: 'Read https://example.invalid/research and compare it', originalUrl: 'https://example.invalid/research', attachments: [] },
  replyPart: { ...base, eventId: 'fixture-reply', kind: 'message', text: 'Quote is external context', attachments: [], replyToGuid: 'fixture-parent', threadOriginatorGuid: 'fixture-thread', partIndex: 2 },
  group: { ...base, eventId: 'fixture-group', chatGuid: 'iMessage;+;fixture-group', isGroup: true, participants: ['owner@example.invalid', 'other@example.invalid'], senderHandle: 'other@example.invalid', kind: 'message', text: 'Untrusted shared content', attachments: [] },
  audio: { ...base, eventId: 'fixture-audio', kind: 'message', text: '', attachments: [attachment('fixture-audio-file', 'audio', 'voice.m4a', 'audio/mp4')] },
  multipleFiles: { ...base, eventId: 'fixture-files', kind: 'message', text: 'In this order', attachments: [attachment('fixture-photo', 'image', 'photo.png', 'image/png'), attachment('fixture-document', 'document', 'notes.pdf', 'application/pdf')] },
  customReaction: { ...base, eventId: 'fixture-reaction', kind: 'reaction', actorHandle: 'other@example.invalid', action: 'add', target: { bridgeId: base.bridgeId, accountId: base.accountId, chatGuid: base.chatGuid, messageGuid: base.messageGuid, partIndex: 2 }, reaction: { kind: 'custom', emoji: '🦉' } },
  edit: { ...base, eventId: 'fixture-edit', kind: 'update', update: 'edit', text: 'Corrected text', attachments: [] },
} as const;
export const parsedSyntheticIMessageEvents = Object.fromEntries(Object.entries(syntheticIMessageEvents).map(([name, event]) => [name, iMessageEventSchema.parse(event)]));
export const syntheticIMessageCommand = () => iMessageCommandSchema.parse({
  version: 1, commandId: 'fixture-command', ownerId: syntheticIMessageBinding.ownerId, binding: syntheticIMessageBinding,
  target: { bridgeId: base.bridgeId, accountId: base.accountId, chatGuid: base.chatGuid },
  service: 'iMessage', allowSMSFallback: false, operation: 'send', text: 'Synthetic send', attachments: [],
});
