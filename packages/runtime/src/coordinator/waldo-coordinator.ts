import {
  canonicalizeWorkUnitPlanningTurnRequestV03ForDigest,
  canonicalizeWorkUnitPlanningCancelRequestV03ForDigest,
  canonicalizeSurfaceCommandRequestForDigest,
  canonicalizeResponsibilityCaptureRequestV02ForDigest,
  executionAttemptV04Schema,
  executionCancelRequestV04Schema,
  executionLeaseV04Schema,
  executionReconciliationV04Schema,
  executionRequestV04Schema,
  executionSessionV04Schema,
  executorObservationV04Schema,
  responsibilityCaptureRequestSchema,
  responsibilityCaptureRequestV02Schema,
  responsibilityCaptureResultSchema,
  responsibilityCaptureTrustedEnvelopeSchema,
  responsibilityCaptureTrustedEnvelopeV02Schema,
  responsibilityProjectionItemV02Schema,
  responsibilityProjectionPageV01CompatibilitySchema,
  responsibilityProjectionPageV02Schema,
  workUnitPlanningAuthorizationResultV03Schema,
  workUnitPlanningCancelRequestV03Schema,
  workUnitPlanningTurnRequestV03Schema,
  workUnitPlanningTurnTrustedEnvelopeV03Schema,
  type ResponsibilityCaptureResult as ResponsibilityCaptureResultContract,
  type ResponsibilityCaptureRequestV02,
  type ResponsibilityCaptureTrustedEnvelopeV02,
  type ResponsibilityProjectionPageV01Compatibility,
  type ResponsibilityProjectionPageV02,
  type WorkUnitPlanningAuthorizationResultV03,
  type WorkUnitPlanningCommandResultV03,
  type WorkUnitPlanningCancelResultV03,
  type WorkUnitPlanningTurnResultV03,
  type WorkUnitPlanningTurnRequestV03,
  type WorkUnitPlanningTurnTrustedEnvelopeV03,
  type WorkUnitPlanningProjectionPageV03,
} from '@waldo/contracts';
import {
  IdentityPresenceModule,
  type ResponsibilityCanonicalAuthority,
  type ResponsibilityCanonicalAuthorityRegistration,
} from './identity-presence-module';
import {
  ResponsibilityDigestConflictError,
  ResponsibilityOwnerRootMismatchError,
  ResponsibilityProjectionCursorError,
} from '../responsibility/errors';
import { OwnerEventLog } from './owner-event-log';
import {
  OutcomeModule,
  type MissionRecord,
  type OutcomeRecord,
  type ResponsibilityReplay,
  type WorkUnitRecord,
} from './outcome-module';
import {
  PlanningExecutionModule,
  type ExecutionAdmissionBindingV04,
  type ExecutionAggregateV04,
} from './planning-execution-module';
import type { LLMGatewayRequest, TrustedProviderEffect } from '../llm/provider';

export type {
  MissionRecord,
  OutcomeRecord,
  ResponsibilityReplay,
  WorkUnitRecord,
} from './outcome-module';

export type ResponsibilityCaptureResult = ResponsibilityCaptureResultContract;

export type ResponsibilityCaptureAdmission = Readonly<{
  routedOwnerId: string;
  request: unknown;
  trustedEnvelope: unknown;
}>;

export type ResponsibilityProjectionRead = Readonly<{
  routedOwnerId: string;
  protocolVersion?: '0.1' | '0.2';
  fromExclusiveCursor: number;
  limit: number;
  snapshotId?: string;
}>;

export type WorkUnitPlanningAdmission = Readonly<{
  routedOwnerId: string;
  request: unknown;
  trustedEnvelope: unknown;
}>;

export type WorkUnitPlanningCancelAdmission = Readonly<{
  routedOwnerId: string;
  request: unknown;
}>;

export type WorkUnitPlanningProjectionRead = Readonly<{
  routedOwnerId: string;
  fromExclusiveCursor: number;
  limit: number;
  snapshotId?: string;
}>;

export type CoordinatorWriteStage =
  | 'owner_root'
  | 'current_state'
  | 'events'
  | 'projection'
  | 'idempotency'
  | 'work_unit_authority'
  | 'execution_request'
  | 'execution_attempt'
  | 'execution_observation'
  | 'execution_cancellation'
  | 'execution_reconciliation'
  | 'planning_projection'
  | 'provider_intent'
  | 'provider_result';

export type CoordinatorDependencies = Readonly<{
  now: () => string;
  newId: (
    kind: 'outcome' | 'mission' | 'work_unit' | 'event' | 'snapshot' |
      'execution_request' | 'agent_session',
  ) => string;
  sha256Hex: (value: string) => Promise<string>;
  afterWrite?: (stage: CoordinatorWriteStage) => void;
}>;

type StoredCommandRow = {
  owner_id: string;
  request_digest: string;
  result_json: string;
};

function defaultDependencies(): CoordinatorDependencies {
  return {
    now: () => new Date().toISOString(),
    newId: (kind) => `${kind}_${crypto.randomUUID()}`,
    async sha256Hex(value) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
      return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
    },
  };
}

export class WaldoCoordinator {
  readonly #storage: DurableObjectStorage;
  readonly #deps: CoordinatorDependencies;
  readonly #identity: IdentityPresenceModule;
  readonly #events: OwnerEventLog;
  readonly #outcomes: OutcomeModule;
  readonly #planning: PlanningExecutionModule;

  constructor(
    storage: DurableObjectStorage,
    dependencies: CoordinatorDependencies = defaultDependencies(),
  ) {
    this.#storage = storage;
    this.#deps = dependencies;
    this.#identity = new IdentityPresenceModule(storage);
    this.#events = new OwnerEventLog(storage);
    this.#outcomes = new OutcomeModule(storage, dependencies.newId);
    this.#planning = new PlanningExecutionModule(storage, dependencies.newId);
  }

  admitCanonicalAuthority(
    registration: ResponsibilityCanonicalAuthorityRegistration,
    beforeCommit?: () => void,
  ): ResponsibilityCanonicalAuthority {
    return this.#storage.transactionSync(() => {
      const authority = this.#identity
        .bootstrapOrRefreshCanonicalAuthorityInCurrentTransaction(registration);
      beforeCommit?.();
      return authority;
    });
  }

  assertCanonicalAuthority(
    authority: ResponsibilityCanonicalAuthority,
  ): ResponsibilityCanonicalAuthority {
    return this.#identity.assertCanonicalAuthorityInCurrentTransaction(
      authority,
      this.#deps.now(),
    );
  }

  async captureResponsibility(
    admission: ResponsibilityCaptureAdmission,
  ): Promise<ResponsibilityCaptureResult> {
    return this.#captureResponsibility(admission);
  }

  async captureAuthorizedResponsibility(
    admission: ResponsibilityCaptureAdmission,
    canonicalAuthority: ResponsibilityCanonicalAuthority,
  ): Promise<ResponsibilityCaptureResult> {
    return this.#captureResponsibility(admission, canonicalAuthority);
  }

  async authorizePlanningTurn(
    admission: WorkUnitPlanningAdmission,
    canonicalAuthority: ResponsibilityCanonicalAuthority,
  ): Promise<WorkUnitPlanningAuthorizationResultV03> {
    const request = workUnitPlanningTurnRequestV03Schema.parse(admission.request);
    const envelope = workUnitPlanningTurnTrustedEnvelopeV03Schema.parse(
      admission.trustedEnvelope,
    );
    this.#validatePlanningAdmission(admission.routedOwnerId, request, envelope);
    const requestDigest = `sha256:${await this.#deps.sha256Hex(
      canonicalizeWorkUnitPlanningTurnRequestV03ForDigest(request),
    )}`;
    if (envelope.requestDigest !== requestDigest) throw new ResponsibilityDigestConflictError();
    for (const governedInput of request.payload.governedInputs) {
      const contentDigest = `sha256:${await this.#deps.sha256Hex(governedInput.content)}`;
      if (contentDigest !== governedInput.digest) throw new ResponsibilityDigestConflictError();
    }

    return this.#storage.transactionSync(() => {
      this.#identity.assertCanonicalAuthorityInCurrentTransaction(
        canonicalAuthority,
        this.#deps.now(),
      );
      this.#assertEnvelopeAuthority(canonicalAuthority, request, envelope);
      const existing = this.#planning.readIdempotentAuthorization(
        admission.routedOwnerId,
        request.requestId,
        requestDigest,
      );
      if (existing !== null) return Object.freeze(
        workUnitPlanningAuthorizationResultV03Schema.parse(existing),
      );

      const at = this.#deps.now();
      const executionRequestId = this.#deps.newId('execution_request');
      const agentSessionId = this.#deps.newId('agent_session');
      const authorized = this.#outcomes.authorizePlanningInCurrentTransaction({
        ownerId: admission.routedOwnerId,
        workUnitId: request.aggregate.id,
        expectedRevision: request.aggregate.expectedRevision,
        agentSessionId,
        executorId: envelope.executor.executorId,
        at,
        commandId: envelope.commandId,
        correlationId: envelope.correlationId,
        authorityCeiling: envelope.authorityCeiling,
        maxDurationMs: 120_000,
      });
      this.#deps.afterWrite?.('work_unit_authority');
      const result = this.#planning.persistAuthorizationInCurrentTransaction({
        ownerId: admission.routedOwnerId,
        requestId: request.requestId,
        requestDigest,
        outcomeId: authorized.workUnit.outcomeId,
        workUnitId: authorized.workUnit.id,
        workUnitRevision: authorized.workUnit.revision,
        executionRequestId,
        agentSessionId,
        cursor: authorized.cursor,
        at,
        envelope,
      });
      this.#deps.afterWrite?.('execution_request');
      this.#deps.afterWrite?.('planning_projection');
      this.#deps.afterWrite?.('idempotency');
      return result;
    });
  }

  async readPlanningCommandResult(
    ownerId: string,
    request: WorkUnitPlanningTurnRequestV03,
  ): Promise<WorkUnitPlanningCommandResultV03 | null> {
    const requestDigest = `sha256:${await this.#deps.sha256Hex(
      canonicalizeWorkUnitPlanningTurnRequestV03ForDigest(request),
    )}`;
    return this.#planning.readIdempotentResult(ownerId, request.requestId, requestDigest);
  }

  async admitExecutionRequestV04(
    requestValue: unknown,
    trustedBinding: ExecutionAdmissionBindingV04,
    canonicalAuthority: ResponsibilityCanonicalAuthority,
  ): Promise<ExecutionAggregateV04> {
    const request = executionRequestV04Schema.parse(requestValue);
    const preflightAuthority = this.#identity.assertCanonicalAuthorityInCurrentTransaction(
      canonicalAuthority,
      this.#deps.now(),
    );
    if (preflightAuthority.ownerId !== request.ownerId ||
        preflightAuthority.ownerId !== trustedBinding.routedOwnerId) {
      throw new ResponsibilityOwnerRootMismatchError();
    }
    const productMaterial = this.#planning.readExecutionProductDigestMaterialV04(
      request.ownerId,
      request.outcome.id,
      request.workUnit.id,
    );
    const [requestDigestHex, outcomeDigestHex, workUnitDigestHex] = await Promise.all([
      this.#deps.sha256Hex(JSON.stringify(request)),
      this.#deps.sha256Hex(productMaterial.outcomeMaterial),
      this.#deps.sha256Hex(productMaterial.workUnitMaterial),
    ]);
    const requestDigest = `sha256:${requestDigestHex}`;
    const productDigestProof = Object.freeze({
      ...productMaterial,
      outcomeDigest: `sha256:${outcomeDigestHex}`,
      workUnitDigest: `sha256:${workUnitDigestHex}`,
    });
    return this.#storage.transactionSync(() => {
      const authority = this.#identity.assertCanonicalAuthorityInCurrentTransaction(
        canonicalAuthority,
        this.#deps.now(),
      );
      if (authority.ownerId !== request.ownerId ||
          authority.ownerId !== trustedBinding.routedOwnerId) {
        throw new ResponsibilityOwnerRootMismatchError();
      }
      this.#planning.admitExecutionRequestV04InCurrentTransaction({
        request,
        trustedBinding,
        requestDigest,
        productDigestProof,
      });
      this.#deps.afterWrite?.('execution_request');
      return this.#planning.readExecutionAggregateV04(request.ownerId, request.id);
    });
  }

  claimExecutionAttemptV04(input: Readonly<{
    attempt: unknown;
    lease: unknown;
    session: unknown;
  }>): ExecutionAggregateV04 {
    const attempt = executionAttemptV04Schema.parse(input.attempt);
    const lease = executionLeaseV04Schema.parse(input.lease);
    const session = executionSessionV04Schema.parse(input.session);
    return this.#storage.transactionSync(() => {
      this.#planning.claimExecutionAttemptV04InCurrentTransaction({
        attempt,
        lease,
        session,
        claimedAt: this.#deps.now(),
      });
      this.#deps.afterWrite?.('execution_attempt');
      return this.#planning.readExecutionAggregateV04(
        attempt.ownerId,
        attempt.executionRequestId,
      );
    });
  }

  async admitExecutorObservationV04(
    observationValue: unknown,
    receivedAt = this.#deps.now(),
  ): Promise<ExecutionAggregateV04> {
    const observation = executorObservationV04Schema.parse(observationValue);
    const observationDigest = `sha256:${await this.#deps.sha256Hex(
      JSON.stringify(observation),
    )}`;
    return this.#storage.transactionSync(() => {
      this.#planning.admitExecutorObservationV04InCurrentTransaction({
        observation,
        observationDigest,
        receivedAt,
      });
      this.#deps.afterWrite?.('execution_observation');
      return this.#planning.readExecutionAggregateForAttemptV04(
        observation.ownerId,
        observation.attemptId,
      );
    });
  }

  async cancelExecutionV04(input: Readonly<{
    request: unknown;
    canonicalAuthority: ResponsibilityCanonicalAuthority;
  }>): Promise<ExecutionAggregateV04> {
    const request = executionCancelRequestV04Schema.parse(input.request);
    const requestDigest = `sha256:${await this.#deps.sha256Hex(JSON.stringify(request))}`;
    return this.#storage.transactionSync(() => {
      const at = this.#deps.now();
      const authority = this.#identity.assertCanonicalAuthorityInCurrentTransaction(
        input.canonicalAuthority,
        at,
      );
      if (authority.presenceRegistrationId !== request.presenceRegistrationId) {
        throw new Error('execution cancellation authority mismatch');
      }
      this.#planning.cancelExecutionV04InCurrentTransaction({
        ownerId: authority.ownerId,
        request,
        requestDigest,
        at,
      });
      this.#deps.afterWrite?.('execution_cancellation');
      return this.#planning.readExecutionAggregateV04(
        authority.ownerId,
        request.executionRequestId,
      );
    });
  }

  async reconcileExecutionAttemptV04(
    reconciliationValue: unknown,
  ): Promise<ExecutionAggregateV04> {
    const reconciliation = executionReconciliationV04Schema.parse(reconciliationValue);
    const reconciliationDigest = `sha256:${await this.#deps.sha256Hex(
      JSON.stringify(reconciliation),
    )}`;
    return this.#storage.transactionSync(() => {
      this.#planning.reconcileExecutionAttemptV04InCurrentTransaction({
        reconciliation,
        reconciliationDigest,
        receivedAt: this.#deps.now(),
      });
      this.#deps.afterWrite?.('execution_reconciliation');
      return this.#planning.readExecutionAggregateForAttemptV04(
        reconciliation.ownerId,
        reconciliation.attemptId,
      );
    });
  }

  readExecutionAggregateV04(
    ownerId: string,
    executionRequestId: string,
  ): ExecutionAggregateV04 {
    return this.#planning.readExecutionAggregateV04(ownerId, executionRequestId);
  }

  readPlanningPromptMaterial(ownerId: string, executionRequestId: string) {
    return this.#planning.readPromptMaterial(ownerId, executionRequestId);
  }

  readPendingPlanningProviderEffect(
    ownerId: string,
    executionRequestId: string,
  ) {
    const at = this.#deps.now();
    const renewedExpiresAt = new Date(Date.parse(at) + 120_000).toISOString();
    return this.#storage.transactionSync(() =>
      this.#planning.recoverPendingProviderEffectInCurrentTransaction(
        ownerId, executionRequestId, at, renewedExpiresAt,
      ));
  }

  async preparePlanningProviderEffect(input: {
    ownerId: string;
    executionRequestId: string;
    holderId: string;
    request: LLMGatewayRequest;
  }): Promise<Readonly<{
    effect: TrustedProviderEffect;
    fence: number;
    cancellationGeneration: number;
  }>> {
    const requestDigest = await this.#deps.sha256Hex(JSON.stringify(input.request));
    const identityDigest = await this.#deps.sha256Hex(JSON.stringify({
      executionRequestId: input.executionRequestId,
      requestDigest,
      execution: {
        step: input.request.step,
        context: input.request.context,
        fallback_step: input.request.fallback_step,
      },
    }));
    const at = this.#deps.now();
    const expiresAt = new Date(Date.parse(at) + 120_000).toISOString();
    return this.#storage.transactionSync(() => {
      const prepared = this.#planning.prepareProviderEffectInCurrentTransaction({
        ...input,
        at,
        expiresAt,
        requestDigest,
        effectRef: `planning_effect_${identityDigest.slice(0, 64)}`,
        invocationKey: `sha256:${identityDigest}`,
      });
      this.#deps.afterWrite?.('provider_intent');
      return prepared;
    });
  }

  async settlePlanningCandidatePlan(input: {
    ownerId: string;
    requestId: string;
    executionRequestId: string;
    holderId: string;
    fence: number;
    cancellationGeneration: number;
    candidatePlan: unknown;
  }): Promise<WorkUnitPlanningTurnResultV03> {
    const resultDigest = `sha256:${await this.#deps.sha256Hex(
      JSON.stringify(input.candidatePlan),
    )}`;
    return this.#storage.transactionSync(() => {
      const result = this.#planning.settleCandidatePlanInCurrentTransaction({
        ...input,
        resultDigest,
        at: this.#deps.now(),
      });
      this.#deps.afterWrite?.('provider_result');
      return result;
    });
  }

  markPlanningProviderAmbiguous(ownerId: string, executionRequestId: string): void {
    this.#storage.transactionSync(() => {
      this.#planning.markProviderAmbiguousInCurrentTransaction({
        ownerId, executionRequestId, at: this.#deps.now(),
      });
    });
  }

  async rejectPlanningProviderOutput(input: {
    ownerId: string;
    executionRequestId: string;
    holderId: string;
    fence: number;
    cancellationGeneration: number;
    providerOutput: string;
  }): Promise<void> {
    const resultDigest = `sha256:${await this.#deps.sha256Hex(input.providerOutput)}`;
    this.#storage.transactionSync(() => {
      this.#planning.rejectInvalidProviderOutputInCurrentTransaction({
        ownerId: input.ownerId,
        executionRequestId: input.executionRequestId,
        holderId: input.holderId,
        fence: input.fence,
        cancellationGeneration: input.cancellationGeneration,
        resultDigest,
        at: this.#deps.now(),
      });
      this.#deps.afterWrite?.('provider_result');
    });
  }

  async cancelAuthorizedPlanningExecution(
    admission: WorkUnitPlanningCancelAdmission,
    canonicalAuthority: ResponsibilityCanonicalAuthority,
  ): Promise<WorkUnitPlanningCancelResultV03> {
    const request = workUnitPlanningCancelRequestV03Schema.parse(admission.request);
    if (request.presenceRegistrationId !== canonicalAuthority.presenceRegistrationId) {
      throw new Error('planning cancellation presence mismatch');
    }
    const requestDigest = `sha256:${await this.#deps.sha256Hex(
      canonicalizeWorkUnitPlanningCancelRequestV03ForDigest(request),
    )}`;
    return this.#storage.transactionSync(() => {
      this.#identity.assertCanonicalAuthorityInCurrentTransaction(
        canonicalAuthority,
        this.#deps.now(),
      );
      return this.#planning.cancelInCurrentTransaction({
        ownerId: admission.routedOwnerId,
        requestId: request.requestId,
        requestDigest,
        executionRequestId: request.executionRequestId,
        expectedCancellationGeneration: request.expectedCancellationGeneration,
        at: this.#deps.now(),
      });
    });
  }

  readAuthorizedPlanningProjection(
    input: WorkUnitPlanningProjectionRead,
    canonicalAuthority: ResponsibilityCanonicalAuthority,
  ): WorkUnitPlanningProjectionPageV03 {
    this.#identity.assertCanonicalAuthorityInCurrentTransaction(
      canonicalAuthority,
      this.#deps.now(),
    );
    const snapshot = this.#outcomes.projections.readSnapshot(input.routedOwnerId);
    return this.#planning.readProjection({
      ownerId: input.routedOwnerId,
      fromExclusiveCursor: input.fromExclusiveCursor,
      limit: input.limit,
      ...(input.snapshotId === undefined ? {} : { snapshotId: input.snapshotId }),
      currentSnapshotId: snapshot.snapshotId,
      snapshotBaseCursor: snapshot.snapshotBaseCursor,
      generatedAt: this.#deps.now(),
    });
  }

  async #captureResponsibility(
    admission: ResponsibilityCaptureAdmission,
    canonicalAuthority?: ResponsibilityCanonicalAuthority,
  ): Promise<ResponsibilityCaptureResult> {
    const parsed = this.#parseAdmission(admission);
    const { request, trustedEnvelope } = parsed;
    const requestDigest = `sha256:${await this.#deps.sha256Hex(
      parsed.canonicalRequest,
    )}`;
    if (trustedEnvelope.requestDigest !== requestDigest) {
      throw new ResponsibilityDigestConflictError();
    }

    return this.#storage.transactionSync(() => {
      const at = this.#deps.now();
      if (canonicalAuthority === undefined) {
        this.#identity.bindOrAssertOwnerRootInCurrentTransaction(admission.routedOwnerId, at);
      } else {
        this.#identity.assertCanonicalAuthorityInCurrentTransaction(canonicalAuthority, at);
      }
      this.#deps.afterWrite?.('owner_root');

      const existing = this.#storage.sql.exec<StoredCommandRow>(
        `SELECT owner_id, request_digest, result_json
           FROM responsibility_commands WHERE request_id = ?`,
        request.requestId,
      ).toArray()[0];
      if (existing !== undefined) {
        if (existing.owner_id !== admission.routedOwnerId ||
            existing.request_digest !== requestDigest) {
          throw new ResponsibilityDigestConflictError();
        }
        const persisted = responsibilityCaptureResultSchema.parse(
          JSON.parse(existing.result_json),
        );
        this.#assertPersistedCaptureResult(persisted, request, parsed.responseVersion);
        return Object.freeze(persisted);
      }

      this.#outcomes.projections.ensureSnapshotInCurrentTransaction(
        admission.routedOwnerId,
        this.#deps.newId('snapshot'),
        at,
      );

      const captured = this.#outcomes.captureInCurrentTransaction({
        ownerId: admission.routedOwnerId,
        payload: request.payload,
        at,
        commandId: trustedEnvelope.commandId,
        correlationId: trustedEnvelope.correlationId,
        afterCurrentState: () => this.#deps.afterWrite?.('current_state'),
        afterEvents: () => this.#deps.afterWrite?.('events'),
        afterProjection: () => this.#deps.afterWrite?.('projection'),
      });
      const result = Object.freeze(responsibilityCaptureResultSchema.parse({
        protocolVersion: parsed.responseVersion,
        ownerId: admission.routedOwnerId,
        requestId: request.requestId,
        outcome: captured.outcome,
        mission: captured.mission,
        workUnits: captured.workUnits,
        projectionCursor: captured.finalCursor,
      }));
      this.#storage.sql.exec(
        `INSERT INTO responsibility_commands (
          request_id, owner_id, request_digest, result_json, recorded_at
        ) VALUES (?, ?, ?, ?, ?)`,
        request.requestId,
        result.ownerId,
        requestDigest,
        JSON.stringify(result),
        at,
      );
      this.#deps.afterWrite?.('idempotency');
      return result;
    });
  }

  readResponsibilityProjection(
    input: ResponsibilityProjectionRead,
  ): ResponsibilityProjectionPageV02 | ResponsibilityProjectionPageV01Compatibility {
    return this.#readResponsibilityProjection(input);
  }

  readAuthorizedResponsibilityProjection(
    input: ResponsibilityProjectionRead,
    canonicalAuthority: ResponsibilityCanonicalAuthority,
  ): ResponsibilityProjectionPageV02 | ResponsibilityProjectionPageV01Compatibility {
    return this.#readResponsibilityProjection(input, canonicalAuthority);
  }

  #readResponsibilityProjection(
    input: ResponsibilityProjectionRead,
    canonicalAuthority?: ResponsibilityCanonicalAuthority,
  ): ResponsibilityProjectionPageV02 | ResponsibilityProjectionPageV01Compatibility {
    if (!Number.isSafeInteger(input.fromExclusiveCursor) || input.fromExclusiveCursor < 0) {
      throw new Error('invalid responsibility projection cursor');
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 256) {
      throw new Error('invalid responsibility projection page limit');
    }
    if (canonicalAuthority === undefined) {
      this.#identity.assertOwnerRoot(input.routedOwnerId);
    } else {
      this.#identity.assertCanonicalAuthorityInCurrentTransaction(
        canonicalAuthority,
        this.#deps.now(),
      );
    }
    const snapshot = this.#outcomes.projections.readSnapshot(input.routedOwnerId);
    if (input.fromExclusiveCursor > 0 && input.snapshotId === undefined) {
      throw new ResponsibilityProjectionCursorError('snapshot_replaced');
    }
    if (input.snapshotId !== undefined && input.snapshotId !== snapshot.snapshotId) {
      throw new ResponsibilityProjectionCursorError('snapshot_replaced');
    }
    const highWaterCursor = this.#events.readHighWater(input.routedOwnerId);
    if (input.fromExclusiveCursor > highWaterCursor) {
      throw new ResponsibilityProjectionCursorError('cursor_ahead');
    }
    const rows = this.#storage.sql.exec<{ owner_cursor: number; item_json: string }>(
      `SELECT owner_cursor, item_json
         FROM responsibility_projection
        WHERE owner_id = ? AND owner_cursor > ? AND owner_cursor <= ?
        ORDER BY owner_cursor ASC
        LIMIT ?`,
      input.routedOwnerId,
      input.fromExclusiveCursor,
      highWaterCursor,
      input.limit,
    ).toArray();
    let previous = input.fromExclusiveCursor;
    const items = rows.map((row) => {
      const item = responsibilityProjectionItemV02Schema.parse(JSON.parse(row.item_json));
      if (row.owner_cursor <= previous || row.owner_cursor !== item.cursor) {
        throw new ResponsibilityProjectionCursorError('cursor_corrupt');
      }
      previous = row.owner_cursor;
      return item;
    });
    const filledPage = rows.length === input.limit;
    const generatedAt = this.#deps.now();
    let truncatedByByteLimit = false;
    while (true) {
      const nextCursor = (filledPage || truncatedByByteLimit) && items.length > 0
        ? items.at(-1)!.cursor
        : highWaterCursor;
      const candidate = {
        protocolVersion: input.protocolVersion ?? '0.2',
        ownerId: input.routedOwnerId,
        projectionName: 'responsibility.summary',
        snapshotId: snapshot.snapshotId,
        snapshotBaseCursor: snapshot.snapshotBaseCursor,
        fromExclusiveCursor: input.fromExclusiveCursor,
        highWaterCursor,
        nextCursor,
        items,
        hasMore: nextCursor < highWaterCursor,
        generatedAt,
      };
      const parsed = input.protocolVersion === '0.1'
        ? responsibilityProjectionPageV01CompatibilitySchema.safeParse(candidate)
        : responsibilityProjectionPageV02Schema.safeParse(candidate);
      if (parsed.success) return parsed.data;
      if (items.length === 0) throw parsed.error;
      items.pop();
      truncatedByByteLimit = true;
    }
  }

  replayResponsibility(routedOwnerId: string): ResponsibilityReplay {
    this.#identity.assertOwnerRoot(routedOwnerId);
    return this.#outcomes.replay(routedOwnerId);
  }

  #validateTrustedAdmission(
    routedOwnerId: string,
    request: Readonly<{ protocolVersion: string; payload: unknown }>,
    trustedEnvelope: Readonly<{
      protocolVersion: string;
      ownerId: string;
      aggregate?: unknown;
      expectedRevision?: number;
      payload: unknown;
    }>,
  ): void {
    if (trustedEnvelope.ownerId !== routedOwnerId) {
      throw new ResponsibilityOwnerRootMismatchError();
    }
    if (request.protocolVersion !== trustedEnvelope.protocolVersion) {
      throw new Error('responsibility protocol version mismatch');
    }
    if (trustedEnvelope.aggregate !== undefined || trustedEnvelope.expectedRevision !== undefined) {
      throw new Error('responsibility capture authority fields must be server-owned');
    }
    if (JSON.stringify(trustedEnvelope.payload) !== JSON.stringify(request.payload)) {
      throw new Error('responsibility capture payload mismatch');
    }
  }

  #validatePlanningAdmission(
    routedOwnerId: string,
    request: WorkUnitPlanningTurnRequestV03,
    envelope: WorkUnitPlanningTurnTrustedEnvelopeV03,
  ): void {
    if (envelope.ownerId !== routedOwnerId) throw new ResponsibilityOwnerRootMismatchError();
    if (request.protocolVersion !== envelope.protocolVersion ||
        request.commandType !== envelope.commandType ||
        request.aggregate.kind !== envelope.aggregate.kind ||
        request.aggregate.id !== envelope.aggregate.id ||
        request.aggregate.expectedRevision !== envelope.aggregate.expectedRevision) {
      throw new Error('planning protocol or aggregate mismatch');
    }
    const admittedRefs = request.payload.governedInputs.map(({ ref, digest }) => ({ ref, digest }));
    if (JSON.stringify(admittedRefs) !== JSON.stringify(envelope.payload.governedInputs)) {
      throw new Error('planning governed input reference mismatch');
    }
  }

  #assertEnvelopeAuthority(
    authority: ResponsibilityCanonicalAuthority,
    request: WorkUnitPlanningTurnRequestV03,
    envelope: WorkUnitPlanningTurnTrustedEnvelopeV03,
  ): void {
    if (authority.ownerId !== envelope.ownerId ||
        authority.presenceRegistrationId !== request.presenceRegistrationId ||
        authority.presenceId !== envelope.presenceId ||
        authority.authenticatedSessionId !== envelope.authenticatedSessionId ||
        authority.ownerPolicyRevision !== envelope.ownerPolicyRevision ||
        authority.ownerRootRoutingVersion !== envelope.ownerRootRoutingVersion ||
        envelope.actor.kind !== 'presence' || envelope.actor.id !== authority.presenceId) {
      throw new ResponsibilityOwnerRootMismatchError();
    }
  }

  #parseAdmission(admission: ResponsibilityCaptureAdmission): Readonly<{
    request: ResponsibilityCaptureRequestV02;
    trustedEnvelope: ResponsibilityCaptureTrustedEnvelopeV02;
    canonicalRequest: string;
    responseVersion: '0.1' | '0.2';
  }> {
    const version = (admission.request as { protocolVersion?: unknown } | null)?.protocolVersion;
    if (version === '0.1') {
      const requestV01 = responsibilityCaptureRequestSchema.parse(admission.request);
      const envelopeV01 = responsibilityCaptureTrustedEnvelopeSchema.parse(
        admission.trustedEnvelope,
      );
      this.#validateTrustedAdmission(admission.routedOwnerId, requestV01, envelopeV01);
      return Object.freeze({
        request: responsibilityCaptureRequestV02Schema.parse({
          ...requestV01,
          protocolVersion: '0.2',
        }),
        trustedEnvelope: responsibilityCaptureTrustedEnvelopeV02Schema.parse({
          ...envelopeV01,
          protocolVersion: '0.2',
        }),
        canonicalRequest: canonicalizeSurfaceCommandRequestForDigest(requestV01),
        responseVersion: '0.1',
      });
    }
    const request = responsibilityCaptureRequestV02Schema.parse(admission.request);
    const trustedEnvelope = responsibilityCaptureTrustedEnvelopeV02Schema.parse(
      admission.trustedEnvelope,
    );
    this.#validateTrustedAdmission(admission.routedOwnerId, request, trustedEnvelope);
    return Object.freeze({
      request,
      trustedEnvelope,
      canonicalRequest: canonicalizeResponsibilityCaptureRequestV02ForDigest(request),
      responseVersion: '0.2',
    });
  }

  #assertPersistedCaptureResult(
    persisted: ResponsibilityCaptureResult,
    request: ResponsibilityCaptureRequestV02,
    responseVersion: '0.1' | '0.2',
  ): void {
    if (persisted.protocolVersion !== responseVersion || persisted.ownerId === '' ||
        persisted.requestId !== request.requestId ||
        persisted.outcome.userStatement !== request.payload.userStatement ||
        (persisted.mission?.brief ?? null) !== (request.payload.mission?.brief ?? null) ||
        persisted.workUnits.length !== (request.payload.workUnits?.length ?? 0) ||
        persisted.workUnits.some((workUnit, index) => {
          const admitted = request.payload.workUnits?.[index];
          return admitted === undefined || workUnit.responsibility !== admitted.responsibility ||
            JSON.stringify(workUnit.inputs) !== JSON.stringify(admitted.inputs) ||
            JSON.stringify(workUnit.expectedEvidence) !== JSON.stringify(admitted.expectedEvidence) ||
            JSON.stringify(workUnit.requiredCapabilities) !==
              JSON.stringify(admitted.requiredCapabilities) ||
            JSON.stringify(workUnit.stopConditions) !== JSON.stringify(admitted.stopConditions);
        })) {
      throw new Error('responsibility capture persisted result mismatch');
    }
    const replay = this.#outcomes.replay(persisted.ownerId);
    const outcome = replay.outcomes.find((value) => value.id === persisted.outcome.id);
    const mission = persisted.mission === null ? null
      : replay.missions.find((value) => value.id === persisted.mission!.id) ?? null;
    const workUnits = replay.workUnits.filter(
      (value) => value.outcomeId === persisted.outcome.id,
    ).sort((left, right) => left.position - right.position);
    const outcomeItems = replay.items.filter(
      (item) => item.outcomeId === persisted.outcome.id,
    );
    const finalOutcomeCursor = outcomeItems.at(-1)?.cursor;
    if (JSON.stringify(outcome) !== JSON.stringify(persisted.outcome) ||
        JSON.stringify(mission) !== JSON.stringify(persisted.mission) ||
        JSON.stringify(workUnits) !== JSON.stringify(persisted.workUnits) ||
        finalOutcomeCursor !== persisted.projectionCursor) {
      throw new Error('responsibility capture persisted result mismatch');
    }
  }
}
