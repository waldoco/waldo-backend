import {
  acceptanceCheckV06Schema,
  acceptanceRecordRequestV06Schema,
  canonicalizeAcceptanceCheckV06ForDigest,
  evidenceAdmissionRequestV06Schema,
  verificationRequestV06Schema,
  type AcceptanceCheckV06,
} from '@waldo/contracts';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { AcceptanceModule } from '../src/coordinator/acceptance-module';
import { ClosureAcceptanceCheckBuilder } from '../src/coordinator/closure-acceptance-check';
import { ClosureCommandSequencer, ClosureCanonicalConflictError } from '../src/coordinator/closure-command-sequencer';
import { ClosurePersistenceModule } from '../src/coordinator/closure-persistence-module';
import { EvidenceVerifier, type TrustedClosureObservation } from '../src/coordinator/evidence-verifier';
import { provisionDoSchema } from '../src/do-schema';
import type { RuntimeProbeDO } from '../src/index';

let sequence = 0;
const at = '2026-09-07T14:00:00.000Z';
const digest = (char: string) => `sha256:${char.repeat(64)}` as const;

function freshStub(): DurableObjectStub<RuntimeProbeDO> {
  sequence += 1;
  return env.RUNTIME_DO.get(env.RUNTIME_DO.idFromName(`closure-acceptance-sequencer-${sequence}`));
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

function observation(check: AcceptanceCheckV06): TrustedClosureObservation {
  return Object.freeze({
    ownerId: check.ownerId,
    subject: check.subject,
    reference: {
      kind: 'execution_observation', id: 'observation_01', revision: 1, digest: digest('5'),
    },
    producer: { kind: 'execution_environment', id: 'executor_01', version: '1.0.0' },
    observedAt: '2026-09-07T13:59:00.000Z',
  });
}

function seedOwnerRoot(sql: SqlStorage): void {
  sql.exec(
    'INSERT INTO owner_roots (root_key, owner_id, created_at) VALUES (1, ?, ?)',
    'owner_01', at,
  );
}

async function activeSet(check: AcceptanceCheckV06) {
  return new ClosureAcceptanceCheckBuilder({
    now: () => at,
    newId: () => 'unused',
    sha256Hex,
  }).buildActiveSet({
    canonical: { ownerId: check.ownerId, subject: check.subject },
    revision: 1,
    records: [check],
  });
}

describe('ClosureCommandSequencer Acceptance', () => {
  it('records Acceptance only from exact current active checks/Evidence/Verification and replays exact bytes', async () => {
    const check = await makeCheck();
    const checks = await activeSet(check);
    const canonicalObservation = observation(check);
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
          findings: null,
        }),
      });
      const acceptanceModule = new AcceptanceModule({
        now: () => at,
        newId: () => 'acceptance_01',
        sha256Hex,
      });
      const sequencer = new ClosureCommandSequencer(state.storage, {
        now: () => at, sha256Hex, persistence, evidenceVerifier, acceptanceModule,
        readAcceptanceCheckInCurrentTransaction: () => check,
        readObservationInCurrentTransaction: () => canonicalObservation,
        readOutcomeRefInCurrentTransaction: () => check.subject.outcome,
        readActiveAcceptanceChecksInCurrentTransaction: () => checks,
      });

      const admitted = await sequencer.admitEvidence({
        ownerId: check.ownerId, correlationId: 'correlation_evidence',
        request: evidenceAdmissionRequestV06Schema.parse({
          protocolVersion: '0.6', requestId: 'request_evidence_01', commandType: 'evidence.admit',
          presenceRegistrationId: 'presence_registration_01',
          aggregate: { kind: 'acceptance_check', id: check.id, expectedRevision: check.revision },
          payload: { observation: canonicalObservation.reference },
        }),
      });
      const verified = await sequencer.requestVerification({
        ownerId: check.ownerId, correlationId: 'correlation_verification',
        request: verificationRequestV06Schema.parse({
          protocolVersion: '0.6', requestId: 'request_verification_01',
          commandType: 'verification.request', presenceRegistrationId: 'presence_registration_01',
          aggregate: { kind: 'acceptance_check', id: check.id, expectedRevision: check.revision },
          payload: { evidence: [admitted.value.evidence] },
        }),
      });
      const acceptanceRequest = acceptanceRecordRequestV06Schema.parse({
        protocolVersion: '0.6', requestId: 'request_acceptance_01', commandType: 'acceptance.record',
        presenceRegistrationId: 'presence_registration_01',
        aggregate: { kind: 'outcome', id: check.subject.outcome.id, expectedRevision: check.subject.outcome.revision },
        payload: { decision: 'accept', verifications: [verified.value.verification], reasonRef: null },
      });
      const first = await sequencer.recordAcceptance({
        ownerId: check.ownerId, request: acceptanceRequest, correlationId: 'correlation_acceptance',
      });
      const duplicate = await sequencer.recordAcceptance({
        ownerId: check.ownerId, request: acceptanceRequest, correlationId: 'correlation_ignored',
      });
      const stored = state.storage.sql.exec<{ result_json: string }>(
        'SELECT result_json FROM closure_commands WHERE request_id = ?',
        acceptanceRequest.requestId,
      ).one();
      return {
        first,
        duplicate,
        stored,
        counts: {
          acceptances: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM closure_acceptances').one().n,
          events: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM owner_domain_events').one().n,
          projections: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM closure_projection').one().n,
          commands: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM closure_commands').one().n,
        },
      };
    });

    expect(observed.first.replayed).toBe(false);
    expect(observed.first.value.decision).toBe('accepted');
    expect(observed.duplicate.replayed).toBe(true);
    expect(observed.duplicate.rawJson).toBe(observed.first.rawJson);
    expect(observed.duplicate.rawJson).toBe(observed.stored.result_json);
    expect(observed.counts).toEqual({ acceptances: 1, events: 3, projections: 3, commands: 3 });
  });

  it('records zero-Verification Release from canonical Outcome material without requiring active checks', async () => {
    const check = await makeCheck();
    const canonicalObservation = observation(check);
    const stub = freshStub();

    const release = await runInDurableObject(stub, async (_instance, state) => {
      provisionDoSchema(state.storage);
      seedOwnerRoot(state.storage.sql);
      const persistence = new ClosurePersistenceModule(state.storage, (kind) => `${kind}_release`);
      const evidenceVerifier = new EvidenceVerifier({
        now: () => at,
        newId: () => 'unused',
        sha256Hex,
        admitter: { kind: 'service', id: 'evidence_verifier' },
        verifier: async () => { throw new Error('unused'); },
      });
      const acceptanceModule = new AcceptanceModule({
        now: () => at, newId: () => 'release_01', sha256Hex,
      });
      const sequencer = new ClosureCommandSequencer(state.storage, {
        now: () => at, sha256Hex, persistence, evidenceVerifier, acceptanceModule,
        readAcceptanceCheckInCurrentTransaction: () => check,
        readObservationInCurrentTransaction: () => canonicalObservation,
        readOutcomeRefInCurrentTransaction: () => check.subject.outcome,
        readActiveAcceptanceChecksInCurrentTransaction: () => null,
      });
      return sequencer.recordAcceptance({
        ownerId: check.ownerId,
        correlationId: 'correlation_release',
        request: acceptanceRecordRequestV06Schema.parse({
          protocolVersion: '0.6', requestId: 'request_release_01', commandType: 'acceptance.record',
          presenceRegistrationId: 'presence_registration_01',
          aggregate: { kind: 'outcome', id: check.subject.outcome.id, expectedRevision: check.subject.outcome.revision },
          payload: { decision: 'release', verifications: [], reasonRef: 'owner_release_reason' },
        }),
      });
    });

    expect(release.value.decision).toBe('released');
    const persisted = JSON.parse(release.rawJson);
    expect(persisted.decision).toBe('released');
  });

  it('rejects an in-flight Acceptance when the active AcceptanceCheck set changes before commit', async () => {
    const check = await makeCheck();
    const checks = await activeSet(check);
    const canonicalObservation = observation(check);
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
          findings: null,
        }),
      });
      const acceptanceModule = new AcceptanceModule({
        now: () => at, newId: () => 'acceptance_race', sha256Hex,
      });
      let activeReads = 0;
      const sequencer = new ClosureCommandSequencer(state.storage, {
        now: () => at, sha256Hex, persistence, evidenceVerifier, acceptanceModule,
        readAcceptanceCheckInCurrentTransaction: () => check,
        readObservationInCurrentTransaction: () => canonicalObservation,
        readOutcomeRefInCurrentTransaction: () => check.subject.outcome,
        readActiveAcceptanceChecksInCurrentTransaction: () => {
          activeReads += 1;
          return activeReads === 1 ? checks : null;
        },
      });

      const admitted = await sequencer.admitEvidence({
        ownerId: check.ownerId, correlationId: 'correlation_evidence',
        request: evidenceAdmissionRequestV06Schema.parse({
          protocolVersion: '0.6', requestId: 'request_evidence_01', commandType: 'evidence.admit',
          presenceRegistrationId: 'presence_registration_01',
          aggregate: { kind: 'acceptance_check', id: check.id, expectedRevision: check.revision },
          payload: { observation: canonicalObservation.reference },
        }),
      });
      const verified = await sequencer.requestVerification({
        ownerId: check.ownerId, correlationId: 'correlation_verification',
        request: verificationRequestV06Schema.parse({
          protocolVersion: '0.6', requestId: 'request_verification_01',
          commandType: 'verification.request', presenceRegistrationId: 'presence_registration_01',
          aggregate: { kind: 'acceptance_check', id: check.id, expectedRevision: check.revision },
          payload: { evidence: [admitted.value.evidence] },
        }),
      });
      const acceptanceRequest = acceptanceRecordRequestV06Schema.parse({
        protocolVersion: '0.6', requestId: 'request_acceptance_race', commandType: 'acceptance.record',
        presenceRegistrationId: 'presence_registration_01',
        aggregate: { kind: 'outcome', id: check.subject.outcome.id, expectedRevision: check.subject.outcome.revision },
        payload: { decision: 'accept', verifications: [verified.value.verification], reasonRef: null },
      });

      let conflict = false;
      try {
        await sequencer.recordAcceptance({
          ownerId: check.ownerId, request: acceptanceRequest, correlationId: 'correlation_acceptance',
        });
      } catch (error) {
        conflict = error instanceof ClosureCanonicalConflictError;
      }
      return {
        conflict,
        activeReads,
        acceptanceCount: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM closure_acceptances').one().n,
        acceptanceCommands: state.storage.sql.exec<{ n: number }>(
          "SELECT count(*) AS n FROM closure_commands WHERE command_type = 'acceptance.record'",
        ).one().n,
      };
    });

    expect(observed.conflict).toBe(true);
    expect(observed.activeReads).toBe(2);
    expect(observed.acceptanceCount).toBe(0);
    expect(observed.acceptanceCommands).toBe(0);
  });
});
