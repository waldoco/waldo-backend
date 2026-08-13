import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import { actorRefSchema, protocolDigestSchema, protocolIdSchema, protocolNameSchema, protocolRevisionSchema } from './responsibility-handshake-v0-1';
import { acceptanceCheckSubjectV04Schema } from './responsibility-acceptance-check-v0-4';
import { exactRevisionV04Schema, protocolVersionV04Schema } from './responsibility-protocol-v0-4';

export const evidenceRefV04Schema = z.strictObject({ id: protocolIdSchema, revision: exactRevisionV04Schema, digest: protocolDigestSchema });
export const candidateEvidenceSubmissionV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema, submissionId: protocolIdSchema,
  source: z.strictObject({ kind: z.enum(['provider', 'execution_environment', 'effect_adapter', 'person']), id: protocolIdSchema, version: protocolNameSchema.nullable() }),
  subject: acceptanceCheckSubjectV04Schema, acceptanceCheckId: protocolIdSchema,
  claim: z.strictObject({ ref: protocolIdSchema, digest: protocolDigestSchema }),
  artifactRefs: z.array(z.strictObject({ ref: protocolIdSchema, digest: protocolDigestSchema })).max(32),
  observedAt: iso8601Schema,
});
export const evidenceV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema, id: protocolIdSchema, ownerId: protocolIdSchema,
  revision: exactRevisionV04Schema, subject: acceptanceCheckSubjectV04Schema,
  acceptanceCheckId: protocolIdSchema, acceptanceCheckRevision: exactRevisionV04Schema,
  claimRef: protocolIdSchema, claimDigest: protocolDigestSchema,
  source: candidateEvidenceSubmissionV04Schema.shape.source,
  artifactRefs: candidateEvidenceSubmissionV04Schema.shape.artifactRefs,
  state: z.enum(['candidate', 'admitted', 'stale', 'invalidated']), admittedAt: iso8601Schema.nullable(),
});
export const verificationV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema, id: protocolIdSchema, ownerId: protocolIdSchema,
  revision: exactRevisionV04Schema, outcome: z.strictObject({ id: protocolIdSchema, revision: exactRevisionV04Schema }),
  acceptanceCheck: z.strictObject({ id: protocolIdSchema, revision: exactRevisionV04Schema, digest: protocolDigestSchema }),
  evidence: z.array(evidenceRefV04Schema).min(1).max(64), evidenceSetDigest: protocolDigestSchema,
  verifier: z.strictObject({
    id: protocolIdSchema,
    version: protocolNameSchema,
    availability: z.enum(['available', 'unavailable', 'unsupported']),
    independentFromProducer: z.boolean(),
    disclosureRef: protocolIdSchema,
  }),
  methodVersion: protocolNameSchema, state: z.enum(['pending', 'passed', 'failed', 'indeterminate', 'stale']),
  findingsRef: protocolIdSchema.nullable(), findingsDigest: protocolDigestSchema.nullable(), verifiedAt: iso8601Schema.nullable(),
}).superRefine((value, context) => {
  if ((value.findingsRef === null) !== (value.findingsDigest === null)) context.addIssue({ code: 'custom', path: ['findingsRef'], message: 'findings ref and digest must appear together' });
  if (value.state === 'pending' && value.verifiedAt !== null) context.addIssue({ code: 'custom', path: ['verifiedAt'], message: 'pending verification is not terminal' });
  if (value.verifier.availability !== 'available' && value.state !== 'indeterminate') {
    context.addIssue({ code: 'custom', path: ['state'], message: 'unavailable or unsupported verification must remain indeterminate' });
  }
});
export const acceptanceCommandRequestV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema, requestId: protocolIdSchema, commandType: z.literal('acceptance.record'),
  presenceRegistrationId: protocolIdSchema, aggregate: z.strictObject({ kind: z.literal('outcome'), id: protocolIdSchema, expectedRevision: exactRevisionV04Schema }),
  decision: z.enum(['accept', 'reopen', 'release']), evidenceSetDigest: protocolDigestSchema,
  verificationIds: z.array(protocolIdSchema).max(32), reasonRef: protocolIdSchema.nullable(), clientIssuedAt: iso8601Schema,
});
export const acceptanceV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema, id: protocolIdSchema, ownerId: protocolIdSchema,
  revision: exactRevisionV04Schema, outcome: z.strictObject({ id: protocolIdSchema, revision: exactRevisionV04Schema }),
  evidenceSetDigest: protocolDigestSchema, verificationIds: z.array(protocolIdSchema).max(32),
  actor: actorRefSchema, mode: z.enum(['explicit_owner', 'delegated_policy']),
  delegatedPolicyRevision: protocolRevisionSchema.nullable(), decision: z.enum(['accepted', 'reopened', 'released']),
  reasonRef: protocolIdSchema.nullable(), recordedAt: iso8601Schema,
});
