import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import { protocolDigestSchema, protocolIdSchema, protocolNameSchema, protocolRevisionSchema } from './responsibility-handshake-v0-1';
import { exactRevisionV04Schema, protocolReferenceV04Schema, protocolVersionV04Schema, versionedManifestReferenceV04Schema } from './responsibility-protocol-v0-4';

export const providerRefV04Schema = z.strictObject({ category: z.literal('provider'), id: protocolIdSchema,
  version: protocolNameSchema, modelRef: protocolIdSchema, manifest: versionedManifestReferenceV04Schema });
export const executionEnvironmentRefV04Schema = z.strictObject({ category: z.literal('execution_environment'),
  id: protocolIdSchema, version: protocolNameSchema, environmentKind: z.enum(['local', 'cloud', 'human']),
  manifest: versionedManifestReferenceV04Schema });
export const executionAuthorityCeilingV04Schema = z.strictObject({
  tools: z.array(protocolNameSchema).max(32), connectors: z.array(protocolNameSchema).max(32),
  externalEffects: z.enum(['none', 'judgment_bound']), outcomeMutation: z.literal('none'),
  evidenceAdmission: z.literal('none'), verification: z.literal('none'), acceptance: z.literal('none'), closure: z.literal('none'),
});
export const executionRequestV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema, id: protocolIdSchema, ownerId: protocolIdSchema,
  outcome: protocolReferenceV04Schema, workUnit: protocolReferenceV04Schema,
  provider: providerRefV04Schema, environment: executionEnvironmentRefV04Schema,
  authorityCeiling: executionAuthorityCeilingV04Schema, contextProjectionRef: protocolIdSchema,
  contextProjectionDigest: protocolDigestSchema, cancellationGeneration: protocolRevisionSchema,
  requestedAt: iso8601Schema,
});
export const executionLeaseV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema, id: protocolIdSchema, ownerId: protocolIdSchema,
  executionRequestId: protocolIdSchema, attemptId: protocolIdSchema, holder: executionEnvironmentRefV04Schema,
  fencingGeneration: exactRevisionV04Schema, cancellationGeneration: protocolRevisionSchema,
  acquiredAt: iso8601Schema, expiresAt: iso8601Schema,
}).refine((v) => Date.parse(v.expiresAt) > Date.parse(v.acquiredAt), { path: ['expiresAt'], error: 'lease must expire after acquisition' });
export const executionAttemptV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema, id: protocolIdSchema, ownerId: protocolIdSchema,
  executionRequestId: protocolIdSchema, workUnit: protocolReferenceV04Schema, attemptNumber: z.int().positive().max(8),
  provider: providerRefV04Schema, environment: executionEnvironmentRefV04Schema, leaseId: protocolIdSchema,
  fencingGeneration: exactRevisionV04Schema, cancellationGeneration: protocolRevisionSchema,
  state: z.enum(['queued', 'running', 'cancelling', 'cancelled', 'settling', 'settled', 'failed', 'indeterminate']),
  createdAt: iso8601Schema, updatedAt: iso8601Schema,
});
export const executionSessionV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema, id: protocolIdSchema, ownerId: protocolIdSchema,
  attemptId: protocolIdSchema, provider: providerRefV04Schema, environment: executionEnvironmentRefV04Schema,
  providerSessionRef: protocolIdSchema.nullable(), state: z.enum(['starting', 'active', 'ended', 'lost', 'unknown']),
  lastObservationSequence: z.int().nonnegative(),
});
export const executorObservationV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema, id: protocolIdSchema, ownerId: protocolIdSchema,
  attemptId: protocolIdSchema, environment: executionEnvironmentRefV04Schema,
  leaseId: protocolIdSchema, fencingGeneration: exactRevisionV04Schema,
  cancellationGeneration: protocolRevisionSchema, sequence: z.int().positive(),
  kind: z.enum(['started', 'activity', 'candidate_artifact', 'candidate_evidence', 'ended', 'failed', 'timed_out', 'unknown']),
  payloadRef: protocolIdSchema.nullable(), payloadDigest: protocolDigestSchema.nullable(), observedAt: iso8601Schema,
}).superRefine((value, context) => {
  if ((value.payloadRef === null) !== (value.payloadDigest === null)) context.addIssue({ code: 'custom', path: ['payloadRef'], message: 'payload ref and digest must appear together' });
});
export const executionCancelRequestV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema, requestId: protocolIdSchema, commandType: z.literal('execution.cancel'),
  presenceRegistrationId: protocolIdSchema, executionRequestId: protocolIdSchema,
  expectedCancellationGeneration: protocolRevisionSchema, clientIssuedAt: iso8601Schema,
});
export const executionReconciliationV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema, id: protocolIdSchema, ownerId: protocolIdSchema,
  attemptId: protocolIdSchema, leaseId: protocolIdSchema, fencingGeneration: exactRevisionV04Schema,
  cancellationGeneration: protocolRevisionSchema,
  state: z.enum(['running', 'cancelled', 'settled', 'failed', 'indeterminate']),
  basisObservationIds: z.array(protocolIdSchema).max(64), checkedAt: iso8601Schema,
});

export function observationMatchesExecutionAttemptV04(attemptValue: unknown, observationValue: unknown): boolean {
  const attempt = executionAttemptV04Schema.parse(attemptValue);
  const observation = executorObservationV04Schema.parse(observationValue);
  return attempt.ownerId === observation.ownerId && attempt.id === observation.attemptId &&
    attempt.leaseId === observation.leaseId && attempt.fencingGeneration === observation.fencingGeneration &&
    attempt.cancellationGeneration === observation.cancellationGeneration &&
    attempt.environment.id === observation.environment.id && attempt.environment.version === observation.environment.version;
}
