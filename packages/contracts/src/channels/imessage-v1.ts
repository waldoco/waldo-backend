import { z } from 'zod';

export const opaqueIMessageIdSchema = z.string().min(1).refine(
  (id) => id.trim() === id && [...id].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
  'identifier must be opaque, nonblank and free of controls',
);
const id = opaqueIMessageIdSchema;
export const iMessageServiceSchema = z.enum(['iMessage', 'SMS', 'RCS']);
export const iMessageTargetSchema = z.strictObject({
  bridgeId: id, accountId: id, chatGuid: id, messageGuid: id.optional(), partIndex: z.int().nonnegative().optional(),
}).refine((t) => t.partIndex === undefined || t.messageGuid !== undefined, 'part requires message');
export const iMessageAttachmentSchema = z.strictObject({
  reference: id, sourceMessageGuid: id, filename: id.refine((name) => !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..', 'filename must be a basename'), mimeType: id,
  byteLength: z.int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  caption: z.string().optional(), kind: z.enum(['image', 'audio', 'video', 'document', 'file', 'sticker']),
  nativeVoice: z.boolean(),
});
const common = {
  version: z.literal(1), bridgeId: id, accountId: id, eventId: id,
  cursor: z.strictObject({ databaseGeneration: id, value: id }),
  occurredAt: z.iso.datetime({ offset: true }), service: iMessageServiceSchema,
  senderHandle: id, chatGuid: id, participants: z.array(id), isGroup: z.boolean(), isFromMe: z.boolean(),
  messageGuid: id, partIndex: z.int().nonnegative(),
};
const content = {
  text: z.string(), attachments: z.array(iMessageAttachmentSchema),
  replyToGuid: id.optional(), threadOriginatorGuid: id.optional(),
};
export const iMessageEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, ...content, kind: z.literal('message') }),
  z.strictObject({ ...common, ...content, kind: z.literal('update'), update: z.enum(['edit', 'url_balloon']), originalUrl: z.url().optional() }),
  z.strictObject({ ...common, kind: z.literal('reaction'), action: z.enum(['add', 'remove']), actorHandle: id, target: iMessageTargetSchema, reaction: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('standard'), type: z.enum(['love', 'like', 'dislike', 'laugh', 'emphasis', 'question']) }), z.strictObject({ kind: z.literal('custom'), emoji: id })]) }),
  z.strictObject({ ...common, kind: z.literal('receipt'), state: z.enum(['delivered', 'read']), target: iMessageTargetSchema }),
  z.strictObject({ ...common, kind: z.literal('typing'), active: z.boolean() }),
  z.strictObject({ ...common, kind: z.literal('poll'), pollGuid: id, action: z.enum(['created', 'vote', 'unknown']), options: z.array(z.strictObject({ id, text: z.string() })), selectedOptionIds: z.array(id) }),
  z.strictObject({ ...common, kind: z.literal('unsupported'), bundleId: id }),
]).superRefine((event, ctx) => {
  if ('target' in event && (event.target.bridgeId !== event.bridgeId || event.target.accountId !== event.accountId || event.target.chatGuid !== event.chatGuid || !event.target.messageGuid)) ctx.addIssue({ code: 'custom', message: 'target binding mismatch' });
  if ('attachments' in event && event.attachments.some((a) => a.sourceMessageGuid !== event.messageGuid)) ctx.addIssue({ code: 'custom', message: 'attachment source mismatch' });
});
export type IMessageEvent = z.infer<typeof iMessageEventSchema>;
export const iMessageBindingSchema = z.strictObject({
  ownerId: id, presenceId: id, subject: id, bridgeId: id, accountId: id, chatGuid: id,
  verified: z.literal(true), service: z.literal('iMessage'),
});
export type IMessageBinding = z.infer<typeof iMessageBindingSchema>;
const bound = { version: z.literal(1), commandId: id, ownerId: id, binding: iMessageBindingSchema, target: iMessageTargetSchema, service: z.literal('iMessage'), allowSMSFallback: z.literal(false) };
export const iMessageCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...bound, operation: z.literal('send'), text: z.string(), attachments: z.array(iMessageAttachmentSchema), formatting: z.array(z.strictObject({ start: z.int().nonnegative(), length: z.int().positive(), style: z.enum(['bold', 'italic', 'underline', 'strikethrough']) })).optional(), effect: id.optional() }),
  z.strictObject({ ...bound, operation: z.literal('react'), reaction: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('standard'), type: z.enum(['love', 'like', 'dislike', 'laugh', 'emphasis', 'question']) }), z.strictObject({ kind: z.literal('custom'), emoji: id })]), action: z.enum(['add', 'remove']) }),
  z.strictObject({ ...bound, operation: z.literal('edit'), text: z.string() }),
  z.strictObject({ ...bound, operation: z.literal('unsend') }),
  z.strictObject({ ...bound, operation: z.literal('typing'), active: z.boolean() }),
  z.strictObject({ ...bound, operation: z.literal('read') }),
]).superRefine((c, ctx) => {
  if (c.operation === 'send' && (!c.text.trim() && c.attachments.length === 0 || c.formatting?.some((range) => range.start + range.length > c.text.length))) ctx.addIssue({ code: 'custom', message: 'empty content or formatting outside text' });
  if (c.ownerId !== c.binding.ownerId || c.target.bridgeId !== c.binding.bridgeId || c.target.accountId !== c.binding.accountId || c.target.chatGuid !== c.binding.chatGuid) ctx.addIssue({ code: 'custom', message: 'owner/account/chat binding mismatch' });
  if (['react', 'edit', 'unsend'].includes(c.operation) && (c.target.messageGuid === undefined || c.target.partIndex === undefined)) ctx.addIssue({ code: 'custom', message: 'mutation requires exact message and part' });
});
export type IMessageCommand = z.infer<typeof iMessageCommandSchema>;
const result = { version: z.literal(1), commandId: id, target: iMessageTargetSchema };
export const iMessageResultSchema = z.discriminatedUnion('state', [
  z.strictObject({ ...result, state: z.literal('queued') }),
  z.strictObject({ ...result, state: z.literal('started') }),
  z.strictObject({ ...result, state: z.literal('local_recorded'), messageGuid: id, evidence: z.strictObject({ kind: z.literal('local_database'), reference: id }) }),
  z.strictObject({ ...result, state: z.literal('delivered'), messageGuid: id, evidence: z.strictObject({ kind: z.enum(['transport_delivery', 'recipient_readback']), reference: id }) }),
  z.strictObject({ ...result, state: z.literal('rejected'), disposition: z.literal('not_started'), reason: id }),
  z.strictObject({ ...result, state: z.literal('unknown'), disposition: z.enum(['may_have_completed', 'still_in_flight']), reason: id }),
]);
export type IMessageResult = z.infer<typeof iMessageResultSchema>;
export const IMESSAGE_FEATURES = ['text', 'files', 'replies', 'standard_reactions', 'custom_reactions', 'formatting', 'url_preview', 'effects', 'native_voice', 'typing', 'read_receipts', 'edit', 'unsend', 'stickers', 'polls', 'groups', 'group_mutations', 'name_photo_sharing'] as const;
export type IMessageFeature = typeof IMESSAGE_FEATURES[number];
const flag = z.strictObject({ receive: z.boolean(), send: z.boolean(), exactTarget: z.boolean(), verified: z.boolean(), probeReference: id.optional() }).refine((f) => !f.verified || f.probeReference !== undefined, 'verified requires probe evidence');
export const iMessageCapabilitiesSchema = z.strictObject({
  version: z.literal(1), bridgeId: id, accountId: id, transport: z.enum(['mock', 'imsg', 'bluebubbles']),
  hostVersion: id, transportVersion: id, readiness: z.enum(['offline', 'unverified', 'ready']),
  features: z.record(z.enum(IMESSAGE_FEATURES), flag),
});
export type IMessageCapabilities = z.infer<typeof iMessageCapabilitiesSchema>;
export const disabledIMessageCapabilities = (bridgeId: string, accountId: string): IMessageCapabilities => iMessageCapabilitiesSchema.parse({
  version: 1, bridgeId, accountId, transport: 'mock', hostVersion: 'fixture-only', transportVersion: 'fixture-v1', readiness: 'unverified',
  features: Object.fromEntries(IMESSAGE_FEATURES.map((feature) => [feature, { receive: false, send: false, exactTarget: false, verified: false }])),
});
