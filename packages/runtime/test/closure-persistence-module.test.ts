import {
  canonicalizeProtocolJson,
  closureProjectionItemV06Schema,
  evidenceAdmissionResultV06Schema,
  evidenceV06Schema,
  verificationResultV06Schema,
  verificationV06Schema,
} from '@waldo/contracts';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { provisionDoSchema } from '../src/do-schema';
import {
  ClosurePersistenceModule,
} from '../src/coordinator/closure-persistence-module';
import { ResponsibilityDigestConflictError } from '../src/responsibility/errors';
import type { RuntimeProbeDO } from '../src/index';

let sequence = 0;

function freshStub(): DurableObjectStub<RuntimeProbeDO> {
  sequence += 1;
  return env.RUNTIME_DO.get(env.RUNTIME_DO.idFromName(`closure-persistence-${sequence}`));
}

const digest = (char: string) => `sha256:${char.repeat(64)}` as const;
const at = '2026-09-07T08:00:00.000Z';
const subject = Object.freeze({
  outcome: Object.freeze({ id: 'outcome_01', revision: 1, digest: digest('1') }),
  workUnit: Object.freeze({ id: 'work_unit_01', revision: 2, digest: digest('2') }),
});
const acceptanceCheck = Object.freeze({ id: 'check_01', revision: 1, digest: digest('3') });

function seedOwnerRoot(sql: SqlStorage, ownerId: string): void {
  sql.exec(
    'INSERT INTO owner_roots (root_key, owner_id, created_at) VALUES (1, ?, ?)',
    ownerId,
    at,
  );
}

function evidence() {
  return evidenceV06Schema.parse({
    protocolVersion: '0.6',
    id: 'evidence_01',
    ownerId: 'owner_01',
    revision: 1,
    subject,
    acceptanceCheck,
    observation: {
      kind: 'execution_observation',
      id: 'execution_observation_01',
      revision: 1,
      digest: digest('4'),
    },
    provenance: {
      producer: { kind: 'execution_environment', id: 'executor_01', version: '1.0.0' },
      admittedBy: { kind: 'service', id: 'evidence_verifier' },
    },
    state: 'admitted',
    observedAt: '2026-09-07T07:59:00.000Z',
    admittedAt: at,
  });
}

function verification() {
  return verificationV06Schema.parse({
    protocolVersion: '0.6',
    id: 'verification_01',
    ownerId: 'owner_01',
    revision: 1,
    subject,
    acceptanceCheck,
    evidence: [{ id: 'evidence_01', revision: 1, digest: digest('5') }],
    evidenceSetDigest: digest('6'),
    method: { kind: 'deterministic_read_back', version: 'calendar-readback-v1' },
    verifier: {
      id: 'calendar_verifier',
      version: '1.0.0',
      availability: 'available',
      independentFromProducer: true,
      disclosure: { ref: 'disclosure_01', digest: digest('7') },
    },
    state: 'passed',
    findings: { ref: 'findings_01', digest: digest('8') },
    verifiedAt: at,
  });
}

describe('ClosurePersistenceModule', () => {
  it('commits Evidence, owner event, projection, and exact replay result as one owner transaction', async () => {
    const stub = freshStub();
    const record = evidence();
    const recordDigest = digest('9');
    const requestJson = canonicalizeProtocolJson({
      protocolVersion: '0.6',
      requestId: 'request_evidence_01',
      commandType: 'evidence.admit',
      aggregate: { kind: 'acceptance_check', id: acceptanceCheck.id, expectedRevision: 1 },
      payload: { observation: record.observation },
    });

    const observed = await runInDurableObject(stub, (_instance, state) => {
      provisionDoSchema(state.storage);
      seedOwnerRoot(state.storage.sql, record.ownerId);
      let idSequence = 0;
      const module = new ClosurePersistenceModule(
        state.storage,
        (kind) => `${kind}_${++idSequence}`,
      );

      const result = state.storage.transactionSync(() =>
        module.persistEvidenceInCurrentTransaction({
          evidence: record,
          evidenceDigest: recordDigest,
          requestId: 'request_evidence_01',
          requestDigest: digest('a'),
          requestJson,
          correlationId: 'correlation_01',
          recordedAt: at,
        }),
      );
      const duplicate = state.storage.transactionSync(() =>
        module.readCommandResultInCurrentTransaction({
          ownerId: record.ownerId,
          requestId: 'request_evidence_01',
          requestDigest: digest('a'),
        }),
      );

      const storedEvidence = state.storage.sql.exec<{
        evidence_json: string;
        evidence_digest: string;
      }>(
        'SELECT evidence_json, evidence_digest FROM closure_evidence WHERE owner_id = ?',
        record.ownerId,
      ).one();
      const event = state.storage.sql.exec<{
        owner_cursor: number;
        schema_version: string;
        aggregate_kind: string;
        aggregate_id: string;
        event_type: string;
        payload_json: string;
      }>(
        'SELECT owner_cursor, schema_version, aggregate_kind, aggregate_id, event_type, payload_json FROM owner_domain_events WHERE owner_id = ?',
        record.ownerId,
      ).one();
      const projection = state.storage.sql.exec<{ owner_cursor: number; item_json: string }>(
        'SELECT owner_cursor, item_json FROM closure_projection WHERE owner_id = ?',
        record.ownerId,
      ).one();
      const command = state.storage.sql.exec<{
        request_digest: string;
        request_json: string;
        result_json: string;
      }>(
        'SELECT request_digest, request_json, result_json FROM closure_commands WHERE owner_id = ?',
        record.ownerId,
      ).one();
      let changedDuplicateConflict = false;
      try {
        state.storage.transactionSync(() =>
          module.readCommandResultInCurrentTransaction({
            ownerId: record.ownerId,
            requestId: 'request_evidence_01',
            requestDigest: digest('b'),
          }),
        );
      } catch (error) {
        changedDuplicateConflict = error instanceof ResponsibilityDigestConflictError;
      }
      return {
        result,
        duplicate,
        storedEvidence,
        event,
        projection,
        command,
        changedDuplicateConflict,
        counts: {
          evidence: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM closure_evidence').one().n,
          events: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM owner_domain_events').one().n,
          projections: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM closure_projection').one().n,
          commands: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM closure_commands').one().n,
        },
      };
    });

    const result = evidenceAdmissionResultV06Schema.parse(observed.result);
    expect(result).toMatchObject({
      protocolVersion: '0.6',
      requestId: 'request_evidence_01',
      evidence: { id: record.id, revision: record.revision, digest: recordDigest },
      state: 'admitted',
      projectionCursor: 1,
    });
    expect(observed.duplicate).toBe(JSON.stringify(result));
    expect(observed.storedEvidence).toEqual({
      evidence_json: JSON.stringify(record),
      evidence_digest: recordDigest,
    });
    expect(observed.event).toMatchObject({
      owner_cursor: 1,
      schema_version: '0.6',
      aggregate_kind: 'evidence',
      aggregate_id: record.id,
      event_type: 'evidence.admitted',
      payload_json: JSON.stringify({ record, recordDigest }),
    });
    const projection = closureProjectionItemV06Schema.parse(JSON.parse(observed.projection.item_json));
    expect(projection).toEqual({
      cursor: 1,
      itemType: 'evidence',
      record,
      recordDigest,
    });
    expect(observed.projection.owner_cursor).toBe(1);
    expect(observed.command).toEqual({
      request_digest: digest('a'),
      request_json: requestJson,
      result_json: JSON.stringify(result),
    });
    expect(observed.changedDuplicateConflict).toBe(true);
    expect(observed.counts).toEqual({ evidence: 1, events: 1, projections: 1, commands: 1 });
  });

  it('persists Verification with the same event/projection/replay contract', async () => {
    const stub = freshStub();
    const record = verification();
    const recordDigest = digest('c');
    const observed = await runInDurableObject(stub, (_instance, state) => {
      provisionDoSchema(state.storage);
      seedOwnerRoot(state.storage.sql, record.ownerId);
      let idSequence = 0;
      const module = new ClosurePersistenceModule(
        state.storage,
        (kind) => `${kind}_${++idSequence}`,
      );
      const result = state.storage.transactionSync(() =>
        module.persistVerificationInCurrentTransaction({
          verification: record,
          verificationDigest: recordDigest,
          requestId: 'request_verification_01',
          requestDigest: digest('d'),
          requestJson: '{}',
          correlationId: 'correlation_02',
          recordedAt: at,
        }),
      );
      return {
        result,
        verificationCount: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM closure_verifications').one().n,
        eventType: state.storage.sql.exec<{ event_type: string }>('SELECT event_type FROM owner_domain_events').one().event_type,
        projectionType: JSON.parse(state.storage.sql.exec<{ item_json: string }>('SELECT item_json FROM closure_projection').one().item_json).itemType,
      };
    });
    expect(verificationResultV06Schema.parse(observed.result)).toMatchObject({
      protocolVersion: '0.6',
      requestId: 'request_verification_01',
      verification: { id: record.id, revision: record.revision, digest: recordDigest },
      state: 'passed',
      projectionCursor: 1,
    });
    expect(observed).toMatchObject({ verificationCount: 1, eventType: 'verification.recorded', projectionType: 'verification' });
  });

  it('rolls back record, event, projection, command result, and cursor when the owner transaction aborts', async () => {
    const stub = freshStub();
    const record = evidence();
    const counts = await runInDurableObject(stub, (_instance, state) => {
      provisionDoSchema(state.storage);
      seedOwnerRoot(state.storage.sql, record.ownerId);
      const module = new ClosurePersistenceModule(state.storage, (kind) => `${kind}_rollback`);
      try {
        state.storage.transactionSync(() => {
          module.persistEvidenceInCurrentTransaction({
            evidence: record,
            evidenceDigest: digest('e'),
            requestId: 'request_rollback_01',
            requestDigest: digest('f'),
            requestJson: '{}',
            correlationId: 'correlation_rollback',
            recordedAt: at,
          });
          throw new Error('inject rollback');
        });
      } catch {
        // expected crash injection
      }
      return {
        evidence: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM closure_evidence').one().n,
        events: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM owner_domain_events').one().n,
        projections: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM closure_projection').one().n,
        commands: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM closure_commands').one().n,
        eventState: state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM owner_event_state').one().n,
      };
    });
    expect(counts).toEqual({ evidence: 0, events: 0, projections: 0, commands: 0, eventState: 0 });
  });
});