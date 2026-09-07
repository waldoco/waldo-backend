import {
  acceptanceCheckV06Schema,
  canonicalizeAcceptanceCheckV06ForDigest,
  evidenceAdmissionRequestV06Schema,
  type AcceptanceCheckV06,
} from '@waldo/contracts';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ClosureCommandSequencer, ClosureCanonicalConflictError } from '../src/coordinator/closure-command-sequencer';
import { ClosurePersistenceModule } from '../src/coordinator/closure-persistence-module';
import { EvidenceVerifier, type TrustedClosureObservation } from '../src/coordinator/evidence-verifier';
import { provisionDoSchema } from '../src/do-schema';
import { ResponsibilityDigestConflictError } from '../src/responsibility/errors';
import type { RuntimeProbeDO } from '../src/index';

let sequence = 0;
const at = '2026-09-07T12:30:00.000Z';
const digest = (char: string) => `sha256:${char.repeat(64)}` as const;

function freshStub(): DurableObjectStub<RuntimeProbeDO> {
  sequence += 1;
  return env.RUNTIME_DO.get(env.RUNTIME_DO.idFromName(`closure-sequencer-${sequence}`));
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function makeCheck(): Promise<AcceptanceCheckV06> {
  const provisional = acceptanceCheckV06Schema.parse({
    protocolVersion: '0.6',
    id: 'check_01',
    ownerId: 'owner_01',
    revision: 1,
    digest: digest('0'),
    subject: {
      outcome: { id: 'outcome_01', revision: 1, digest: digest('1') },
      workUnit: { id: 'work_unit_01', revision: 2, digest: digest('2') },
    },
    criterion: {
      ref: 'criterion_01', revision: 1, version: '1.0.0', digest: digest('3'),
    },
    verificationMethod: {
      kind: 'deterministic_read_back',
      capability: 'calendar.read',
      version: 'calendar-readback-v1',
      material: { ref: 'method_01', digest: digest('4') },
    },
    state: 'active',
    createdAt: at,
    updatedAt: at,
  });
  return acceptanceCheckV06Schema.parse({
    ...provisional,
    digest: `sha256:${await sha256Hex(canonicalizeAcceptanceCheckV06ForDigest(provisional))}`,
  });
}

function canonicalObservation(check: AcceptanceCheckV06): TrustedClosureObservation {
  return Object.freeze({
    ownerId: check.ownerId,
    subject: check.subject,
    reference: {
      kind: 'execution_observation',
      id: 'execution_observation_01',
      revision: 1,
      digest: digest('5'),
    },
    producer: {
      kind: 'execution_environment',
      id: 'kennel_executor_01',
      version: '1.0.0',
    },
    observedAt: '2026-09-07T12:29:00.000Z',
  });
}

function request(observation: TrustedClosureObservation['reference']) {
  return evidenceAdmissionRequestV06Schema.parse({
    protocolVersion: '0.6',
    requestId: 'request_evidence_01',
    commandType: 'evidence.admit',
    presenceRegistrationId: 'presence_registration_01',
    aggregate: { kind: 'acceptance_check', id: 'check_01', expectedRevision: 1 },
    payload: { observation },
  });
}

function seedOwnerRoot(sql: SqlStorage): void {
  sql.exec(
    'INSERT INTO owner_roots (root_key, owner_id, created_at) VALUES (1, ?, ?)',
    'owner_01',
    at,
  );
}

describe('ClosureCommandSequencer', () => {
  it('admits Evidence through preflight + transaction reread and returns exact persisted bytes on duplicate', async () => {
    const check = await makeCheck();
    const observation = canonicalObservation(check);
    const input = request(observation.reference);
    const stub = freshStub();

    const observed = await runInDurableObject(stub, async (_instance, state) => {
      provisionDoSchema(state.storage);
      seedOwnerRoot(state.storage.sql);
      let eventId = 0;
      let evidenceId = 0;
      const persistence = new ClosurePersistenceModule(
        state.storage,
        (kind) => `${kind}_${++eventId}`,
      );
      const evidenceVerifier = new EvidenceVerifier({
        now: () => at,
        newId: (kind) => kind === 'evidence' ? `evidence_${++evidenceId}` : 'verification_unused',
        sha256Hex,
        admitter: { kind: 'service', id: 'evidence_verifier' },
        verifier: async () => { throw new Error('not used by Evidence admission'); },
      });
      const sequencer = new ClosureCommandSequencer(state.storage, {
        now: () => at,
        sha256Hex,
        persistence,
        evidenceVerifier,
        readAcceptanceCheckInCurrentTransaction: ({ ownerId, id, expectedRevision }) => {
          if (ownerId !== check.ownerId || id !== check.id || expectedRevision !== check.revision) {
            throw new ClosureCanonicalConflictError();
          }
          return check;
        },
        readObservationInCurrentTransaction: ({ ownerId, reference }) => {
          if (ownerId !== observation.ownerId || JSON.stringify(reference) !== JSON.stringify(observation.reference)) {
            throw new ClosureCanonicalConflictError();
          }
          return observation;
        },
      });

      const first = await sequencer.admitEvidence({
        ownerId: 'owner_01', request: input, correlationId: 'correlation_01',
      });
      const duplicate = await sequencer.admitEvidence({
        ownerId: 'owner_01', request: input, correlationId: 'correlation_ignored',
      });
      const stored = state.storage.sql.exec<{ result_json: string }>(
        'SELECT result_json FROM closure_commands WHERE request_id = ?',
        input.requestId,
      ).one();

      let changedDuplicateRejected = false;
      const changed = evidenceAdmissionRequestV06Schema.parse({
        ...input,
        payload: {
          observation: { ...input.payload.observation, digest: digest('f') },
        },
      });
      try {
        await sequencer.admitEvidence({
          ownerId: 'owner_01', request: changed, correlationId: 'correlation_changed',
        });
      } catch (error) {
        changedDuplicateRejected = error instanceof ResponsibilityDigestConflictError;
      }

      return {
        first,
        duplicate,
        stored,
        changedDuplicateRejected,
        counts: {
          evidence: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM closure_evidence').one().n,
          events: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM owner_domain_events').one().n,
          projections: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM closure_projection').one().n,
          commands: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM closure_commands').one().n,
        },
      };
    });

    expect(observed.first.replayed).toBe(false);
    expect(observed.duplicate.replayed).toBe(true);
    expect(observed.duplicate.rawJson).toBe(observed.first.rawJson);
    expect(observed.duplicate.rawJson).toBe(observed.stored.result_json);
    expect(observed.duplicate.value).toEqual(observed.first.value);
    expect(observed.changedDuplicateRejected).toBe(true);
    expect(observed.counts).toEqual({ evidence: 1, events: 1, projections: 1, commands: 1 });
  });

  it('fails closed without persistence when the canonical observation changes between preflight and commit', async () => {
    const check = await makeCheck();
    const observation = canonicalObservation(check);
    const input = request(observation.reference);
    const stub = freshStub();

    const observed = await runInDurableObject(stub, async (_instance, state) => {
      provisionDoSchema(state.storage);
      seedOwnerRoot(state.storage.sql);
      const persistence = new ClosurePersistenceModule(state.storage, (kind) => `${kind}_race`);
      const evidenceVerifier = new EvidenceVerifier({
        now: () => at,
        newId: () => 'evidence_race',
        sha256Hex,
        admitter: { kind: 'service', id: 'evidence_verifier' },
        verifier: async () => { throw new Error('not used'); },
      });
      let observationReads = 0;
      const sequencer = new ClosureCommandSequencer(state.storage, {
        now: () => at,
        sha256Hex,
        persistence,
        evidenceVerifier,
        readAcceptanceCheckInCurrentTransaction: () => check,
        readObservationInCurrentTransaction: () => {
          observationReads += 1;
          return observationReads === 1
            ? observation
            : Object.freeze({ ...observation, observedAt: '2026-09-07T12:29:30.000Z' });
        },
      });

      let conflict = false;
      try {
        await sequencer.admitEvidence({
          ownerId: 'owner_01', request: input, correlationId: 'correlation_race',
        });
      } catch (error) {
        conflict = error instanceof ClosureCanonicalConflictError;
      }
      return {
        conflict,
        observationReads,
        counts: {
          evidence: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM closure_evidence').one().n,
          events: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM owner_domain_events').one().n,
          projections: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM closure_projection').one().n,
          commands: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM closure_commands').one().n,
        },
      };
    });

    expect(observed.conflict).toBe(true);
    expect(observed.observationReads).toBe(2);
    expect(observed.counts).toEqual({ evidence: 0, events: 0, projections: 0, commands: 0 });
  });
});
