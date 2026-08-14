import {
  executionAttemptV04Schema,
  executionCancelRequestV04Schema,
  executionLeaseV04Schema,
  executionObservationIsFreshV04,
  executionReconciliationV04Schema,
  executionRequestV04Schema,
  executionSessionV04Schema,
  executorObservationV04Schema,
  planningExecutionLeaseV03Schema,
  ROSTER,
  ROSTER_REFS,
  planningProviderInvocationV03Schema,
  workUnitCandidatePlanV03Schema,
  planningAgentSessionV03Schema,
  workUnitPlanningCancelResultV03Schema,
  workUnitPlanningAuthorizationResultV03Schema,
  workUnitPlanningCommandResultV03Schema,
  workUnitPlanningExecutionRequestV03Schema,
  workUnitPlanningProjectionItemV03Schema,
  workUnitPlanningProjectionPageV03Schema,
  workUnitPlanningTurnResultV03Schema,
  type PlanningAgentSessionV03,
  type WorkUnitPlanningAuthorizationResultV03,
  type WorkUnitPlanningCommandResultV03,
  type WorkUnitPlanningExecutionRequestV03,
  type WorkUnitPlanningCancelResultV03,
  type WorkUnitPlanningProjectionPageV03,
  type WorkUnitPlanningTurnTrustedEnvelopeV03,
} from '@waldo/contracts';
import type {
  LLMGatewayRequest,
  TrustedProviderEffect,
} from '../llm/provider';
import { OwnerEventLog } from './owner-event-log';
import {
  ResponsibilityDigestConflictError,
  ResponsibilityPlanningConflictError,
  ResponsibilityProjectionCursorError,
} from '../responsibility/errors';

type PlanningProjectionRead = Readonly<{
  ownerId: string;
  fromExclusiveCursor: number;
  limit: number;
  snapshotId?: string;
  currentSnapshotId: string;
  snapshotBaseCursor: number;
  generatedAt: string;
}>;

type StoredPlanningCommandRow = {
  owner_id: string;
  request_digest: string;
  result_json: string;
};

type ExecutionRequestV04 = ReturnType<typeof executionRequestV04Schema.parse>;
type ExecutionAttemptV04 = ReturnType<typeof executionAttemptV04Schema.parse>;
type ExecutionLeaseV04 = ReturnType<typeof executionLeaseV04Schema.parse>;
type ExecutionSessionV04 = ReturnType<typeof executionSessionV04Schema.parse>;
type ExecutorObservationV04 = ReturnType<typeof executorObservationV04Schema.parse>;
type ExecutionReconciliationV04 = ReturnType<typeof executionReconciliationV04Schema.parse>;

export type ExecutionAdmissionBindingV04 = Readonly<{
  routedOwnerId: string;
  outcome: ExecutionRequestV04['outcome'];
  workUnit: ExecutionRequestV04['workUnit'];
  provider: ExecutionRequestV04['provider'];
  environment: ExecutionRequestV04['environment'];
  authorityCeiling: ExecutionRequestV04['authorityCeiling'];
  contextProjectionRef: string;
  contextProjectionDigest: string;
}>;

export type ExecutionAggregateV04 = Readonly<{
  request: ExecutionRequestV04;
  currentCancellationGeneration: number;
  attempts: readonly ExecutionAttemptV04[];
  leases: readonly ExecutionLeaseV04[];
  sessions: readonly ExecutionSessionV04[];
  observations: readonly ExecutorObservationV04[];
  reconciliations: readonly ExecutionReconciliationV04[];
}>;

function canonicalizeExecutionProtocolValue(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeExecutionProtocolValue).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalizeExecutionProtocolValue(record[key])}`).join(',')}}`;
  }
  throw new Error('execution protocol value is not JSON');
}

function sameProtocolValue(left: unknown, right: unknown): boolean {
  return canonicalizeExecutionProtocolValue(left) ===
    canonicalizeExecutionProtocolValue(right);
}

/** Owns execution-harness state; it never writes Outcome, Mission, or WorkUnit truth. */
export class PlanningExecutionModule {
  private readonly events: OwnerEventLog;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly newId: (kind: 'event') => string,
  ) {
    this.events = new OwnerEventLog(storage);
  }

  admitExecutionRequestV04InCurrentTransaction(input: Readonly<{
    request: unknown;
    trustedBinding: ExecutionAdmissionBindingV04;
    requestDigest: string;
  }>): ExecutionRequestV04 {
    const request = executionRequestV04Schema.parse(input.request);
    const bindingMatches =
      request.ownerId === input.trustedBinding.routedOwnerId &&
      sameProtocolValue(request.outcome, input.trustedBinding.outcome) &&
      sameProtocolValue(request.workUnit, input.trustedBinding.workUnit) &&
      sameProtocolValue(request.provider, input.trustedBinding.provider) &&
      sameProtocolValue(request.environment, input.trustedBinding.environment) &&
      sameProtocolValue(request.authorityCeiling, input.trustedBinding.authorityCeiling) &&
      request.contextProjectionRef === input.trustedBinding.contextProjectionRef &&
      request.contextProjectionDigest === input.trustedBinding.contextProjectionDigest;
    if (!bindingMatches) throw new Error('execution request binding mismatch');

    const existing = this.storage.sql.exec<{
      owner_id: string;
      request_digest: string;
    }>(
      `SELECT owner_id, request_digest
         FROM planning_execution_requests
        WHERE id = ? AND protocol_version = '0.4'`,
      request.id,
    ).toArray()[0];
    if (existing !== undefined) {
      if (existing.owner_id !== request.ownerId || existing.request_digest !== input.requestDigest) {
        throw new ResponsibilityDigestConflictError();
      }
      const persisted = this.readExecutionAggregateV04(request.ownerId, request.id).request;
      if (!sameProtocolValue(persisted, request)) throw new ResponsibilityDigestConflictError();
      return persisted;
    }

    this.storage.sql.exec(
      `INSERT INTO planning_execution_requests (
        id, owner_id, outcome_id, work_unit_id, work_unit_revision, request_id,
        request_digest, governed_inputs_json, provider_ref_json, executor_ref_json,
        capability_manifest_json, authority_ceiling_json, status,
        cancellation_generation, created_at, updated_at, protocol_version,
        outcome_ref_json, work_unit_ref_json, environment_ref_json,
        context_projection_ref, context_projection_digest, request_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, '0.4', ?, ?, ?, ?, ?, ?)`,
      request.id,
      request.ownerId,
      request.outcome.id,
      request.workUnit.id,
      request.workUnit.revision,
      request.id,
      input.requestDigest,
      JSON.stringify({
        contextProjectionRef: request.contextProjectionRef,
        contextProjectionDigest: request.contextProjectionDigest,
      }),
      JSON.stringify(request.provider),
      JSON.stringify(request.environment),
      JSON.stringify(request.environment.manifest),
      JSON.stringify(request.authorityCeiling),
      request.cancellationGeneration,
      request.requestedAt,
      request.requestedAt,
      JSON.stringify(request.outcome),
      JSON.stringify(request.workUnit),
      JSON.stringify(request.environment),
      request.contextProjectionRef,
      request.contextProjectionDigest,
      JSON.stringify(request),
    );
    return request;
  }

  claimExecutionAttemptV04InCurrentTransaction(input: Readonly<{
    attempt: unknown;
    lease: unknown;
    session: unknown;
  }>): Readonly<{
    attempt: ExecutionAttemptV04;
    lease: ExecutionLeaseV04;
    session: ExecutionSessionV04;
  }> {
    const attempt = executionAttemptV04Schema.parse(input.attempt);
    const lease = executionLeaseV04Schema.parse(input.lease);
    const session = executionSessionV04Schema.parse(input.session);
    const aggregate = this.readExecutionAggregateV04(attempt.ownerId, attempt.executionRequestId);
    const request = aggregate.request;
    const requestWriterState = this.storage.sql.exec<{
      status: string;
      cancellation_request_id: string | null;
    }>(
      `SELECT status, cancellation_request_id FROM planning_execution_requests
        WHERE id = ? AND owner_id = ? AND protocol_version = '0.4'`,
      attempt.executionRequestId,
      attempt.ownerId,
    ).one();

    const matchingIndex = aggregate.attempts.findIndex((value) => value.id === attempt.id);
    if (matchingIndex >= 0) {
      const persistedAttempt = aggregate.attempts[matchingIndex]!;
      const persistedLease = aggregate.leases[matchingIndex]!;
      const persistedSession = aggregate.sessions[matchingIndex]!;
      const immutableClaimMatches =
        persistedAttempt.ownerId === attempt.ownerId &&
        persistedAttempt.executionRequestId === attempt.executionRequestId &&
        sameProtocolValue(persistedAttempt.workUnit, attempt.workUnit) &&
        persistedAttempt.attemptNumber === attempt.attemptNumber &&
        sameProtocolValue(persistedAttempt.provider, attempt.provider) &&
        sameProtocolValue(persistedAttempt.environment, attempt.environment) &&
        persistedAttempt.leaseId === attempt.leaseId &&
        persistedAttempt.fencingGeneration === attempt.fencingGeneration &&
        persistedAttempt.cancellationGeneration === attempt.cancellationGeneration &&
        persistedAttempt.createdAt === attempt.createdAt &&
        sameProtocolValue(persistedLease, lease) &&
        persistedSession.id === session.id &&
        persistedSession.ownerId === session.ownerId &&
        persistedSession.attemptId === session.attemptId &&
        sameProtocolValue(persistedSession.provider, session.provider) &&
        sameProtocolValue(persistedSession.environment, session.environment) &&
        persistedSession.providerSessionRef === session.providerSessionRef;
      if (!immutableClaimMatches) {
        throw new ResponsibilityPlanningConflictError('execution claim digest conflict');
      }
      return Object.freeze({
        attempt: persistedAttempt,
        lease: persistedLease,
        session: persistedSession,
      });
    }
    if (aggregate.attempts.length > 0) {
      const previousIndex = aggregate.attempts.length - 1;
      const previous = aggregate.attempts[previousIndex]!;
      const previousLease = aggregate.leases[previousIndex]!;
      const priorReconciliation = aggregate.reconciliations
        .filter((value) => value.attemptId === previous.id)
        .at(-1);
      const retryIsReconciled =
        priorReconciliation !== undefined &&
        priorReconciliation.state === 'failed' &&
        attempt.attemptNumber === previous.attemptNumber + 1 &&
        attempt.fencingGeneration === previousLease.fencingGeneration + 1;
      if (!retryIsReconciled) {
        throw new ResponsibilityPlanningConflictError('execution request already claimed');
      }
    }

    const exact =
      (attempt.state === 'queued' || attempt.state === 'running') &&
      session.lastObservationSequence === 0 &&
      requestWriterState.status !== 'completed' &&
      requestWriterState.status !== 'cancelled' &&
      requestWriterState.cancellation_request_id === null &&
      attempt.ownerId === request.ownerId &&
      attempt.executionRequestId === request.id &&
      sameProtocolValue(attempt.workUnit, request.workUnit) &&
      sameProtocolValue(attempt.provider, request.provider) &&
      sameProtocolValue(attempt.environment, request.environment) &&
      attempt.cancellationGeneration === aggregate.currentCancellationGeneration &&
      lease.ownerId === attempt.ownerId &&
      lease.executionRequestId === attempt.executionRequestId &&
      lease.attemptId === attempt.id &&
      lease.id === attempt.leaseId &&
      lease.fencingGeneration === attempt.fencingGeneration &&
      lease.cancellationGeneration === attempt.cancellationGeneration &&
      sameProtocolValue(lease.holder, attempt.environment) &&
      session.ownerId === attempt.ownerId &&
      session.attemptId === attempt.id &&
      sameProtocolValue(session.provider, attempt.provider) &&
      sameProtocolValue(session.environment, attempt.environment);
    if (!exact) throw new Error('execution claim binding mismatch');

    this.storage.sql.exec(
      `INSERT INTO execution_attempts (
        id, owner_id, execution_request_id, work_unit_ref_json, attempt_number,
        provider_ref_json, environment_ref_json, lease_id, fencing_generation,
        cancellation_generation, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      attempt.id, attempt.ownerId, attempt.executionRequestId, JSON.stringify(attempt.workUnit),
      attempt.attemptNumber, JSON.stringify(attempt.provider), JSON.stringify(attempt.environment),
      attempt.leaseId, attempt.fencingGeneration, attempt.cancellationGeneration,
      attempt.state, attempt.createdAt, attempt.updatedAt,
    );
    this.storage.sql.exec(
      `INSERT INTO planning_execution_leases (
        execution_request_id, owner_id, holder_id, fence, cancellation_generation,
        acquired_at, expires_at, id, attempt_id, environment_ref_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      lease.executionRequestId, lease.ownerId, lease.holder.id, lease.fencingGeneration,
      lease.cancellationGeneration, lease.acquiredAt, lease.expiresAt, lease.id,
      lease.attemptId, JSON.stringify(lease.holder),
    );
    this.storage.sql.exec(
      `INSERT INTO planning_agent_sessions (
        id, owner_id, outcome_id, work_unit_id, execution_request_id, status,
        provider_ref_json, executor_ref_json, capability_manifest_json,
        cancellation_generation, created_at, updated_at, protocol_version,
        attempt_id, environment_ref_json, provider_session_ref,
        last_observation_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0.4', ?, ?, ?, ?)`,
      session.id, session.ownerId, request.outcome.id, request.workUnit.id, request.id,
      session.state, JSON.stringify(session.provider), JSON.stringify(session.environment),
      JSON.stringify(session.environment.manifest), attempt.cancellationGeneration,
      attempt.createdAt, attempt.updatedAt, session.attemptId, JSON.stringify(session.environment),
      session.providerSessionRef, session.lastObservationSequence,
    );
    this.storage.sql.exec(
      "UPDATE planning_execution_requests SET status = 'leased', updated_at = ? WHERE id = ?",
      attempt.updatedAt,
      request.id,
    );
    return Object.freeze({ attempt, lease, session });
  }

  admitExecutorObservationV04InCurrentTransaction(input: Readonly<{
    observation: unknown;
    observationDigest: string;
    receivedAt: string;
  }>): ExecutorObservationV04 {
    const observation = executorObservationV04Schema.parse(input.observation);
    const existing = this.storage.sql.exec<{ canonical_digest: string; observation_json: string }>(
      'SELECT canonical_digest, observation_json FROM execution_observations WHERE id = ?',
      observation.id,
    ).toArray()[0];
    if (existing !== undefined) {
      if (existing.canonical_digest !== input.observationDigest) {
        throw new ResponsibilityDigestConflictError();
      }
      const persisted = executorObservationV04Schema.parse(JSON.parse(existing.observation_json));
      if (!sameProtocolValue(persisted, observation)) {
        throw new ResponsibilityDigestConflictError();
      }
      return persisted;
    }

    const attempt = this.readAttemptV04(observation.attemptId);
    const lease = this.readLeaseV04(attempt.leaseId);
    const sessionRow = this.storage.sql.exec<{
      id: string;
      last_observation_sequence: number;
    }>(
      `SELECT id, last_observation_sequence FROM planning_agent_sessions
        WHERE attempt_id = ? AND protocol_version = '0.4'`,
      attempt.id,
    ).toArray()[0];
    const requestGeneration = this.storage.sql.exec<{ cancellation_generation: number }>(
      `SELECT cancellation_generation FROM planning_execution_requests
        WHERE id = ? AND owner_id = ? AND protocol_version = '0.4'`,
      attempt.executionRequestId,
      attempt.ownerId,
    ).toArray()[0]?.cancellation_generation;
    if (
      sessionRow === undefined ||
      (attempt.state !== 'queued' && attempt.state !== 'running') ||
      requestGeneration !== observation.cancellationGeneration ||
      !executionObservationIsFreshV04(
        attempt,
        lease,
        observation,
        sessionRow.last_observation_sequence,
        input.receivedAt,
      )
    ) {
      throw new Error('execution observation rejected');
    }

    this.storage.sql.exec(
      `INSERT INTO execution_observations (
        id, owner_id, attempt_id, lease_id, fencing_generation,
        cancellation_generation, sequence, kind, environment_ref_json,
        payload_ref, payload_digest, observed_at, received_at, observation_json,
        canonical_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      observation.id, observation.ownerId, observation.attemptId, observation.leaseId,
      observation.fencingGeneration, observation.cancellationGeneration,
      observation.sequence, observation.kind, JSON.stringify(observation.environment),
      observation.payloadRef, observation.payloadDigest, observation.observedAt,
      input.receivedAt, JSON.stringify(observation), input.observationDigest,
    );
    const sessionState = observation.kind === 'ended' || observation.kind === 'failed'
      ? 'ended'
      : observation.kind === 'timed_out'
        ? 'lost'
        : observation.kind === 'unknown'
          ? 'unknown'
          : 'active';
    this.storage.sql.exec(
      `UPDATE planning_agent_sessions
          SET status = ?, last_observation_sequence = ?, updated_at = ?
        WHERE id = ?`,
      sessionState, observation.sequence, input.receivedAt, sessionRow.id,
    );
    const attemptState = observation.kind === 'ended'
      ? 'settling'
      : observation.kind === 'failed' || observation.kind === 'timed_out'
        ? 'failed'
        : observation.kind === 'unknown'
          ? 'indeterminate'
          : 'running';
    this.storage.sql.exec(
      'UPDATE execution_attempts SET state = ?, updated_at = ? WHERE id = ?',
      attemptState,
      input.receivedAt,
      attempt.id,
    );
    return observation;
  }

  cancelExecutionV04InCurrentTransaction(input: Readonly<{
    ownerId: string;
    request: unknown;
    requestDigest: string;
    at: string;
  }>): number {
    const request = executionCancelRequestV04Schema.parse(input.request);
    const row = this.storage.sql.exec<{
      cancellation_generation: number;
      status: string;
      cancellation_request_id: string | null;
      cancellation_request_digest: string | null;
      cancellation_request_json: string | null;
    }>(
      `SELECT cancellation_generation, status, cancellation_request_id,
              cancellation_request_digest, cancellation_request_json
         FROM planning_execution_requests
        WHERE id = ? AND owner_id = ? AND protocol_version = '0.4'`,
      request.executionRequestId,
      input.ownerId,
    ).toArray()[0];
    if (row?.cancellation_request_id === request.requestId) {
      if (row.cancellation_request_digest !== input.requestDigest ||
          row.cancellation_request_json === null ||
          !sameProtocolValue(JSON.parse(row.cancellation_request_json), request)) {
        throw new ResponsibilityDigestConflictError();
      }
      return row.cancellation_generation;
    }
    if (row === undefined || row.cancellation_request_id !== null ||
        row.cancellation_generation !== request.expectedCancellationGeneration) {
      throw new ResponsibilityPlanningConflictError('execution cancellation generation mismatch');
    }
    if (row.status !== 'pending' && row.status !== 'leased' && row.status !== 'ambiguous') {
      throw new ResponsibilityPlanningConflictError('execution cancellation rejected');
    }
    const nextGeneration = row.cancellation_generation + 1;
    this.storage.sql.exec(
      `UPDATE planning_execution_requests
          SET cancellation_generation = ?, status = 'cancelled', updated_at = ?,
              cancellation_request_id = ?, cancellation_request_digest = ?,
              cancellation_request_json = ?
        WHERE id = ? AND owner_id = ?`,
      nextGeneration,
      input.at,
      request.requestId,
      input.requestDigest,
      JSON.stringify(request),
      request.executionRequestId,
      input.ownerId,
    );
    this.storage.sql.exec(
      `UPDATE execution_attempts SET state = 'cancelling', updated_at = ?
        WHERE execution_request_id = ? AND owner_id = ?
          AND state IN ('queued', 'running', 'settling', 'indeterminate')`,
      input.at,
      request.executionRequestId,
      input.ownerId,
    );
    return nextGeneration;
  }

  reconcileExecutionAttemptV04InCurrentTransaction(input: Readonly<{
    reconciliation: unknown;
    reconciliationDigest: string;
  }>): ExecutionReconciliationV04 {
    const reconciliation = executionReconciliationV04Schema.parse(input.reconciliation);
    const existing = this.storage.sql.exec<{ canonical_digest: string; reconciliation_json: string }>(
      'SELECT canonical_digest, reconciliation_json FROM execution_reconciliations WHERE id = ?',
      reconciliation.id,
    ).toArray()[0];
    if (existing !== undefined) {
      if (existing.canonical_digest !== input.reconciliationDigest) {
        throw new ResponsibilityDigestConflictError();
      }
      const persisted = executionReconciliationV04Schema.parse(
        JSON.parse(existing.reconciliation_json),
      );
      if (!sameProtocolValue(persisted, reconciliation)) {
        throw new ResponsibilityDigestConflictError();
      }
      return persisted;
    }
    const attempt = this.readAttemptV04(reconciliation.attemptId);
    const lease = this.readLeaseV04(reconciliation.leaseId);
    const aggregate = this.readExecutionAggregateV04(attempt.ownerId, attempt.executionRequestId);
    if (aggregate.attempts.at(-1)?.id !== attempt.id) {
      throw new Error('execution reconciliation rejected');
    }
    const priorReconciliation = aggregate.reconciliations
      .filter((value) => value.attemptId === attempt.id)
      .at(-1);
    if (priorReconciliation !== undefined &&
        priorReconciliation.state !== 'running' &&
        priorReconciliation.state !== 'indeterminate') {
      throw new Error('execution reconciliation rejected');
    }
    if (aggregate.currentCancellationGeneration !== attempt.cancellationGeneration &&
        reconciliation.state === 'running') {
      throw new Error('execution reconciliation rejected');
    }
    const exact =
      reconciliation.ownerId === attempt.ownerId &&
      reconciliation.leaseId === attempt.leaseId &&
      reconciliation.fencingGeneration === attempt.fencingGeneration &&
      reconciliation.cancellationGeneration === attempt.cancellationGeneration &&
      lease.attemptId === attempt.id &&
      lease.fencingGeneration === attempt.fencingGeneration &&
      lease.cancellationGeneration === attempt.cancellationGeneration;
    if (!exact) throw new Error('execution reconciliation binding mismatch');
    const knownObservationIds = new Set(
      this.storage.sql.exec<{ id: string }>(
        'SELECT id FROM execution_observations WHERE attempt_id = ?',
        attempt.id,
      ).toArray().map((row) => row.id),
    );
    if (reconciliation.basisObservationIds.some((id) => !knownObservationIds.has(id))) {
      throw new Error('execution reconciliation basis mismatch');
    }

    this.storage.sql.exec(
      `INSERT INTO execution_reconciliations (
        id, owner_id, attempt_id, lease_id, fencing_generation,
        cancellation_generation, state, basis_observation_ids_json, checked_at,
        reconciliation_json, canonical_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      reconciliation.id, reconciliation.ownerId, reconciliation.attemptId,
      reconciliation.leaseId, reconciliation.fencingGeneration,
      reconciliation.cancellationGeneration, reconciliation.state,
      JSON.stringify(reconciliation.basisObservationIds), reconciliation.checkedAt,
      JSON.stringify(reconciliation), input.reconciliationDigest,
    );
    this.storage.sql.exec(
      'UPDATE execution_attempts SET state = ?, updated_at = ? WHERE id = ?',
      reconciliation.state,
      reconciliation.checkedAt,
      attempt.id,
    );
    const requestStatus = reconciliation.state === 'settled'
      ? 'completed'
      : reconciliation.state === 'indeterminate'
        ? 'ambiguous'
        : reconciliation.state;
    this.storage.sql.exec(
      'UPDATE planning_execution_requests SET status = ?, updated_at = ? WHERE id = ?',
      requestStatus,
      reconciliation.checkedAt,
      attempt.executionRequestId,
    );
    return reconciliation;
  }

  readExecutionAggregateV04(ownerId: string, executionRequestId: string): ExecutionAggregateV04 {
    const row = this.storage.sql.exec<{
      request_json: string;
      cancellation_generation: number;
    }>(
      `SELECT request_json, cancellation_generation
         FROM planning_execution_requests
        WHERE id = ? AND owner_id = ? AND protocol_version = '0.4'`,
      executionRequestId,
      ownerId,
    ).toArray()[0];
    if (row === undefined) throw new Error('execution request not found');
    const request = executionRequestV04Schema.parse(JSON.parse(row.request_json));
    const attempts = this.storage.sql.exec<{ id: string }>(
      `SELECT id FROM execution_attempts
        WHERE execution_request_id = ? AND owner_id = ? ORDER BY attempt_number`,
      executionRequestId,
      ownerId,
    ).toArray().map((attemptRow) => this.readAttemptV04(attemptRow.id));
    const leases = attempts.map((attemptValue) => this.readLeaseV04(attemptValue.leaseId));
    const sessions = attempts.map((attemptValue) => this.readSessionV04(attemptValue.id));
    const observations = this.storage.sql.exec<{ observation_json: string }>(
      `SELECT observation_json FROM execution_observations
        WHERE owner_id = ? AND attempt_id IN (
          SELECT id FROM execution_attempts WHERE execution_request_id = ? AND owner_id = ?
        ) ORDER BY attempt_id, sequence`,
      ownerId,
      executionRequestId,
      ownerId,
    ).toArray().map((item) => executorObservationV04Schema.parse(JSON.parse(item.observation_json)));
    const reconciliations = this.storage.sql.exec<{ reconciliation_json: string }>(
      `SELECT reconciliation_json FROM execution_reconciliations
        WHERE owner_id = ? AND attempt_id IN (
          SELECT id FROM execution_attempts WHERE execution_request_id = ? AND owner_id = ?
        ) ORDER BY checked_at, id`,
      ownerId,
      executionRequestId,
      ownerId,
    ).toArray().map((item) =>
      executionReconciliationV04Schema.parse(JSON.parse(item.reconciliation_json)));
    return Object.freeze({
      request,
      currentCancellationGeneration: row.cancellation_generation,
      attempts,
      leases,
      sessions,
      observations,
      reconciliations,
    });
  }

  readExecutionAggregateForAttemptV04(
    ownerId: string,
    attemptId: string,
  ): ExecutionAggregateV04 {
    const row = this.storage.sql.exec<{ execution_request_id: string }>(
      'SELECT execution_request_id FROM execution_attempts WHERE id = ? AND owner_id = ?',
      attemptId,
      ownerId,
    ).toArray()[0];
    if (row === undefined) throw new Error('execution attempt not found');
    return this.readExecutionAggregateV04(ownerId, row.execution_request_id);
  }

  private readAttemptV04(attemptId: string): ExecutionAttemptV04 {
    const row = this.storage.sql.exec<{
      id: string; owner_id: string; execution_request_id: string; work_unit_ref_json: string;
      attempt_number: number; provider_ref_json: string; environment_ref_json: string;
      lease_id: string; fencing_generation: number; cancellation_generation: number;
      state: ExecutionAttemptV04['state']; created_at: string; updated_at: string;
    }>('SELECT * FROM execution_attempts WHERE id = ?', attemptId).toArray()[0];
    if (row === undefined) throw new Error('execution attempt not found');
    return executionAttemptV04Schema.parse({
      protocolVersion: '0.4', id: row.id, ownerId: row.owner_id,
      executionRequestId: row.execution_request_id, workUnit: JSON.parse(row.work_unit_ref_json),
      attemptNumber: row.attempt_number, provider: JSON.parse(row.provider_ref_json),
      environment: JSON.parse(row.environment_ref_json), leaseId: row.lease_id,
      fencingGeneration: row.fencing_generation,
      cancellationGeneration: row.cancellation_generation, state: row.state,
      createdAt: row.created_at, updatedAt: row.updated_at,
    });
  }

  private readLeaseV04(leaseId: string): ExecutionLeaseV04 {
    const row = this.storage.sql.exec<{
      id: string; owner_id: string; execution_request_id: string; attempt_id: string;
      environment_ref_json: string; fence: number; cancellation_generation: number;
      acquired_at: string; expires_at: string;
    }>('SELECT * FROM planning_execution_leases WHERE id = ?', leaseId).toArray()[0];
    if (row === undefined) throw new Error('execution lease not found');
    return executionLeaseV04Schema.parse({
      protocolVersion: '0.4', id: row.id, ownerId: row.owner_id,
      executionRequestId: row.execution_request_id, attemptId: row.attempt_id,
      holder: JSON.parse(row.environment_ref_json), fencingGeneration: row.fence,
      cancellationGeneration: row.cancellation_generation,
      acquiredAt: row.acquired_at, expiresAt: row.expires_at,
    });
  }

  private readSessionV04(attemptId: string): ExecutionSessionV04 {
    const row = this.storage.sql.exec<{
      id: string; owner_id: string; attempt_id: string; provider_ref_json: string;
      environment_ref_json: string; provider_session_ref: string | null;
      status: ExecutionSessionV04['state']; last_observation_sequence: number;
    }>(
      `SELECT id, owner_id, attempt_id, provider_ref_json, environment_ref_json,
              provider_session_ref, status, last_observation_sequence
         FROM planning_agent_sessions
        WHERE attempt_id = ? AND protocol_version = '0.4'`,
      attemptId,
    ).toArray()[0];
    if (row === undefined) throw new Error('execution session not found');
    return executionSessionV04Schema.parse({
      protocolVersion: '0.4', id: row.id, ownerId: row.owner_id, attemptId: row.attempt_id,
      provider: JSON.parse(row.provider_ref_json), environment: JSON.parse(row.environment_ref_json),
      providerSessionRef: row.provider_session_ref, state: row.status,
      lastObservationSequence: row.last_observation_sequence,
    });
  }

  readIdempotentResult(
    ownerId: string,
    requestId: string,
    requestDigest: string,
  ): WorkUnitPlanningCommandResultV03 | null {
    const row = this.storage.sql.exec<StoredPlanningCommandRow>(
      `SELECT owner_id, request_digest, result_json
         FROM work_unit_planning_commands WHERE request_id = ?`,
      requestId,
    ).toArray()[0];
    if (row === undefined) return null;
    if (row.owner_id !== ownerId || row.request_digest !== requestDigest) {
      throw new ResponsibilityDigestConflictError();
    }
    return workUnitPlanningCommandResultV03Schema.parse(JSON.parse(row.result_json));
  }

  readIdempotentAuthorization(
    ownerId: string,
    requestId: string,
    requestDigest: string,
  ): WorkUnitPlanningAuthorizationResultV03 | null {
    const result = this.readIdempotentResult(ownerId, requestId, requestDigest);
    if (result === null) return null;
    return workUnitPlanningAuthorizationResultV03Schema.parse(result);
  }

  readPromptMaterial(ownerId: string, executionRequestId: string): Readonly<{
    outcomeStatement: string;
    workUnitResponsibility: string;
    stopConditions: readonly string[];
  }> {
    const row = this.storage.sql.exec<{
      owner_id: string;
      user_statement: string;
      responsibility: string;
      stop_conditions_json: string;
    }>(
      `SELECT requests.owner_id, outcomes.user_statement, work_units.responsibility,
              work_units.stop_conditions_json
         FROM planning_execution_requests AS requests
         JOIN outcomes ON outcomes.id = requests.outcome_id
           AND outcomes.owner_id = requests.owner_id
         JOIN work_units ON work_units.id = requests.work_unit_id
           AND work_units.owner_id = requests.owner_id
        WHERE requests.owner_id = ? AND requests.id = ?
          AND requests.protocol_version = '0.3'`,
      ownerId, executionRequestId,
    ).toArray()[0];
    if (row === undefined || row.owner_id !== ownerId) throw new Error('planning execution not found');
    const stopConditions = JSON.parse(row.stop_conditions_json);
    if (!Array.isArray(stopConditions) || stopConditions.some((value) => typeof value !== 'string')) {
      throw new Error('invalid persisted WorkUnit stop conditions');
    }
    return Object.freeze({
      outcomeStatement: row.user_statement,
      workUnitResponsibility: row.responsibility,
      stopConditions: Object.freeze(stopConditions),
    });
  }

  recoverPendingProviderEffectInCurrentTransaction(
    ownerId: string,
    executionRequestId: string,
    at: string,
    renewedExpiresAt: string,
  ): Readonly<{
    effect: TrustedProviderEffect;
    holderId: string;
    fence: number;
    cancellationGeneration: number;
  }> | null {
    const row = this.storage.sql.exec<{
      owner_id: string; effect_ref: string; invocation_key: string;
      request_digest: string; execution_json: string; status: string;
    }>(
      `SELECT owner_id, effect_ref, invocation_key, request_digest, execution_json, status
         FROM planning_provider_invocations
        WHERE execution_request_id = ? AND owner_id = ?`,
      executionRequestId, ownerId,
    ).toArray()[0];
    if (row === undefined) return null;
    if (row.status === 'invalid_output') throw new Error('planning provider output rejected');
    if (row.status !== 'pending' && row.status !== 'ambiguous') return null;
    const request = this.storage.sql.exec<{
      status: string; cancellation_generation: number;
    }>(
      `SELECT status, cancellation_generation
         FROM planning_execution_requests
        WHERE id = ? AND owner_id = ? AND protocol_version = '0.3'`,
      executionRequestId, ownerId,
    ).toArray()[0];
    if (request === undefined || request.status !== 'leased') return null;
    const lease = this.storage.sql.exec<{
      holder_id: string; fence: number; cancellation_generation: number; expires_at: string;
    }>(
      `SELECT holder_id, fence, cancellation_generation, expires_at
         FROM planning_execution_leases
        WHERE execution_request_id = ? AND owner_id = ?`,
      executionRequestId, ownerId,
    ).toArray()[0];
    if (lease === undefined ||
        request.cancellation_generation !== lease.cancellation_generation) return null;
    let fence = lease.fence;
    if (Date.parse(lease.expires_at) <= Date.parse(at)) {
      fence += 1;
      this.storage.sql.exec(
        `UPDATE planning_execution_leases
            SET fence = ?, acquired_at = ?, expires_at = ?
          WHERE execution_request_id = ? AND owner_id = ?`,
        fence, at, renewedExpiresAt, executionRequestId, ownerId,
      );
    }
    return Object.freeze({
      effect: Object.freeze({
        effect_ref: row.effect_ref,
        idempotency_key: row.invocation_key,
        request_digest: row.request_digest,
        execution: JSON.parse(row.execution_json),
        operation: 'reconcile',
      }),
      holderId: lease.holder_id,
      fence,
      cancellationGeneration: lease.cancellation_generation,
    });
  }

  rejectInvalidProviderOutputInCurrentTransaction(input: {
    ownerId: string;
    executionRequestId: string;
    holderId: string;
    fence: number;
    cancellationGeneration: number;
    resultDigest: string;
    at: string;
  }): void {
    const lease = this.storage.sql.exec<{
      owner_id: string; holder_id: string; fence: number; cancellation_generation: number;
      expires_at: string;
    }>(
      `SELECT owner_id, holder_id, fence, cancellation_generation, expires_at
         FROM planning_execution_leases WHERE execution_request_id = ?`,
      input.executionRequestId,
    ).one();
    if (lease.owner_id !== input.ownerId || lease.holder_id !== input.holderId ||
        lease.fence !== input.fence ||
        lease.cancellation_generation !== input.cancellationGeneration) {
      throw new Error('planning lease or fence mismatch');
    }
    if (Date.parse(lease.expires_at) <= Date.parse(input.at)) {
      throw new Error('planning lease expired');
    }
    const request = this.storage.sql.exec<{
      owner_id: string; outcome_id: string; work_unit_id: string;
      status: string; cancellation_generation: number;
    }>(
      `SELECT owner_id, outcome_id, work_unit_id, status, cancellation_generation
         FROM planning_execution_requests WHERE id = ? AND protocol_version = '0.3'`,
      input.executionRequestId,
    ).one();
    if (request.owner_id !== input.ownerId || request.status !== 'leased' ||
        request.cancellation_generation !== input.cancellationGeneration) {
      throw new Error('stale planning execution generation');
    }
    const receipt = this.storage.sql.exec<{ status: string }>(
      'SELECT status FROM planning_provider_invocations WHERE execution_request_id = ?',
      input.executionRequestId,
    ).one();
    if (receipt.status === 'invalid_output') return;
    if (receipt.status !== 'pending' && receipt.status !== 'ambiguous') {
      throw new Error('planning provider receipt already settled');
    }
    const session = this.storage.sql.exec<{ id: string; status: string }>(
      'SELECT id, status FROM planning_agent_sessions WHERE execution_request_id = ?',
      input.executionRequestId,
    ).one();
    this.storage.sql.exec(
      `UPDATE planning_provider_invocations
          SET status = 'invalid_output', result_digest = ?, completed_at = ?
        WHERE execution_request_id = ?`,
      input.resultDigest, input.at, input.executionRequestId,
    );
    this.storage.sql.exec(
      "UPDATE planning_execution_requests SET status = 'failed', updated_at = ? WHERE id = ?",
      input.at, input.executionRequestId,
    );
    this.storage.sql.exec(
      "UPDATE planning_agent_sessions SET status = 'failed', updated_at = ? WHERE id = ?",
      input.at, session.id,
    );
    const cursor = this.events.appendInCurrentTransaction({
      schemaVersion: '0.3', eventId: this.newId('event'), ownerId: input.ownerId,
      aggregateKind: 'agent_session', aggregateId: session.id,
      revision: session.status === 'ambiguous' ? 3 : 2,
      eventType: 'agent_session.failed', causationId: input.executionRequestId,
      correlationId: input.executionRequestId, occurredAt: input.at,
      payloadJson: JSON.stringify({
        status: 'failed', executionRequestId: input.executionRequestId,
        failureCode: 'invalid_provider_output', resultDigest: input.resultDigest,
      }),
    });
    this.publishActivity(input.ownerId, {
      cursor, itemType: 'agent_session_activity', outcomeId: request.outcome_id,
      workUnitId: request.work_unit_id, executionRequestId: input.executionRequestId,
      agentSessionId: session.id, status: 'failed', occurredAt: input.at,
    });
  }

  readProjection(input: PlanningProjectionRead): WorkUnitPlanningProjectionPageV03 {
    if (!Number.isSafeInteger(input.fromExclusiveCursor) || input.fromExclusiveCursor < 0 ||
        !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 256) {
      throw new Error('invalid planning projection query');
    }
    if (input.fromExclusiveCursor > 0 && input.snapshotId === undefined) {
      throw new ResponsibilityProjectionCursorError('snapshot_replaced');
    }
    if (input.snapshotId !== undefined && input.snapshotId !== input.currentSnapshotId) {
      throw new ResponsibilityProjectionCursorError('snapshot_replaced');
    }
    const highWaterCursor = this.events.readHighWater(input.ownerId);
    if (input.fromExclusiveCursor > highWaterCursor) {
      throw new ResponsibilityProjectionCursorError('cursor_ahead');
    }
    const rows = this.storage.sql.exec<{ owner_cursor: number; item_json: string }>(
      `SELECT owner_cursor, item_json FROM work_unit_planning_projection
        WHERE owner_id = ? AND owner_cursor > ? AND owner_cursor <= ?
        ORDER BY owner_cursor ASC LIMIT ?`,
      input.ownerId, input.fromExclusiveCursor, highWaterCursor, input.limit + 1,
    ).toArray();
    const pageRows = rows.slice(0, input.limit);
    let previous = input.fromExclusiveCursor;
    const items = pageRows.map((row) => {
      const item = workUnitPlanningProjectionItemV03Schema.parse(JSON.parse(row.item_json));
      if (item.cursor !== row.owner_cursor || item.cursor <= previous) {
        throw new ResponsibilityProjectionCursorError('cursor_corrupt');
      }
      previous = item.cursor;
      return item;
    });
    const filledPage = rows.length > input.limit;
    let truncatedByByteLimit = false;
    while (true) {
      const nextCursor = (filledPage || truncatedByByteLimit) && items.length > 0
        ? items.at(-1)!.cursor
        : highWaterCursor;
      const candidate = {
        protocolVersion: '0.3', ownerId: input.ownerId,
        projectionName: 'work_unit.planning_activity', snapshotId: input.currentSnapshotId,
        snapshotBaseCursor: input.snapshotBaseCursor,
        fromExclusiveCursor: input.fromExclusiveCursor, highWaterCursor, nextCursor,
        items, hasMore: nextCursor < highWaterCursor, generatedAt: input.generatedAt,
      };
      const parsed = workUnitPlanningProjectionPageV03Schema.safeParse(candidate);
      if (parsed.success) return parsed.data;
      if (items.length === 0) throw parsed.error;
      items.pop();
      if (items.length === 0) {
        throw new Error('planning projection item exceeds page byte limit');
      }
      truncatedByByteLimit = true;
    }
  }

  prepareProviderEffectInCurrentTransaction(input: {
    ownerId: string;
    executionRequestId: string;
    holderId: string;
    at: string;
    expiresAt: string;
    request: LLMGatewayRequest;
    effectRef: string;
    invocationKey: string;
    requestDigest: string;
  }): Readonly<{ effect: TrustedProviderEffect; fence: number; cancellationGeneration: number }> {
    const requestRow = this.storage.sql.exec<{
      owner_id: string; outcome_id: string; work_unit_id: string; status: string;
      cancellation_generation: number; provider_ref_json: string;
    }>(
      `SELECT owner_id, outcome_id, work_unit_id, status, cancellation_generation,
              provider_ref_json
         FROM planning_execution_requests WHERE id = ? AND protocol_version = '0.3'`,
      input.executionRequestId,
    ).toArray()[0];
    if (requestRow === undefined || requestRow.owner_id !== input.ownerId) {
      throw new Error('planning execution not found');
    }
    if (requestRow.status !== 'pending') {
      throw new ResponsibilityPlanningConflictError('planning execution is not claimable');
    }
    const provider = JSON.parse(requestRow.provider_ref_json) as { modelRef?: unknown };
    if (provider.modelRef !== ROSTER_REFS.primary || input.request.step.model !== ROSTER.primary) {
      throw new Error('planning provider pin mismatch');
    }
    const lease = planningExecutionLeaseV03Schema.parse({
      executionRequestId: input.executionRequestId,
      ownerId: input.ownerId,
      holderId: input.holderId,
      fence: 1,
      cancellationGeneration: requestRow.cancellation_generation,
      acquiredAt: input.at,
      expiresAt: input.expiresAt,
    });
    this.storage.sql.exec(
      `INSERT INTO planning_execution_leases (
        execution_request_id, owner_id, holder_id, fence, cancellation_generation,
        acquired_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      lease.executionRequestId, lease.ownerId, lease.holderId, lease.fence,
      lease.cancellationGeneration, lease.acquiredAt, lease.expiresAt,
    );
    this.storage.sql.exec(
      "UPDATE planning_execution_requests SET status = 'leased', updated_at = ? WHERE id = ?",
      input.at, input.executionRequestId,
    );
    this.storage.sql.exec(
      "UPDATE planning_agent_sessions SET status = 'running', updated_at = ? WHERE execution_request_id = ?",
      input.at, input.executionRequestId,
    );
    const execution = {
      step: input.request.step,
      context: input.request.context,
      fallback_step: input.request.fallback_step,
    };
    this.storage.sql.exec(
      `INSERT INTO planning_provider_invocations (
        execution_request_id, owner_id, invocation_key, effect_ref, request_digest,
        execution_json, provider_ref_json, status, result_digest,
        started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
      input.executionRequestId, input.ownerId, input.invocationKey, input.effectRef,
      input.requestDigest, JSON.stringify(execution), requestRow.provider_ref_json, input.at,
    );
    const session = this.storage.sql.exec<{ id: string }>(
      'SELECT id FROM planning_agent_sessions WHERE execution_request_id = ?',
      input.executionRequestId,
    ).one();
    const cursor = this.events.appendInCurrentTransaction({
      schemaVersion: '0.3', eventId: this.newId('event'), ownerId: input.ownerId,
      aggregateKind: 'agent_session', aggregateId: session.id, revision: 1,
      eventType: 'agent_session.running', causationId: input.executionRequestId,
      correlationId: input.executionRequestId, occurredAt: input.at,
      payloadJson: JSON.stringify({ status: 'running', executionRequestId: input.executionRequestId }),
    });
    this.publishActivity(input.ownerId, {
      cursor, itemType: 'agent_session_activity', outcomeId: requestRow.outcome_id,
      workUnitId: requestRow.work_unit_id, executionRequestId: input.executionRequestId,
      agentSessionId: session.id, status: 'running', occurredAt: input.at,
    });
    return Object.freeze({
      effect: Object.freeze({
        effect_ref: input.effectRef,
        idempotency_key: input.invocationKey,
        request_digest: input.requestDigest,
        execution,
        operation: 'issue',
      }),
      fence: lease.fence,
      cancellationGeneration: lease.cancellationGeneration,
    });
  }

  persistAuthorizationInCurrentTransaction(input: {
    ownerId: string;
    requestId: string;
    requestDigest: string;
    outcomeId: string;
    workUnitId: string;
    workUnitRevision: number;
    executionRequestId: string;
    agentSessionId: string;
    cursor: number;
    at: string;
    envelope: WorkUnitPlanningTurnTrustedEnvelopeV03;
  }): WorkUnitPlanningAuthorizationResultV03 {
    const executionRequest = workUnitPlanningExecutionRequestV03Schema.parse({
      id: input.executionRequestId,
      ownerId: input.ownerId,
      outcomeId: input.outcomeId,
      workUnitId: input.workUnitId,
      workUnitRevision: input.workUnitRevision,
      requestId: input.requestId,
      requestDigest: input.requestDigest,
      governedInputs: input.envelope.payload.governedInputs,
      provider: input.envelope.provider,
      executor: input.envelope.executor,
      capabilityManifest: input.envelope.capabilityManifest,
      authorityCeiling: input.envelope.authorityCeiling,
      status: 'pending',
      cancellationGeneration: 0,
      createdAt: input.at,
      updatedAt: input.at,
    });
    const agentSession = planningAgentSessionV03Schema.parse({
      id: input.agentSessionId,
      ownerId: input.ownerId,
      outcomeId: input.outcomeId,
      workUnitId: input.workUnitId,
      executionRequestId: input.executionRequestId,
      status: 'authorized',
      provider: input.envelope.provider,
      executor: input.envelope.executor,
      capabilityManifest: input.envelope.capabilityManifest,
      cancellationGeneration: 0,
      createdAt: input.at,
      updatedAt: input.at,
    });
    this.insertExecutionRequest(executionRequest);
    this.insertAgentSession(agentSession);
    const projection = workUnitPlanningProjectionItemV03Schema.parse({
      cursor: input.cursor,
      itemType: 'planning_authorized',
      outcomeId: input.outcomeId,
      workUnitId: input.workUnitId,
      workUnitRevision: input.workUnitRevision,
      executionRequestId: input.executionRequestId,
      agentSessionId: input.agentSessionId,
      createdAt: input.at,
    });
    this.storage.sql.exec(
      `INSERT INTO work_unit_planning_projection (owner_cursor, owner_id, item_json)
       VALUES (?, ?, ?)`,
      projection.cursor, input.ownerId, JSON.stringify(projection),
    );
    const result = workUnitPlanningAuthorizationResultV03Schema.parse({
      protocolVersion: '0.3',
      ownerId: input.ownerId,
      requestId: input.requestId,
      outcomeId: input.outcomeId,
      workUnitId: input.workUnitId,
      workUnitRevision: input.workUnitRevision,
      workUnitState: 'planning_authorized',
      executionRequest,
      agentSession,
      projectionCursor: input.cursor,
    });
    this.storage.sql.exec(
      `INSERT INTO work_unit_planning_commands (
        request_id, owner_id, request_digest, result_json, recorded_at
      ) VALUES (?, ?, ?, ?, ?)`,
      input.requestId, input.ownerId, input.requestDigest, JSON.stringify(result), input.at,
    );
    return Object.freeze(result);
  }

  settleCandidatePlanInCurrentTransaction(input: {
    ownerId: string;
    requestId: string;
    executionRequestId: string;
    holderId: string;
    fence: number;
    cancellationGeneration: number;
    resultDigest: string;
    candidatePlan: unknown;
    at: string;
  }) {
    const lease = this.storage.sql.exec<{
      owner_id: string; holder_id: string; fence: number;
      cancellation_generation: number; expires_at: string;
    }>(
      `SELECT owner_id, holder_id, fence, cancellation_generation, expires_at
         FROM planning_execution_leases WHERE execution_request_id = ?`,
      input.executionRequestId,
    ).toArray()[0];
    if (lease === undefined || lease.owner_id !== input.ownerId ||
        lease.holder_id !== input.holderId || lease.fence !== input.fence ||
        lease.cancellation_generation !== input.cancellationGeneration) {
      throw new Error('planning lease or fence mismatch');
    }
    if (Date.parse(lease.expires_at) <= Date.parse(input.at)) {
      throw new Error('planning lease expired');
    }
    const request = this.storage.sql.exec<{
      owner_id: string; outcome_id: string; work_unit_id: string;
      work_unit_revision: number; status: string; cancellation_generation: number;
    }>(
      `SELECT owner_id, outcome_id, work_unit_id, work_unit_revision, status,
              cancellation_generation
         FROM planning_execution_requests WHERE id = ? AND protocol_version = '0.3'`,
      input.executionRequestId,
    ).one();
    if (request.owner_id !== input.ownerId || request.status !== 'leased' ||
        request.cancellation_generation !== input.cancellationGeneration) {
      throw new Error('stale planning execution generation');
    }
    const session = this.storage.sql.exec<{ id: string; status: string }>(
      'SELECT id, status FROM planning_agent_sessions WHERE execution_request_id = ?',
      input.executionRequestId,
    ).one();
    if (session.status !== 'running' && session.status !== 'ambiguous') {
      throw new Error('planning session is not running');
    }
    // Validate untrusted provider output before this settlement method performs its first write.
    const plan = workUnitCandidatePlanV03Schema.parse(input.candidatePlan);
    const receiptRow = this.storage.sql.exec<{ invocation_key: string; provider_ref_json: string; status: string; started_at: string }>(
      `SELECT invocation_key, provider_ref_json, status, started_at
         FROM planning_provider_invocations WHERE execution_request_id = ?`,
      input.executionRequestId,
    ).one();
    if (receiptRow.status !== 'pending' && receiptRow.status !== 'ambiguous') {
      throw new Error('planning provider receipt already settled');
    }
    this.storage.sql.exec(
      `UPDATE planning_provider_invocations
          SET status = 'completed', result_digest = ?, completed_at = ?
        WHERE execution_request_id = ?`,
      input.resultDigest, input.at, input.executionRequestId,
    );
    this.storage.sql.exec(
      "UPDATE planning_execution_requests SET status = 'completed', updated_at = ? WHERE id = ?",
      input.at, input.executionRequestId,
    );
    this.storage.sql.exec(
      "UPDATE planning_agent_sessions SET status = 'completed', updated_at = ? WHERE id = ?",
      input.at, session.id,
    );
    this.storage.sql.exec(
      `INSERT INTO work_unit_candidate_plans (
        execution_request_id, owner_id, outcome_id, work_unit_id, agent_session_id,
        result_digest, plan_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.executionRequestId, input.ownerId, request.outcome_id, request.work_unit_id,
      session.id, input.resultDigest, JSON.stringify(plan), input.at,
    );
    const activityCursor = this.events.appendInCurrentTransaction({
      schemaVersion: '0.3', eventId: this.newId('event'), ownerId: input.ownerId,
      aggregateKind: 'agent_session', aggregateId: session.id,
      revision: session.status === 'ambiguous' ? 3 : 2,
      eventType: 'agent_session.completed', causationId: input.executionRequestId,
      correlationId: input.executionRequestId, occurredAt: input.at,
      payloadJson: JSON.stringify({ status: 'completed', executionRequestId: input.executionRequestId }),
    });
    this.publishActivity(input.ownerId, {
      cursor: activityCursor, itemType: 'agent_session_activity', outcomeId: request.outcome_id,
      workUnitId: request.work_unit_id, executionRequestId: input.executionRequestId,
      agentSessionId: session.id, status: 'completed', occurredAt: input.at,
    });
    const candidateCursor = this.events.appendInCurrentTransaction({
      schemaVersion: '0.3', eventId: this.newId('event'), ownerId: input.ownerId,
      aggregateKind: 'work_unit_candidate_plan', aggregateId: input.executionRequestId,
      revision: 1, eventType: 'work_unit.candidate_plan_recorded',
      causationId: input.executionRequestId, correlationId: input.executionRequestId,
      occurredAt: input.at,
      payloadJson: JSON.stringify({ resultDigest: input.resultDigest, candidatePlan: plan }),
    });
    this.publishActivity(input.ownerId, {
      cursor: candidateCursor, itemType: 'work_unit_candidate_plan',
      outcomeId: request.outcome_id, workUnitId: request.work_unit_id,
      executionRequestId: input.executionRequestId, agentSessionId: session.id,
      resultDigest: input.resultDigest, candidatePlan: plan, createdAt: input.at,
    });
    const providerInvocation = planningProviderInvocationV03Schema.parse({
      executionRequestId: input.executionRequestId,
      invocationKey: receiptRow.invocation_key,
      provider: JSON.parse(receiptRow.provider_ref_json),
      status: 'completed',
      resultDigest: input.resultDigest,
      startedAt: receiptRow.started_at,
      completedAt: input.at,
    });
    const result = workUnitPlanningTurnResultV03Schema.parse({
      protocolVersion: '0.3', ownerId: input.ownerId, requestId: input.requestId,
      outcomeId: request.outcome_id, workUnitId: request.work_unit_id,
      workUnitRevision: request.work_unit_revision, workUnitState: 'planning_authorized',
      executionRequestId: input.executionRequestId, agentSessionId: session.id,
      sessionStatus: 'completed', providerInvocation, candidatePlan: plan,
      projectionCursor: candidateCursor,
    });
    this.storage.sql.exec(
      'UPDATE work_unit_planning_commands SET result_json = ? WHERE request_id = ? AND owner_id = ?',
      JSON.stringify(result), input.requestId, input.ownerId,
    );
    return Object.freeze(result);
  }

  markProviderAmbiguousInCurrentTransaction(input: {
    ownerId: string;
    executionRequestId: string;
    at: string;
  }): void {
    const request = this.storage.sql.exec<{
      outcome_id: string; work_unit_id: string; status: string;
    }>(
      `SELECT outcome_id, work_unit_id, status
         FROM planning_execution_requests
        WHERE id = ? AND owner_id = ? AND protocol_version = '0.3'`,
      input.executionRequestId, input.ownerId,
    ).toArray()[0];
    if (request === undefined || request.status !== 'leased') return;
    const receipt = this.storage.sql.exec<{ status: string }>(
      `SELECT status FROM planning_provider_invocations
        WHERE execution_request_id = ? AND owner_id = ?`,
      input.executionRequestId, input.ownerId,
    ).one();
    if (receipt.status === 'completed') return;
    if (receipt.status === 'ambiguous') return;
    this.storage.sql.exec(
      `UPDATE planning_provider_invocations SET status = 'ambiguous'
        WHERE execution_request_id = ? AND owner_id = ?`,
      input.executionRequestId, input.ownerId,
    );
    const session = this.storage.sql.exec<{ id: string }>(
      `SELECT id FROM planning_agent_sessions
        WHERE execution_request_id = ? AND owner_id = ?`,
      input.executionRequestId, input.ownerId,
    ).one();
    this.storage.sql.exec(
      `UPDATE planning_agent_sessions SET status = 'ambiguous', updated_at = ?
        WHERE id = ? AND owner_id = ?`,
      input.at, session.id, input.ownerId,
    );
    const cursor = this.events.appendInCurrentTransaction({
      schemaVersion: '0.3', eventId: this.newId('event'), ownerId: input.ownerId,
      aggregateKind: 'agent_session', aggregateId: session.id, revision: 2,
      eventType: 'agent_session.ambiguous', causationId: input.executionRequestId,
      correlationId: input.executionRequestId, occurredAt: input.at,
      payloadJson: JSON.stringify({ status: 'ambiguous', executionRequestId: input.executionRequestId }),
    });
    this.publishActivity(input.ownerId, {
      cursor, itemType: 'agent_session_activity', outcomeId: request.outcome_id,
      workUnitId: request.work_unit_id, executionRequestId: input.executionRequestId,
      agentSessionId: session.id, status: 'ambiguous', occurredAt: input.at,
    });
  }

  cancelInCurrentTransaction(input: {
    ownerId: string;
    requestId: string;
    requestDigest: string;
    executionRequestId: string;
    expectedCancellationGeneration: number;
    at: string;
  }): WorkUnitPlanningCancelResultV03 {
    const existing = this.storage.sql.exec<StoredPlanningCommandRow>(
      `SELECT owner_id, request_digest, result_json
         FROM work_unit_planning_controls WHERE request_id = ?`,
      input.requestId,
    ).toArray()[0];
    if (existing !== undefined) {
      if (existing.owner_id !== input.ownerId || existing.request_digest !== input.requestDigest) {
        throw new ResponsibilityDigestConflictError();
      }
      return workUnitPlanningCancelResultV03Schema.parse(JSON.parse(existing.result_json));
    }
    const request = this.storage.sql.exec<{
      owner_id: string; outcome_id: string; work_unit_id: string; status: string;
      cancellation_generation: number;
    }>(
      `SELECT owner_id, outcome_id, work_unit_id, status, cancellation_generation
         FROM planning_execution_requests
        WHERE id = ? AND owner_id = ? AND protocol_version = '0.3'`,
      input.executionRequestId, input.ownerId,
    ).toArray()[0];
    if (request === undefined) {
      throw new ResponsibilityPlanningConflictError('planning execution not found');
    }
    if (request.cancellation_generation !== input.expectedCancellationGeneration) {
      throw new ResponsibilityPlanningConflictError('stale planning cancellation generation');
    }
    if (request.status === 'completed' || request.status === 'cancelled' ||
        request.status === 'failed') {
      throw new ResponsibilityPlanningConflictError('invalid planning cancellation transition');
    }
    const nextGeneration = request.cancellation_generation + 1;
    this.storage.sql.exec(
      `UPDATE planning_execution_requests
          SET status = 'cancelled', cancellation_generation = ?, updated_at = ?
        WHERE id = ? AND owner_id = ?`,
      nextGeneration, input.at, input.executionRequestId, input.ownerId,
    );
    const session = this.storage.sql.exec<{ id: string; status: string }>(
      `SELECT id, status FROM planning_agent_sessions
        WHERE execution_request_id = ? AND owner_id = ?`,
      input.executionRequestId, input.ownerId,
    ).one();
    this.storage.sql.exec(
      `UPDATE planning_agent_sessions
          SET status = 'cancelled', cancellation_generation = ?, updated_at = ?
        WHERE id = ? AND owner_id = ?`,
      nextGeneration, input.at, session.id, input.ownerId,
    );
    this.storage.sql.exec(
      `UPDATE planning_execution_leases
          SET cancellation_generation = ?
        WHERE execution_request_id = ? AND owner_id = ?`,
      nextGeneration, input.executionRequestId, input.ownerId,
    );
    this.storage.sql.exec(
      `UPDATE planning_provider_invocations SET status = 'ambiguous'
        WHERE execution_request_id = ? AND owner_id = ? AND status = 'pending'`,
      input.executionRequestId, input.ownerId,
    );
    const cursor = this.events.appendInCurrentTransaction({
      schemaVersion: '0.3', eventId: this.newId('event'), ownerId: input.ownerId,
      aggregateKind: 'agent_session', aggregateId: session.id,
      revision: session.status === 'authorized' ? 1 : session.status === 'ambiguous' ? 3 : 2,
      eventType: 'agent_session.cancelled', causationId: input.executionRequestId,
      correlationId: input.executionRequestId, occurredAt: input.at,
      payloadJson: JSON.stringify({ status: 'cancelled', executionRequestId: input.executionRequestId }),
    });
    this.publishActivity(input.ownerId, {
      cursor, itemType: 'agent_session_activity', outcomeId: request.outcome_id,
      workUnitId: request.work_unit_id, executionRequestId: input.executionRequestId,
      agentSessionId: session.id, status: 'cancelled', occurredAt: input.at,
    });
    const result = workUnitPlanningCancelResultV03Schema.parse({
      protocolVersion: '0.3', ownerId: input.ownerId, requestId: input.requestId,
      executionRequestId: input.executionRequestId, status: 'cancelled',
      cancellationGeneration: nextGeneration, projectionCursor: cursor,
      cancelledAt: input.at,
    });
    this.storage.sql.exec(
      `INSERT INTO work_unit_planning_controls (
        request_id, owner_id, request_digest, result_json, recorded_at
      ) VALUES (?, ?, ?, ?, ?)`,
      input.requestId, input.ownerId, input.requestDigest, JSON.stringify(result), input.at,
    );
    return result;
  }

  private insertExecutionRequest(request: WorkUnitPlanningExecutionRequestV03): void {
    this.storage.sql.exec(
      `INSERT INTO planning_execution_requests (
        id, owner_id, outcome_id, work_unit_id, work_unit_revision, request_id,
        request_digest, governed_inputs_json, provider_ref_json, executor_ref_json,
        capability_manifest_json, authority_ceiling_json, status,
        cancellation_generation, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      request.id, request.ownerId, request.outcomeId, request.workUnitId,
      request.workUnitRevision, request.requestId, request.requestDigest,
      JSON.stringify(request.governedInputs), JSON.stringify(request.provider),
      JSON.stringify(request.executor), JSON.stringify(request.capabilityManifest),
      JSON.stringify(request.authorityCeiling), request.status,
      request.cancellationGeneration, request.createdAt, request.updatedAt,
    );
  }

  private insertAgentSession(session: PlanningAgentSessionV03): void {
    this.storage.sql.exec(
      `INSERT INTO planning_agent_sessions (
        id, owner_id, outcome_id, work_unit_id, execution_request_id, status,
        provider_ref_json, executor_ref_json, capability_manifest_json,
        cancellation_generation, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      session.id, session.ownerId, session.outcomeId, session.workUnitId,
      session.executionRequestId, session.status, JSON.stringify(session.provider),
      JSON.stringify(session.executor), JSON.stringify(session.capabilityManifest),
      session.cancellationGeneration, session.createdAt, session.updatedAt,
    );
  }

  private publishActivity(ownerId: string, candidate: unknown): void {
    const item = workUnitPlanningProjectionItemV03Schema.parse(candidate);
    this.storage.sql.exec(
      `INSERT INTO work_unit_planning_projection (owner_cursor, owner_id, item_json)
       VALUES (?, ?, ?)`,
      item.cursor, ownerId, JSON.stringify(item),
    );
  }
}
