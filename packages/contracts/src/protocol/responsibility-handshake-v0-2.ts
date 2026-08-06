import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import {
  actorRefSchema,
  aggregateRefSchema,
  canonicalizeProtocolJson,
  protocolDigestSchema,
  protocolIdSchema,
  protocolNameSchema,
  protocolRevisionSchema,
} from './responsibility-handshake-v0-1';

export const protocolVersionV02Schema = z.literal('0.2');
const MAX_CAPTURE_PAYLOAD_BYTES = 16_384;
const MAX_PROJECTION_ITEMS = 256;
const MAX_PROJECTION_PAGE_BYTES = 262_144;

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export const responsibilityCaptureTextV02Schema = z.string().min(1).max(8_192)
  .refine(isWellFormedUtf16, { error: 'responsibility text must contain well-formed Unicode' })
  .regex(/\S/, { error: 'responsibility text must contain non-whitespace content' });

export const responsibilityCaptureMissionProposalV02Schema = z.strictObject({
  brief: responsibilityCaptureTextV02Schema,
});

export const responsibilityCaptureWorkUnitProposalV02Schema = z.strictObject({
  responsibility: responsibilityCaptureTextV02Schema,
});

export const responsibilityCapturePayloadV02Schema = z.strictObject({
  userStatement: responsibilityCaptureTextV02Schema,
  mission: responsibilityCaptureMissionProposalV02Schema.optional(),
  workUnitProposals: z.array(responsibilityCaptureWorkUnitProposalV02Schema).max(32).optional(),
}).refine(
  (value) => utf8ByteLength(JSON.stringify(value)) <= MAX_CAPTURE_PAYLOAD_BYTES,
  { error: `protocol payload must not exceed ${MAX_CAPTURE_PAYLOAD_BYTES} UTF-8 bytes` },
);
export type ResponsibilityCapturePayloadV02 = z.infer<
  typeof responsibilityCapturePayloadV02Schema
>;

export const responsibilityCaptureRequestV02Schema = z.strictObject({
  protocolVersion: protocolVersionV02Schema,
  requestId: protocolIdSchema,
  commandType: z.literal('responsibility.capture'),
  presenceRegistrationId: protocolIdSchema,
  aggregate: z.never().optional(),
  correlationId: protocolIdSchema.optional(),
  clientIssuedAt: iso8601Schema,
  payload: responsibilityCapturePayloadV02Schema,
});
export type ResponsibilityCaptureRequestV02 = z.infer<
  typeof responsibilityCaptureRequestV02Schema
>;

export function canonicalizeResponsibilityCaptureRequestV02ForDigest(value: unknown): string {
  return canonicalizeProtocolJson(responsibilityCaptureRequestV02Schema.parse(value));
}

export const responsibilityCaptureTrustedEnvelopeV02Schema = z.strictObject({
  protocolVersion: protocolVersionV02Schema,
  commandId: protocolIdSchema,
  commandType: z.literal('responsibility.capture'),
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
  payload: responsibilityCapturePayloadV02Schema,
});
export type ResponsibilityCaptureTrustedEnvelopeV02 = z.infer<
  typeof responsibilityCaptureTrustedEnvelopeV02Schema
>;

export const responsibilityProtocolCapabilitiesV02Schema = z.strictObject({
  protocolName: z.literal('responsibility-handshake'),
  supportedVersions: z.tuple([z.literal('0.1'), z.literal('0.2')]),
  selectedVersion: z.enum(['0.1', '0.2']),
  offlineCommands: z.literal('none'),
}).superRefine((value, context) => {
  if (!value.supportedVersions.includes(value.selectedVersion)) {
    context.addIssue({ code: 'custom', path: ['selectedVersion'], message: 'unsupported selection' });
  }
});
export type ResponsibilityProtocolCapabilitiesV02 = z.infer<
  typeof responsibilityProtocolCapabilitiesV02Schema
>;

export const outcomeRecordV02Schema = z.strictObject({
  id: protocolIdSchema,
  ownerId: protocolIdSchema,
  revision: z.int().positive(),
  userStatement: responsibilityCaptureTextV02Schema,
  state: z.literal('captured'),
  createdAt: iso8601Schema,
  updatedAt: iso8601Schema,
});
export type OutcomeRecordV02 = z.infer<typeof outcomeRecordV02Schema>;

export const missionRecordV02Schema = z.strictObject({
  id: protocolIdSchema,
  ownerId: protocolIdSchema,
  outcomeId: protocolIdSchema,
  revision: z.int().positive(),
  brief: responsibilityCaptureTextV02Schema,
  state: z.literal('proposed'),
  createdAt: iso8601Schema,
  updatedAt: iso8601Schema,
});
export type MissionRecordV02 = z.infer<typeof missionRecordV02Schema>;

export const workUnitProposalRecordV02Schema = z.strictObject({
  id: protocolIdSchema,
  ownerId: protocolIdSchema,
  outcomeId: protocolIdSchema,
  missionId: protocolIdSchema.nullable(),
  position: protocolRevisionSchema,
  revision: z.int().positive(),
  responsibility: responsibilityCaptureTextV02Schema,
  state: z.literal('proposed'),
  createdAt: iso8601Schema,
  updatedAt: iso8601Schema,
});
export type WorkUnitProposalRecordV02 = z.infer<typeof workUnitProposalRecordV02Schema>;

const projectionItemBaseV02Schema = z.strictObject({
  cursor: protocolRevisionSchema,
  aggregateId: protocolIdSchema,
  outcomeId: protocolIdSchema,
  revision: z.int().positive(),
  createdAt: iso8601Schema,
});

export const outcomeProjectionItemV02Schema = projectionItemBaseV02Schema.extend({
  itemType: z.literal('outcome'),
  state: z.literal('captured'),
  userStatement: responsibilityCaptureTextV02Schema,
}).superRefine((item, context) => {
  if (item.aggregateId !== item.outcomeId) {
    context.addIssue({ code: 'custom', path: ['outcomeId'], message: 'Outcome identity mismatch' });
  }
});

export const missionProjectionItemV02Schema = projectionItemBaseV02Schema.extend({
  itemType: z.literal('mission'),
  state: z.literal('proposed'),
  brief: responsibilityCaptureTextV02Schema,
});

export const workUnitProposalProjectionItemV02Schema = projectionItemBaseV02Schema.extend({
  itemType: z.literal('work_unit_proposal'),
  missionId: protocolIdSchema.nullable(),
  position: protocolRevisionSchema,
  state: z.literal('proposed'),
  responsibility: responsibilityCaptureTextV02Schema,
});

export const responsibilityProjectionItemV02Schema = z.union([
  outcomeProjectionItemV02Schema,
  missionProjectionItemV02Schema,
  workUnitProposalProjectionItemV02Schema,
]);
export type ResponsibilityProjectionItemV02 = z.infer<
  typeof responsibilityProjectionItemV02Schema
>;

export const responsibilityProjectionPageV02Schema = z.strictObject({
  protocolVersion: protocolVersionV02Schema,
  ownerId: protocolIdSchema,
  projectionName: z.literal('responsibility.summary'),
  snapshotId: protocolIdSchema,
  snapshotBaseCursor: protocolRevisionSchema,
  fromExclusiveCursor: protocolRevisionSchema,
  highWaterCursor: protocolRevisionSchema,
  nextCursor: protocolRevisionSchema,
  items: z.array(responsibilityProjectionItemV02Schema).max(MAX_PROJECTION_ITEMS),
  hasMore: z.boolean(),
  generatedAt: iso8601Schema,
}).superRefine((page, context) => {
  if (page.snapshotBaseCursor > page.fromExclusiveCursor ||
      page.fromExclusiveCursor > page.nextCursor || page.nextCursor > page.highWaterCursor) {
    context.addIssue({ code: 'custom', path: ['nextCursor'], message: 'invalid cursor range' });
  }
  if (page.hasMore !== (page.nextCursor < page.highWaterCursor)) {
    context.addIssue({ code: 'custom', path: ['hasMore'], message: 'invalid pagination state' });
  }
  let previous = page.fromExclusiveCursor;
  for (let index = 0; index < page.items.length; index += 1) {
    const cursor = page.items[index]!.cursor;
    if (cursor <= previous || cursor > page.nextCursor) {
      context.addIssue({
        code: 'custom', path: ['items', index, 'cursor'], message: 'items must be strictly ordered',
      });
      break;
    }
    previous = cursor;
  }
  if (utf8ByteLength(JSON.stringify(page)) > MAX_PROJECTION_PAGE_BYTES) {
    context.addIssue({ code: 'custom', message: 'projection page exceeds byte limit' });
  }
});
export type ResponsibilityProjectionPageV02 = z.infer<
  typeof responsibilityProjectionPageV02Schema
>;

export const responsibilityCaptureResultV02Schema = z.strictObject({
  protocolVersion: protocolVersionV02Schema,
  duplicate: z.literal(false),
  ownerId: protocolIdSchema,
  requestId: protocolIdSchema,
  outcome: outcomeRecordV02Schema,
  mission: missionRecordV02Schema.nullable(),
  workUnitProposals: z.array(workUnitProposalRecordV02Schema).max(32),
  projectionCursor: z.int().positive(),
}).superRefine((result, context) => {
  if (result.outcome.ownerId !== result.ownerId) {
    context.addIssue({ code: 'custom', path: ['outcome', 'ownerId'], message: 'Outcome owner mismatch' });
  }
  if (result.mission !== null &&
      (result.mission.ownerId !== result.ownerId || result.mission.outcomeId !== result.outcome.id)) {
    context.addIssue({ code: 'custom', path: ['mission'], message: 'Mission relationship mismatch' });
  }
  result.workUnitProposals.forEach((proposal, index) => {
    if (proposal.ownerId !== result.ownerId || proposal.outcomeId !== result.outcome.id ||
        proposal.missionId !== (result.mission?.id ?? null) || proposal.position !== index) {
      context.addIssue({
        code: 'custom', path: ['workUnitProposals', index], message: 'proposal relationship mismatch',
      });
    }
  });
});
export type ResponsibilityCaptureResultV02 = z.infer<
  typeof responsibilityCaptureResultV02Schema
>;
