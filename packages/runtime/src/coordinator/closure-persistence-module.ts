import {
  acceptanceRecordResultV06Schema,
  acceptanceV06Schema,
  closureDomainEventV06Schema,
  closureProjectionItemV06Schema,
  evidenceAdmissionResultV06Schema,
  evidenceV06Schema,
  verificationResultV06Schema,
  verificationV06Schema,
  type AcceptanceV06,
  type EvidenceV06,
  type VerificationV06,
} from '@waldo/contracts';
import { ResponsibilityDigestConflictError } from '../responsibility/errors';
import { OwnerEventLog } from './owner-event-log';

type ProtocolDigest = `sha256:${string}`;
type ClosureCommandType =
  | 'acceptance_check.declare'
  | 'evidence.admit'
  | 'verification.request'
  | 'acceptance.record';
type ClosureAggregateKind = 'acceptance_check' | 'evidence' | 'verification' | 'acceptance';
type ClosureEventType =
  | 'acceptance_check.declared'
  | 'evidence.admitted'
  | 'evidence.invalidated'
  | 'verification.recorded'
  | 'acceptance.recorded'
  | 'release.recorded';
type ClosureProjectionItem = ReturnType<typeof closureProjectionItemV06Schema.parse>;
type EvidenceAdmissionResult = ReturnType<typeof evidenceAdmissionResultV06Schema.parse>;
type VerificationResult = ReturnType<typeof verificationResultV06Schema.parse>;
type AcceptanceRecordResult = ReturnType<typeof acceptanceRecordResultV06Schema.parse>;

type StoredCommandRow = Readonly<{
  owner_id: string;
  request_digest: string;
  result_json: string;
}>;

export type ClosurePersistenceNewId = (kind: 'event' | 'snapshot') => string;

export class ClosurePersistenceModule {
  private readonly events: OwnerEventLog;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly newId: ClosurePersistenceNewId,
  ) {
    this.events = new OwnerEventLog(storage);
  }

  readCommandResultInCurrentTransaction(input: Readonly<{
    ownerId: string;
    requestId: string;
    requestDigest: ProtocolDigest;
  }>): string | undefined {
    const row = this.storage.sql.exec<StoredCommandRow>(
      `SELECT owner_id, request_digest, result_json
         FROM closure_commands
        WHERE request_id = ?`,
      input.requestId,
    ).toArray()[0];
    if (row === undefined) return undefined;
    if (row.owner_id !== input.ownerId || row.request_digest !== input.requestDigest) {
      throw new ResponsibilityDigestConflictError();
    }
    return row.result_json;
  }

  persistEvidenceInCurrentTransaction(input: Readonly<{
    evidence: EvidenceV06;
    evidenceDigest: ProtocolDigest;
    requestId: string;
    requestDigest: ProtocolDigest;
    requestJson: string;
    correlationId: string;
    recordedAt: string;
  }>): EvidenceAdmissionResult {
    const record = evidenceV06Schema.parse(input.evidence);
    const duplicate = this.readCommandResultInCurrentTransaction({
      ownerId: record.ownerId,
      requestId: input.requestId,
      requestDigest: input.requestDigest,
    });
    if (duplicate !== undefined) {
      return evidenceAdmissionResultV06Schema.parse(JSON.parse(duplicate));
    }

    this.storage.sql.exec(
      `INSERT INTO closure_evidence (
        id, owner_id, revision,
        acceptance_check_id, acceptance_check_revision,
        observation_kind, observation_id, observation_revision, observation_digest,
        producer_kind, producer_id,
        evidence_digest, evidence_json, state, observed_at, admitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.ownerId,
      record.revision,
      record.acceptanceCheck.id,
      record.acceptanceCheck.revision,
      record.observation.kind,
      record.observation.id,
      record.observation.revision,
      record.observation.digest,
      record.provenance.producer.kind,
      record.provenance.producer.id,
      input.evidenceDigest,
      JSON.stringify(record),
      record.state,
      record.observedAt,
      record.admittedAt,
    );

    const cursor = this.appendEventAndProjectionInCurrentTransaction({
      ownerId: record.ownerId,
      aggregateKind: 'evidence',
      aggregateId: record.id,
      revision: record.revision,
      eventType: record.state === 'admitted' ? 'evidence.admitted' : 'evidence.invalidated',
      record,
      recordDigest: input.evidenceDigest,
      requestId: input.requestId,
      correlationId: input.correlationId,
      occurredAt: input.recordedAt,
    });
    const result = evidenceAdmissionResultV06Schema.parse({
      protocolVersion: '0.6',
      requestId: input.requestId,
      evidence: { id: record.id, revision: record.revision, digest: input.evidenceDigest },
      state: record.state,
      projectionCursor: cursor,
    });
    this.persistCommandInCurrentTransaction({
      ownerId: record.ownerId,
      requestId: input.requestId,
      commandType: 'evidence.admit',
      requestDigest: input.requestDigest,
      requestJson: input.requestJson,
      resultJson: JSON.stringify(result),
      recordedAt: input.recordedAt,
    });
    return Object.freeze(result);
  }

  persistVerificationInCurrentTransaction(input: Readonly<{
    verification: VerificationV06;
    verificationDigest: ProtocolDigest;
    requestId: string;
    requestDigest: ProtocolDigest;
    requestJson: string;
    correlationId: string;
    recordedAt: string;
  }>): VerificationResult {
    const record = verificationV06Schema.parse(input.verification);
    const duplicate = this.readCommandResultInCurrentTransaction({
      ownerId: record.ownerId,
      requestId: input.requestId,
      requestDigest: input.requestDigest,
    });
    if (duplicate !== undefined) {
      return verificationResultV06Schema.parse(JSON.parse(duplicate));
    }

    this.storage.sql.exec(
      `INSERT INTO closure_verifications (
        id, owner_id, revision,
        acceptance_check_id, acceptance_check_revision,
        evidence_set_digest, verifier_id, verifier_version,
        state, verification_digest, verification_json, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.ownerId,
      record.revision,
      record.acceptanceCheck.id,
      record.acceptanceCheck.revision,
      record.evidenceSetDigest,
      record.verifier.id,
      record.verifier.version,
      record.state,
      input.verificationDigest,
      JSON.stringify(record),
      record.verifiedAt,
    );

    const cursor = this.appendEventAndProjectionInCurrentTransaction({
      ownerId: record.ownerId,
      aggregateKind: 'verification',
      aggregateId: record.id,
      revision: record.revision,
      eventType: 'verification.recorded',
      record,
      recordDigest: input.verificationDigest,
      requestId: input.requestId,
      correlationId: input.correlationId,
      occurredAt: input.recordedAt,
    });
    const result = verificationResultV06Schema.parse({
      protocolVersion: '0.6',
      requestId: input.requestId,
      verification: { id: record.id, revision: record.revision, digest: input.verificationDigest },
      state: record.state,
      projectionCursor: cursor,
    });
    this.persistCommandInCurrentTransaction({
      ownerId: record.ownerId,
      requestId: input.requestId,
      commandType: 'verification.request',
      requestDigest: input.requestDigest,
      requestJson: input.requestJson,
      resultJson: JSON.stringify(result),
      recordedAt: input.recordedAt,
    });
    return Object.freeze(result);
  }

  persistAcceptanceInCurrentTransaction(input: Readonly<{
    acceptance: AcceptanceV06;
    acceptanceDigest: ProtocolDigest;
    requestId: string;
    requestDigest: ProtocolDigest;
    requestJson: string;
    correlationId: string;
    recordedAt: string;
  }>): AcceptanceRecordResult {
    const record = acceptanceV06Schema.parse(input.acceptance);
    const duplicate = this.readCommandResultInCurrentTransaction({
      ownerId: record.ownerId,
      requestId: input.requestId,
      requestDigest: input.requestDigest,
    });
    if (duplicate !== undefined) {
      return acceptanceRecordResultV06Schema.parse(JSON.parse(duplicate));
    }

    this.storage.sql.exec(
      `INSERT INTO closure_acceptances (
        id, owner_id, revision,
        outcome_id, outcome_revision,
        work_unit_id, work_unit_revision,
        decision, acceptance_digest, acceptance_json, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.ownerId,
      record.revision,
      record.subject.outcome.id,
      record.subject.outcome.revision,
      record.subject.workUnit?.id ?? null,
      record.subject.workUnit?.revision ?? null,
      record.decision,
      input.acceptanceDigest,
      JSON.stringify(record),
      record.recordedAt,
    );

    const cursor = this.appendEventAndProjectionInCurrentTransaction({
      ownerId: record.ownerId,
      aggregateKind: 'acceptance',
      aggregateId: record.id,
      revision: record.revision,
      eventType: record.decision === 'accepted' ? 'acceptance.recorded' : 'release.recorded',
      record,
      recordDigest: input.acceptanceDigest,
      requestId: input.requestId,
      correlationId: input.correlationId,
      occurredAt: input.recordedAt,
    });
    const result = acceptanceRecordResultV06Schema.parse({
      protocolVersion: '0.6',
      requestId: input.requestId,
      acceptance: { id: record.id, revision: record.revision, digest: input.acceptanceDigest },
      decision: record.decision,
      projectionCursor: cursor,
    });
    this.persistCommandInCurrentTransaction({
      ownerId: record.ownerId,
      requestId: input.requestId,
      commandType: 'acceptance.record',
      requestDigest: input.requestDigest,
      requestJson: input.requestJson,
      resultJson: JSON.stringify(result),
      recordedAt: input.recordedAt,
    });
    return Object.freeze(result);
  }

  readEvidenceInCurrentTransaction(
    ownerId: string,
    evidenceId: string,
  ): EvidenceV06 | undefined {
    const row = this.storage.sql.exec<{ evidence_json: string }>(
      'SELECT evidence_json FROM closure_evidence WHERE owner_id = ? AND id = ?',
      ownerId,
      evidenceId,
    ).toArray()[0];
    return row === undefined ? undefined : evidenceV06Schema.parse(JSON.parse(row.evidence_json));
  }

  readVerificationInCurrentTransaction(
    ownerId: string,
    verificationId: string,
  ): VerificationV06 | undefined {
    const row = this.storage.sql.exec<{ verification_json: string }>(
      'SELECT verification_json FROM closure_verifications WHERE owner_id = ? AND id = ?',
      ownerId,
      verificationId,
    ).toArray()[0];
    return row === undefined
      ? undefined
      : verificationV06Schema.parse(JSON.parse(row.verification_json));
  }

  readAcceptanceInCurrentTransaction(
    ownerId: string,
    acceptanceId: string,
  ): AcceptanceV06 | undefined {
    const row = this.storage.sql.exec<{ acceptance_json: string }>(
      'SELECT acceptance_json FROM closure_acceptances WHERE owner_id = ? AND id = ?',
      ownerId,
      acceptanceId,
    ).toArray()[0];
    return row === undefined
      ? undefined
      : acceptanceV06Schema.parse(JSON.parse(row.acceptance_json));
  }

  private appendEventAndProjectionInCurrentTransaction(input: Readonly<{
    ownerId: string;
    aggregateKind: ClosureAggregateKind;
    aggregateId: string;
    revision: number;
    eventType: ClosureEventType;
    record: EvidenceV06 | VerificationV06 | AcceptanceV06;
    recordDigest: ProtocolDigest;
    requestId: string;
    correlationId: string;
    occurredAt: string;
  }>): number {
    const eventId = this.newId('event');
    const cursor = this.events.appendInCurrentTransaction({
      schemaVersion: '0.6',
      eventId,
      ownerId: input.ownerId,
      aggregateKind: input.aggregateKind,
      aggregateId: input.aggregateId,
      revision: input.revision,
      eventType: input.eventType,
      causationId: input.requestId,
      correlationId: input.correlationId,
      occurredAt: input.occurredAt,
      payloadJson: JSON.stringify({ payloadDigest: input.recordDigest }),
    });
    closureDomainEventV06Schema.parse({
      schemaVersion: '0.6',
      eventId,
      ownerId: input.ownerId,
      aggregate: {
        kind: input.aggregateKind,
        id: input.aggregateId,
        revision: input.revision,
      },
      eventType: input.eventType,
      payloadDigest: input.recordDigest,
      cursor,
      occurredAt: input.occurredAt,
    });

    this.ensureProjectionSnapshotInCurrentTransaction(input.ownerId, input.occurredAt);
    const item = closureProjectionItemV06Schema.parse({
      cursor,
      itemType: input.aggregateKind,
      record: input.record,
      recordDigest: input.recordDigest,
    } satisfies ClosureProjectionItem);
    this.storage.sql.exec(
      `INSERT INTO closure_projection (owner_cursor, owner_id, item_json)
       VALUES (?, ?, ?)`,
      cursor,
      input.ownerId,
      JSON.stringify(item),
    );
    return cursor;
  }

  private ensureProjectionSnapshotInCurrentTransaction(ownerId: string, at: string): void {
    const row = this.storage.sql.exec<{ snapshot_id: string }>(
      'SELECT snapshot_id FROM closure_projection_state WHERE owner_id = ?',
      ownerId,
    ).toArray()[0];
    if (row !== undefined) return;
    this.storage.sql.exec(
      `INSERT INTO closure_projection_state (
        owner_id, snapshot_id, snapshot_base_cursor, updated_at
      ) VALUES (?, ?, 0, ?)`,
      ownerId,
      this.newId('snapshot'),
      at,
    );
  }

  private persistCommandInCurrentTransaction(input: Readonly<{
    ownerId: string;
    requestId: string;
    commandType: ClosureCommandType;
    requestDigest: ProtocolDigest;
    requestJson: string;
    resultJson: string;
    recordedAt: string;
  }>): void {
    this.storage.sql.exec(
      `INSERT INTO closure_commands (
        request_id, owner_id, command_type, request_digest,
        request_json, result_json, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.requestId,
      input.ownerId,
      input.commandType,
      input.requestDigest,
      input.requestJson,
      input.resultJson,
      input.recordedAt,
    );
  }
}