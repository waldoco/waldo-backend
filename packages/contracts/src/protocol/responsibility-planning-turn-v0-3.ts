import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import { workUnitRecordV02Schema } from './responsibility-handshake-v0-2';
import {
  actorRefSchema,
  canonicalizeProtocolJson,
  protocolDigestSchema,
  protocolIdSchema,
  protocolNameSchema,
  protocolRevisionSchema,
} from './responsibility-handshake-v0-1';

const MAX_REQUEST_BYTES = 24_576;
const MAX_PLAN_BYTES = 16_384;
export const MAX_PLANNING_PROJECTION_PAGE_UTF8_BYTES = 262_144;

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function utf8ByteLength(value: unknown): number {
  let bytes = 0;
  for (const character of JSON.stringify(value)) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

const boundedText = (maximum: number) => z.string().min(1).max(maximum)
  .refine(isWellFormedUtf16, { error: 'text must contain well-formed Unicode' })
  .regex(/\S/, { error: 'text must contain non-whitespace content' });

export const governedPlanningInputV03Schema = z.strictObject({
  ref: protocolIdSchema,
  digest: protocolDigestSchema,
  // Transient request material. The runtime verifies the digest and deliberately persists only
  // ref + digest; provider prompts and supplied material never enter the Durable Object store.
  content: boundedText(4_096),
});

export const workUnitPlanningTurnRequestV03Schema = z.strictObject({
  protocolVersion: z.literal('0.3'),
  requestId: protocolIdSchema,
  commandType: z.literal('work_unit.request_planning_turn'),
  presenceRegistrationId: protocolIdSchema,
  aggregate: z.strictObject({
    kind: z.literal('work_unit'),
    id: protocolIdSchema,
    expectedRevision: z.int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  correlationId: protocolIdSchema.optional(),
  clientIssuedAt: iso8601Schema,
  payload: z.strictObject({
    governedInputs: z.array(governedPlanningInputV03Schema).max(8)
      .refine((inputs) => new Set(inputs.map((input) => input.ref)).size === inputs.length, {
        error: 'governed input references must be unique',
      }),
  }),
}).refine((request) => utf8ByteLength(request) <= MAX_REQUEST_BYTES, {
  error: `planning request must not exceed ${MAX_REQUEST_BYTES} UTF-8 bytes`,
});
export type WorkUnitPlanningTurnRequestV03 = z.infer<
  typeof workUnitPlanningTurnRequestV03Schema
>;

export function canonicalizeWorkUnitPlanningTurnRequestV03ForDigest(value: unknown): string {
  return canonicalizeProtocolJson(workUnitPlanningTurnRequestV03Schema.parse(value));
}

export const workUnitPlanningCancelRequestV03Schema = z.strictObject({
  protocolVersion: z.literal('0.3'),
  requestId: protocolIdSchema,
  commandType: z.literal('work_unit.cancel_planning_turn'),
  presenceRegistrationId: protocolIdSchema,
  executionRequestId: protocolIdSchema,
  expectedCancellationGeneration: protocolRevisionSchema,
  correlationId: protocolIdSchema.optional(),
  clientIssuedAt: iso8601Schema,
}).refine((request) => utf8ByteLength(request) <= MAX_REQUEST_BYTES, {
  error: `planning cancellation request must not exceed ${MAX_REQUEST_BYTES} UTF-8 bytes`,
});
export type WorkUnitPlanningCancelRequestV03 = z.infer<
  typeof workUnitPlanningCancelRequestV03Schema
>;

export function canonicalizeWorkUnitPlanningCancelRequestV03ForDigest(value: unknown): string {
  return canonicalizeProtocolJson(workUnitPlanningCancelRequestV03Schema.parse(value));
}

export const workUnitPlanningCancelResultV03Schema = z.strictObject({
  protocolVersion: z.literal('0.3'),
  ownerId: protocolIdSchema,
  requestId: protocolIdSchema,
  executionRequestId: protocolIdSchema,
  status: z.literal('cancelled'),
  cancellationGeneration: z.int().positive(),
  projectionCursor: z.int().positive(),
  cancelledAt: iso8601Schema,
});
export type WorkUnitPlanningCancelResultV03 = z.infer<
  typeof workUnitPlanningCancelResultV03Schema
>;

export const workUnitCandidatePlanV03Schema = z.strictObject({
  summary: boundedText(1_024),
  proposedSteps: z.array(boundedText(512)).min(1).max(12),
  openQuestions: z.array(boundedText(512)).max(8),
  constraints: z.array(boundedText(512)).max(12),
}).refine((plan) => utf8ByteLength(plan) <= MAX_PLAN_BYTES, {
  error: `candidate plan must not exceed ${MAX_PLAN_BYTES} UTF-8 bytes`,
});
export type WorkUnitCandidatePlanV03 = z.infer<typeof workUnitCandidatePlanV03Schema>;

export const planningInputReferenceV03Schema = governedPlanningInputV03Schema.omit({
  content: true,
});
export type PlanningInputReferenceV03 = z.infer<typeof planningInputReferenceV03Schema>;

export const emptyPlanningCapabilityManifestV03Schema = z.strictObject({
  schemaVersion: z.literal('0.3'),
  tools: z.array(protocolIdSchema).max(0),
  connectors: z.array(protocolIdSchema).max(0),
  filesystem: z.literal('none'),
  shell: z.literal('none'),
  network: z.literal('none'),
  externalEffects: z.literal('none'),
});
export type EmptyPlanningCapabilityManifestV03 = z.infer<
  typeof emptyPlanningCapabilityManifestV03Schema
>;

export const workUnitPlanningAuthorityCeilingV03Schema = z.strictObject({
  providerPlanningTurns: z.literal(1),
  tools: z.literal('none'),
  connectors: z.literal('none'),
  externalEffects: z.literal('none'),
  outcomeMutation: z.literal('none'),
  evidence: z.literal('none'),
  verification: z.literal('none'),
  acceptance: z.literal('none'),
  closure: z.literal('none'),
});
export type WorkUnitPlanningAuthorityCeilingV03 = z.infer<
  typeof workUnitPlanningAuthorityCeilingV03Schema
>;

export const workUnitPlanningAuthorizedRecordV03Schema = workUnitRecordV02Schema.omit({
  revision: true,
  authorityCeiling: true,
  budget: true,
  isolation: true,
  assignee: true,
  sessionIds: true,
  state: true,
}).extend({
  revision: z.int().min(2),
  authorityCeiling: workUnitPlanningAuthorityCeilingV03Schema,
  budget: z.strictObject({
    maxProviderTurns: z.literal(1),
    maxExternalEffects: z.literal(0),
    maxDurationMs: z.int().min(1).max(300_000),
  }),
  isolation: z.strictObject({
    mode: z.literal('provider_planning'),
    egress: z.literal('provider_only'),
    credentials: z.literal('runtime_managed'),
  }),
  assignee: protocolIdSchema,
  sessionIds: z.tuple([protocolIdSchema]),
  state: z.literal('planning_authorized'),
});
export type WorkUnitPlanningAuthorizedRecordV03 = z.infer<
  typeof workUnitPlanningAuthorizedRecordV03Schema
>;

export const canonicalWorkUnitRecordV03Schema = z.union([
  workUnitRecordV02Schema,
  workUnitPlanningAuthorizedRecordV03Schema,
]);
export type CanonicalWorkUnitRecordV03 = z.infer<typeof canonicalWorkUnitRecordV03Schema>;

export const planningManifestReferenceV03Schema = z.strictObject({
  id: protocolIdSchema,
  revision: z.int().positive(),
  digest: protocolDigestSchema,
});

export const planningProviderReferenceV03Schema = z.strictObject({
  adapterId: protocolIdSchema,
  adapterVersion: protocolNameSchema,
  modelRef: protocolIdSchema,
  capabilityManifest: planningManifestReferenceV03Schema,
});

export const planningExecutorReferenceV03Schema = z.strictObject({
  executorId: protocolIdSchema,
  executorVersion: protocolNameSchema,
  capabilityManifest: planningManifestReferenceV03Schema,
});

export const workUnitPlanningTurnTrustedEnvelopeV03Schema = z.strictObject({
  protocolVersion: z.literal('0.3'),
  commandId: protocolIdSchema,
  commandType: z.literal('work_unit.request_planning_turn'),
  ownerId: protocolIdSchema,
  actor: actorRefSchema,
  presenceId: protocolIdSchema,
  authenticatedSessionId: protocolIdSchema,
  ownerPolicyRevision: protocolRevisionSchema,
  authAssurance: protocolNameSchema,
  ownerRootRoutingVersion: protocolRevisionSchema,
  aggregate: z.strictObject({
    kind: z.literal('work_unit'),
    id: protocolIdSchema,
    expectedRevision: z.int().positive(),
  }),
  requestDigest: protocolDigestSchema,
  correlationId: protocolIdSchema,
  receivedAt: iso8601Schema,
  provider: planningProviderReferenceV03Schema,
  executor: planningExecutorReferenceV03Schema,
  capabilityManifest: emptyPlanningCapabilityManifestV03Schema,
  authorityCeiling: workUnitPlanningAuthorityCeilingV03Schema,
  payload: z.strictObject({
    governedInputs: z.array(planningInputReferenceV03Schema).max(8),
  }),
});
export type WorkUnitPlanningTurnTrustedEnvelopeV03 = z.infer<
  typeof workUnitPlanningTurnTrustedEnvelopeV03Schema
>;

export function canonicalizeWorkUnitPlanningTurnTrustedEnvelopeV03ForDigest(
  value: unknown,
): string {
  return canonicalizeProtocolJson(workUnitPlanningTurnTrustedEnvelopeV03Schema.parse(value));
}

export const workUnitPlanningExecutionRequestV03Schema = z.strictObject({
  id: protocolIdSchema,
  ownerId: protocolIdSchema,
  outcomeId: protocolIdSchema,
  workUnitId: protocolIdSchema,
  workUnitRevision: z.int().min(2),
  requestId: protocolIdSchema,
  requestDigest: protocolDigestSchema,
  governedInputs: z.array(planningInputReferenceV03Schema).max(8),
  provider: planningProviderReferenceV03Schema,
  executor: planningExecutorReferenceV03Schema,
  capabilityManifest: emptyPlanningCapabilityManifestV03Schema,
  authorityCeiling: workUnitPlanningAuthorityCeilingV03Schema,
  status: z.enum(['pending', 'leased', 'completed', 'cancelled', 'failed', 'ambiguous']),
  cancellationGeneration: protocolRevisionSchema,
  createdAt: iso8601Schema,
  updatedAt: iso8601Schema,
});
export type WorkUnitPlanningExecutionRequestV03 = z.infer<
  typeof workUnitPlanningExecutionRequestV03Schema
>;

export const planningAgentSessionV03Schema = z.strictObject({
  id: protocolIdSchema,
  ownerId: protocolIdSchema,
  outcomeId: protocolIdSchema,
  workUnitId: protocolIdSchema,
  executionRequestId: protocolIdSchema,
  status: z.enum(['authorized', 'running', 'completed', 'cancelled', 'failed', 'ambiguous']),
  provider: planningProviderReferenceV03Schema,
  executor: planningExecutorReferenceV03Schema,
  capabilityManifest: emptyPlanningCapabilityManifestV03Schema,
  cancellationGeneration: protocolRevisionSchema,
  createdAt: iso8601Schema,
  updatedAt: iso8601Schema,
});
export type PlanningAgentSessionV03 = z.infer<typeof planningAgentSessionV03Schema>;

export const planningExecutionLeaseV03Schema = z.strictObject({
  executionRequestId: protocolIdSchema,
  ownerId: protocolIdSchema,
  holderId: protocolIdSchema,
  fence: z.int().positive(),
  cancellationGeneration: protocolRevisionSchema,
  acquiredAt: iso8601Schema,
  expiresAt: iso8601Schema,
});
export type PlanningExecutionLeaseV03 = z.infer<typeof planningExecutionLeaseV03Schema>;

export const planningProviderInvocationV03Schema = z.strictObject({
  executionRequestId: protocolIdSchema,
  invocationKey: protocolDigestSchema,
  provider: planningProviderReferenceV03Schema,
  status: z.literal('completed'),
  resultDigest: protocolDigestSchema,
  startedAt: iso8601Schema,
  completedAt: iso8601Schema,
});
export type PlanningProviderInvocationV03 = z.infer<typeof planningProviderInvocationV03Schema>;

export const workUnitPlanningAuthorizationResultV03Schema = z.strictObject({
  protocolVersion: z.literal('0.3'),
  ownerId: protocolIdSchema,
  requestId: protocolIdSchema,
  outcomeId: protocolIdSchema,
  workUnitId: protocolIdSchema,
  workUnitRevision: z.int().min(2),
  workUnitState: z.literal('planning_authorized'),
  executionRequest: workUnitPlanningExecutionRequestV03Schema,
  agentSession: planningAgentSessionV03Schema,
  projectionCursor: z.int().positive(),
});
export type WorkUnitPlanningAuthorizationResultV03 = z.infer<
  typeof workUnitPlanningAuthorizationResultV03Schema
>;

export const workUnitPlanningTurnResultV03Schema = z.strictObject({
  protocolVersion: z.literal('0.3'),
  ownerId: protocolIdSchema,
  requestId: protocolIdSchema,
  outcomeId: protocolIdSchema,
  workUnitId: protocolIdSchema,
  workUnitRevision: z.int().min(2),
  workUnitState: z.literal('planning_authorized'),
  executionRequestId: protocolIdSchema,
  agentSessionId: protocolIdSchema,
  sessionStatus: z.literal('completed'),
  providerInvocation: planningProviderInvocationV03Schema,
  candidatePlan: workUnitCandidatePlanV03Schema,
  projectionCursor: z.int().positive(),
});
export type WorkUnitPlanningTurnResultV03 = z.infer<typeof workUnitPlanningTurnResultV03Schema>;

export const workUnitPlanningCommandResultV03Schema = z.union([
  workUnitPlanningAuthorizationResultV03Schema,
  workUnitPlanningTurnResultV03Schema,
]);
export type WorkUnitPlanningCommandResultV03 = z.infer<
  typeof workUnitPlanningCommandResultV03Schema
>;

export const workUnitPlanningProjectionItemV03Schema = z.discriminatedUnion('itemType', [
  z.strictObject({
    cursor: z.int().positive(),
    itemType: z.literal('planning_authorized'),
    outcomeId: protocolIdSchema,
    workUnitId: protocolIdSchema,
    workUnitRevision: z.int().min(2),
    executionRequestId: protocolIdSchema,
    agentSessionId: protocolIdSchema,
    createdAt: iso8601Schema,
  }),
  z.strictObject({
    cursor: z.int().positive(),
    itemType: z.literal('agent_session_activity'),
    outcomeId: protocolIdSchema,
    workUnitId: protocolIdSchema,
    executionRequestId: protocolIdSchema,
    agentSessionId: protocolIdSchema,
    status: z.enum(['running', 'completed', 'cancelled', 'failed', 'ambiguous']),
    occurredAt: iso8601Schema,
  }),
  z.strictObject({
    cursor: z.int().positive(),
    itemType: z.literal('work_unit_candidate_plan'),
    outcomeId: protocolIdSchema,
    workUnitId: protocolIdSchema,
    executionRequestId: protocolIdSchema,
    agentSessionId: protocolIdSchema,
    resultDigest: protocolDigestSchema,
    candidatePlan: workUnitCandidatePlanV03Schema,
    createdAt: iso8601Schema,
  }),
]);
export type WorkUnitPlanningProjectionItemV03 = z.infer<
  typeof workUnitPlanningProjectionItemV03Schema
>;

export const workUnitPlanningTurnProjectionQueryV03Schema = z.strictObject({
  protocolVersion: z.literal('0.3'),
  fromExclusiveCursor: protocolRevisionSchema,
  limit: z.int().min(1).max(256),
  snapshotId: protocolIdSchema.optional(),
});

export const workUnitPlanningProjectionPageV03Schema = z.strictObject({
  protocolVersion: z.literal('0.3'),
  ownerId: protocolIdSchema,
  projectionName: z.literal('work_unit.planning_activity'),
  snapshotId: protocolIdSchema,
  snapshotBaseCursor: protocolRevisionSchema,
  fromExclusiveCursor: protocolRevisionSchema,
  highWaterCursor: protocolRevisionSchema,
  nextCursor: protocolRevisionSchema,
  items: z.array(workUnitPlanningProjectionItemV03Schema).max(256),
  hasMore: z.boolean(),
  generatedAt: iso8601Schema,
}).superRefine((page, context) => {
  let cursor = page.fromExclusiveCursor;
  for (const [index, item] of page.items.entries()) {
    if (item.cursor <= cursor || item.cursor > page.highWaterCursor) {
      context.addIssue({ code: 'custom', path: ['items', index, 'cursor'], message: 'invalid ordering' });
    }
    cursor = item.cursor;
  }
  if (page.nextCursor < page.fromExclusiveCursor || page.nextCursor > page.highWaterCursor ||
      page.hasMore !== (page.nextCursor < page.highWaterCursor)) {
    context.addIssue({ code: 'custom', message: 'invalid planning projection cursor envelope' });
  }
  if (utf8ByteLength(page) > MAX_PLANNING_PROJECTION_PAGE_UTF8_BYTES) {
    context.addIssue({ code: 'custom', message: 'planning projection page exceeds byte limit' });
  }
});
export type WorkUnitPlanningProjectionPageV03 = z.infer<
  typeof workUnitPlanningProjectionPageV03Schema
>;
