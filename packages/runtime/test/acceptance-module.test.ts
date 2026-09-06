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
const digest = (char: string) => `sha256:${char.repeat(64)}` as const;
const ref = (id: string, char: string, revision = 1) => ({ id, revision, digest: digest(char) });
const subject = Object.freeze({ outcome: ref('outcome_01', '1'), workUnit: ref('work_01', '2', 2) });

async function sha(value: string): Promise<`sha256:${string}`> {
  return `sha256:${await sha256Hex(value)}`;
}

async function closureProof() {
  const provisionalCheck = acceptanceCheckV06Schema.parse({
    protocolVersion: '0.6', id: 'check_01', ownerId: 'owner_01', revision: 1,
    digest: digest('0'), subject,
    criterion: { ref: 'criterion_01', revision: 1, version: '1.0.0', digest: digest('4') },
    verificationMethod: {
      kind: 'deterministic_read_back', capability: 'calendar.read',
      version: 'calendar-readback-v1', material: { ref: 'method_01', digest: digest('5') },
    },
    state: 'active', createdAt: '2026-09-06T14:00:00.000Z', updatedAt: '2026-09-06T14:00:00.000Z',
  });
  const check = acceptanceCheckV06Schema.parse({
    ...provisionalCheck,
    digest: await sha(canonicalizeAcceptanceCheckV06ForDigest(provisionalCheck)),
  });
  const provisionalSet = activeAcceptanceCheckSetV06Schema.parse({
    protocolVersion: '0.6', ownerId: 'owner_01', subject, revision: 1, count: 1,
    digest: digest('0'),
    acceptanceChecks: [{ id: check.id, revision: check.revision, digest: check.digest }],
    records: [check],
  });
  const activeChecks = activeAcceptanceCheckSetV06Schema.parse({
    ...provisionalSet,
    digest: await sha(canonicalizeActiveAcceptanceCheckSetV06ForDigest(provisionalSet)),
  });
  const evidenceVerifier = new EvidenceVerifier({
    now: () => '2026-09-06T14:02:00.000Z',
    newId: (kind) => kind === 'evidence' ? 'evidence_01' : 'verification_01',
    sha256Hex,
    admitter: { kind: 'service', id: 'evidence_verifier' },
    verifier: async () => ({
      state: 'passed',
      verifier: {
        id: 'calendar_verifier', version: '1.0.0', availability: 'available',
        independentFromProducer: true,
        disclosure: { ref: 'disclosure_01', digest: digest('7') },
      },
      findings: { ref: 'findings_01', digest: digest('8') },
    }),
  });
  const evidence = await evidenceVerifier.admitEvidence({
    ownerId: 'owner_01', acceptanceCheck: check,
    observation: {
      ownerId: 'owner_01', subject,
      reference: { kind: 'execution_observation', id: 'execution_observation_01', revision: 1, digest: digest('6') },
      producer: { kind: 'execution_environment', id: 'kennel_executor_01', version: '1.0.0' },
      observedAt: '2026-09-06T14:01:00.000Z',
    },
  });
  const evidenceSet = await evidenceVerifier.buildCurrentEvidenceSet({
    ownerId: 'owner_01', acceptanceCheck: check, evidence: [evidence],
  });
  const verification = await evidenceVerifier.verify({
    ownerId: 'owner_01', acceptanceCheck: check, evidence: evidenceSet,
  });
  const verificationRef = {
    id: verification.id,
    revision: verification.revision,
    digest: await sha(canonicalizeProtocolJson(verification)),
  };
  return { activeChecks, evidenceSet, verification, verificationRef };
}

function module() {
  return new AcceptanceModule({
    now: () => '2026-09-06T14:03:00.000Z',
    newId: () => 'acceptance_01',
    sha256Hex,
  });
}

function request(decision: 'accept' | 'release', verifications: unknown[] = []) {
  return acceptanceRecordRequestV06Schema.parse({
    protocolVersion: '0.6',
    requestId: `request_${decision}`,
    commandType: 'acceptance.record',
    presenceRegistrationId: 'presence_registration_01',
    aggregate: { kind: 'outcome', id: 'outcome_01', expectedRevision: 1 },
    payload: decision === 'accept'
      ? { decision, verifications, reasonRef: null }
      : { decision, verifications, reasonRef: 'owner_release_reason' },
  });
}

describe('AcceptanceModule', () => {
  it('accepts only complete current passed independent coverage for the authenticated owner', async () => {
    const proof = await closureProof();
    const acceptance = await module().record({
      ownerId: 'owner_01', authenticatedOwnerId: 'owner_01', subject,
      request: request('accept', [proof.verificationRef]),
      activeChecks: proof.activeChecks,
      evidenceSets: [proof.evidenceSet],
      verifications: [proof.verification],
    });
    expect(acceptance).toMatchObject({
      ownerId: 'owner_01', actor: { kind: 'owner', id: 'owner_01' },
      mode: 'explicit_owner', decision: 'accepted',
    });
  });

  it('rejects missing or non-passed verification coverage', async () => {
    const proof = await closureProof();
    await expect(module().record({
      ownerId: 'owner_01', authenticatedOwnerId: 'owner_01', subject,
      request: request('accept', [proof.verificationRef]), activeChecks: proof.activeChecks,
      evidenceSets: [proof.evidenceSet], verifications: [],
    })).rejects.toThrow();
    await expect(module().record({
      ownerId: 'owner_01', authenticatedOwnerId: 'owner_01', subject,
      request: request('accept', [proof.verificationRef]), activeChecks: proof.activeChecks,
      evidenceSets: [proof.evidenceSet],
      verifications: [{ ...proof.verification, state: 'failed' as const }],
    })).rejects.toThrow();
  });

  it('keeps release distinct from verified acceptance', async () => {
    const release = await module().record({
      ownerId: 'owner_01', authenticatedOwnerId: 'owner_01', subject,
      request: request('release'), activeChecks: null, evidenceSets: [], verifications: [],
    });
    expect(release).toMatchObject({
      ownerId: 'owner_01', actor: { kind: 'owner', id: 'owner_01' },
      decision: 'released', reasonRef: 'owner_release_reason', verifications: [],
    });
    expect('activeAcceptanceChecks' in release).toBe(false);
    expect('evidenceSets' in release).toBe(false);
  });

  it('rejects authenticated-owner or outcome-revision substitution', async () => {
    await expect(module().record({
      ownerId: 'owner_01', authenticatedOwnerId: 'owner_other', subject,
      request: request('release'), activeChecks: null, evidenceSets: [], verifications: [],
    })).rejects.toThrow();
    const staleRequest = acceptanceRecordRequestV06Schema.parse({
      ...request('release'), aggregate: { kind: 'outcome', id: 'outcome_01', expectedRevision: 2 },
    });
    await expect(module().record({
      ownerId: 'owner_01', authenticatedOwnerId: 'owner_01', subject,
      request: staleRequest, activeChecks: null, evidenceSets: [], verifications: [],
    })).rejects.toThrow();
  });
});
