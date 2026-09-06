import { describe, expect, it } from 'vitest';
import { acceptanceCheckV06Schema } from '@waldo/contracts';
import {
  EvidenceVerifier,
  type ClosureVerifierPort,
  type TrustedClosureObservation,
} from '../src/coordinator/evidence-verifier';

const digest = (hex: string) => `sha256:${hex.repeat(64).slice(0, 64)}` as const;

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const subject = Object.freeze({
  outcome: { id: 'outcome_01', revision: 1, digest: digest('1') },
  workUnit: { id: 'work_01', revision: 2, digest: digest('2') },
});

const acceptanceCheck = acceptanceCheckV06Schema.parse({
  protocolVersion: '0.6',
  id: 'check_01',
  ownerId: 'owner_01',
  revision: 1,
  digest: digest('3'),
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

const observation: TrustedClosureObservation = Object.freeze({
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
});

function makeVerifier(port: ClosureVerifierPort) {
  let evidenceId = 0;
  let verificationId = 0;
  return new EvidenceVerifier({
    now: () => '2026-09-06T14:02:00.000Z',
    newId: (kind) => kind === 'evidence'
      ? `evidence_${++evidenceId}`
      : `verification_${++verificationId}`,
    sha256Hex,
    admitter: { kind: 'service', id: 'evidence_verifier' },
    verifier: port,
  });
}

const disclosure = { ref: 'verifier_disclosure', digest: digest('7') } as const;

async function admittedEnvelope(verifier: EvidenceVerifier) {
  const evidence = await verifier.admitEvidence({
    ownerId: 'owner_01',
    acceptanceCheck,
    observation,
  });
  const envelope = await verifier.buildCurrentEvidenceSet({
    ownerId: 'owner_01',
    acceptanceCheck,
    evidence: [evidence],
  });
  return { evidence, envelope };
}

describe('EvidenceVerifier', () => {
  it('derives Evidence provenance from a trusted canonical observation', async () => {
    const verifier = makeVerifier(async () => ({
      state: 'passed',
      verifier: {
        id: 'calendar_verifier',
        version: '1.0.0',
        availability: 'available',
        independentFromProducer: true,
        disclosure,
      },
      findings: null,
    }));

    const evidence = await verifier.admitEvidence({
      ownerId: 'owner_01',
      acceptanceCheck,
      observation,
    });

    expect(evidence).toMatchObject({
      protocolVersion: '0.6',
      ownerId: 'owner_01',
      revision: 1,
      acceptanceCheck: {
        id: acceptanceCheck.id,
        revision: acceptanceCheck.revision,
        digest: acceptanceCheck.digest,
      },
      observation: observation.reference,
      provenance: {
        producer: observation.producer,
        admittedBy: { kind: 'service', id: 'evidence_verifier' },
      },
      state: 'admitted',
      observedAt: observation.observedAt,
      admittedAt: '2026-09-06T14:02:00.000Z',
    });
  });

  it('builds a deterministic exact Evidence-set envelope', async () => {
    const verifier = makeVerifier(async () => ({
      state: 'passed',
      verifier: {
        id: 'calendar_verifier',
        version: '1.0.0',
        availability: 'available',
        independentFromProducer: true,
        disclosure,
      },
      findings: null,
    }));

    const { evidence, envelope } = await admittedEnvelope(verifier);

    expect(envelope.count).toBe(1);
    expect(envelope.records).toEqual([evidence]);
    expect(envelope.evidence).toHaveLength(1);
    expect(envelope.evidence[0]).toMatchObject({ id: evidence.id, revision: 1 });
    expect(envelope.evidence[0]!.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(envelope.evidenceSetDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(envelope.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('records passed only for an available independent verifier', async () => {
    const verifier = makeVerifier(async () => ({
      state: 'passed',
      verifier: {
        id: 'calendar_verifier',
        version: '1.0.0',
        availability: 'available',
        independentFromProducer: true,
        disclosure,
      },
      findings: { ref: 'findings_01', digest: digest('8') },
    }));
    const { envelope } = await admittedEnvelope(verifier);

    const verification = await verifier.verify({
      ownerId: 'owner_01',
      acceptanceCheck,
      evidence: envelope,
    });

    expect(verification.state).toBe('passed');
    expect(verification.verifier).toMatchObject({
      id: 'calendar_verifier',
      availability: 'available',
      independentFromProducer: true,
    });
    expect(verification.method).toEqual({
      kind: acceptanceCheck.verificationMethod.kind,
      version: acceptanceCheck.verificationMethod.version,
    });
    expect(verification.evidenceSetDigest).toBe(envelope.evidenceSetDigest);
  });

  it('downgrades a colluding verifier to indeterminate even if it claims passed', async () => {
    const verifier = makeVerifier(async () => ({
      state: 'passed',
      verifier: {
        id: observation.producer.id,
        version: '1.0.0',
        availability: 'available',
        independentFromProducer: true,
        disclosure,
      },
      findings: null,
    }));
    const { envelope } = await admittedEnvelope(verifier);

    const verification = await verifier.verify({
      ownerId: 'owner_01',
      acceptanceCheck,
      evidence: envelope,
    });

    expect(verification.state).toBe('indeterminate');
    expect(verification.verifier.independentFromProducer).toBe(false);
  });

  it('maps unavailable verifier execution to indeterminate, never passed', async () => {
    const verifier = makeVerifier(async () => ({
      state: 'passed',
      verifier: {
        id: 'calendar_verifier',
        version: '1.0.0',
        availability: 'unavailable',
        independentFromProducer: true,
        disclosure,
      },
      findings: null,
    }));
    const { envelope } = await admittedEnvelope(verifier);

    const verification = await verifier.verify({
      ownerId: 'owner_01',
      acceptanceCheck,
      evidence: envelope,
    });

    expect(verification.state).toBe('indeterminate');
    expect(verification.verifier.availability).toBe('unavailable');
  });

  it('fails closed on owner or subject substitution before verifier execution', async () => {
    let calls = 0;
    const verifier = makeVerifier(async () => {
      calls += 1;
      return {
        state: 'passed',
        verifier: {
          id: 'calendar_verifier',
          version: '1.0.0',
          availability: 'available',
          independentFromProducer: true,
          disclosure,
        },
        findings: null,
      };
    });

    await expect(verifier.admitEvidence({
      ownerId: 'owner_other',
      acceptanceCheck,
      observation,
    })).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
