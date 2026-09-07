import {
  acceptanceCheckV06Schema,
  canonicalizeAcceptanceCheckV06ForDigest,
  canonicalizeProtocolJson,
  evidenceAdmissionRequestV06Schema,
  evidenceV06Schema,
  verificationRequestV06Schema,
  type AcceptanceCheckV06,
} from '@waldo/contracts';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ClosureCommandSequencer, ClosureCanonicalConflictError } from '../src/coordinator/closure-command-sequencer';
import { ClosurePersistenceModule } from '../src/coordinator/closure-persistence-module';
import { EvidenceVerifier, type TrustedClosureObservation } from '../src/coordinator/evidence-verifier';
import { provisionDoSchema } from '../src/do-schema';
import type { RuntimeProbeDO } from '../src/index';

let sequence = 0;
const at = '2026-09-07T13:00:00.000Z';
const digest = (char: string) => `sha256:${char.repeat(64)}` as const;

function freshStub(): DurableObjectStub<RuntimeProbeDO> {
  sequence += 1;
  return env.RUNTIME_DO.get(env.RUNTIME_DO.idFromName(`closure-verification-sequencer-${sequence}`));
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function makeCheck(): Promise<AcceptanceCheckV06> {
  const provisional = acceptanceCheckV06Schema.parse({
    protocolVersion: '0.6', id: 'check_01', ownerId: 'owner_01', revision: 1,
    digest: digest('0'),
    subject: {
      outcome: { id: 'outcome_01', revision: 1, digest: digest('1') },
      workUnit: { id: 'work_unit_01', revision: 2, digest: digest('2') },
    },
    criterion: { ref: 'criterion_01', revision: 1, version: '1.0.0', digest: digest('3') },
    verificationMethod: {
      kind: 'deterministic_read_back', capability: 'calendar.read',
      version: 'calendar-readback-v1', material: { ref: 'method_01', digest: digest('4') },
    },
    state: 'active', createdAt: at, updatedAt: at,
  });
  return acceptanceCheckV06Schema.parse({
    ...provisional,
    digest: `sha256:${await sha256Hex(canonicalizeAcceptanceCheckV06ForDigest(provisional))}`,
  });
}

function observation(check: AcceptanceCheckV06, id: string, hash: string): TrustedClosureObservation {
  return Object.freeze({
    ownerId: check.ownerId,
    subject: check.subject,
    reference: {
      kind: 'execution_observation', id, revision: 1, digest: digest(hash),
    },
    producer: { kind: 'execution_environment', id: `executor_${id}`, version: '1.0.0' },
    observedAt: '2026-09-07T12:59:00.000Z',
  });
}

function seedOwnerRoot(sql: SqlStorage): void {
  sql.exec(
    'INSERT INTO owner_roots (root_key, owner_id, created_at) VALUES (1, ?, ?)',
    'owner_01', at,
  );
}

describe('ClosureCommandSequencer Verification', () => {
  it('verifies the exact current admitted Evidence set and replays persisted result bytes exactly', async () => {
    const check = await makeCheck();
    const canonicalObservation = observation(check, 'observation_01', '5');
    const stub = freshStub();

    const observed = await runInDurableObject(stub, async (_instance, state) => {
      provisionDoSchema(state.storage);
      seedOwnerRoot(state.storage.sql);
      let ids = 0;
      const persistence = new ClosurePersistenceModule(state.storage, (kind) => `${kind}_${++ids}`);
      const evidenceVerifier = new EvidenceVerifier({
        now: () => at,
        newId: (kind) => kind === 'evidence' ? 'evidence_01' : 'verification_01',
        sha256Hex,
        admitter: { kind: 'service', id: 'evidence_verifier' },
        verifier: async () => ({
          state: 'passed',
          verifier: {
            id: 'calendar_verifier', version: '1.0.0', availability: 'available',
            independentFromProducer: true,
            disclosure: { ref: 'disclosure_01', digest: digest('6') },
          },
          findings: { ref: 'findings_01', digest: digest('7') },
        }),
      });
      const sequencer = new ClosureCommandSequencer(state.storage, {
        now: () => at,
        sha256Hex,
        persistence,
        evidenceVerifier,
        readAcceptanceCheckInCurrentTransaction: () => check,
        readObservationInCurrentTransaction: () => canonicalObservation,
      });

      const evidenceRequest = evidenceAdmissionRequestV06Schema.parse({
        protocolVersion: '0.6', requestId: 'request_evidence_01', commandType: 'evidence.admit',
        presenceRegistrationId: 'presence_registration_01',
        aggregate: { kind: 'acceptance_check', id: check.id, expectedRevision: check.revision },
        payload: { observation: canonicalObservation.reference },
      });
      const admitted = await sequencer.admitEvidence({
        ownerId: check.ownerId, request: evidenceRequest, correlationId: 'correlation_evidence',
      });
      const verificationRequest = verificationRequestV06Schema.parse({
        protocolVersion: '0.6', requestId: 'request_verification_01',
        commandType: 'verification.request', presenceRegistrationId: 'presence_registration_01',
        aggregate: { kind: 'acceptance_check', id: check.id, expectedRevision: check.revision },
        payload: { evidence: [admitted.value.evidence] },
      });
      const first = await sequencer.requestVerification({
        ownerId: check.ownerId, request: verificationRequest, correlationId: 'correlation_verification',
      });
      const duplicate = await sequencer.requestVerification({
        ownerId: check.ownerId, request: verificationRequest, correlationId: 'correlation_ignored',
      });
      const stored = state.storage.sql.exec<{ result_json: string }>(
        'SELECT result_json FROM closure_commands WHERE request_id = ?',
        verificationRequest.requestId,
      ).one();
      return {
        first,
        duplicate,
        stored,
        counts: {
          verifications: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM closure_verifications').one().n,
          events: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM owner_domain_events').one().n,
          projections: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM closure_projection').one().n,
          commands: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM closure_commands').one().n,
        },
      };
    });

    expect(observed.first.replayed).toBe(false);
    expect(observed.first.value.state).toBe('passed');
    expect(observed.duplicate.replayed).toBe(true);
    expect(observed.duplicate.rawJson).toBe(observed.first.rawJson);
    expect(observed.duplicate.rawJson).toBe(observed.stored.result_json);
    expect(observed.counts).toEqual({ verifications: 1, events: 2, projections: 2, commands: 2 });
  });

  it('rejects a caller-selected Evidence subset when more current admitted Evidence exists', async () => {
    const check = await makeCheck();
    const firstObservation = observation(check, 'observation_01', '5');
    const secondObservation = observation(check, 'observation_02', '6');
    const stub = freshStub();

    const rejected = await runInDurableObject(stub, async (_instance, state) => {
      provisionDoSchema(state.storage);
      seedOwnerRoot(state.storage.sql);
      let ids = 0;
      let evidenceIds = 0;
      const persistence = new ClosurePersistenceModule(state.storage, (kind) => `${kind}_${++ids}`);
      const evidenceVerifier = new EvidenceVerifier({
        now: () => at,
        newId: (kind) => kind === 'evidence' ? `evidence_${++evidenceIds}` : 'verification_01',
        sha256Hex,
        admitter: { kind: 'service', id: 'evidence_verifier' },
        verifier: async () => ({
          state: 'passed',
          verifier: {
            id: 'calendar_verifier', version: '1.0.0', availability: 'available',
            independentFromProducer: true,
            disclosure: { ref: 'disclosure_01', digest: digest('7') },
          },
          findings: null,
        }),
      });
      const byId = new Map([
        [firstObservation.reference.id, firstObservation],
        [secondObservation.reference.id, secondObservation],
      ]);
      const sequencer = new ClosureCommandSequencer(state.storage, {
        now: () => at, sha256Hex, persistence, evidenceVerifier,
        readAcceptanceCheckInCurrentTransaction: () => check,
        readObservationInCurrentTransaction: ({ reference }) => byId.get(reference.id)!,
      });

      const admit = async (trusted: TrustedClosureObservation, requestId: string) =>
        sequencer.admitEvidence({
          ownerId: check.ownerId,
          correlationId: `correlation_${requestId}`,
          request: evidenceAdmissionRequestV06Schema.parse({
            protocolVersion: '0.6', requestId, commandType: 'evidence.admit',
            presenceRegistrationId: 'presence_registration_01',
            aggregate: { kind: 'acceptance_check', id: check.id, expectedRevision: check.revision },
            payload: { observation: trusted.reference },
          }),
        });
      const first = await admit(firstObservation, 'request_evidence_01');
      await admit(secondObservation, 'request_evidence_02');

      const verificationRequest = verificationRequestV06Schema.parse({
        protocolVersion: '0.6', requestId: 'request_verification_subset',
        commandType: 'verification.request', presenceRegistrationId: 'presence_registration_01',
        aggregate: { kind: 'acceptance_check', id: check.id, expectedRevision: check.revision },
        payload: { evidence: [first.value.evidence] },
      });
      try {
        await sequencer.requestVerification({
          ownerId: check.ownerId, request: verificationRequest, correlationId: 'correlation_subset',
        });
        return false;
      } catch (error) {
        return error instanceof ClosureCanonicalConflictError;
      }
    });

    expect(rejected).toBe(true);
  });

  it('rejects an in-flight Verification if the current Evidence set changes before commit', async () => {
    const check = await makeCheck();
    const firstObservation = observation(check, 'observation_01', '5');
    const secondObservation = observation(check, 'observation_02', '6');
    const stub = freshStub();

    const observed = await runInDurableObject(stub, async (_instance, state) => {
      provisionDoSchema(state.storage);
      seedOwnerRoot(state.storage.sql);
      let ids = 0;
      const persistence = new ClosurePersistenceModule(state.storage, (kind) => `${kind}_${++ids}`);
      let insertedConcurrentEvidence = false;
      const evidenceVerifier = new EvidenceVerifier({
        now: () => at,
        newId: (kind) => kind === 'evidence' ? 'evidence_01' : 'verification_race',
        sha256Hex,
        admitter: { kind: 'service', id: 'evidence_verifier' },
        verifier: async () => {
          if (!insertedConcurrentEvidence) {
            insertedConcurrentEvidence = true;
            const concurrent = evidenceV06Schema.parse({
              protocolVersion: '0.6', id: 'evidence_concurrent', ownerId: check.ownerId, revision: 1,
              subject: check.subject,
              acceptanceCheck: { id: check.id, revision: check.revision, digest: check.digest },
              observation: secondObservation.reference,
              provenance: {
                producer: secondObservation.producer,
                admittedBy: { kind: 'service', id: 'evidence_verifier' },
              },
              state: 'admitted', observedAt: secondObservation.observedAt, admittedAt: at,
            });
            const concurrentDigest = `sha256:${await sha256Hex(canonicalizeProtocolJson(concurrent))}` as const;
            state.storage.transactionSync(() =>
              persistence.persistEvidenceInCurrentTransaction({
                evidence: concurrent,
                evidenceDigest: concurrentDigest,
                requestId: 'request_concurrent_evidence',
                requestDigest: digest('e'),
                requestJson: '{}',
                correlationId: 'correlation_concurrent',
                recordedAt: at,
              }),
            );
          }
          return {
            state: 'passed' as const,
            verifier: {
              id: 'calendar_verifier', version: '1.0.0', availability: 'available' as const,
              independentFromProducer: true,
              disclosure: { ref: 'disclosure_01', digest: digest('7') },
            },
            findings: null,
          };
        },
      });
      const sequencer = new ClosureCommandSequencer(state.storage, {
        now: () => at, sha256Hex, persistence, evidenceVerifier,
        readAcceptanceCheckInCurrentTransaction: () => check,
        readObservationInCurrentTransaction: () => firstObservation,
      });
      const admitted = await sequencer.admitEvidence({
        ownerId: check.ownerId,
        correlationId: 'correlation_evidence',
        request: evidenceAdmissionRequestV06Schema.parse({
          protocolVersion: '0.6', requestId: 'request_evidence_01', commandType: 'evidence.admit',
          presenceRegistrationId: 'presence_registration_01',
          aggregate: { kind: 'acceptance_check', id: check.id, expectedRevision: check.revision },
          payload: { observation: firstObservation.reference },
        }),
      });
      const verificationRequest = verificationRequestV06Schema.parse({
        protocolVersion: '0.6', requestId: 'request_verification_race',
        commandType: 'verification.request', presenceRegistrationId: 'presence_registration_01',
        aggregate: { kind: 'acceptance_check', id: check.id, expectedRevision: check.revision },
        payload: { evidence: [admitted.value.evidence] },
      });

      let conflict = false;
      try {
        await sequencer.requestVerification({
          ownerId: check.ownerId, request: verificationRequest, correlationId: 'correlation_verification',
        });
      } catch (error) {
        conflict = error instanceof ClosureCanonicalConflictError;
      }
      return {
        conflict,
        insertedConcurrentEvidence,
        counts: {
          evidence: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM closure_evidence').one().n,
          verifications: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM closure_verifications').one().n,
          verificationCommands: state.storage.sql.exec<{ n: number }>(
            "SELECT count(*) AS n FROM closure_commands WHERE command_type = 'verification.request'",
          ).one().n,
        },
      };
    });

    expect(observed.conflict).toBe(true);
    expect(observed.insertedConcurrentEvidence).toBe(true);
    expect(observed.counts).toEqual({ evidence: 2, verifications: 0, verificationCommands: 0 });
  });
});
