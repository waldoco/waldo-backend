import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import {
  canonicalizeProtocolJson,
  protocolDigestSchema,
  protocolIdSchema,
  protocolNameSchema,
} from './responsibility-handshake-v0-1';
import { acceptanceCheckSubjectV04Schema } from './responsibility-acceptance-check-v0-4';
import {
  exactRevisionV04Schema,
  protocolReferenceV04Schema,
  protocolVersionV04Schema,
} from './responsibility-protocol-v0-4';

export const evidenceRefV04Schema = z.strictObject({
  id: protocolIdSchema,
  revision: exactRevisionV04Schema,
  digest: protocolDigestSchema,
});
export const candidateEvidenceSubmissionV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema,
  submissionId: protocolIdSchema,
  source: z.strictObject({
    kind: z.enum(['provider', 'execution_environment', 'effect_adapter', 'person']),
    id: protocolIdSchema,
    version: protocolNameSchema.nullable(),
  }),
  subject: acceptanceCheckSubjectV04Schema,
  acceptanceCheckId: protocolIdSchema,
  claim: z.strictObject({ ref: protocolIdSchema, digest: protocolDigestSchema }),
  artifactRefs: z
    .array(z.strictObject({ ref: protocolIdSchema, digest: protocolDigestSchema }))
    .max(32),
  observedAt: iso8601Schema,
});
const evidenceBaseV04Shape = {
  protocolVersion: protocolVersionV04Schema,
  id: protocolIdSchema,
  ownerId: protocolIdSchema,
  revision: exactRevisionV04Schema,
  subject: acceptanceCheckSubjectV04Schema,
  acceptanceCheckId: protocolIdSchema,
  acceptanceCheckRevision: exactRevisionV04Schema,
  claimRef: protocolIdSchema,
  claimDigest: protocolDigestSchema,
  source: candidateEvidenceSubmissionV04Schema.shape.source,
  artifactRefs: candidateEvidenceSubmissionV04Schema.shape.artifactRefs,
} as const;
export const evidenceV04Schema = z.discriminatedUnion('state', [
  z.strictObject({ ...evidenceBaseV04Shape, state: z.literal('candidate'), admittedAt: z.null() }),
  z.strictObject({
    ...evidenceBaseV04Shape,
    state: z.literal('admitted'),
    admittedAt: iso8601Schema,
  }),
  z.strictObject({ ...evidenceBaseV04Shape, state: z.literal('stale'), admittedAt: iso8601Schema }),
  z.strictObject({
    ...evidenceBaseV04Shape,
    state: z.literal('invalidated'),
    admittedAt: iso8601Schema,
  }),
]);
const verificationBaseV04Shape = {
  protocolVersion: protocolVersionV04Schema,
  id: protocolIdSchema,
  ownerId: protocolIdSchema,
  revision: exactRevisionV04Schema,
  outcome: z.strictObject({ id: protocolIdSchema, revision: exactRevisionV04Schema }),
  acceptanceCheck: z.strictObject({
    id: protocolIdSchema,
    revision: exactRevisionV04Schema,
    digest: protocolDigestSchema,
  }),
  evidence: z.array(evidenceRefV04Schema).min(1).max(64),
  evidenceSetDigest: protocolDigestSchema,
  methodVersion: protocolNameSchema,
  findings: z.union([
    z.strictObject({ ref: protocolIdSchema, digest: protocolDigestSchema }),
    z.null(),
  ]),
} as const;
const availableVerifierV04Schema = z.strictObject({
  id: protocolIdSchema,
  version: protocolNameSchema,
  availability: z.literal('available'),
  independentFromProducer: z.boolean(),
  disclosureRef: protocolIdSchema,
});
const independentVerifierV04Schema = z.strictObject({
  id: protocolIdSchema,
  version: protocolNameSchema,
  availability: z.literal('available'),
  independentFromProducer: z.literal(true),
  disclosureRef: protocolIdSchema,
});
const unavailableVerifierV04Schema = z.strictObject({
  id: protocolIdSchema,
  version: protocolNameSchema,
  availability: z.enum(['unavailable', 'unsupported']),
  independentFromProducer: z.boolean(),
  disclosureRef: protocolIdSchema,
});
export const verificationV04Schema = z.discriminatedUnion('state', [
  z.strictObject({
    ...verificationBaseV04Shape,
    verifier: availableVerifierV04Schema,
    state: z.literal('pending'),
    verifiedAt: z.null(),
  }),
  z.strictObject({
    ...verificationBaseV04Shape,
    verifier: independentVerifierV04Schema,
    state: z.literal('passed'),
    verifiedAt: iso8601Schema,
  }),
  z.strictObject({
    ...verificationBaseV04Shape,
    verifier: independentVerifierV04Schema,
    state: z.literal('failed'),
    verifiedAt: iso8601Schema,
  }),
  z.strictObject({
    ...verificationBaseV04Shape,
    verifier: z.union([availableVerifierV04Schema, unavailableVerifierV04Schema]),
    state: z.literal('indeterminate'),
    verifiedAt: iso8601Schema.nullable(),
  }),
  z.strictObject({
    ...verificationBaseV04Shape,
    verifier: availableVerifierV04Schema,
    state: z.literal('stale'),
    verifiedAt: iso8601Schema,
  }),
]);
export const acceptanceCommandRequestV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema,
  requestId: protocolIdSchema,
  commandType: z.literal('acceptance.record'),
  presenceRegistrationId: protocolIdSchema,
  aggregate: z.strictObject({
    kind: z.literal('outcome'),
    id: protocolIdSchema,
    expectedRevision: exactRevisionV04Schema,
  }),
  decision: z.enum(['accept', 'reopen', 'release']),
  evidenceSetDigest: protocolDigestSchema,
  verificationIds: z.array(protocolIdSchema).max(32),
  reasonRef: protocolIdSchema.nullable(),
  clientIssuedAt: iso8601Schema,
});
const acceptanceBaseV04Shape = {
  protocolVersion: protocolVersionV04Schema,
  id: protocolIdSchema,
  ownerId: protocolIdSchema,
  revision: exactRevisionV04Schema,
  outcome: z.strictObject({ id: protocolIdSchema, revision: exactRevisionV04Schema }),
  evidenceSetDigest: protocolDigestSchema,
  verificationIds: z.array(protocolIdSchema).max(32),
  decision: z.enum(['accepted', 'reopened', 'released']),
  reasonRef: protocolIdSchema.nullable(),
  recordedAt: iso8601Schema,
} as const;
export const acceptanceV04Schema = z.discriminatedUnion('mode', [
  z.strictObject({
    ...acceptanceBaseV04Shape,
    actor: z.strictObject({ kind: z.literal('owner'), id: protocolIdSchema }),
    mode: z.literal('explicit_owner'),
    delegatedPolicy: z.null(),
  }),
  z.strictObject({
    ...acceptanceBaseV04Shape,
    actor: z.strictObject({ kind: z.enum(['owner', 'service', 'person']), id: protocolIdSchema }),
    mode: z.literal('delegated_policy'),
    delegatedPolicy: protocolReferenceV04Schema,
  }),
]);

export function acceptanceMatchesAuthorityV04(
  value: unknown,
  authenticatedOwnerId: string,
  expectedDelegatedPolicyValue?: unknown,
  expectedDelegatedActorValue?: unknown,
): boolean {
  const acceptance = acceptanceV04Schema.parse(value);
  if (acceptance.ownerId !== authenticatedOwnerId) return false;
  if (acceptance.mode === 'explicit_owner') return acceptance.actor.id === authenticatedOwnerId;
  if (expectedDelegatedPolicyValue === undefined || expectedDelegatedActorValue === undefined) {
    return false;
  }
  const expectedPolicy = protocolReferenceV04Schema.parse(expectedDelegatedPolicyValue);
  const expectedActor = z
    .strictObject({ kind: z.enum(['owner', 'service', 'person']), id: protocolIdSchema })
    .parse(expectedDelegatedActorValue);
  return (
    canonicalizeProtocolJson(acceptance.delegatedPolicy) ===
      canonicalizeProtocolJson(expectedPolicy) &&
    canonicalizeProtocolJson(acceptance.actor) === canonicalizeProtocolJson(expectedActor)
  );
}
