import {
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

/** Owns execution-harness state; it never writes Outcome, Mission, or WorkUnit truth. */
export class PlanningExecutionModule {
  private readonly events: OwnerEventLog;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly newId: (kind: 'event') => string,
  ) {
    this.events = new OwnerEventLog(storage);
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
        WHERE requests.owner_id = ? AND requests.id = ?`,
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
        WHERE id = ? AND owner_id = ?`,
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
         FROM planning_execution_requests WHERE id = ?`,
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
         FROM planning_execution_requests WHERE id = ?`,
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
         FROM planning_execution_requests WHERE id = ?`,
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
        WHERE id = ? AND owner_id = ?`,
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
         FROM planning_execution_requests WHERE id = ? AND owner_id = ?`,
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
