import { z } from 'zod';
import { iso8601Schema } from '../core/error';

export const protocolVersionV01Schema = z.literal('0.1');
export const protocolIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const protocolNameSchema = protocolIdSchema;
export const protocolRevisionSchema = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const protocolDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const MAX_PROTOCOL_PAYLOAD_BYTES = 16_384;
export const protocolJsonValueSchema = z.json();
export type ProtocolJsonValue = z.infer<typeof protocolJsonValueSchema>;

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export const protocolJsonObjectSchema = z
  .record(protocolNameSchema, protocolJsonValueSchema)
  .refine(
    (value) => utf8ByteLength(JSON.stringify(value)) <= MAX_PROTOCOL_PAYLOAD_BYTES,
    { error: `protocol payload must not exceed ${MAX_PROTOCOL_PAYLOAD_BYTES} UTF-8 bytes` },
  );
export type ProtocolJsonObject = z.infer<typeof protocolJsonObjectSchema>;

export const surfaceAggregateRefSchema = z.strictObject({
  kind: protocolNameSchema,
  id: protocolIdSchema,
  expectedRevision: protocolRevisionSchema.optional(),
});
export type SurfaceAggregateRef = z.infer<typeof surfaceAggregateRefSchema>;

export function surfaceCommandRequestSchemaFor<Payload extends z.ZodType>(
  payloadSchema: Payload,
) {
  return z.strictObject({
    protocolVersion: protocolVersionV01Schema,
    requestId: protocolIdSchema,
    commandType: protocolNameSchema,
    presenceRegistrationId: protocolIdSchema,
    aggregate: surfaceAggregateRefSchema.optional(),
    correlationId: protocolIdSchema.optional(),
    clientIssuedAt: iso8601Schema,
    payload: payloadSchema,
  });
}

export const surfaceCommandRequestSchema = surfaceCommandRequestSchemaFor(
  protocolJsonObjectSchema,
);
export type SurfaceCommandRequest = z.infer<typeof surfaceCommandRequestSchema>;

function orderProtocolJson(value: ProtocolJsonValue): ProtocolJsonValue {
  if (Array.isArray(value)) return value.map(orderProtocolJson);
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, orderProtocolJson(value[key]!)]),
  );
}

export function canonicalizeProtocolJson(value: unknown): string {
  return JSON.stringify(orderProtocolJson(protocolJsonValueSchema.parse(value)));
}

export function canonicalizeSurfaceCommandRequestForDigest(value: unknown): string {
  return canonicalizeProtocolJson(surfaceCommandRequestSchema.parse(value));
}

export const responsibilityCapturePayloadSchema = z
  .strictObject({
    userStatement: z
      .string()
      .min(1)
      .max(8_192)
      .refine((value) => value.trim().length > 0, {
        error: 'userStatement must contain non-whitespace content',
      }),
  })
  .refine(
    (value) => utf8ByteLength(JSON.stringify(value)) <= MAX_PROTOCOL_PAYLOAD_BYTES,
    { error: `protocol payload must not exceed ${MAX_PROTOCOL_PAYLOAD_BYTES} UTF-8 bytes` },
  );
export type ResponsibilityCapturePayload = z.infer<
  typeof responsibilityCapturePayloadSchema
>;

export const responsibilityCaptureRequestSchema = surfaceCommandRequestSchemaFor(
  responsibilityCapturePayloadSchema,
).extend({
  commandType: z.literal('responsibility.capture'),
});
export type ResponsibilityCaptureRequest = z.infer<
  typeof responsibilityCaptureRequestSchema
>;

export const aggregateRefSchema = z.strictObject({
  kind: protocolNameSchema,
  id: protocolIdSchema,
  revision: protocolRevisionSchema,
});
export type AggregateRef = z.infer<typeof aggregateRefSchema>;

export const actorRefSchema = z.strictObject({
  kind: z.enum(['owner', 'presence', 'service', 'provider', 'person']),
  id: protocolIdSchema,
});
export type ActorRef = z.infer<typeof actorRefSchema>;

export function trustedCommandEnvelopeSchemaFor<Payload extends z.ZodType>(
  payloadSchema: Payload,
) {
  return z.strictObject({
    protocolVersion: protocolVersionV01Schema,
    commandId: protocolIdSchema,
    commandType: protocolNameSchema,
    ownerId: protocolIdSchema,
    actor: actorRefSchema,
    presenceId: protocolIdSchema,
    authenticatedSessionId: protocolIdSchema,
    ownerPolicyRevision: protocolRevisionSchema,
    authAssurance: protocolNameSchema,
    ownerRootRoutingVersion: protocolRevisionSchema,
    aggregate: aggregateRefSchema.optional(),
    expectedRevision: protocolRevisionSchema.optional(),
    requestDigest: protocolDigestSchema,
    causationId: protocolIdSchema.optional(),
    correlationId: protocolIdSchema,
    receivedAt: iso8601Schema,
    payload: payloadSchema,
  });
}

export const trustedCommandEnvelopeSchema = trustedCommandEnvelopeSchemaFor(
  protocolJsonObjectSchema,
);
export type TrustedCommandEnvelope = z.infer<typeof trustedCommandEnvelopeSchema>;

export const responsibilityCaptureTrustedEnvelopeSchema =
  trustedCommandEnvelopeSchemaFor(responsibilityCapturePayloadSchema).extend({
    commandType: z.literal('responsibility.capture'),
  });
export type ResponsibilityCaptureTrustedEnvelope = z.infer<
  typeof responsibilityCaptureTrustedEnvelopeSchema
>;

export const presenceCapabilityV01Schema = z.strictObject({
  protocolVersion: protocolVersionV01Schema,
  offlineCommands: z.literal('none'),
});
export type PresenceCapabilityV01 = z.infer<typeof presenceCapabilityV01Schema>;

export function domainEventSchemaFor<Payload extends z.ZodType>(payloadSchema: Payload) {
  return z.strictObject({
    schemaVersion: protocolNameSchema,
    eventId: protocolIdSchema,
    eventType: protocolNameSchema,
    ownerId: protocolIdSchema,
    aggregate: aggregateRefSchema,
    ownerCursor: protocolRevisionSchema,
    causationId: protocolIdSchema.optional(),
    correlationId: protocolIdSchema,
    occurredAt: iso8601Schema,
    payload: payloadSchema,
  });
}

export const domainEventSchema = domainEventSchemaFor(protocolJsonObjectSchema);
export type DomainEvent = z.infer<typeof domainEventSchema>;

export const agentSessionActivityObservationPayloadSchema = z.strictObject({
  trust: z.literal('untrusted'),
  sessionId: protocolIdSchema,
  workUnitId: protocolIdSchema,
  activity: z.enum(['started', 'progress', 'provider_done', 'failed']),
  observedAt: iso8601Schema,
});
export type AgentSessionActivityObservationPayload = z.infer<
  typeof agentSessionActivityObservationPayloadSchema
>;

export const judgmentNeededObservationPayloadSchema = z.strictObject({
  trust: z.literal('untrusted'),
  sessionId: protocolIdSchema,
  workUnitId: protocolIdSchema,
  reasonCode: z.enum(['choice_required', 'blocked', 'risk_changed', 'authority_required']),
  optionRefs: z.array(protocolIdSchema).min(2).max(8),
  observedAt: iso8601Schema,
});
export type JudgmentNeededObservationPayload = z.infer<
  typeof judgmentNeededObservationPayloadSchema
>;

export const candidateEvidenceObservationPayloadSchema = z.strictObject({
  trust: z.literal('untrusted'),
  sessionId: protocolIdSchema,
  workUnitId: protocolIdSchema,
  subjectRef: protocolIdSchema,
  evidenceRef: protocolIdSchema,
  contentDigest: protocolDigestSchema,
  observedAt: iso8601Schema,
});
export type CandidateEvidenceObservationPayload = z.infer<
  typeof candidateEvidenceObservationPayloadSchema
>;

export const agentSessionActivityObservedEventSchema = domainEventSchemaFor(
  agentSessionActivityObservationPayloadSchema,
).extend({
  eventType: z.literal('agent_session.activity_observed'),
});

export const judgmentNeededObservedEventSchema = domainEventSchemaFor(
  judgmentNeededObservationPayloadSchema,
).extend({
  eventType: z.literal('agent_session.judgment_needed_observed'),
});

export const candidateEvidenceObservedEventSchema = domainEventSchemaFor(
  candidateEvidenceObservationPayloadSchema,
).extend({
  eventType: z.literal('agent_session.candidate_evidence_observed'),
});

const MAX_PROJECTION_ITEMS = 256;
const MAX_PROJECTION_PAGE_BYTES = 262_144;

export function projectionPageSchemaFor<Item extends z.ZodType>(itemSchema: Item) {
  return z
    .strictObject({
      protocolVersion: protocolVersionV01Schema,
      ownerId: protocolIdSchema,
      projectionName: protocolNameSchema,
      snapshotId: protocolIdSchema,
      snapshotBaseCursor: protocolRevisionSchema,
      fromExclusiveCursor: protocolRevisionSchema,
      highWaterCursor: protocolRevisionSchema,
      nextCursor: protocolRevisionSchema,
      items: z.array(itemSchema).max(MAX_PROJECTION_ITEMS),
      hasMore: z.boolean(),
      generatedAt: iso8601Schema,
    })
    .superRefine((page, context) => {
      if (page.snapshotBaseCursor > page.fromExclusiveCursor) {
        context.addIssue({
          code: 'custom',
          path: ['snapshotBaseCursor'],
          message: 'snapshotBaseCursor must not exceed fromExclusiveCursor',
        });
      }
      if (page.fromExclusiveCursor > page.nextCursor) {
        context.addIssue({
          code: 'custom',
          path: ['nextCursor'],
          message: 'nextCursor must not precede fromExclusiveCursor',
        });
      }
      if (page.nextCursor > page.highWaterCursor) {
        context.addIssue({
          code: 'custom',
          path: ['nextCursor'],
          message: 'nextCursor must not exceed highWaterCursor',
        });
      }
      if (page.hasMore !== (page.nextCursor < page.highWaterCursor)) {
        context.addIssue({
          code: 'custom',
          path: ['hasMore'],
          message: 'hasMore must reflect whether nextCursor precedes highWaterCursor',
        });
      }
      if (utf8ByteLength(JSON.stringify(page)) > MAX_PROJECTION_PAGE_BYTES) {
        context.addIssue({
          code: 'custom',
          message: `projection page must not exceed ${MAX_PROJECTION_PAGE_BYTES} UTF-8 bytes`,
        });
      }
    });
}

export const projectionPageSchema = projectionPageSchemaFor(protocolJsonValueSchema);
export type ProjectionPage = z.infer<typeof projectionPageSchema>;
