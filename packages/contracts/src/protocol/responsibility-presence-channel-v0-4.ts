import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import {
  canonicalizeProtocolJson,
  protocolDigestSchema,
  protocolIdSchema,
  protocolNameSchema,
} from './responsibility-handshake-v0-1';
import {
  boundedProtocolTextV04,
  exactRevisionV04Schema,
  protocolVersionV04Schema,
  versionedManifestReferenceV04Schema,
} from './responsibility-protocol-v0-4';

export const presenceRefV04Schema = z.strictObject({
  category: z.literal('presence'),
  id: protocolIdSchema,
  registrationRevision: exactRevisionV04Schema,
});
export const channelAdapterRefV04Schema = z.strictObject({
  category: z.literal('channel_adapter'),
  id: protocolIdSchema,
  version: protocolNameSchema,
  manifest: versionedManifestReferenceV04Schema,
});
export const surfaceCapabilityManifestV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema,
  id: protocolIdSchema,
  version: protocolNameSchema,
  commands: z
    .array(z.enum(['conversation.send', 'responsibility.capture']))
    .min(1)
    .max(2),
  projections: z
    .array(z.enum(['conversation', 'responsibility_status', 'needs_you', 're_entry']))
    .max(4),
  offlineCommands: z.literal('none'),
});
export const channelPresenceV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema,
  presence: presenceRefV04Schema,
  adapter: channelAdapterRefV04Schema,
  externalAccountRef: protocolIdSchema,
  state: z.enum(['linked', 'revoked', 'blocked']),
  capabilityManifest: versionedManifestReferenceV04Schema,
});
export const normalizedInboundEnvelopeV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema,
  trust: z.literal('untrusted_content'),
  adapter: channelAdapterRefV04Schema,
  sourceAccountRef: protocolIdSchema,
  conversationRef: protocolIdSchema,
  messageRef: protocolIdSchema,
  dedupeKey: protocolIdSchema,
  content: boundedProtocolTextV04(4_096),
  contentDigest: protocolDigestSchema,
  receivedAt: iso8601Schema,
});
const surfaceCommandBase = {
  protocolVersion: protocolVersionV04Schema,
  requestId: protocolIdSchema,
  presenceRegistrationId: protocolIdSchema,
  correlationId: protocolIdSchema.optional(),
  clientIssuedAt: iso8601Schema,
} as const;
export const conversationCommandRequestV04Schema = z.strictObject({
  ...surfaceCommandBase,
  commandType: z.literal('conversation.send'),
  payload: z.strictObject({
    content: boundedProtocolTextV04(4_096),
    contentDigest: protocolDigestSchema,
  }),
});
export const responsibilityCaptureCommandRequestV04Schema = z.strictObject({
  ...surfaceCommandBase,
  commandType: z.literal('responsibility.capture'),
  payload: z.strictObject({
    userStatement: boundedProtocolTextV04(4_096),
    statementDigest: protocolDigestSchema,
  }),
});
export const deliveryIntentV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema,
  id: protocolIdSchema,
  ownerId: protocolIdSchema,
  revision: exactRevisionV04Schema,
  presence: presenceRefV04Schema,
  adapter: channelAdapterRefV04Schema,
  projectionRef: protocolIdSchema,
  projectionDigest: protocolDigestSchema,
  contentRef: protocolIdSchema,
  contentDigest: protocolDigestSchema,
  dedupeKey: protocolIdSchema,
  state: z.literal('pending_delivery'),
  createdAt: iso8601Schema,
});
export const deliverySettlementV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema,
  id: protocolIdSchema,
  ownerId: protocolIdSchema,
  deliveryIntentId: protocolIdSchema,
  deliveryIntentRevision: exactRevisionV04Schema,
  adapter: channelAdapterRefV04Schema,
  state: z.enum(['delivered', 'rejected', 'failed', 'timed_out', 'unknown']),
  transportMessageRef: protocolIdSchema.nullable(),
  observationDigest: protocolDigestSchema,
  observedAt: iso8601Schema,
});
export const canonicalizeNormalizedInboundEnvelopeV04ForDigest = (value: unknown) =>
  canonicalizeProtocolJson(normalizedInboundEnvelopeV04Schema.parse(value));

export type PresenceRefV04 = z.infer<typeof presenceRefV04Schema>;
export type ChannelAdapterRefV04 = z.infer<typeof channelAdapterRefV04Schema>;
