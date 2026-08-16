import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import {
  canonicalizeProtocolJson,
  protocolDigestSchema,
  protocolIdSchema,
  protocolNameSchema,
} from './responsibility-handshake-v0-1';
import { exactRevisionV04Schema } from './responsibility-protocol-v0-4';

export const protocolVersionV06Schema = z.literal('0.6');

export const closureRecordRefV06Schema = z.strictObject({
  id: protocolIdSchema,
  revision: exactRevisionV04Schema,
  digest: protocolDigestSchema,
});

const isStrictlyOrderedById = (values: ReadonlyArray<{ id: string }>): boolean =>
  values.every((value, index) => index === 0 || values[index - 1]!.id < value.id);

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export const evidenceSetV06Schema = z
  .array(closureRecordRefV06Schema)
  .min(1)
  .max(64)
  .refine(isStrictlyOrderedById, {
    error: 'Evidence references must be unique and strictly ordered by id',
  });

export function canonicalizeEvidenceSetV06ForDigest(value: unknown): string {
  return canonicalizeProtocolJson({
    algorithm: 'waldo-evidence-set-v1',
    evidence: evidenceSetV06Schema.parse(value),
  });
}

export const closureSubjectV06Schema = z.strictObject({
  outcome: closureRecordRefV06Schema,
  workUnit: closureRecordRefV06Schema.nullable(),
});

const verificationBaseV06Shape = {
  protocolVersion: protocolVersionV06Schema,
  id: protocolIdSchema,
  ownerId: protocolIdSchema,
  revision: exactRevisionV04Schema,
  subject: closureSubjectV06Schema,
  acceptanceCheck: closureRecordRefV06Schema,
  evidence: evidenceSetV06Schema,
  evidenceSetDigest: protocolDigestSchema,
  method: z.strictObject({
    kind: z.enum([
      'deterministic_read_back',
      'deterministic_artifact_check',
      'declared_semantic_check',
    ]),
    version: protocolNameSchema,
  }),
  findings: z.union([
    z.strictObject({ ref: protocolIdSchema, digest: protocolDigestSchema }),
    z.null(),
  ]),
} as const;

const availableVerifierV06Schema = z.strictObject({
  id: protocolIdSchema,
  version: protocolNameSchema,
  availability: z.literal('available'),
  independentFromProducer: z.boolean(),
  disclosure: z.strictObject({ ref: protocolIdSchema, digest: protocolDigestSchema }),
});

const independentVerifierV06Schema = availableVerifierV06Schema.extend({
  independentFromProducer: z.literal(true),
});

const unavailableVerifierV06Schema = z.strictObject({
  id: protocolIdSchema,
  version: protocolNameSchema,
  availability: z.enum(['unavailable', 'unsupported']),
  independentFromProducer: z.boolean(),
  disclosure: z.strictObject({ ref: protocolIdSchema, digest: protocolDigestSchema }),
});

export const verificationV06Schema = z.discriminatedUnion('state', [
  z.strictObject({
    ...verificationBaseV06Shape,
    verifier: availableVerifierV06Schema,
    state: z.literal('pending'),
    verifiedAt: z.null(),
  }),
  z.strictObject({
    ...verificationBaseV06Shape,
    verifier: independentVerifierV06Schema,
    state: z.literal('passed'),
    verifiedAt: iso8601Schema,
  }),
  z.strictObject({
    ...verificationBaseV06Shape,
    verifier: independentVerifierV06Schema,
    state: z.literal('failed'),
    verifiedAt: iso8601Schema,
  }),
  z.strictObject({
    ...verificationBaseV06Shape,
    verifier: z.union([availableVerifierV06Schema, unavailableVerifierV06Schema]),
    state: z.literal('indeterminate'),
    verifiedAt: iso8601Schema.nullable(),
  }),
  z.strictObject({
    ...verificationBaseV06Shape,
    verifier: availableVerifierV06Schema,
    state: z.literal('stale'),
    verifiedAt: iso8601Schema,
  }),
]);

export type VerificationV06 = z.infer<typeof verificationV06Schema>;

const closureCommandBaseV06Shape = {
  protocolVersion: protocolVersionV06Schema,
  requestId: protocolIdSchema,
  presenceRegistrationId: protocolIdSchema,
} as const;

const unsafePublicCommandKeysV06 = ['__proto__', 'prototype', 'constructor'] as const;

function containsEnumerableUnsafePublicCommandKeyV06(
  value: unknown,
  seen: WeakSet<object>,
): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  for (const key of unsafePublicCommandKeysV06) {
    if (Object.prototype.propertyIsEnumerable.call(value, key)) return true;
  }
  return Object.keys(value).some((key) =>
    containsEnumerableUnsafePublicCommandKeyV06(
      (value as Record<string, unknown>)[key],
      seen,
    ),
  );
}

function rejectEnumerableUnsafePublicCommandKeysV06(value: unknown): unknown {
  return containsEnumerableUnsafePublicCommandKeyV06(value, new WeakSet<object>())
    ? { rejectedUnsafePublicCommandKey: true }
    : value;
}

export const acceptanceCheckMethodProposalV06Schema = z.strictObject({
  kind: z.enum([
    'deterministic_read_back',
    'deterministic_artifact_check',
    'declared_semantic_check',
  ]),
  capability: protocolNameSchema,
});

export const closureTargetSelectorV06Schema = z.strictObject({
  kind: z.enum(['outcome', 'work_unit']),
  id: protocolIdSchema,
  expectedRevision: exactRevisionV04Schema,
});

export const acceptanceVerificationMethodV06Schema = z.strictObject({
  kind: acceptanceCheckMethodProposalV06Schema.shape.kind,
  capability: protocolNameSchema,
  version: protocolNameSchema,
  material: z.strictObject({ ref: protocolIdSchema, digest: protocolDigestSchema }),
});

export const acceptanceCriterionRefV06Schema = z.strictObject({
  ref: protocolIdSchema,
  revision: exactRevisionV04Schema,
  version: protocolNameSchema,
  digest: protocolDigestSchema,
});

export const acceptanceCheckV06Schema = z
  .strictObject({
    protocolVersion: protocolVersionV06Schema,
    id: protocolIdSchema,
    ownerId: protocolIdSchema,
    revision: exactRevisionV04Schema,
    digest: protocolDigestSchema,
    subject: closureSubjectV06Schema,
    criterion: acceptanceCriterionRefV06Schema,
    verificationMethod: acceptanceVerificationMethodV06Schema,
    state: z.enum(['active', 'superseded', 'withdrawn']),
    createdAt: iso8601Schema,
    updatedAt: iso8601Schema,
  })
  .superRefine((check, context) => {
    if (Date.parse(check.updatedAt) < Date.parse(check.createdAt)) {
      context.addIssue({
        code: 'custom',
        path: ['updatedAt'],
        message: 'AcceptanceCheck update cannot predate creation',
      });
    }
  });

export type AcceptanceCheckV06 = z.infer<typeof acceptanceCheckV06Schema>;

export function canonicalizeAcceptanceCheckV06ForDigest(value: unknown): string {
  const check = acceptanceCheckV06Schema.parse(value);
  const { digest: _digest, ...digestInput } = check;
  return canonicalizeProtocolJson(digestInput);
}

const acceptanceCheckDeclarationRequestV06StructuralSchema = z.strictObject({
  ...closureCommandBaseV06Shape,
  commandType: z.literal('acceptance_check.declare'),
  payload: z.strictObject({
    target: closureTargetSelectorV06Schema,
    criterion: acceptanceCriterionRefV06Schema,
    verificationMethod: acceptanceCheckMethodProposalV06Schema,
  }),
});

export const acceptanceCheckDeclarationRequestV06Schema = z.preprocess(
  rejectEnumerableUnsafePublicCommandKeysV06,
  acceptanceCheckDeclarationRequestV06StructuralSchema,
);

export type AcceptanceCheckDeclarationRequestV06 = z.infer<
  typeof acceptanceCheckDeclarationRequestV06Schema
>;

export const acceptanceCheckDeclarationResultV06Schema = z.strictObject({
  protocolVersion: protocolVersionV06Schema,
  requestId: protocolIdSchema,
  acceptanceCheck: closureRecordRefV06Schema,
  projectionCursor: exactRevisionV04Schema,
});

export const closureObservationRefV06Schema = z.strictObject({
  kind: z.enum([
    'provider_observation',
    'execution_observation',
    'effect_receipt',
    'person_statement',
  ]),
  id: protocolIdSchema,
  revision: exactRevisionV04Schema,
  digest: protocolDigestSchema,
});

const evidenceAdmissionRequestV06StructuralSchema = z.strictObject({
  ...closureCommandBaseV06Shape,
  commandType: z.literal('evidence.admit'),
  aggregate: z.strictObject({
    kind: z.literal('acceptance_check'),
    id: protocolIdSchema,
    expectedRevision: exactRevisionV04Schema,
  }),
  payload: z.strictObject({ observation: closureObservationRefV06Schema }),
});

export const evidenceAdmissionRequestV06Schema = z.preprocess(
  rejectEnumerableUnsafePublicCommandKeysV06,
  evidenceAdmissionRequestV06StructuralSchema,
);

export type EvidenceAdmissionRequestV06 = z.infer<typeof evidenceAdmissionRequestV06Schema>;

const evidenceProducerV06Schema = z.strictObject({
  kind: z.enum(['provider', 'execution_environment', 'effect_adapter', 'person']),
  id: protocolIdSchema,
  version: protocolNameSchema.nullable(),
});

const evidenceAdmitterV06Schema = z.strictObject({
  kind: z.enum(['owner', 'service']),
  id: protocolIdSchema,
});

const evidenceBaseV06Shape = {
  protocolVersion: protocolVersionV06Schema,
  id: protocolIdSchema,
  ownerId: protocolIdSchema,
  revision: exactRevisionV04Schema,
  subject: closureSubjectV06Schema,
  acceptanceCheck: closureRecordRefV06Schema,
  observation: closureObservationRefV06Schema,
  provenance: z.strictObject({
    producer: evidenceProducerV06Schema,
    admittedBy: evidenceAdmitterV06Schema,
  }),
  observedAt: iso8601Schema,
} as const;

const producerKindByObservationKindV06 = {
  provider_observation: 'provider',
  execution_observation: 'execution_environment',
  effect_receipt: 'effect_adapter',
  person_statement: 'person',
} as const;

export const evidenceV06Schema = z.discriminatedUnion('state', [
  z.strictObject({
    ...evidenceBaseV06Shape,
    state: z.literal('admitted'),
    admittedAt: iso8601Schema,
  }),
  z.strictObject({
    ...evidenceBaseV06Shape,
    state: z.enum(['stale', 'invalidated']),
    admittedAt: iso8601Schema,
  }),
]).superRefine((evidence, context) => {
  if (Date.parse(evidence.admittedAt) < Date.parse(evidence.observedAt)) {
    context.addIssue({
      code: 'custom',
      path: ['admittedAt'],
      message: 'Evidence admission cannot predate its canonical observation',
    });
  }
  if (
    evidence.provenance.producer.kind !==
    producerKindByObservationKindV06[evidence.observation.kind]
  ) {
    context.addIssue({
      code: 'custom',
      path: ['provenance', 'producer', 'kind'],
      message: 'Evidence producer kind must match its canonical observation category',
    });
  }
  if (
    evidence.provenance.producer.kind === 'person' &&
    evidence.provenance.producer.id !== evidence.ownerId
  ) {
    context.addIssue({
      code: 'custom',
      path: ['provenance', 'producer', 'id'],
      message: 'Person-produced Evidence must identify the exact owner',
    });
  }
  if (
    evidence.provenance.admittedBy.kind === 'owner' &&
    evidence.provenance.admittedBy.id !== evidence.ownerId
  ) {
    context.addIssue({
      code: 'custom',
      path: ['provenance', 'admittedBy', 'id'],
      message: 'Owner-admitted Evidence must identify the exact owner',
    });
  }
});

export type EvidenceV06 = z.infer<typeof evidenceV06Schema>;

export const evidenceAdmissionResultV06Schema = z.strictObject({
  protocolVersion: protocolVersionV06Schema,
  requestId: protocolIdSchema,
  evidence: closureRecordRefV06Schema,
  state: z.enum(['admitted', 'stale', 'invalidated']),
  projectionCursor: exactRevisionV04Schema,
});

const verificationRequestV06StructuralSchema = z.strictObject({
  ...closureCommandBaseV06Shape,
  commandType: z.literal('verification.request'),
  aggregate: z.strictObject({
    kind: z.literal('acceptance_check'),
    id: protocolIdSchema,
    expectedRevision: exactRevisionV04Schema,
  }),
  payload: z.strictObject({ evidence: evidenceSetV06Schema }),
});

export const verificationRequestV06Schema = z.preprocess(
  rejectEnumerableUnsafePublicCommandKeysV06,
  verificationRequestV06StructuralSchema,
);

export type VerificationRequestV06 = z.infer<typeof verificationRequestV06Schema>;

export const verificationResultV06Schema = z.strictObject({
  protocolVersion: protocolVersionV06Schema,
  requestId: protocolIdSchema,
  verification: closureRecordRefV06Schema,
  state: z.enum(['pending', 'passed', 'failed', 'indeterminate', 'stale']),
  projectionCursor: exactRevisionV04Schema,
});

export const closureCommandRetrySemanticsV06 = Object.freeze({
  identity: 'requestId',
  exactDuplicate: 'return_persisted_result_byte_for_byte',
  changedDuplicate: 'reject_request_conflict',
} as const);

export const verificationReferenceSetV06Schema = z
  .array(closureRecordRefV06Schema)
  .max(32)
  .refine(isStrictlyOrderedById, {
    error: 'Verification references must be unique and strictly ordered by id',
  });

export const nonEmptyVerificationReferenceSetV06Schema = z
  .array(closureRecordRefV06Schema)
  .min(1)
  .max(32)
  .refine(isStrictlyOrderedById, {
    error: 'Verification references must be unique and strictly ordered by id',
  });

const acceptanceRecordRequestV06StructuralSchema = z.strictObject({
  protocolVersion: protocolVersionV06Schema,
  requestId: protocolIdSchema,
  commandType: z.literal('acceptance.record'),
  presenceRegistrationId: protocolIdSchema,
  aggregate: z.strictObject({
    kind: z.literal('outcome'),
    id: protocolIdSchema,
    expectedRevision: exactRevisionV04Schema,
  }),
  payload: z.discriminatedUnion('decision', [
    z.strictObject({
      decision: z.literal('accept'),
      verifications: nonEmptyVerificationReferenceSetV06Schema,
      reasonRef: protocolIdSchema.nullable(),
    }),
    z.strictObject({
      decision: z.literal('release'),
      verifications: verificationReferenceSetV06Schema,
      reasonRef: protocolIdSchema,
    }),
  ]),
});

export const acceptanceRecordRequestV06Schema = z.preprocess(
  rejectEnumerableUnsafePublicCommandKeysV06,
  acceptanceRecordRequestV06StructuralSchema,
);

export type AcceptanceRecordRequestV06 = z.infer<typeof acceptanceRecordRequestV06Schema>;

export const acceptanceRecordResultV06Schema = z.strictObject({
  protocolVersion: protocolVersionV06Schema,
  requestId: protocolIdSchema,
  acceptance: closureRecordRefV06Schema,
  decision: z.enum(['accepted', 'released']),
  projectionCursor: exactRevisionV04Schema,
});

export const activeAcceptanceCheckSetSummaryV06Schema = z.strictObject({
  revision: exactRevisionV04Schema,
  count: z.int().min(1).max(32),
  digest: protocolDigestSchema,
});

export const currentEvidenceSetSummaryV06Schema = z.strictObject({
  acceptanceCheck: closureRecordRefV06Schema,
  revision: exactRevisionV04Schema,
  count: z.int().min(1).max(64),
  evidenceSetDigest: protocolDigestSchema,
  digest: protocolDigestSchema,
});

const currentEvidenceSetSummariesV06Schema = z
  .array(currentEvidenceSetSummaryV06Schema)
  .min(1)
  .max(32)
  .refine(
    (values) =>
      values.every(
        (value, index) =>
          index === 0 ||
          values[index - 1]!.acceptanceCheck.id < value.acceptanceCheck.id,
      ),
    { error: 'Evidence-set summaries must be unique and ordered by AcceptanceCheck id' },
  );

const acceptanceBaseV06Shape = {
  protocolVersion: protocolVersionV06Schema,
  id: protocolIdSchema,
  ownerId: protocolIdSchema,
  revision: exactRevisionV04Schema,
  subject: closureSubjectV06Schema,
  actor: z.strictObject({ kind: z.literal('owner'), id: protocolIdSchema }),
  mode: z.literal('explicit_owner'),
  recordedAt: iso8601Schema,
} as const;

export const acceptedAcceptanceV06Schema = z
  .strictObject({
    ...acceptanceBaseV06Shape,
    activeAcceptanceChecks: activeAcceptanceCheckSetSummaryV06Schema,
    evidenceSets: currentEvidenceSetSummariesV06Schema,
    verifications: nonEmptyVerificationReferenceSetV06Schema,
    decision: z.literal('accepted'),
    reasonRef: protocolIdSchema.nullable(),
  })
  .superRefine((acceptance, context) => {
    if (acceptance.actor.id !== acceptance.ownerId) {
      context.addIssue({
        code: 'custom',
        path: ['actor', 'id'],
        message: 'Acceptance actor must match its authenticated owner',
      });
    }
  });

export const releasedAcceptanceV06Schema = z
  .strictObject({
    ...acceptanceBaseV06Shape,
    verifications: verificationReferenceSetV06Schema,
    decision: z.literal('released'),
    reasonRef: protocolIdSchema,
  })
  .superRefine((acceptance, context) => {
    if (acceptance.actor.id !== acceptance.ownerId) {
      context.addIssue({
        code: 'custom',
        path: ['actor', 'id'],
        message: 'Release actor must match its authenticated owner',
      });
    }
  });

export const acceptanceV06Schema = z.union([
  acceptedAcceptanceV06Schema,
  releasedAcceptanceV06Schema,
]);

export type AcceptanceV06 = z.infer<typeof acceptanceV06Schema>;

const sameProtocolValue = (left: unknown, right: unknown): boolean =>
  canonicalizeProtocolJson(left) === canonicalizeProtocolJson(right);

const activeAcceptanceCheckRefsV06Schema = z
  .array(closureRecordRefV06Schema)
  .min(1)
  .max(32)
  .refine(isStrictlyOrderedById, {
    error: 'AcceptanceCheck references must be unique and strictly ordered by id',
  });

export const activeAcceptanceCheckSetV06Schema = z
  .strictObject({
    protocolVersion: protocolVersionV06Schema,
    ownerId: protocolIdSchema,
    subject: closureSubjectV06Schema,
    revision: exactRevisionV04Schema,
    count: z.int().min(1).max(32),
    digest: protocolDigestSchema,
    acceptanceChecks: activeAcceptanceCheckRefsV06Schema,
    records: z
      .array(acceptanceCheckV06Schema)
      .min(1)
      .max(32)
      .refine(isStrictlyOrderedById, {
        error: 'AcceptanceCheck records must be unique and strictly ordered by id',
      }),
  })
  .superRefine((set, context) => {
    const issue = (path: PropertyKey[], message: string) =>
      context.addIssue({ code: 'custom', path, message });
    if (set.count !== set.acceptanceChecks.length || set.count !== set.records.length) {
      issue(['count'], 'active AcceptanceCheck count must match exact references and records');
    }
    for (const [index, record] of set.records.entries()) {
      const reference = set.acceptanceChecks[index];
      if (
        reference === undefined ||
        reference.id !== record.id ||
        reference.revision !== record.revision ||
        reference.digest !== record.digest
      ) {
        issue(
          ['records', index],
          'active AcceptanceCheck record must match its exact ordered reference',
        );
      }
      if (
        record.state !== 'active' ||
        record.ownerId !== set.ownerId ||
        !sameProtocolValue(record.subject, set.subject)
      ) {
        issue(
          ['records', index],
          'active AcceptanceCheck record must match exact owner, subject, and active state',
        );
      }
    }
  });

export type ActiveAcceptanceCheckSetV06 = z.infer<
  typeof activeAcceptanceCheckSetV06Schema
>;

export function canonicalizeActiveAcceptanceCheckSetV06ForDigest(value: unknown): string {
  const set = activeAcceptanceCheckSetV06Schema.parse(value);
  const { digest: _digest, ...digestInput } = set;
  return canonicalizeProtocolJson(digestInput);
}

export const currentEvidenceSetEnvelopeV06Schema = z
  .strictObject({
    protocolVersion: protocolVersionV06Schema,
    ownerId: protocolIdSchema,
    subject: closureSubjectV06Schema,
    acceptanceCheck: closureRecordRefV06Schema,
    revision: exactRevisionV04Schema,
    count: z.int().min(1).max(64),
    evidenceSetDigest: protocolDigestSchema,
    digest: protocolDigestSchema,
    evidence: evidenceSetV06Schema,
    records: z
      .array(evidenceV06Schema)
      .min(1)
      .max(64)
      .refine(isStrictlyOrderedById, {
        error: 'Evidence records must be unique and strictly ordered by id',
      }),
  })
  .superRefine((set, context) => {
    const issue = (path: PropertyKey[], message: string) =>
      context.addIssue({ code: 'custom', path, message });
    if (set.count !== set.evidence.length || set.count !== set.records.length) {
      issue(['count'], 'current Evidence count must match exact references and records');
    }
    for (const [index, record] of set.records.entries()) {
      const reference = set.evidence[index];
      if (
        reference === undefined ||
        reference.id !== record.id ||
        reference.revision !== record.revision
      ) {
        issue(['records', index], 'current Evidence record must match its exact ordered reference');
      }
      if (
        record.state !== 'admitted' ||
        record.ownerId !== set.ownerId ||
        !sameProtocolValue(record.subject, set.subject) ||
        !sameProtocolValue(record.acceptanceCheck, set.acceptanceCheck)
      ) {
        issue(
          ['records', index],
          'current Evidence must be admitted and match exact owner, subject, and AcceptanceCheck',
        );
      }
    }
  });

export type CurrentEvidenceSetEnvelopeV06 = z.infer<
  typeof currentEvidenceSetEnvelopeV06Schema
>;

export function canonicalizeCurrentEvidenceSetEnvelopeV06ForDigest(value: unknown): string {
  const set = currentEvidenceSetEnvelopeV06Schema.parse(value);
  const { digest: _digest, ...digestInput } = set;
  return canonicalizeProtocolJson(digestInput);
}

export const closureVerifierIndependenceRuleV06 = Object.freeze({
  version: 'verifier-producer-identity-v1',
  requirement: 'verifier_id_must_differ_from_every_evidence_producer_id',
} as const);

const currentEvidenceSetEnvelopesV06Schema = z
  .array(currentEvidenceSetEnvelopeV06Schema)
  .min(1)
  .max(32)
  .refine(
    (values) =>
      values.every(
        (value, index) =>
          index === 0 ||
          values[index - 1]!.acceptanceCheck.id < value.acceptanceCheck.id,
      ),
    { error: 'Evidence-set envelopes must be unique and ordered by AcceptanceCheck id' },
  );

export const verifiedAcceptanceBindingV06Schema = z
  .strictObject({
    acceptance: acceptedAcceptanceV06Schema,
    activeAcceptanceChecks: activeAcceptanceCheckSetV06Schema,
    evidenceSets: currentEvidenceSetEnvelopesV06Schema,
    verifications: z
      .array(verificationV06Schema)
      .min(1)
      .max(32)
      .refine(isStrictlyOrderedById, {
        error: 'Verifications must be unique and strictly ordered by id',
      }),
  })
  .superRefine((binding, context) => {
    const issue = (path: PropertyKey[], message: string) =>
      context.addIssue({ code: 'custom', path, message });
    const { acceptance } = binding;
    const acceptanceChecks = binding.activeAcceptanceChecks.records;
    const evidenceSets = new Map(
      binding.evidenceSets.map((set) => [set.acceptanceCheck.id, set]),
    );
    const acceptanceVerificationRefs = new Map(
      acceptance.verifications.map((reference) => [reference.id, reference]),
    );
    if (
      binding.verifications.length !== acceptanceVerificationRefs.size ||
      acceptanceChecks.length !== binding.verifications.length ||
      binding.evidenceSets.length !== binding.verifications.length ||
      acceptance.evidenceSets.length !== binding.verifications.length
    ) {
      issue(
        ['verifications'],
        'accepted closure requires one current passed Verification per active AcceptanceCheck',
      );
    }
    if (
      binding.activeAcceptanceChecks.ownerId !== acceptance.ownerId ||
      !sameProtocolValue(binding.activeAcceptanceChecks.subject, acceptance.subject)
    ) {
      issue(
        ['activeAcceptanceChecks'],
        'active AcceptanceCheck set must bind the exact accepted owner and subject',
      );
    }
    if (
      acceptance.activeAcceptanceChecks.revision !== binding.activeAcceptanceChecks.revision ||
      acceptance.activeAcceptanceChecks.count !== binding.activeAcceptanceChecks.count ||
      acceptance.activeAcceptanceChecks.digest !== binding.activeAcceptanceChecks.digest
    ) {
      issue(
        ['acceptance', 'activeAcceptanceChecks'],
        'Acceptance must bind the exact server-derived active AcceptanceCheck set',
      );
    }
    for (const [index, check] of acceptanceChecks.entries()) {
      if (
        check.ownerId !== acceptance.ownerId ||
        check.state !== 'active' ||
        !sameProtocolValue(check.subject, acceptance.subject)
      ) {
        issue(
          ['acceptanceChecks', index],
          'AcceptanceCheck must be active and bind the exact accepted owner and subject',
        );
      }
    }
    const seenCheckIds = new Set<string>();
    for (const [index, verification] of binding.verifications.entries()) {
      const expectedRef = acceptanceVerificationRefs.get(verification.id);
      if (
        expectedRef === undefined ||
        expectedRef.revision !== verification.revision ||
        verification.state !== 'passed'
      ) {
        issue(
          ['verifications', index],
          'Acceptance must reference the exact current passed Verification',
        );
      }
      if (
        verification.ownerId !== acceptance.ownerId ||
        !sameProtocolValue(verification.subject, acceptance.subject)
      ) {
        issue(
          ['verifications', index],
          'Verification must bind the exact accepted owner and subject',
        );
      }
      const check = acceptanceChecks.find(
        (candidate) => candidate.id === verification.acceptanceCheck.id,
      );
      const evidenceSet = evidenceSets.get(verification.acceptanceCheck.id);
      const evidenceSetSummary = acceptance.evidenceSets.find(
        (summary) => summary.acceptanceCheck.id === verification.acceptanceCheck.id,
      );
      if (
        check === undefined ||
        check.revision !== verification.acceptanceCheck.revision ||
        check.digest !== verification.acceptanceCheck.digest ||
        seenCheckIds.has(verification.acceptanceCheck.id)
      ) {
        issue(
          ['verifications', index, 'acceptanceCheck'],
          'Verification must cover one exact current AcceptanceCheck exactly once',
        );
      }
      if (
        check !== undefined &&
        (verification.method.kind !== check.verificationMethod.kind ||
          verification.method.version !== check.verificationMethod.version)
      ) {
        issue(
          ['verifications', index, 'method'],
          'Verification method and version must match the exact current AcceptanceCheck',
        );
      }
      if (
        evidenceSet === undefined ||
        evidenceSet.evidenceSetDigest !== verification.evidenceSetDigest ||
        !sameProtocolValue(evidenceSet.evidence, verification.evidence)
      ) {
        issue(
          ['evidenceSets'],
          'Verification must bind one exact current Evidence-set envelope for its AcceptanceCheck',
        );
      }
      if (
        evidenceSet !== undefined &&
        evidenceSet.records.some(
          (evidence) => evidence.provenance.producer.id === verification.verifier.id,
        )
      ) {
        issue(
          ['verifications', index, 'verifier', 'id'],
          'passed verifier identity must differ from every exact Evidence producer identity',
        );
      }
      if (
        evidenceSet === undefined ||
        evidenceSetSummary === undefined ||
        evidenceSetSummary.acceptanceCheck.revision !== evidenceSet.acceptanceCheck.revision ||
        evidenceSetSummary.acceptanceCheck.digest !== evidenceSet.acceptanceCheck.digest ||
        evidenceSetSummary.revision !== evidenceSet.revision ||
        evidenceSetSummary.count !== evidenceSet.count ||
        evidenceSetSummary.evidenceSetDigest !== evidenceSet.evidenceSetDigest ||
        evidenceSetSummary.digest !== evidenceSet.digest
      ) {
        issue(
          ['acceptance', 'evidenceSets'],
          'Acceptance must bind every exact server-derived current Evidence-set envelope',
        );
      }
      seenCheckIds.add(verification.acceptanceCheck.id);
    }
  });

export type VerifiedAcceptanceBindingV06 = z.infer<typeof verifiedAcceptanceBindingV06Schema>;

export const CLOSURE_EVENT_SCHEMA_VERSION_V06 = '0.6' as const;

const eventTypesByAggregateV06 = {
  acceptance_check: ['acceptance_check.declared'],
  evidence: ['evidence.admitted', 'evidence.invalidated'],
  verification: ['verification.recorded'],
  acceptance: ['acceptance.recorded', 'release.recorded'],
} as const;

export const closureDomainEventV06Schema = z
  .strictObject({
    schemaVersion: z.literal(CLOSURE_EVENT_SCHEMA_VERSION_V06),
    eventId: protocolIdSchema,
    ownerId: protocolIdSchema,
    aggregate: z.strictObject({
      kind: z.enum(['acceptance_check', 'evidence', 'verification', 'acceptance']),
      id: protocolIdSchema,
      revision: exactRevisionV04Schema,
    }),
    eventType: z.enum([
      'acceptance_check.declared',
      'evidence.admitted',
      'evidence.invalidated',
      'verification.recorded',
      'acceptance.recorded',
      'release.recorded',
    ]),
    payloadDigest: protocolDigestSchema,
    cursor: exactRevisionV04Schema,
    occurredAt: iso8601Schema,
  })
  .superRefine((event, context) => {
    const allowed = eventTypesByAggregateV06[event.aggregate.kind] as readonly string[];
    if (!allowed.includes(event.eventType)) {
      context.addIssue({
        code: 'custom',
        path: ['eventType'],
        message: 'closure event type must match its aggregate writer namespace',
      });
    }
  });

export const closureProjectionQueryV06Schema = z.strictObject({
  protocolVersion: protocolVersionV06Schema,
  fromExclusiveCursor: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  limit: z.int().min(1).max(256),
  snapshotId: protocolIdSchema.optional(),
});

export const closureProjectionItemV06Schema = z.discriminatedUnion('itemType', [
  z.strictObject({
    cursor: exactRevisionV04Schema,
    itemType: z.literal('acceptance_check'),
    record: acceptanceCheckV06Schema,
    recordDigest: protocolDigestSchema,
  }),
  z.strictObject({
    cursor: exactRevisionV04Schema,
    itemType: z.literal('evidence'),
    record: evidenceV06Schema,
    recordDigest: protocolDigestSchema,
  }),
  z.strictObject({
    cursor: exactRevisionV04Schema,
    itemType: z.literal('verification'),
    record: verificationV06Schema,
    recordDigest: protocolDigestSchema,
  }),
  z.strictObject({
    cursor: exactRevisionV04Schema,
    itemType: z.literal('acceptance'),
    record: acceptanceV06Schema,
    recordDigest: protocolDigestSchema,
  }),
]);

export const MAX_CLOSURE_PROJECTION_PAGE_UTF8_BYTES_V06 = 262_144;

const closureProjectionPageStructuralV06Schema = z.strictObject({
    protocolVersion: protocolVersionV06Schema,
    ownerId: protocolIdSchema,
    projectionName: z.literal('responsibility.closure'),
    snapshotId: protocolIdSchema,
    snapshotBaseCursor: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
    fromExclusiveCursor: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
    highWaterCursor: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
    nextCursor: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
    items: z.array(closureProjectionItemV06Schema).max(256),
    hasMore: z.boolean(),
    generatedAt: iso8601Schema,
    pageDigest: protocolDigestSchema,
  });

export const closureProjectionPageV06Schema = closureProjectionPageStructuralV06Schema
  .superRefine((page, context) => {
    const issue = (path: PropertyKey[], message: string) =>
      context.addIssue({ code: 'custom', path, message });
    if (page.snapshotBaseCursor > page.fromExclusiveCursor) {
      issue(['snapshotBaseCursor'], 'snapshot base cursor must not exceed requested cursor');
    }
    let cursor = page.fromExclusiveCursor;
    for (const [index, item] of page.items.entries()) {
      if (item.cursor <= cursor || item.cursor > page.nextCursor) {
        issue(['items', index, 'cursor'], 'projection items must be strictly ordered');
      }
      if (item.record.ownerId !== page.ownerId) {
        issue(['items', index, 'record', 'ownerId'], 'projection item must belong to page owner');
      }
      cursor = item.cursor;
    }
    if (
      page.nextCursor < page.fromExclusiveCursor ||
      page.nextCursor > page.highWaterCursor ||
      page.hasMore !== (page.nextCursor < page.highWaterCursor) ||
      (page.nextCursor === page.fromExclusiveCursor && page.highWaterCursor > page.fromExclusiveCursor) ||
      (page.items.length === 0 && page.nextCursor !== page.fromExclusiveCursor) ||
      (page.items.length > 0 && page.items.at(-1)!.cursor !== page.nextCursor)
    ) {
      issue(['nextCursor'], 'projection cursor envelope is inconsistent');
    }
    if (utf8ByteLength(JSON.stringify(page)) > MAX_CLOSURE_PROJECTION_PAGE_UTF8_BYTES_V06) {
      issue([], 'closure projection page exceeds byte limit');
    }
  });

export type ClosureProjectionPageV06 = z.infer<typeof closureProjectionPageV06Schema>;

export type ClosureSha256HexV06 = (canonicalUtf8: string) => string;

function assertTrustedSha256HexV06(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError('trusted SHA-256 implementation must return 64 lowercase hex characters');
  }
}

function digestCanonicalUtf8V06(
  canonicalUtf8: string,
  sha256Hex: ClosureSha256HexV06,
): string {
  const digest = sha256Hex(canonicalUtf8);
  assertTrustedSha256HexV06(digest);
  return `sha256:${digest}`;
}

function digestCanonicalValueV06(value: unknown, sha256Hex: ClosureSha256HexV06): string {
  return digestCanonicalUtf8V06(canonicalizeProtocolJson(value), sha256Hex);
}

export function createEvidenceSetDigestV06(
  sha256Hex: ClosureSha256HexV06,
): (value: unknown) => string {
  return (value) =>
    digestCanonicalUtf8V06(canonicalizeEvidenceSetV06ForDigest(value), sha256Hex);
}

export class VerifiedAcceptanceDigestMismatchErrorV06 extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerifiedAcceptanceDigestMismatchErrorV06';
  }
}

export function createVerifiedAcceptanceBindingVerifierV06(
  sha256Hex: ClosureSha256HexV06,
): (value: unknown) => VerifiedAcceptanceBindingV06 {
  return (value) => {
    const binding = verifiedAcceptanceBindingV06Schema.parse(value);
    const checks = new Map(
      binding.activeAcceptanceChecks.records.map((check) => [check.id, check]),
    );
    const verificationRefs = new Map(
      binding.acceptance.verifications.map((reference) => [reference.id, reference]),
    );
    if (
      binding.activeAcceptanceChecks.digest !==
      digestCanonicalUtf8V06(
        canonicalizeActiveAcceptanceCheckSetV06ForDigest(
          binding.activeAcceptanceChecks,
        ),
        sha256Hex,
      )
    ) {
      throw new VerifiedAcceptanceDigestMismatchErrorV06(
        'active AcceptanceCheck set digest must match its canonical exact envelope',
      );
    }
    for (const check of binding.activeAcceptanceChecks.records) {
      const digest = sha256Hex(canonicalizeAcceptanceCheckV06ForDigest(check));
      assertTrustedSha256HexV06(digest);
      if (check.digest !== `sha256:${digest}`) {
        throw new VerifiedAcceptanceDigestMismatchErrorV06(
          'AcceptanceCheck digest must match its canonical current record',
        );
      }
    }
    for (const evidenceSet of binding.evidenceSets) {
      if (
        evidenceSet.evidenceSetDigest !==
        createEvidenceSetDigestV06(sha256Hex)(evidenceSet.evidence)
      ) {
        throw new VerifiedAcceptanceDigestMismatchErrorV06(
          'current Evidence-set digest must match its canonical ordered references',
        );
      }
      if (
        evidenceSet.digest !==
        digestCanonicalUtf8V06(
          canonicalizeCurrentEvidenceSetEnvelopeV06ForDigest(evidenceSet),
          sha256Hex,
        )
      ) {
        throw new VerifiedAcceptanceDigestMismatchErrorV06(
          'current Evidence-set envelope digest must match its canonical exact records',
        );
      }
      for (const [index, evidence] of evidenceSet.records.entries()) {
        if (
          evidenceSet.evidence[index]?.digest !==
          digestCanonicalValueV06(evidence, sha256Hex)
        ) {
          throw new VerifiedAcceptanceDigestMismatchErrorV06(
            'Evidence reference digest must match its canonical current admitted record',
          );
        }
      }
    }
    for (const verification of binding.verifications) {
      if (
        verification.evidenceSetDigest !==
        createEvidenceSetDigestV06(sha256Hex)(verification.evidence)
      ) {
        throw new VerifiedAcceptanceDigestMismatchErrorV06(
          'Verification evidenceSetDigest must match its canonical ordered Evidence set',
        );
      }
      const check = checks.get(verification.acceptanceCheck.id);
      if (check === undefined || verification.acceptanceCheck.digest !== check.digest) {
        throw new VerifiedAcceptanceDigestMismatchErrorV06(
          'Verification AcceptanceCheck digest must match the canonical current check',
        );
      }
      const reference = verificationRefs.get(verification.id);
      if (
        reference === undefined ||
        reference.digest !== digestCanonicalValueV06(verification, sha256Hex)
      ) {
        throw new VerifiedAcceptanceDigestMismatchErrorV06(
          'Acceptance Verification digest must match its canonical passed record',
        );
      }
    }
    return binding;
  };
}

export class ClosureProjectionDigestMismatchErrorV06 extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClosureProjectionDigestMismatchErrorV06';
  }
}

export function canonicalizeClosureProjectionPageV06ForDigest(value: unknown): string {
  const page = closureProjectionPageV06Schema.parse(value);
  const { pageDigest: _pageDigest, ...digestInput } = page;
  return canonicalizeProtocolJson(digestInput);
}

export function createClosureProjectionPageVerifierV06(
  sha256Hex: ClosureSha256HexV06,
): (value: unknown) => ClosureProjectionPageV06 {
  return (value) => {
    const page = closureProjectionPageV06Schema.parse(value);
    for (const item of page.items) {
      if (item.recordDigest !== digestCanonicalValueV06(item.record, sha256Hex)) {
        throw new ClosureProjectionDigestMismatchErrorV06(
          'recordDigest must match the canonical embedded closure record',
        );
      }
    }
    if (
      page.pageDigest !==
      digestCanonicalUtf8V06(canonicalizeClosureProjectionPageV06ForDigest(page), sha256Hex)
    ) {
      throw new ClosureProjectionDigestMismatchErrorV06(
        'pageDigest must match the canonical closure projection page',
      );
    }
    return page;
  };
}
