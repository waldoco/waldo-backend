import { describe, expect, it } from 'vitest';
import {
  acceptanceCheckV06Schema,
  acceptanceRecordRequestV06Schema,
  activeAcceptanceCheckSetV06Schema,
  canonicalizeAcceptanceCheckV06ForDigest,
  canonicalizeActiveAcceptanceCheckSetV06ForDigest,
  canonicalizeProtocolJson,
} from '@waldo/contracts';
import { AcceptanceModule } from '../src/coordinator/acceptance-module';
import { EvidenceVerifier } from '../src/coordinator/evidence-verifier';

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha(value: string): Promise<`sha256:${string}`> {
  return `sha256:${await sha256Hex(value)}`;
}

const digest = (hex: string) => `sha256:${hex.repeat(64).slice(0, 64)}` as const;
const subject = Object.freeze({
  outcome: { id: 'outcome_01', revision: 1, digest: digest('1') },
  workUnit: { id: 'work_01', revision: 2, digest: digest('2') },
});

async function makeAcceptanceCheck() {
  const provisional = acceptanceCheckV06Schema.parse({
    protocolVersion: '0.6',
    id: 'check_01',
    ownerId: 'owner_01',
    revision: 1,
    digest: digest('0'),
    subject,
    criterion: {
      ref: 'criterion_01',
      revision: 1,
      version: '1.0.0',
      digest: digest('4'),
    },
    verificationMethod: {
      kind: 'deterministic_read_back',
      capability: 'calendar.read',
      version: 'calendar-readback-v1',
      material: { ref: 'method_01', digest: digest('5') },
    },
    state: 'active',
    createdAt: '2026-09-06T14:00:00.000Z',
    updatedAt: '2026-09-06T14:00:00.000Z',
  });
  return acceptanceCheckV06Schema.parse({
    ...provisional,
    digest: await sha(canonicalizeAcceptanceCheckV06ForDigest(provisional)),
  });
}

async function makeActiveSet(check: Awaited<ReturnType<typeof makeAcceptanceCheck>>) {
  const provisional = activeAcceptanceCheckSetV06Schema.parse({
    protocolVersion: '0.6',
    ownerId: 'owner_01',
    subject,
    revision: 1,
    count: 1,
    digest: digest('0'),
    acceptanceChecks: [{ id: check.id, revision: check.revision, digest: check.digest }],
    records: [check],
  });
  return activeAcceptanceCheckSetV06Schema.parse({
    ...provisional,
    digest: await sha(canonicalizeActiveAcceptanceCheckSetV06ForDigest(provisional)),
  });
}

async function makeVerifiedClosure() {
  const check = await makeAcceptanceCheck();
  const activeChecks = await makeActiveSet(check);
  const verifier = new EvidenceVerifier({
    now: () => '2026-09-06T14:02:00.000Z',
    newId: (kind) => kind === 'evidence' ? 'evidence_01' : 'verification_01',
    sha256Hex,
    admitter: { kind: 'service', id: 'evidence_verifier' },
    verifier: async () => ({
      state: 'passed',
      verifier: {
        id: 'calendar_verifier',
        version: '1.0.0',
        availability: 'available',
        independentFromProducer: true,
        disclosure: { ref: 'disclosure_01', digest: digest('7') },
      },
      findings: { ref: 'findings_01', digest: digest('8') },
    }),
  });
  const evidence = await verifier.admitEvidence({
    ownerId: 'owner_01',
    acceptanceCheck: check,
    observation: {
      ownerId: 'owner_01',
      subject,
      reference: {
        kind: 'execution_observation',
        id: 'execution_observation_01',
        revision: 1,
        digest: digest('6'),
      },
      producer: {
        kind: 'execution_environment',
        id: 'kennel_executor_01',
        version: '1.0.0',
      },
      observedAt: '2026-09-06T14:01:00.000Z',
    },
  });
  const evidenceSet = await verifier.buildCurrentEvidenceSet({
    ownerId: 'owner_01',
    acceptanceCheck: check,
    evidence: [evidence],
  });
  const verification = await verifier.verify({
    ownerId: 'owner_01',
    acceptanceCheck: check,
    evidence: evidenceSet,
  });
  const verificationRef = {
    id: verification.id,
    revision: verification.revision,
    digest: await sha(canonicalizeProtocolJson(verification)),
  };
  return { check, activeChecks, evidenceSet, verification, verificationRef };
}

function makeModule() {
  let id = 0;
  return new AcceptanceModule({
    now: () => '2026-09-06T14:03:00.000Z',
    newId: () => `acceptance_${++id}`,
    sha256Hex,
  });
}

describe('AcceptanceModule', () => {
  it('records explicit owner Acceptance only for complete current passed verification coverage', async () => {
    const proof = await makeVerifiedClosure();
    const request = acceptanceRecordRequestV06Schema.parse({
      protocolVersion: '0.6',
      requestId: 'accept_request_01',
      commandType: 'acceptance.record',
      presenceRegistrationId: 'presence_registration_01',
      aggregate: { kind: 'outcome', id: 'outcome_01', expectedRevision: 1 },
      payload: {
        decision: 'accept',
        verifications: [proof.verificationRef],
        reasonRef: null,
      },
    });

    const acceptance = await makeModule().record({
      ownerId: 'owner_01',
      subject,
      request,
      activeChecks: proof.activeChecks,
      evidenceSets: [proof.evidenceSet],
      verifications: [proof.verification],
    });

    expect(acceptance).toMatchObject({
      protocolVersion: '0.6',
      ownerId: 'owner_01',
      actor: { kind: 'owner', id: 'owner_01' },
      mode: 'explicit_owner',
      decision: 'accepted',
      reasonRef: null,
    });
    if (acceptance.decision !== 'accepted') throw new Error('expected accepted');
    expect(acceptance.activeAcceptanceChecks).toEqual({
      revision: proof.activeChecks.revision,
      count: proof.activeChecks.count,
      digest: proof.activeChecks.digest,
    });
    expect(acceptance.verifications).toEqual([proof.verificationRef]);
  });

  it('rejects partial or missing verification coverage', async () => {
    const proof = await makeVerifiedClosure();
    const request = acceptanceRecordRequestV06Schema.parse({
      protocolVersion: '0.6',
      requestId: 'accept_request_partial',
      commandType: 'acceptance.record',
      presenceRegistrationId: 'presence_registration_01',
      aggregate: { kind: 'outcome', id: 'outcome_01', expectedRevision: 1 },
      payload: {
        decision: 'accept',
        verifications: [proof.verificationRef],
        reasonRef: null,
      },
    });

    await expect(makeModule().record({
      ownerId: 'owner_01',
      subject,
      request,
      activeChecks: proof.activeChecks,
      evidenceSets: [proof.evidenceSet],
      verifications: [],
    })).rejects.toThrow();
  });

  it('rejects stale or non-passed verification material', async () => {
    const proof = await makeVerifiedClosure();
    const failedVerification = {
      ...proof.verification,
      state: 'failed' as const,
    };
    const failedRef = {
      id: failedVerification.id,
      revision: failedVerification.revision,
      digest: await sha(canonicalizeProtocolJson(failedVerification)),
    };
    const request = acceptanceRecordRequestV06Schema.parse({
      protocolVersion: '0.6',
      requestId: 'accept_request_failed',
      commandType: 'acceptance.record',
      presenceRegistrationId: 'presence_registration_01',
      aggregate: { kind: 'outcome', id: 'outcome_01', expectedRevision: 1 },
      payload: { decision: 'accept', verifications: [failedRef], reasonRef: null },
    });

    await expect(makeModule().record({
      ownerId: 'owner_01',
      subject,
      request,
      activeChecks: proof.activeChecks,
      evidenceSets: [proof.evidenceSet],
      verifications: [failedVerification],
    })).rejects.toThrow();
  });

  it('records Release as a distinct conscious owner disposition without claiming verification', async () => {
    const request = acceptanceRecordRequestV06Schema.parse({
      protocolVersion: '0.6',
      requestId: 'release_request_01',
      commandType: 'acceptance.record',
      presenceRegistrationId: 'presence_registration_01',
      aggregate: { kind: 'outcome', id: 'outcome_01', expectedRevision: 1 },
      payload: {
        decision: 'release',
        verifications: [],
        reasonRef: 'owner_no_longer_wants_outcome',
      },
    });

    const release = await makeModule().record({
      ownerId: 'owner_01',
      subject,
      request,
      activeChecks: null,
      evidenceSets: [],
      verifications: [],
    });

    expect(release).toEqual(expect.objectContaining({
      ownerId: 'owner_01',
      actor: { kind: 'owner', id: 'owner_01' },
      decision: 'released',
      reasonRef: 'owner_no_longer_wants_outcome',
      verifications: [],
    }));
    expect('activeAcceptanceChecks' in release).toBe(false);
    expect('evidenceSets' in release).toBe(false);
  });

  it('rejects owner or outcome revision substitution', async () => {
    const request = acceptanceRecordRequestV06Schema.parse({
      protocolVersion: '0.6',
      requestId: 'release_request_wrong_owner',
      commandType: 'acceptance.record',
      presenceRegistrationId: 'presence_registration_01',
      aggregate: { kind: 'outcome', id: 'outcome_01', expectedRevision: 1 },
      payload: {
        decision: 'release',
        verifications: [],
        reasonRef: 'owner_no_longer_wants_outcome',
      },
    });

    await expect(makeModule().record({
      ownerId: 'owner_other',
      subject,
      request,
      activeChecks: null,
      evidenceSets: [],
      verifications: [],
    })).rejects.toThrow();
  });
});
