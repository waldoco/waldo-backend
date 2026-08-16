// @ts-expect-error TS2307 -- Node types are intentionally absent from the portable package
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  acceptanceCheckDeclarationRequestV06Schema,
  acceptanceCheckDeclarationResultV06Schema,
  acceptanceCheckV06Schema,
  acceptanceRecordRequestV06Schema,
  acceptanceRecordResultV06Schema,
  acceptanceV06Schema,
  closureDomainEventV06Schema,
  closureProjectionPageV06Schema,
  closureProjectionQueryV06Schema,
  canonicalizeAcceptanceCheckV06ForDigest,
  canonicalizeActiveAcceptanceCheckSetV06ForDigest,
  canonicalizeCurrentEvidenceSetEnvelopeV06ForDigest,
  createClosureProjectionPageVerifierV06,
  createEvidenceSetDigestV06,
  createVerifiedAcceptanceBindingVerifierV06,
  evidenceAdmissionRequestV06Schema,
  evidenceAdmissionResultV06Schema,
  evidenceV06Schema,
  verificationRequestV06Schema,
  verificationResultV06Schema,
  verificationV06Schema,
  verifiedAcceptanceBindingV06Schema,
} from './responsibility-closure-v0-6';
import {
  buildResponsibilityClosureV06Bundle,
  responsibilityClosureRejectionCatalogueV06Schema,
} from './responsibility-closure-v0-6-fixtures';
import { canonicalizeProtocolJson } from './responsibility-handshake-v0-1';

const validFixtureSchemas = {
  'acceptance-check-declaration-request.valid.json': acceptanceCheckDeclarationRequestV06Schema,
  'acceptance-check-declaration-result.valid.json': acceptanceCheckDeclarationResultV06Schema,
  'acceptance-check.valid.json': acceptanceCheckV06Schema,
  'evidence-admission-request.valid.json': evidenceAdmissionRequestV06Schema,
  'evidence-admission-result.valid.json': evidenceAdmissionResultV06Schema,
  'evidence.valid.json': evidenceV06Schema,
  'evidence-stale.valid.json': evidenceV06Schema,
  'verification-request.valid.json': verificationRequestV06Schema,
  'verification-result.valid.json': verificationResultV06Schema,
  'verification-passed.valid.json': verificationV06Schema,
  'verification-indeterminate.valid.json': verificationV06Schema,
  'acceptance-record-request.valid.json': acceptanceRecordRequestV06Schema,
  'release-record-request.valid.json': acceptanceRecordRequestV06Schema,
  'acceptance-record-result.valid.json': acceptanceRecordResultV06Schema,
  'release-record-result.valid.json': acceptanceRecordResultV06Schema,
  'acceptance.valid.json': acceptanceV06Schema,
  'release.valid.json': acceptanceV06Schema,
  'verified-acceptance-binding.valid.json': verifiedAcceptanceBindingV06Schema,
  'closure-domain-event.valid.json': closureDomainEventV06Schema,
  'closure-projection-query.valid.json': closureProjectionQueryV06Schema,
  'closure-projection-page.valid.json': closureProjectionPageV06Schema,
} as const;

const schemaForValidFixture: Record<keyof typeof validFixtureSchemas, string> = {
  'acceptance-check-declaration-request.valid.json': 'acceptance-check-declaration-request.schema.json',
  'acceptance-check-declaration-result.valid.json': 'acceptance-check-declaration-result.schema.json',
  'acceptance-check.valid.json': 'acceptance-check.schema.json',
  'evidence-admission-request.valid.json': 'evidence-admission-request.schema.json',
  'evidence-admission-result.valid.json': 'evidence-admission-result.schema.json',
  'evidence.valid.json': 'evidence.schema.json',
  'evidence-stale.valid.json': 'evidence.schema.json',
  'verification-request.valid.json': 'verification-request.schema.json',
  'verification-result.valid.json': 'verification-result.schema.json',
  'verification-passed.valid.json': 'verification.schema.json',
  'verification-indeterminate.valid.json': 'verification.schema.json',
  'acceptance-record-request.valid.json': 'acceptance-record-request.schema.json',
  'release-record-request.valid.json': 'acceptance-record-request.schema.json',
  'acceptance-record-result.valid.json': 'acceptance-record-result.schema.json',
  'release-record-result.valid.json': 'acceptance-record-result.schema.json',
  'acceptance.valid.json': 'acceptance.schema.json',
  'release.valid.json': 'acceptance.schema.json',
  'verified-acceptance-binding.valid.json': 'verified-acceptance-binding.schema.json',
  'closure-domain-event.valid.json': 'closure-domain-event.schema.json',
  'closure-projection-query.valid.json': 'closure-projection-query.schema.json',
  'closure-projection-page.valid.json': 'closure-projection-page.schema.json',
};

const rejectionSchemas = {
  'acceptance-check-declaration-request.schema.json': acceptanceCheckDeclarationRequestV06Schema,
  'evidence-admission-request.schema.json': evidenceAdmissionRequestV06Schema,
  'evidence.schema.json': evidenceV06Schema,
  'verification-request.schema.json': verificationRequestV06Schema,
  'verification.schema.json': verificationV06Schema,
  'acceptance-record-request.schema.json': acceptanceRecordRequestV06Schema,
  'acceptance.schema.json': acceptanceV06Schema,
  'verified-acceptance-binding.schema.json': verifiedAcceptanceBindingV06Schema,
  'closure-projection-page.schema.json': closureProjectionPageV06Schema,
} as const;

const requiredRejections = [
  'empty-accept-verification',
  'caller-owner',
  'caller-acceptance-actor',
  'caller-acceptance-policy',
  'caller-acceptance-grantee',
  'caller-acceptance-override',
  'caller-declaration-subject',
  'caller-declaration-target-digest',
  'inline-semantic-criterion',
  'unsafe-key-proto',
  'unsafe-key-prototype',
  'unsafe-key-constructor',
  'caller-clock',
  'caller-verifier',
  'caller-source',
  'inline-private-material',
  'provider-done-implies-evidence',
  'self-verification-passed',
  'unavailable-verification-passed',
  'producer-verifier-identity-conflict',
  'observation-producer-category-confusion',
  'cross-owner-person-producer',
  'cross-owner-admitter',
  'duplicate-evidence-refs',
  'reordered-evidence-refs',
  'partial-check-coverage',
  'missing-evidence-record',
  'nonexistent-evidence-record',
  'stale-evidence-acceptance',
  'invalidated-evidence-acceptance',
  'cross-owner-evidence-acceptance',
  'wrong-check-evidence-acceptance',
  'failed-verification-acceptance',
  'indeterminate-verification-acceptance',
  'stale-verification-acceptance',
  'cross-owner-acceptance',
  'release-claimed-as-accepted',
  'changed-duplicate-request',
  'projection-owner-mismatch',
  'projection-cursor-corruption',
  'projection-page-digest-corruption',
] as const;

function fixtureAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
  for (const keyword of ['x-waldo-validation-level', 'x-waldo-offline-commands']) {
    ajv.addKeyword(keyword);
  }
  return ajv;
}

describe('responsibility closure v0.6 fixtures', () => {
  const sourceSha256 = 'f'.repeat(64);
  const hashHex = (value: string): string => createHash('sha256').update(value).digest('hex');

  it('publishes digest-coherent fixtures and pins every payload byte', () => {
    const bundle = buildResponsibilityClosureV06Bundle(hashHex, sourceSha256);
    for (const [path, contractSchema] of Object.entries(validFixtureSchemas)) {
      const value = JSON.parse(bundle[path]!);
      expect(contractSchema.parse(value), path).toEqual(value);
      const validate = fixtureAjv().compile(JSON.parse(bundle[schemaForValidFixture[path as keyof typeof validFixtureSchemas]]!));
      expect(validate(value), `${path}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
    const binding = JSON.parse(bundle['verified-acceptance-binding.valid.json']!);
    expect(() => createVerifiedAcceptanceBindingVerifierV06(hashHex)(
      binding,
      binding.activeAcceptanceChecks,
    )).not.toThrow();
    const secondCheckWithoutDigest = {
      ...binding.activeAcceptanceChecks.records[0],
      id: 'check_fixture_two',
      criterion: {
        ...binding.activeAcceptanceChecks.records[0].criterion,
        ref: 'criterion_fixture_two',
      },
    };
    const secondCheck = {
      ...secondCheckWithoutDigest,
      digest: `sha256:${hashHex(
        canonicalizeAcceptanceCheckV06ForDigest(secondCheckWithoutDigest),
      )}`,
    };
    const authoritativeWithoutDigest = {
      ...binding.activeAcceptanceChecks,
      revision: 2,
      count: 2,
      acceptanceChecks: [
        binding.activeAcceptanceChecks.acceptanceChecks[0],
        { id: secondCheck.id, revision: secondCheck.revision, digest: secondCheck.digest },
      ],
      records: [binding.activeAcceptanceChecks.records[0], secondCheck],
    };
    const authoritativeActiveChecks = {
      ...authoritativeWithoutDigest,
      digest: `sha256:${hashHex(
        canonicalizeActiveAcceptanceCheckSetV06ForDigest(authoritativeWithoutDigest),
      )}`,
    };
    expect(() => createVerifiedAcceptanceBindingVerifierV06(hashHex)(
      binding,
      authoritativeActiveChecks,
    )).toThrow('authoritative active AcceptanceCheck set');
    const rebindEvidenceEnvelope = (
      envelopeOverrides: Record<string, unknown>,
      recordOverrides: Record<string, unknown>,
    ) => {
      const record = { ...binding.evidenceSets[0].records[0], ...recordOverrides };
      const evidence = [{
        id: record.id,
        revision: record.revision,
        digest: `sha256:${hashHex(canonicalizeProtocolJson(record))}`,
      }];
      const evidenceSetDigest = createEvidenceSetDigestV06(hashHex)(evidence);
      const envelopeWithoutDigest = {
        ...binding.evidenceSets[0],
        ...envelopeOverrides,
        evidence,
        evidenceSetDigest,
        records: [record],
      };
      const envelope = {
        ...envelopeWithoutDigest,
        digest: `sha256:${hashHex(
          canonicalizeCurrentEvidenceSetEnvelopeV06ForDigest(envelopeWithoutDigest),
        )}`,
      };
      const verification = {
        ...binding.verifications[0],
        evidence,
        evidenceSetDigest,
      };
      const verificationReference = {
        id: verification.id,
        revision: verification.revision,
        digest: `sha256:${hashHex(canonicalizeProtocolJson(verification))}`,
      };
      return {
        ...binding,
        acceptance: {
          ...binding.acceptance,
          evidenceSets: [{
            acceptanceCheck: envelope.acceptanceCheck,
            revision: envelope.revision,
            count: envelope.count,
            evidenceSetDigest,
            digest: envelope.digest,
          }],
          verifications: [verificationReference],
        },
        evidenceSets: [envelope],
        verifications: [verification],
      };
    };
    const changedSubject = {
      ...binding.acceptance.subject,
      outcome: { ...binding.acceptance.subject.outcome, revision: 4 },
    };
    const staleCheck = {
      ...binding.activeAcceptanceChecks.acceptanceChecks[0],
      revision: 2,
      digest: `sha256:${'b'.repeat(64)}`,
    };
    for (const attack of [
      rebindEvidenceEnvelope(
        { ownerId: 'owner_other' },
        { ownerId: 'owner_other' },
      ),
      rebindEvidenceEnvelope(
        { subject: changedSubject },
        { subject: changedSubject },
      ),
      rebindEvidenceEnvelope(
        { acceptanceCheck: staleCheck },
        { acceptanceCheck: staleCheck },
      ),
    ]) {
      expect(() => createVerifiedAcceptanceBindingVerifierV06(hashHex)(
        attack,
        binding.activeAcceptanceChecks,
      )).toThrow('Evidence-set envelope must bind');
    }
    const duplicateObservationRecord = {
      ...binding.evidenceSets[0].records[0],
      id: 'evidence_fixture_two',
      acceptanceCheck: authoritativeActiveChecks.acceptanceChecks[1],
    };
    const duplicateObservationEvidence = [{
      id: duplicateObservationRecord.id,
      revision: duplicateObservationRecord.revision,
      digest: `sha256:${hashHex(canonicalizeProtocolJson(duplicateObservationRecord))}`,
    }];
    const duplicateObservationEvidenceSetDigest = createEvidenceSetDigestV06(hashHex)(
      duplicateObservationEvidence,
    );
    const secondEnvelopeWithoutDigest = {
      ...binding.evidenceSets[0],
      acceptanceCheck: authoritativeActiveChecks.acceptanceChecks[1],
      evidence: duplicateObservationEvidence,
      evidenceSetDigest: duplicateObservationEvidenceSetDigest,
      records: [duplicateObservationRecord],
    };
    const secondEnvelope = {
      ...secondEnvelopeWithoutDigest,
      digest: `sha256:${hashHex(
        canonicalizeCurrentEvidenceSetEnvelopeV06ForDigest(secondEnvelopeWithoutDigest),
      )}`,
    };
    const secondVerification = {
      ...binding.verifications[0],
      id: 'verification_fixture_two',
      acceptanceCheck: authoritativeActiveChecks.acceptanceChecks[1],
      evidence: duplicateObservationEvidence,
      evidenceSetDigest: duplicateObservationEvidenceSetDigest,
    };
    const secondVerificationReference = {
      id: secondVerification.id,
      revision: secondVerification.revision,
      digest: `sha256:${hashHex(canonicalizeProtocolJson(secondVerification))}`,
    };
    const duplicateObservationBinding = {
      ...binding,
      acceptance: {
        ...binding.acceptance,
        activeAcceptanceChecks: {
          revision: authoritativeActiveChecks.revision,
          count: authoritativeActiveChecks.count,
          digest: authoritativeActiveChecks.digest,
        },
        evidenceSets: [
          binding.acceptance.evidenceSets[0],
          {
            acceptanceCheck: secondEnvelope.acceptanceCheck,
            revision: secondEnvelope.revision,
            count: secondEnvelope.count,
            evidenceSetDigest: secondEnvelope.evidenceSetDigest,
            digest: secondEnvelope.digest,
          },
        ],
        verifications: [
          binding.acceptance.verifications[0],
          secondVerificationReference,
        ],
      },
      activeAcceptanceChecks: authoritativeActiveChecks,
      evidenceSets: [binding.evidenceSets[0], secondEnvelope],
      verifications: [binding.verifications[0], secondVerification],
    };
    expect(() => createVerifiedAcceptanceBindingVerifierV06(hashHex)(
      duplicateObservationBinding,
      authoritativeActiveChecks,
    )).toThrow('canonical observation reference must be unique');
    const corruptedDigest = `sha256:${'0'.repeat(64)}`;
    expect(() => createVerifiedAcceptanceBindingVerifierV06(hashHex)({
      ...binding,
      acceptance: {
        ...binding.acceptance,
        activeAcceptanceChecks: {
          ...binding.acceptance.activeAcceptanceChecks,
          digest: corruptedDigest,
        },
      },
      activeAcceptanceChecks: {
        ...binding.activeAcceptanceChecks,
        digest: corruptedDigest,
      },
    }, binding.activeAcceptanceChecks)).toThrow('active AcceptanceCheck set');
    expect(() => createVerifiedAcceptanceBindingVerifierV06(hashHex)({
      ...binding,
      acceptance: {
        ...binding.acceptance,
        evidenceSets: [{ ...binding.acceptance.evidenceSets[0], digest: corruptedDigest }],
      },
      evidenceSets: [{ ...binding.evidenceSets[0], digest: corruptedDigest }],
    }, binding.activeAcceptanceChecks)).toThrow('current Evidence-set envelope digest');
    expect(() => createVerifiedAcceptanceBindingVerifierV06(hashHex)({
      ...binding,
      evidenceSets: [{
        ...binding.evidenceSets[0],
        evidence: [{ ...binding.evidenceSets[0].evidence[0], digest: corruptedDigest }],
      }],
      verifications: [{
        ...binding.verifications[0],
        evidence: [{ ...binding.verifications[0].evidence[0], digest: corruptedDigest }],
      }],
    }, binding.activeAcceptanceChecks)).toThrow('current Evidence-set digest');
    expect(() => createClosureProjectionPageVerifierV06(hashHex)(
      JSON.parse(bundle['closure-projection-page.valid.json']!),
    )).not.toThrow();

    const manifest = JSON.parse(bundle['manifest.json']!);
    expect(manifest).toMatchObject({
      protocolName: 'responsibility-closure',
      protocolVersion: '0.6',
      mediaType: 'application/vnd.waldo.responsibility.v0.6+json',
      offlineCommands: 'none',
      proofLevel: 'adapter_conformance_fixture',
      source: {
        path: 'packages/contracts/src/protocol/responsibility-closure-v0-6.ts',
        sha256: `sha256:${sourceSha256}`,
      },
      compatibilityWindow: {
        predecessor: '0.5',
        mode: 'parallel_additive',
        promise: 'v0.1-v0.5 source, tests, and fixture bytes remain preserved',
        removal: 'none_authorized',
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
        independence: {
          version: 'verifier-producer-identity-v1',
          requirement: 'verifier_id_must_differ_from_every_evidence_producer_id',
        },
        evidence: 'exact_current_admitted_owner_subject_check_records',
        observationUniqueness: 'binding_wide_canonical_kind_id_revision_digest',
      },
      publicCommandSafety: {
        recursiveOwnUnsafeKeys: ['__proto__', 'prototype', 'constructor'],
        jsonSchemaUniqueItems: true,
        runtimeOrdering: 'strict_by_id',
      },
      retrySemantics: {
        identity: 'requestId',
        exactDuplicate: 'return_persisted_result_byte_for_byte',
        changedDuplicate: 'reject_request_conflict',
      },
    });
    expect(manifest.files).toEqual(
      Object.keys(bundle).filter((path) => path !== 'manifest.json').sort().map((path) => ({
        path,
        sha256: `sha256:${hashHex(bundle[path]!)}`,
      })),
    );
    expect(manifest.fixturePayloadRootSha256).toBe(
      `sha256:${hashHex(manifest.files.map(
        ({ path, sha256 }: { path: string; sha256: string }) => `${path}\u0000${sha256}\n`,
      ).join(''))}`,
    );
  });

  it('makes exact duplicate results byte-identical and changed duplicates conflicts', () => {
    const fixture = JSON.parse(
      buildResponsibilityClosureV06Bundle(hashHex, sourceSha256)['idempotency.valid.json']!,
    );
    expect(JSON.stringify(fixture.firstResult)).toBe(JSON.stringify(fixture.exactDuplicateResult));
    expect(JSON.stringify(fixture.request)).not.toBe(JSON.stringify(fixture.changedDuplicate.duplicate));
    expect(fixture.semantics.changedDuplicate).toBe('reject_request_conflict');
  });

  it('catalogues authority, completeness, privacy, ordering, and corruption attacks', () => {
    const bundle = buildResponsibilityClosureV06Bundle(hashHex, sourceSha256);
    const catalogue = responsibilityClosureRejectionCatalogueV06Schema.parse(
      JSON.parse(bundle['closure.rejections.json']!),
    );
    expect(catalogue.cases.map(({ name }) => name)).toEqual([...requiredRejections]);
    const validators = Object.fromEntries(Object.keys(rejectionSchemas).map((schemaPath) => [
      schemaPath,
      fixtureAjv().compile(JSON.parse(bundle[schemaPath]!)),
    ]));
    for (const rejection of catalogue.cases) {
      const validate = validators[rejection.schema]!;
      expect(
        validate(rejection.value),
        `${rejection.name}: ${JSON.stringify(validate.errors)}`,
      ).toBe(rejection.layer === 'runtime');
      expect(
        rejectionSchemas[rejection.schema].safeParse(rejection.value).success,
        rejection.name,
      ).toBe(rejection.zodOutcome === 'accept');
      if (rejection.name === 'projection-page-digest-corruption') {
        expect(() => createClosureProjectionPageVerifierV06(hashHex)(rejection.value)).toThrow(
          'pageDigest must match the canonical closure projection page',
        );
      }
    }
  });
});
