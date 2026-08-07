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
const MAX_PROTOCOL_JSON_DEPTH = 64;
const MAX_PROTOCOL_JSON_NODES = 4_096;

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
  }
  return true;
}

const protocolJsonStructureSchema = z.unknown().superRefine((value, context) => {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let discoveredNodes = 1;

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > MAX_PROTOCOL_JSON_DEPTH) {
      context.addIssue({
        code: 'custom',
        message: `protocol JSON must not exceed depth ${MAX_PROTOCOL_JSON_DEPTH}`,
      });
      return;
    }
    if (typeof current.value === 'string' && !isWellFormedUtf16(current.value)) {
      context.addIssue({
        code: 'custom',
        message: 'protocol JSON strings must contain well-formed Unicode',
      });
      return;
    }
    if (current.value === null || typeof current.value !== 'object') continue;

    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        discoveredNodes += 1;
        if (discoveredNodes > MAX_PROTOCOL_JSON_NODES) {
          context.addIssue({
            code: 'custom',
            message: `protocol JSON must not exceed ${MAX_PROTOCOL_JSON_NODES} nodes`,
          });
          return;
        }
        pending.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }

    const record = current.value as Record<string, unknown>;
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      if (!isWellFormedUtf16(key)) {
        context.addIssue({
          code: 'custom',
          message: 'protocol JSON object keys must contain well-formed Unicode',
        });
        return;
      }
      discoveredNodes += 1;
      if (discoveredNodes > MAX_PROTOCOL_JSON_NODES) {
        context.addIssue({
          code: 'custom',
          message: `protocol JSON must not exceed ${MAX_PROTOCOL_JSON_NODES} nodes`,
        });
        return;
      }
      pending.push({ value: record[key], depth: current.depth + 1 });
    }
  }
});

export const protocolJsonValueSchema = protocolJsonStructureSchema.pipe(z.json());
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

export const protocolJsonObjectSchema = protocolJsonStructureSchema
  .pipe(z.record(protocolNameSchema, z.json()))
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

export function surfaceCommandRequestEnvelopeSchemaFor<Payload extends z.ZodType>(
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

function compareUtf16CodeUnits(left: string, right: string): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function serializeCanonicalProtocolJson(value: ProtocolJsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonicalProtocolJson).join(',')}]`;
  }

  const members = Object.keys(value)
    .sort(compareUtf16CodeUnits)
    .map(
      (key) =>
        `${JSON.stringify(key)}:${serializeCanonicalProtocolJson(value[key]!)}`,
    );
  return `{${members.join(',')}}`;
}

export function canonicalizeProtocolJson(value: unknown): string {
  return serializeCanonicalProtocolJson(protocolJsonValueSchema.parse(value));
}

export const responsibilityCapturePayloadSchema = z
  .strictObject({
    userStatement: z
      .string()
      .min(1)
      .max(8_192)
      .refine(isWellFormedUtf16, {
        error: 'userStatement must contain well-formed Unicode',
      })
      .regex(/\S/, {
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

export const responsibilityCaptureRequestSchema =
  surfaceCommandRequestEnvelopeSchemaFor(responsibilityCapturePayloadSchema).extend({
    commandType: z.literal('responsibility.capture'),
  });
export type ResponsibilityCaptureRequest = z.infer<
  typeof responsibilityCaptureRequestSchema
>;

export const surfaceCommandRequestSchema = z.discriminatedUnion('commandType', [
  responsibilityCaptureRequestSchema,
]);
export type SurfaceCommandRequest = z.infer<typeof surfaceCommandRequestSchema>;

export function canonicalizeSurfaceCommandRequestForDigest(value: unknown): string {
  return canonicalizeProtocolJson(surfaceCommandRequestSchema.parse(value));
}

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

export const responsibilityCaptureTrustedEnvelopeSchema =
  trustedCommandEnvelopeSchemaFor(responsibilityCapturePayloadSchema).extend({
    commandType: z.literal('responsibility.capture'),
  });
export type ResponsibilityCaptureTrustedEnvelope = z.infer<
  typeof responsibilityCaptureTrustedEnvelopeSchema
>;

export function canonicalizeResponsibilityCaptureTrustedEnvelopeForDigest(
  value: unknown,
): string {
  return canonicalizeProtocolJson(responsibilityCaptureTrustedEnvelopeSchema.parse(value));
}

export const trustedCommandEnvelopeSchema = z.discriminatedUnion('commandType', [
  responsibilityCaptureTrustedEnvelopeSchema,
]);
export type TrustedCommandEnvelope = z.infer<typeof trustedCommandEnvelopeSchema>;

export const presenceCapabilityV01Schema = z.strictObject({
  protocolVersion: protocolVersionV01Schema,
  offlineCommands: z.literal('none'),
});
export type PresenceCapabilityV01 = z.infer<typeof presenceCapabilityV01Schema>;

const domainEventSchemaVersionV01Schema = z.literal('0.1');

export function domainEventEnvelopeSchemaFor<Payload extends z.ZodType>(
  payloadSchema: Payload,
) {
  return z.strictObject({
    schemaVersion: domainEventSchemaVersionV01Schema,
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

const agentSessionAggregateRefSchema = aggregateRefSchema.extend({
  kind: z.literal('agent_session'),
});

function requireMatchingAgentSessionAggregate(
  event: { aggregate: { id: string }; payload: { sessionId: string } },
  context: z.RefinementCtx,
): void {
  if (event.aggregate.id !== event.payload.sessionId) {
    context.addIssue({
      code: 'custom',
      path: ['aggregate', 'id'],
      message: 'agent-session observation aggregate must match payload.sessionId',
    });
  }
}

export const agentSessionActivityObservedEventSchema = domainEventEnvelopeSchemaFor(
  agentSessionActivityObservationPayloadSchema,
).extend({
  eventType: z.literal('agent_session.activity_observed'),
  aggregate: agentSessionAggregateRefSchema,
}).superRefine(requireMatchingAgentSessionAggregate);

export const judgmentNeededObservedEventSchema = domainEventEnvelopeSchemaFor(
  judgmentNeededObservationPayloadSchema,
).extend({
  eventType: z.literal('agent_session.judgment_needed_observed'),
  aggregate: agentSessionAggregateRefSchema,
}).superRefine(requireMatchingAgentSessionAggregate);

export const candidateEvidenceObservedEventSchema = domainEventEnvelopeSchemaFor(
  candidateEvidenceObservationPayloadSchema,
).extend({
  eventType: z.literal('agent_session.candidate_evidence_observed'),
  aggregate: agentSessionAggregateRefSchema,
}).superRefine(requireMatchingAgentSessionAggregate);

export const domainEventSchema = z.discriminatedUnion('eventType', [
  agentSessionActivityObservedEventSchema,
  judgmentNeededObservedEventSchema,
  candidateEvidenceObservedEventSchema,
]);
export type DomainEvent = z.infer<typeof domainEventSchema>;

const MAX_PROJECTION_ITEMS = 256;
const MAX_PROJECTION_PAGE_BYTES = 262_144;

function jsonStringUtf8ByteLengthAtMost(value: string, limit: number): number {
  let bytes = 2;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint === 0x22 || codePoint === 0x5c) {
      bytes += 2;
    } else if (
      codePoint === 0x08 ||
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0c ||
      codePoint === 0x0d
    ) {
      bytes += 2;
    } else if (codePoint <= 0x1f) {
      bytes += 6;
    } else {
      bytes +=
        codePoint <= 0x7f
          ? 1
          : codePoint <= 0x7ff
            ? 2
            : codePoint <= 0xffff
              ? 3
              : 4;
    }
    if (bytes > limit) return bytes;
  }
  return bytes;
}

function jsonEncodedUtf8ByteLengthAtMost(value: ProtocolJsonValue, limit: number): number {
  const pending: ProtocolJsonValue[] = [value];
  let bytes = 0;
  const add = (count: number): boolean => {
    bytes += count;
    return bytes <= limit;
  };

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === null) {
      if (!add(4)) return bytes;
      continue;
    }
    if (typeof current === 'boolean') {
      if (!add(current ? 4 : 5)) return bytes;
      continue;
    }
    if (typeof current === 'number') {
      if (!add(JSON.stringify(current).length)) return bytes;
      continue;
    }
    if (typeof current === 'string') {
      if (!add(jsonStringUtf8ByteLengthAtMost(current, limit - bytes))) return bytes;
      continue;
    }
    if (Array.isArray(current)) {
      if (!add(2 + Math.max(0, current.length - 1))) return bytes;
      for (let index = current.length - 1; index >= 0; index -= 1) {
        pending.push(current[index]!);
      }
      continue;
    }

    const keys = Object.keys(current);
    if (!add(2 + Math.max(0, keys.length - 1) + keys.length)) return bytes;
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      if (!add(jsonStringUtf8ByteLengthAtMost(key, limit - bytes))) return bytes;
      pending.push(current[key]!);
    }
  }

  return bytes;
}

export function projectionPageEnvelopeSchemaFor<
  Item extends z.ZodType<ProtocolJsonValue>,
>(
  itemSchema: Item,
) {
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
      if (
        jsonEncodedUtf8ByteLengthAtMost(page, MAX_PROJECTION_PAGE_BYTES) >
        MAX_PROJECTION_PAGE_BYTES
      ) {
        context.addIssue({
          code: 'custom',
          message: `projection page must not exceed ${MAX_PROJECTION_PAGE_BYTES} UTF-8 bytes`,
        });
      }
    });
}

export const projectionPageSchema =
  projectionPageEnvelopeSchemaFor(protocolJsonValueSchema);
export type ProjectionPage = z.infer<typeof projectionPageSchema>;
