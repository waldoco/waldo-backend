import { z } from 'zod';
import {
  acceptanceCheckDeclarationRequestV06Schema,
  acceptanceCheckDeclarationResultV06Schema,
  acceptanceCheckV06Schema,
  acceptanceRecordRequestV06Schema,
  acceptanceRecordResultV06Schema,
  acceptanceV06Schema,
  canonicalizeActiveAcceptanceCheckSetV06ForDigest,
  canonicalizeAcceptanceCheckV06ForDigest,
  canonicalizeClosureProjectionPageV06ForDigest,
  canonicalizeCurrentEvidenceSetEnvelopeV06ForDigest,
  closureCommandRetrySemanticsV06,
  closureDomainEventV06Schema,
  closureProjectionPageV06Schema,
  closureProjectionQueryV06Schema,
  closureVerifierIndependenceRuleV06,
  createEvidenceSetDigestV06,
  currentEvidenceSetEnvelopeV06Schema,
  evidenceAdmissionRequestV06Schema,
  evidenceAdmissionResultV06Schema,
  evidenceV06Schema,
  verificationRequestV06Schema,
  verificationResultV06Schema,
  verificationV06Schema,
  verifiedAcceptanceBindingV06Schema,
  activeAcceptanceCheckSetV06Schema,
  type ClosureSha256HexV06,
} from './responsibility-closure-v0-6';
import { canonicalizeProtocolJson } from './responsibility-handshake-v0-1';
import { addResponsibilityClosureUniqueItemsV06 } from './responsibility-closure-v0-6-json-schema';

const file = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function schema(value: z.ZodType, name: string): object {
  const generated = addResponsibilityClosureUniqueItemsV06(z.toJSONSchema(value, {
    target: 'draft-2020-12',
    io: 'input',
    reused: 'ref',
  }) as Record<string, unknown>);
  return {
    ...generated,
    $id: `urn:waldo:protocol:responsibility-closure:0.6:${name}`,
    'x-waldo-validation-level': 'structural-plus-runtime-invariants',
    'x-waldo-offline-commands': 'none',
  };
}

const rejectionSchemaNamesV06 = [
  'acceptance-check-declaration-request.schema.json',
  'evidence-admission-request.schema.json',
  'evidence.schema.json',
  'verification-request.schema.json',
  'verification.schema.json',
  'acceptance-record-request.schema.json',
  'acceptance.schema.json',
  'verified-acceptance-binding.schema.json',
  'closure-projection-page.schema.json',
] as const;

export const responsibilityClosureRejectionCatalogueV06Schema = z.strictObject({
  protocolVersion: z.literal('0.6'),
  cases: z.array(z.strictObject({
    name: z.string().min(1),
    schema: z.enum(rejectionSchemaNamesV06),
    layer: z.enum(['structural', 'runtime']),
    zodOutcome: z.enum(['accept', 'reject']),
    value: z.unknown(),
  })),
});

export function buildResponsibilityClosureV06Bundle(
  hashHex: ClosureSha256HexV06,
  sourceSha256: string,
): Record<string, string> {
  const digest = (value: unknown): string =>
    `sha256:${hashHex(canonicalizeProtocolJson(value))}`;
  const fixtureDigest = `sha256:${hashHex('responsibility-closure-v0.6-fixture')}`;
  const subject = {
    outcome: { id: 'outcome_fixture', revision: 3, digest: fixtureDigest },
    workUnit: { id: 'work_fixture', revision: 2, digest: fixtureDigest },
  } as const;

  const declarationRequest = acceptanceCheckDeclarationRequestV06Schema.parse({
    protocolVersion: '0.6',
    requestId: 'check_declaration_request_fixture',
    commandType: 'acceptance_check.declare',
    presenceRegistrationId: 'presence_fixture',
    payload: {
      target: { kind: 'work_unit', id: 'work_fixture', expectedRevision: 2 },
      criterion: {
        ref: 'criterion_fixture',
        revision: 1,
        version: '1.0.0',
        digest: fixtureDigest,
      },
      verificationMethod: { kind: 'deterministic_read_back', capability: 'calendar.read' },
    },
  });
  const checkWithoutDigest = {
    protocolVersion: '0.6',
    id: 'check_fixture',
    ownerId: 'owner_fixture',
    revision: 1,
    digest: fixtureDigest,
    subject,
    criterion: declarationRequest.payload.criterion,
    verificationMethod: {
      kind: 'deterministic_read_back',
      capability: 'calendar.read',
      version: '1.0.0',
      material: { ref: 'calendar_state_fixture', digest: fixtureDigest },
    },
    state: 'active',
    createdAt: '2026-08-16T12:00:01.000Z',
    updatedAt: '2026-08-16T12:00:01.000Z',
  } as const;
  const check = acceptanceCheckV06Schema.parse({
    ...checkWithoutDigest,
    digest: `sha256:${hashHex(canonicalizeAcceptanceCheckV06ForDigest(checkWithoutDigest))}`,
  });
  const checkRef = { id: check.id, revision: check.revision, digest: check.digest };
  const activeCheckSetWithoutDigest = {
    protocolVersion: '0.6',
    ownerId: 'owner_fixture',
    subject,
    revision: 1,
    count: 1,
    digest: fixtureDigest,
    acceptanceChecks: [checkRef],
    records: [check],
  } as const;
  const activeCheckSet = activeAcceptanceCheckSetV06Schema.parse({
    ...activeCheckSetWithoutDigest,
    digest: `sha256:${hashHex(
      canonicalizeActiveAcceptanceCheckSetV06ForDigest(activeCheckSetWithoutDigest),
    )}`,
  });
  const declarationResult = acceptanceCheckDeclarationResultV06Schema.parse({
    protocolVersion: '0.6',
    requestId: declarationRequest.requestId,
    acceptanceCheck: checkRef,
    projectionCursor: 1,
  });

  const evidenceRequest = evidenceAdmissionRequestV06Schema.parse({
    protocolVersion: '0.6',
    requestId: 'evidence_request_fixture',
    commandType: 'evidence.admit',
    presenceRegistrationId: 'presence_fixture',
    aggregate: { kind: 'acceptance_check', id: check.id, expectedRevision: check.revision },
    payload: {
      observation: {
        kind: 'execution_observation',
        id: 'observation_fixture',
        revision: 4,
        digest: fixtureDigest,
      },
    },
  });
  const evidence = evidenceV06Schema.parse({
    protocolVersion: '0.6',
    id: 'evidence_fixture',
    ownerId: 'owner_fixture',
    revision: 1,
    subject,
    acceptanceCheck: checkRef,
    observation: evidenceRequest.payload.observation,
    provenance: {
      producer: { kind: 'execution_environment', id: 'kennel_fixture', version: '1.0.0' },
      admittedBy: { kind: 'service', id: 'evidence_verifier_fixture' },
    },
    state: 'admitted',
    observedAt: '2026-08-16T12:00:30.000Z',
    admittedAt: '2026-08-16T12:01:01.000Z',
  });
  const staleEvidence = evidenceV06Schema.parse({ ...evidence, id: 'evidence_stale_fixture', state: 'stale' });
  const evidenceRef = { id: evidence.id, revision: evidence.revision, digest: digest(evidence) };
  const evidenceResult = evidenceAdmissionResultV06Schema.parse({
    protocolVersion: '0.6',
    requestId: evidenceRequest.requestId,
    evidence: evidenceRef,
    state: 'admitted',
    projectionCursor: 2,
  });

  const verificationRequest = verificationRequestV06Schema.parse({
    protocolVersion: '0.6',
    requestId: 'verification_request_fixture',
    commandType: 'verification.request',
    presenceRegistrationId: 'presence_fixture',
    aggregate: { kind: 'acceptance_check', id: check.id, expectedRevision: check.revision },
    payload: { evidence: [evidenceRef] },
  });
  const evidenceSetDigest = createEvidenceSetDigestV06(hashHex)(verificationRequest.payload.evidence);
  const evidenceSetEnvelopeWithoutDigest = {
    protocolVersion: '0.6',
    ownerId: 'owner_fixture',
    subject,
    acceptanceCheck: checkRef,
    revision: 1,
    count: 1,
    evidenceSetDigest,
    digest: fixtureDigest,
    evidence: verificationRequest.payload.evidence,
    records: [evidence],
  } as const;
  const evidenceSetEnvelope = currentEvidenceSetEnvelopeV06Schema.parse({
    ...evidenceSetEnvelopeWithoutDigest,
    digest: `sha256:${hashHex(
      canonicalizeCurrentEvidenceSetEnvelopeV06ForDigest(evidenceSetEnvelopeWithoutDigest),
    )}`,
  });
  const passedVerification = verificationV06Schema.parse({
    protocolVersion: '0.6',
    id: 'verification_fixture',
    ownerId: 'owner_fixture',
    revision: 1,
    subject,
    acceptanceCheck: checkRef,
    evidence: verificationRequest.payload.evidence,
    evidenceSetDigest,
    method: { kind: 'deterministic_read_back', version: '1.0.0' },
    verifier: {
      id: 'independent_verifier_fixture',
      version: '1.0.0',
      availability: 'available',
      independentFromProducer: true,
      disclosure: { ref: 'verifier_disclosure_fixture', digest: fixtureDigest },
    },
    state: 'passed',
    findings: { ref: 'findings_fixture', digest: fixtureDigest },
    verifiedAt: '2026-08-16T12:02:01.000Z',
  });
  const indeterminateVerification = verificationV06Schema.parse({
    ...passedVerification,
    id: 'verification_indeterminate_fixture',
    verifier: {
      ...passedVerification.verifier,
      id: 'unavailable_verifier_fixture',
      availability: 'unavailable',
    },
    state: 'indeterminate',
    findings: null,
    verifiedAt: '2026-08-16T12:02:01.000Z',
  });
  const verificationRef = {
    id: passedVerification.id,
    revision: passedVerification.revision,
    digest: digest(passedVerification),
  };
  const verificationResult = verificationResultV06Schema.parse({
    protocolVersion: '0.6',
    requestId: verificationRequest.requestId,
    verification: verificationRef,
    state: 'passed',
    projectionCursor: 3,
  });

  const acceptanceRequest = acceptanceRecordRequestV06Schema.parse({
    protocolVersion: '0.6',
    requestId: 'acceptance_request_fixture',
    commandType: 'acceptance.record',
    presenceRegistrationId: 'presence_fixture',
    aggregate: { kind: 'outcome', id: 'outcome_fixture', expectedRevision: 3 },
    payload: {
      decision: 'accept',
      verifications: [verificationRef],
      reasonRef: null,
    },
  });
  const acceptance = acceptanceV06Schema.parse({
    protocolVersion: '0.6',
    id: 'acceptance_fixture',
    ownerId: 'owner_fixture',
    revision: 1,
    subject,
    verifications: [verificationRef],
    activeAcceptanceChecks: {
      revision: activeCheckSet.revision,
      count: activeCheckSet.count,
      digest: activeCheckSet.digest,
    },
    evidenceSets: [
      {
        acceptanceCheck: evidenceSetEnvelope.acceptanceCheck,
        revision: evidenceSetEnvelope.revision,
        count: evidenceSetEnvelope.count,
        evidenceSetDigest: evidenceSetEnvelope.evidenceSetDigest,
        digest: evidenceSetEnvelope.digest,
      },
    ],
    actor: { kind: 'owner', id: 'owner_fixture' },
    mode: 'explicit_owner',
    decision: 'accepted',
    reasonRef: null,
    recordedAt: '2026-08-16T12:03:01.000Z',
  });
  const releaseRequest = acceptanceRecordRequestV06Schema.parse({
    ...acceptanceRequest,
    requestId: 'release_request_fixture',
    payload: {
      decision: 'release',
      verifications: [],
      reasonRef: 'owner_release_reason_fixture',
    },
  });
  const release = acceptanceV06Schema.parse({
    protocolVersion: '0.6',
    id: 'release_fixture',
    ownerId: 'owner_fixture',
    revision: 1,
    subject,
    verifications: [],
    actor: { kind: 'owner', id: 'owner_fixture' },
    mode: 'explicit_owner',
    decision: 'released',
    reasonRef: 'owner_release_reason_fixture',
    recordedAt: '2026-08-16T12:03:01.000Z',
  });
  const acceptanceResult = acceptanceRecordResultV06Schema.parse({
    protocolVersion: '0.6',
    requestId: acceptanceRequest.requestId,
    acceptance: { id: acceptance.id, revision: acceptance.revision, digest: digest(acceptance) },
    decision: 'accepted',
    projectionCursor: 4,
  });
  const releaseResult = acceptanceRecordResultV06Schema.parse({
    protocolVersion: '0.6',
    requestId: releaseRequest.requestId,
    acceptance: { id: release.id, revision: release.revision, digest: digest(release) },
    decision: 'released',
    projectionCursor: 4,
  });
  const binding = verifiedAcceptanceBindingV06Schema.parse({
    acceptance,
    activeAcceptanceChecks: activeCheckSet,
    evidenceSets: [evidenceSetEnvelope],
    verifications: [passedVerification],
  });
  const projectionQuery = closureProjectionQueryV06Schema.parse({
    protocolVersion: '0.6',
    fromExclusiveCursor: 0,
    limit: 32,
  });
  const pageWithoutDigest = {
    protocolVersion: '0.6',
    ownerId: 'owner_fixture',
    projectionName: 'responsibility.closure',
    snapshotId: 'closure_snapshot_fixture',
    snapshotBaseCursor: 0,
    fromExclusiveCursor: 0,
    highWaterCursor: 4,
    nextCursor: 4,
    items: [
      { cursor: 1, itemType: 'acceptance_check', record: check, recordDigest: digest(check) },
      { cursor: 2, itemType: 'evidence', record: evidence, recordDigest: digest(evidence) },
      { cursor: 3, itemType: 'verification', record: passedVerification, recordDigest: digest(passedVerification) },
      { cursor: 4, itemType: 'acceptance', record: acceptance, recordDigest: digest(acceptance) },
    ],
    hasMore: false,
    generatedAt: '2026-08-16T12:04:00.000Z',
    pageDigest: fixtureDigest,
  } as const;
  const projectionPage = closureProjectionPageV06Schema.parse({
    ...pageWithoutDigest,
    pageDigest: `sha256:${hashHex(canonicalizeClosureProjectionPageV06ForDigest(pageWithoutDigest))}`,
  });
  const domainEvent = closureDomainEventV06Schema.parse({
    schemaVersion: '0.6',
    eventId: 'closure_event_fixture',
    ownerId: 'owner_fixture',
    aggregate: { kind: 'acceptance', id: acceptance.id, revision: acceptance.revision },
    eventType: 'acceptance.recorded',
    payloadDigest: digest(acceptance),
    cursor: 4,
    occurredAt: acceptance.recordedAt,
  });

  const secondCheck = acceptanceCheckV06Schema.parse({
    ...check,
    id: 'check_second_fixture',
    digest: fixtureDigest,
  });
  const secondCheckWithDigest = acceptanceCheckV06Schema.parse({
    ...secondCheck,
    digest: `sha256:${hashHex(canonicalizeAcceptanceCheckV06ForDigest(secondCheck))}`,
  });
  const changedDuplicate = {
    original: acceptanceRequest,
    duplicate: { ...acceptanceRequest, payload: { ...acceptanceRequest.payload, reasonRef: 'changed' } },
  };
  const unsafeDeclaration = (key: '__proto__' | 'prototype' | 'constructor') => {
    const value = {
      ...declarationRequest,
      payload: {
        ...declarationRequest.payload,
        criterion: { ...declarationRequest.payload.criterion },
      },
    };
    Object.defineProperty(value.payload.criterion, key, {
      value: 'forbidden_unsafe_key',
      enumerable: true,
    });
    return value;
  };
  const rejectionCatalogue = responsibilityClosureRejectionCatalogueV06Schema.parse({
    protocolVersion: '0.6',
    cases: [
      { name: 'empty-accept-verification', schema: 'acceptance-record-request.schema.json', layer: 'structural', zodOutcome: 'reject', value: { ...acceptanceRequest, payload: { ...acceptanceRequest.payload, verifications: [] } } },
      { name: 'caller-owner', schema: 'acceptance-record-request.schema.json', layer: 'structural', zodOutcome: 'reject', value: { ...acceptanceRequest, ownerId: 'owner_attacker' } },
      { name: 'caller-acceptance-actor', schema: 'acceptance-record-request.schema.json', layer: 'structural', zodOutcome: 'reject', value: { ...acceptanceRequest, actor: { kind: 'owner', id: 'owner_attacker' } } },
      { name: 'caller-acceptance-policy', schema: 'acceptance-record-request.schema.json', layer: 'structural', zodOutcome: 'reject', value: { ...acceptanceRequest, policy: 'delegate_if_unavailable' } },
      { name: 'caller-acceptance-grantee', schema: 'acceptance-record-request.schema.json', layer: 'structural', zodOutcome: 'reject', value: { ...acceptanceRequest, grantee: 'delegate_attacker' } },
      { name: 'caller-acceptance-override', schema: 'acceptance-record-request.schema.json', layer: 'structural', zodOutcome: 'reject', value: { ...acceptanceRequest, override: true } },
      { name: 'caller-declaration-subject', schema: 'acceptance-check-declaration-request.schema.json', layer: 'structural', zodOutcome: 'reject', value: { ...declarationRequest, subject: { outcome: { id: 'outcome_attacker', revision: 1, digest: fixtureDigest }, workUnit: null } } },
      { name: 'caller-declaration-target-digest', schema: 'acceptance-check-declaration-request.schema.json', layer: 'structural', zodOutcome: 'reject', value: { ...declarationRequest, payload: { ...declarationRequest.payload, target: { ...declarationRequest.payload.target, digest: fixtureDigest } } } },
      { name: 'inline-semantic-criterion', schema: 'acceptance-check-declaration-request.schema.json', layer: 'structural', zodOutcome: 'reject', value: { ...declarationRequest, payload: { ...declarationRequest.payload, criterion: { ...declarationRequest.payload.criterion, text: 'private health criterion content' } } } },
      { name: 'unsafe-key-proto', schema: 'acceptance-check-declaration-request.schema.json', layer: 'structural', zodOutcome: 'reject', value: unsafeDeclaration('__proto__') },
      { name: 'unsafe-key-prototype', schema: 'acceptance-check-declaration-request.schema.json', layer: 'structural', zodOutcome: 'reject', value: unsafeDeclaration('prototype') },
      { name: 'unsafe-key-constructor', schema: 'acceptance-check-declaration-request.schema.json', layer: 'structural', zodOutcome: 'reject', value: unsafeDeclaration('constructor') },
      { name: 'caller-clock', schema: 'acceptance-check-declaration-request.schema.json', layer: 'structural', zodOutcome: 'reject', value: { ...declarationRequest, clientIssuedAt: '2026-08-16T00:00:00.000Z' } },
      { name: 'caller-verifier', schema: 'verification-request.schema.json', layer: 'structural', zodOutcome: 'reject', value: { ...verificationRequest, verifier: 'verifier_attacker' } },
      { name: 'caller-source', schema: 'evidence-admission-request.schema.json', layer: 'structural', zodOutcome: 'reject', value: { ...evidenceRequest, source: 'provider_attacker' } },
      { name: 'inline-private-material', schema: 'evidence-admission-request.schema.json', layer: 'structural', zodOutcome: 'reject', value: { ...evidenceRequest, payload: { ...evidenceRequest.payload, inlineEvidence: { credential: 'credential_fixture_forbidden' } } } },
      { name: 'provider-done-implies-evidence', schema: 'evidence-admission-request.schema.json', layer: 'structural', zodOutcome: 'reject', value: { ...evidenceRequest, payload: { ...evidenceRequest.payload, done: true } } },
      { name: 'self-verification-passed', schema: 'verification.schema.json', layer: 'structural', zodOutcome: 'reject', value: { ...passedVerification, verifier: { ...passedVerification.verifier, independentFromProducer: false } } },
      { name: 'unavailable-verification-passed', schema: 'verification.schema.json', layer: 'structural', zodOutcome: 'reject', value: { ...passedVerification, verifier: { ...passedVerification.verifier, availability: 'unavailable' } } },
      { name: 'producer-verifier-identity-conflict', schema: 'verified-acceptance-binding.schema.json', layer: 'runtime', zodOutcome: 'reject', value: { ...binding, verifications: [{ ...passedVerification, verifier: { ...passedVerification.verifier, id: 'kennel_fixture' } }] } },
      { name: 'observation-producer-category-confusion', schema: 'evidence.schema.json', layer: 'runtime', zodOutcome: 'reject', value: { ...evidence, observation: { ...evidence.observation, kind: 'person_statement' } } },
      { name: 'cross-owner-person-producer', schema: 'evidence.schema.json', layer: 'runtime', zodOutcome: 'reject', value: { ...evidence, observation: { ...evidence.observation, kind: 'person_statement' }, provenance: { producer: { kind: 'person', id: 'owner_other', version: null }, admittedBy: { kind: 'owner', id: 'owner_fixture' } } } },
      { name: 'cross-owner-admitter', schema: 'evidence.schema.json', layer: 'runtime', zodOutcome: 'reject', value: { ...evidence, provenance: { ...evidence.provenance, admittedBy: { kind: 'owner', id: 'owner_other' } } } },
      { name: 'duplicate-evidence-refs', schema: 'verification-request.schema.json', layer: 'structural', zodOutcome: 'reject', value: { ...verificationRequest, payload: { evidence: [evidenceRef, evidenceRef] } } },
      { name: 'reordered-evidence-refs', schema: 'verification-request.schema.json', layer: 'runtime', zodOutcome: 'reject', value: { ...verificationRequest, payload: { evidence: [{ ...evidenceRef, id: 'evidence_z' }, evidenceRef] } } },
      { name: 'partial-check-coverage', schema: 'verified-acceptance-binding.schema.json', layer: 'runtime', zodOutcome: 'reject', value: { ...binding, activeAcceptanceChecks: { ...activeCheckSet, count: 2, acceptanceChecks: [checkRef, { id: secondCheckWithDigest.id, revision: secondCheckWithDigest.revision, digest: secondCheckWithDigest.digest }], records: [check, secondCheckWithDigest] } } },
      { name: 'missing-evidence-record', schema: 'verified-acceptance-binding.schema.json', layer: 'structural', zodOutcome: 'reject', value: { ...binding, evidenceSets: [{ ...evidenceSetEnvelope, records: [] }] } },
      { name: 'nonexistent-evidence-record', schema: 'verified-acceptance-binding.schema.json', layer: 'runtime', zodOutcome: 'reject', value: { ...binding, evidenceSets: [{ ...evidenceSetEnvelope, evidence: [{ ...evidenceRef, id: 'evidence_missing' }] }] } },
      { name: 'stale-evidence-acceptance', schema: 'verified-acceptance-binding.schema.json', layer: 'runtime', zodOutcome: 'reject', value: { ...binding, evidenceSets: [{ ...evidenceSetEnvelope, records: [{ ...evidence, state: 'stale' }] }] } },
      { name: 'invalidated-evidence-acceptance', schema: 'verified-acceptance-binding.schema.json', layer: 'runtime', zodOutcome: 'reject', value: { ...binding, evidenceSets: [{ ...evidenceSetEnvelope, records: [{ ...evidence, state: 'invalidated' }] }] } },
      { name: 'cross-owner-evidence-acceptance', schema: 'verified-acceptance-binding.schema.json', layer: 'runtime', zodOutcome: 'reject', value: { ...binding, evidenceSets: [{ ...evidenceSetEnvelope, records: [{ ...evidence, ownerId: 'owner_other' }] }] } },
      { name: 'wrong-check-evidence-acceptance', schema: 'verified-acceptance-binding.schema.json', layer: 'runtime', zodOutcome: 'reject', value: { ...binding, evidenceSets: [{ ...evidenceSetEnvelope, records: [{ ...evidence, acceptanceCheck: { ...checkRef, id: 'check_other' } }] }] } },
      { name: 'failed-verification-acceptance', schema: 'verified-acceptance-binding.schema.json', layer: 'runtime', zodOutcome: 'reject', value: { ...binding, verifications: [{ ...passedVerification, state: 'failed' }] } },
      { name: 'indeterminate-verification-acceptance', schema: 'verified-acceptance-binding.schema.json', layer: 'runtime', zodOutcome: 'reject', value: { ...binding, verifications: [indeterminateVerification] } },
      { name: 'stale-verification-acceptance', schema: 'verified-acceptance-binding.schema.json', layer: 'runtime', zodOutcome: 'reject', value: { ...binding, verifications: [{ ...passedVerification, state: 'stale' }] } },
      { name: 'cross-owner-acceptance', schema: 'verified-acceptance-binding.schema.json', layer: 'runtime', zodOutcome: 'reject', value: { ...binding, verifications: [{ ...passedVerification, ownerId: 'owner_other' }] } },
      { name: 'release-claimed-as-accepted', schema: 'acceptance.schema.json', layer: 'structural', zodOutcome: 'reject', value: { ...release, decision: 'accepted' } },
      { name: 'changed-duplicate-request', schema: 'acceptance-record-request.schema.json', layer: 'runtime', zodOutcome: 'accept', value: changedDuplicate.duplicate },
      { name: 'projection-owner-mismatch', schema: 'closure-projection-page.schema.json', layer: 'runtime', zodOutcome: 'reject', value: { ...projectionPage, ownerId: 'owner_other' } },
      { name: 'projection-cursor-corruption', schema: 'closure-projection-page.schema.json', layer: 'runtime', zodOutcome: 'reject', value: { ...projectionPage, nextCursor: 3 } },
      { name: 'projection-page-digest-corruption', schema: 'closure-projection-page.schema.json', layer: 'runtime', zodOutcome: 'accept', value: { ...projectionPage, pageDigest: fixtureDigest } },
    ],
  });

  const schemas = {
    'acceptance-check-declaration-request': acceptanceCheckDeclarationRequestV06Schema,
    'acceptance-check-declaration-result': acceptanceCheckDeclarationResultV06Schema,
    'acceptance-check': acceptanceCheckV06Schema,
    'evidence-admission-request': evidenceAdmissionRequestV06Schema,
    'evidence-admission-result': evidenceAdmissionResultV06Schema,
    evidence: evidenceV06Schema,
    'verification-request': verificationRequestV06Schema,
    'verification-result': verificationResultV06Schema,
    verification: verificationV06Schema,
    'acceptance-record-request': acceptanceRecordRequestV06Schema,
    'acceptance-record-result': acceptanceRecordResultV06Schema,
    acceptance: acceptanceV06Schema,
    'verified-acceptance-binding': verifiedAcceptanceBindingV06Schema,
    'closure-domain-event': closureDomainEventV06Schema,
    'closure-projection-query': closureProjectionQueryV06Schema,
    'closure-projection-page': closureProjectionPageV06Schema,
  } as const;
  const valid = {
    'acceptance-check-declaration-request.valid.json': declarationRequest,
    'acceptance-check-declaration-result.valid.json': declarationResult,
    'acceptance-check.valid.json': check,
    'evidence-admission-request.valid.json': evidenceRequest,
    'evidence-admission-result.valid.json': evidenceResult,
    'evidence.valid.json': evidence,
    'evidence-stale.valid.json': staleEvidence,
    'verification-request.valid.json': verificationRequest,
    'verification-result.valid.json': verificationResult,
    'verification-passed.valid.json': passedVerification,
    'verification-indeterminate.valid.json': indeterminateVerification,
    'acceptance-record-request.valid.json': acceptanceRequest,
    'release-record-request.valid.json': releaseRequest,
    'acceptance-record-result.valid.json': acceptanceResult,
    'release-record-result.valid.json': releaseResult,
    'acceptance.valid.json': acceptance,
    'release.valid.json': release,
    'verified-acceptance-binding.valid.json': binding,
    'closure-domain-event.valid.json': domainEvent,
    'closure-projection-query.valid.json': projectionQuery,
    'closure-projection-page.valid.json': projectionPage,
  } as const;
  const files: Record<string, string> = {};
  for (const [name, value] of Object.entries(schemas)) {
    files[`${name}.schema.json`] = file(schema(value, name));
  }
  for (const [path, value] of Object.entries(valid)) files[path] = file(value);
  files['closure.rejections.json'] = file(rejectionCatalogue);
  files['idempotency.valid.json'] = file({
    protocolVersion: '0.6',
    request: acceptanceRequest,
    firstResult: acceptanceResult,
    exactDuplicateResult: acceptanceResult,
    changedDuplicate,
    semantics: closureCommandRetrySemanticsV06,
  });

  const filePins = Object.keys(files).sort().map((path) => ({
    path,
    sha256: `sha256:${hashHex(files[path]!)}`,
  }));
  const fixturePayloadRootSha256 = `sha256:${hashHex(
    filePins.map(({ path, sha256 }) => `${path}\u0000${sha256}\n`).join(''),
  )}`;
  return {
    ...files,
    'manifest.json': file({
      protocolName: 'responsibility-closure',
      protocolVersion: '0.6',
      mediaType: 'application/vnd.waldo.responsibility.v0.6+json',
      offlineCommands: 'none',
      proofLevel: 'adapter_conformance_fixture',
      source: {
        path: 'packages/contracts/src/protocol/responsibility-closure-v0-6.ts',
        sha256: `sha256:${sourceSha256}`,
      },
      fixturePayloadRootSha256,
      compatibilityWindow: {
        predecessor: '0.5',
        mode: 'parallel_additive',
        promise: 'v0.1-v0.5 source, tests, and fixture bytes remain preserved',
        removal: 'none_authorized',
      },
      consumers: [
        { name: 'waldo-backend-runtime', contractRole: 'canonical_runtime' },
        { name: 'kennel', contractRole: 'owner_surface' },
        { name: 'waldo-mobile', contractRole: 'owner_surface' },
        { name: 'telegram', contractRole: 'messaging_presence' },
        { name: 'discord', contractRole: 'messaging_presence' },
      ],
      writers: {
        acceptanceCheck: 'OutcomeModule',
        evidence: 'EvidenceVerifier',
        verification: 'EvidenceVerifier',
        acceptance: 'AcceptanceModule',
        projection: 'ProjectionPublisher',
      },
      acceptancePolicy: {
        mode: 'explicit_owner_only',
        acceptRequires:
          'complete_active_check_set_with_exact_current_evidence_and_passed_independent_verification',
        completenessAuthority:
          'separate_transactional_reread_of_exact_canonical_active_acceptance_check_set',
        nonPassedDisposition: 'release',
      },
      targetingPolicy: {
        callerProposal: 'outcome_or_work_unit_id_and_expected_revision_only',
        canonicalSubject: 'server_reread_owner_revision_and_digest',
      },
      criterionPolicy: {
        publicRepresentation: 'content_free_server_reread_ref_revision_version_digest',
        inlineSemanticContent: 'forbidden',
      },
      verificationPolicy: {
        independence: closureVerifierIndependenceRuleV06,
        evidence: 'exact_current_admitted_owner_subject_check_records',
        observationUniqueness: 'binding_wide_canonical_kind_id_revision_digest',
      },
      publicCommandSafety: {
        recursiveOwnUnsafeKeys: ['__proto__', 'prototype', 'constructor'],
        jsonSchemaUniqueItems: true,
        runtimeOrdering: 'strict_by_id',
      },
      bytePreservation: {
        throughVersion: '0.5',
        guard: 'scripts/guards/guard-responsibility-released-v0-1-v0-5-bytes.mjs',
        compositeSha256: 'sha256:f5bf7db0d5cef40f5acd8f9b04467e605a38cb6ab1d4e8ed15c0e6dd3db15a64',
      },
      retrySemantics: closureCommandRetrySemanticsV06,
      files: filePins,
    }),
  };
}
