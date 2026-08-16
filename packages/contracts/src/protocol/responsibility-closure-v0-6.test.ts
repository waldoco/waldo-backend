import { describe, expect, it } from 'vitest';
import {
  acceptanceCheckV06Schema,
  acceptanceCheckDeclarationRequestV06Schema,
  acceptanceV06Schema,
  acceptanceRecordResultV06Schema,
  acceptanceRecordRequestV06Schema,
  canonicalizeEvidenceSetV06ForDigest,
  closureDomainEventV06Schema,
  closureProjectionPageV06Schema,
  evidenceAdmissionRequestV06Schema,
  evidenceV06Schema,
  evidenceSetV06Schema,
  verifiedAcceptanceBindingV06Schema,
  verificationRequestV06Schema,
  verificationV06Schema,
} from './responsibility-closure-v0-6';

const digest = `sha256:${'a'.repeat(64)}`;

describe('responsibility closure v0.6', () => {
  it('admits owner accept only with an exact non-empty verification set', () => {
    const request = {
      protocolVersion: '0.6',
      requestId: 'acceptance_request',
      commandType: 'acceptance.record',
      presenceRegistrationId: 'presence',
      aggregate: { kind: 'outcome', id: 'outcome', expectedRevision: 3 },
      payload: {
        decision: 'accept',
        evidenceSetDigest: digest,
        verifications: [{ id: 'verification', revision: 1, digest }],
        reasonRef: null,
      },
    };

    expect(acceptanceRecordRequestV06Schema.parse(request)).toEqual(request);
    expect(
      acceptanceRecordRequestV06Schema.safeParse({
        ...request,
        payload: { ...request.payload, verifications: [] },
      }).success,
    ).toBe(false);
    for (const field of [
      'ownerId',
      'actor',
      'policy',
      'authority',
      'verifier',
      'source',
      'clientIssuedAt',
      'clock',
    ]) {
      expect(
        acceptanceRecordRequestV06Schema.safeParse({ ...request, [field]: 'caller' }).success,
        field,
      ).toBe(false);
    }
  });

  it('defines one ordered unique Evidence set and forbids false passed Verification', () => {
    const evidence = [
      { id: 'evidence_a', revision: 1, digest },
      { id: 'evidence_b', revision: 2, digest },
    ];
    expect(evidenceSetV06Schema.parse(evidence)).toEqual(evidence);
    expect(evidenceSetV06Schema.safeParse([...evidence].reverse()).success).toBe(false);
    expect(evidenceSetV06Schema.safeParse([evidence[0], evidence[0]]).success).toBe(false);
    expect(canonicalizeEvidenceSetV06ForDigest(evidence)).toBe(
      `{"algorithm":"waldo-evidence-set-v1","evidence":[` +
        `{"digest":"${digest}","id":"evidence_a","revision":1},` +
        `{"digest":"${digest}","id":"evidence_b","revision":2}]}`,
    );

    const verification = {
      protocolVersion: '0.6',
      id: 'verification',
      ownerId: 'owner',
      revision: 1,
      subject: {
        outcome: { id: 'outcome', revision: 3, digest },
        workUnit: { id: 'work', revision: 2, digest },
      },
      acceptanceCheck: { id: 'check', revision: 4, digest },
      evidence,
      evidenceSetDigest: digest,
      method: { kind: 'deterministic_read_back', version: '1.0.0' },
      verifier: {
        id: 'verifier',
        version: '1.0.0',
        availability: 'available',
        independentFromProducer: true,
        disclosure: { ref: 'disclosure', digest },
      },
      state: 'passed',
      findings: { ref: 'findings', digest },
      verifiedAt: '2026-08-16T12:01:00.000Z',
    };
    expect(verificationV06Schema.parse(verification)).toEqual(verification);
    expect(
      verificationV06Schema.safeParse({
        ...verification,
        verifier: { ...verification.verifier, independentFromProducer: false },
      }).success,
    ).toBe(false);
    expect(
      verificationV06Schema.safeParse({
        ...verification,
        verifier: { ...verification.verifier, availability: 'unavailable' },
      }).success,
    ).toBe(false);
  });

  it('keeps declaration, Evidence admission, and Verification requests authority-free', () => {
    const declaration = {
      protocolVersion: '0.6',
      requestId: 'declaration_request',
      commandType: 'acceptance_check.declare',
      presenceRegistrationId: 'presence',
      payload: {
        criterion: 'The exact owner-readable result is independently confirmed.',
        verificationMethod: { kind: 'deterministic_read_back', capability: 'calendar.read' },
      },
    };
    expect(acceptanceCheckDeclarationRequestV06Schema.parse(declaration)).toEqual(declaration);
    for (const field of ['aggregate', 'subject', 'ownerId', 'createdAt', 'digest']) {
      expect(
        acceptanceCheckDeclarationRequestV06Schema.safeParse({
          ...declaration,
          [field]: field === 'aggregate'
            ? { kind: 'work_unit', id: 'work', expectedRevision: 2 }
            : 'caller',
        }).success,
        field,
      ).toBe(false);
    }

    const evidenceRequest = {
      protocolVersion: '0.6',
      requestId: 'evidence_request',
      commandType: 'evidence.admit',
      presenceRegistrationId: 'presence',
      aggregate: { kind: 'acceptance_check', id: 'check', expectedRevision: 1 },
      payload: {
        observation: {
          kind: 'execution_observation',
          id: 'observation',
          revision: 4,
          digest,
        },
      },
    };
    expect(evidenceAdmissionRequestV06Schema.parse(evidenceRequest)).toEqual(evidenceRequest);

    const verificationRequest = {
      protocolVersion: '0.6',
      requestId: 'verification_request',
      commandType: 'verification.request',
      presenceRegistrationId: 'presence',
      aggregate: { kind: 'acceptance_check', id: 'check', expectedRevision: 1 },
      payload: {
        evidence: [{ id: 'evidence', revision: 1, digest }],
      },
    };
    expect(verificationRequestV06Schema.parse(verificationRequest)).toEqual(verificationRequest);

    const acceptanceRequest = {
      protocolVersion: '0.6',
      requestId: 'acceptance_request',
      commandType: 'acceptance.record',
      presenceRegistrationId: 'presence',
      aggregate: { kind: 'outcome', id: 'outcome', expectedRevision: 3 },
      payload: {
        decision: 'accept',
        evidenceSetDigest: digest,
        verifications: [{ id: 'verification', revision: 1, digest }],
        reasonRef: null,
      },
    };
    expect(acceptanceRecordRequestV06Schema.parse(acceptanceRequest)).toEqual(acceptanceRequest);

    for (const [schema, value] of [
      [acceptanceCheckDeclarationRequestV06Schema, declaration],
      [evidenceAdmissionRequestV06Schema, evidenceRequest],
      [verificationRequestV06Schema, verificationRequest],
      [acceptanceRecordRequestV06Schema, acceptanceRequest],
    ] as const) {
      for (const field of [
        'ownerId',
        'actor',
        'collector',
        'source',
        'verifier',
        'policy',
        'authority',
        'grantee',
        'override',
        'credential',
        'clientIssuedAt',
        'clock',
        'rawHealth',
        'transcript',
      ]) {
        expect(schema.safeParse({ ...value, [field]: 'caller' }).success, field).toBe(false);
      }
    }
  });

  it('records bounded server-derived Evidence and conscious owner release distinctly', () => {
    const evidence = {
      protocolVersion: '0.6',
      id: 'evidence',
      ownerId: 'owner',
      revision: 1,
      subject: {
        outcome: { id: 'outcome', revision: 3, digest },
        workUnit: { id: 'work', revision: 2, digest },
      },
      acceptanceCheck: { id: 'check', revision: 1, digest },
      observation: {
        kind: 'execution_observation',
        id: 'observation',
        revision: 4,
        digest,
      },
      provenance: {
        producer: { kind: 'execution_environment', id: 'kennel', version: '1.0.0' },
        admittedBy: { kind: 'owner', id: 'owner' },
      },
      state: 'admitted',
      observedAt: '2026-08-16T11:59:00.000Z',
      admittedAt: '2026-08-16T12:01:00.000Z',
    };
    expect(evidenceV06Schema.parse(evidence)).toEqual(evidence);
    expect(evidenceV06Schema.safeParse({ ...evidence, inlineEvidence: 'private' }).success).toBe(
      false,
    );

    const releaseRequest = {
      protocolVersion: '0.6',
      requestId: 'release_request',
      commandType: 'acceptance.record',
      presenceRegistrationId: 'presence',
      aggregate: { kind: 'outcome', id: 'outcome', expectedRevision: 3 },
      payload: {
        decision: 'release',
        evidenceSetDigest: null,
        verifications: [],
        reasonRef: 'owner_release_reason',
      },
    };
    expect(acceptanceRecordRequestV06Schema.parse(releaseRequest)).toEqual(releaseRequest);
    expect(
      acceptanceRecordRequestV06Schema.safeParse({
        ...releaseRequest,
        payload: { ...releaseRequest.payload, reasonRef: null },
      }).success,
    ).toBe(false);

    const result = {
      protocolVersion: '0.6',
      requestId: 'release_request',
      acceptance: { id: 'acceptance', revision: 1, digest },
      decision: 'released',
      projectionCursor: 8,
    };
    expect(acceptanceRecordResultV06Schema.parse(result)).toEqual(result);
  });

  it('accepts only a complete current passed independent Verification set', () => {
    const subject = {
      outcome: { id: 'outcome', revision: 3, digest },
      workUnit: { id: 'work', revision: 2, digest },
    };
    const check = acceptanceCheckV06Schema.parse({
      protocolVersion: '0.6',
      id: 'check',
      ownerId: 'owner',
      revision: 1,
      digest,
      subject,
      criterion: 'The exact result is independently confirmed.',
      verificationMethod: {
        kind: 'deterministic_read_back',
        capability: 'calendar.read',
        version: '1.0.0',
        material: { ref: 'calendar_result', digest },
      },
      state: 'active',
      createdAt: '2026-08-16T12:00:00.000Z',
      updatedAt: '2026-08-16T12:00:00.000Z',
    });
    const verification = verificationV06Schema.parse({
      protocolVersion: '0.6',
      id: 'verification',
      ownerId: 'owner',
      revision: 1,
      subject,
      acceptanceCheck: { id: 'check', revision: 1, digest },
      evidence: [{ id: 'evidence', revision: 1, digest }],
      evidenceSetDigest: digest,
      method: { kind: 'deterministic_read_back', version: '1.0.0' },
      verifier: {
        id: 'independent_verifier',
        version: '1.0.0',
        availability: 'available',
        independentFromProducer: true,
        disclosure: { ref: 'disclosure', digest },
      },
      state: 'passed',
      findings: { ref: 'findings', digest },
      verifiedAt: '2026-08-16T12:02:00.000Z',
    });
    const acceptance = acceptanceV06Schema.parse({
      protocolVersion: '0.6',
      id: 'acceptance',
      ownerId: 'owner',
      revision: 1,
      subject,
      evidenceSetDigest: digest,
      verifications: [{ id: 'verification', revision: 1, digest }],
      actor: { kind: 'owner', id: 'owner' },
      mode: 'explicit_owner',
      decision: 'accepted',
      reasonRef: null,
      recordedAt: '2026-08-16T12:03:00.000Z',
    });
    const binding = { acceptance, acceptanceChecks: [check], verifications: [verification] };
    expect(verifiedAcceptanceBindingV06Schema.parse(binding)).toEqual(binding);
    expect(
      verifiedAcceptanceBindingV06Schema.safeParse({
        ...binding,
        verifications: [{ ...verification, state: 'stale' }],
      }).success,
    ).toBe(false);
    expect(
      verifiedAcceptanceBindingV06Schema.safeParse({ ...binding, acceptanceChecks: [] }).success,
    ).toBe(false);
    expect(
      verifiedAcceptanceBindingV06Schema.safeParse({
        ...binding,
        acceptance: { ...acceptance, actor: { kind: 'owner', id: 'attacker' } },
      }).success,
    ).toBe(false);
  });

  it('publishes a bounded ordered digest-bearing projection under a distinct v0.6 event namespace', () => {
    const event = {
      schemaVersion: '0.6',
      eventId: 'event',
      ownerId: 'owner',
      aggregate: { kind: 'verification', id: 'verification', revision: 1 },
      eventType: 'verification.recorded',
      payloadDigest: digest,
      cursor: 1,
      occurredAt: '2026-08-16T12:02:00.000Z',
    };
    expect(closureDomainEventV06Schema.parse(event)).toEqual(event);
    expect(closureDomainEventV06Schema.safeParse({ ...event, schemaVersion: '0.5' }).success).toBe(
      false,
    );

    const release = acceptanceV06Schema.parse({
      protocolVersion: '0.6',
      id: 'acceptance',
      ownerId: 'owner',
      revision: 1,
      subject: {
        outcome: { id: 'outcome', revision: 3, digest },
        workUnit: null,
      },
      evidenceSetDigest: null,
      verifications: [],
      actor: { kind: 'owner', id: 'owner' },
      mode: 'explicit_owner',
      decision: 'released',
      reasonRef: 'release_reason',
      recordedAt: '2026-08-16T12:03:00.000Z',
    });
    const page = {
      protocolVersion: '0.6',
      ownerId: 'owner',
      projectionName: 'responsibility.closure',
      snapshotId: 'snapshot',
      snapshotBaseCursor: 0,
      fromExclusiveCursor: 0,
      highWaterCursor: 1,
      nextCursor: 1,
      items: [
        {
          cursor: 1,
          itemType: 'acceptance',
          record: release,
          recordDigest: digest,
        },
      ],
      hasMore: false,
      generatedAt: '2026-08-16T12:04:00.000Z',
      pageDigest: digest,
    };
    expect(closureProjectionPageV06Schema.parse(page)).toEqual(page);
    expect(
      closureProjectionPageV06Schema.safeParse({
        ...page,
        items: [{ ...page.items[0], cursor: 0 }],
      }).success,
    ).toBe(false);
    expect(
      closureProjectionPageV06Schema.safeParse({ ...page, nextCursor: 0 }).success,
    ).toBe(false);
  });
});
