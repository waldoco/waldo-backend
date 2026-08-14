import {
  executionAttemptV04Schema,
  executionEnvironmentRefV04Schema,
  executionLeaseV04Schema,
  executionReconciliationV04Schema,
  executionRequestV04Schema,
  executionSessionV04Schema,
  executorObservationV04Schema,
  protocolDigestSchema,
  protocolIdSchema,
} from '@waldo/contracts';
import type { ExecutionAggregateV04 } from '../coordinator/planning-execution-module';
import {
  EXECUTION_ENVIRONMENT_ACTIONS,
  type ExecutionEnvironmentAction,
  type ExecutionEnvironmentCommandV1,
} from './port';
import type { ExecutionEnvironmentDispatchResult } from './conformance';

export type ExecutionEnvironmentControl = Readonly<{
  payloadRef: string;
  payloadDigest: string;
}> | null;

export type ExecutionEnvironmentDispatchInput = Readonly<{
  action: ExecutionEnvironmentAction;
  intentRef: string;
  control: ExecutionEnvironmentControl;
}>;

export type ExecutionEnvironmentOperationBinding = Readonly<{
  adapter: Readonly<{ id: string; version: string }>;
  capability: Readonly<{
    action: ExecutionEnvironmentAction;
    mode: 'native' | 'emulated';
    version: string;
  }>;
}>;

export type CurrentExecutionBinding = Readonly<{
  aggregate: ExecutionAggregateV04;
  attempt: ExecutionAggregateV04['attempts'][number];
  lease: ExecutionAggregateV04['leases'][number];
  session: ExecutionAggregateV04['sessions'][number];
}>;

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseAction(value: unknown): ExecutionEnvironmentAction {
  if (!EXECUTION_ENVIRONMENT_ACTIONS.includes(value as ExecutionEnvironmentAction)) {
    throw new Error('execution environment action is invalid');
  }
  return value as ExecutionEnvironmentAction;
}

function strictDispatchRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('execution environment dispatch input must be a strict object');
  }
  return value as Record<string, unknown>;
}

function parseControl(value: unknown, action: ExecutionEnvironmentAction): ExecutionEnvironmentControl {
  if (value === null) {
    if (action === 'steer') throw new Error('steer requires a bounded control reference');
    return null;
  }
  if (action !== 'steer') throw new Error('control reference is only valid for steer');
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('execution environment control must be a strict object');
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 2 ||
      !Object.hasOwn(input, 'payloadRef') || !Object.hasOwn(input, 'payloadDigest')) {
    throw new Error('execution environment control contains unrecognized fields');
  }
  return Object.freeze({
    payloadRef: protocolIdSchema.parse(input.payloadRef),
    payloadDigest: protocolDigestSchema.parse(input.payloadDigest),
  });
}

export function parseExecutionEnvironmentDispatchInput(
  value: unknown,
): ExecutionEnvironmentDispatchInput {
  const input = strictDispatchRecord(value);
  const keys = ['action', 'intentRef', 'control'];
  if (Object.keys(input).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(input, key))) {
    throw new Error('execution environment dispatch input contains unrecognized fields');
  }
  const action = parseAction(input.action);
  return Object.freeze({
    action,
    intentRef: protocolIdSchema.parse(input.intentRef),
    control: parseControl(input.control, action),
  });
}

export function currentExecutionBinding(value: ExecutionAggregateV04): CurrentExecutionBinding {
  const request = executionRequestV04Schema.parse(value.request);
  if (!Number.isSafeInteger(value.currentCancellationGeneration) ||
      value.currentCancellationGeneration < 0) {
    throw new Error('execution aggregate cancellation generation is invalid');
  }
  const attempts = value.attempts.map((item) => executionAttemptV04Schema.parse(item));
  const leases = value.leases.map((item) => executionLeaseV04Schema.parse(item));
  const sessions = value.sessions.map((item) => executionSessionV04Schema.parse(item));
  const attempt = attempts.at(-1);
  if (attempt === undefined) throw new Error('execution environment requires a claimed attempt');
  const lease = leases.find((item) => item.id === attempt.leaseId);
  const session = sessions.find((item) => item.attemptId === attempt.id);
  if (lease === undefined || session === undefined) {
    throw new Error('execution aggregate current binding is incomplete');
  }
  if (attempt.executionRequestId !== request.id || lease.executionRequestId !== request.id ||
      lease.attemptId !== attempt.id || session.attemptId !== attempt.id ||
      attempt.fencingGeneration !== lease.fencingGeneration ||
      attempt.cancellationGeneration !== lease.cancellationGeneration ||
      attempt.cancellationGeneration !== value.currentCancellationGeneration ||
      !sameValue(request.provider, attempt.provider) ||
      !sameValue(request.provider, session.provider) ||
      !sameValue(request.environment, attempt.environment) ||
      !sameValue(request.environment, session.environment) ||
      !sameValue(request.environment, lease.holder)) {
    throw new Error('execution aggregate current binding is contradictory');
  }
  return Object.freeze({
    aggregate: Object.freeze({
      ...value,
      request,
      attempts: Object.freeze(attempts),
      leases: Object.freeze(leases),
      sessions: Object.freeze(sessions),
    }),
    attempt,
    lease,
    session,
  });
}

export async function buildExecutionEnvironmentCommand(
  aggregateValue: ExecutionAggregateV04,
  inputValue: ExecutionEnvironmentDispatchInput,
  operationBinding: ExecutionEnvironmentOperationBinding,
): Promise<ExecutionEnvironmentCommandV1> {
  const current = currentExecutionBinding(aggregateValue);
  const input = parseExecutionEnvironmentDispatchInput(inputValue);
  const { action, intentRef, control } = input;
  if (operationBinding.capability.action !== action) {
    throw new Error('execution environment operation capability does not match action');
  }
  if (action === 'cancel' && current.attempt.state !== 'cancelling') {
    throw new Error('execution cancellation must be committed before adapter I/O');
  }
  if (action !== 'cancel' && action !== 'reconcile' && current.attempt.state !== 'running') {
    throw new Error('execution environment action requires a running attempt');
  }
  const material = Object.freeze({
    protocolVersion: '0.4' as const,
    category: 'execution_environment_command' as const,
    intentRef,
    action,
    adapter: Object.freeze({ ...operationBinding.adapter }),
    capability: Object.freeze({ ...operationBinding.capability }),
    executionRequestId: current.aggregate.request.id,
    attemptId: current.attempt.id,
    sessionId: current.session.id,
    leaseId: current.lease.id,
    fencingGeneration: current.attempt.fencingGeneration,
    cancellationGeneration: current.attempt.cancellationGeneration,
    leaseExpiresAt: current.lease.expiresAt,
    provider: current.aggregate.request.provider,
    environment: current.aggregate.request.environment,
    contextProjectionRef: current.aggregate.request.contextProjectionRef,
    contextProjectionDigest: current.aggregate.request.contextProjectionDigest,
    control,
  });
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(material)),
  );
  const digestHex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')).join('');
  const operationDigest = protocolDigestSchema.parse(`sha256:${digestHex}`);
  const operationId = protocolIdSchema.parse(`execution_operation_${digestHex}`);
  return Object.freeze({
    ...material,
    operationId,
    operationDigest,
    provider: Object.freeze({
      ...material.provider,
      manifest: Object.freeze({ ...material.provider.manifest }),
    }),
    environment: Object.freeze({
      ...executionEnvironmentRefV04Schema.parse(material.environment),
      manifest: Object.freeze({ ...material.environment.manifest }),
    }),
    control,
  });
}

function assertDispatchMatchesCurrent(
  current: CurrentExecutionBinding,
  dispatch: ExecutionEnvironmentDispatchResult,
): void {
  const command = dispatch.command;
  if (command.executionRequestId !== current.aggregate.request.id ||
      command.attemptId !== current.attempt.id ||
      command.sessionId !== current.session.id ||
      command.leaseId !== current.lease.id ||
      command.fencingGeneration !== current.attempt.fencingGeneration ||
      command.cancellationGeneration !== current.attempt.cancellationGeneration ||
      command.leaseExpiresAt !== current.lease.expiresAt ||
      command.contextProjectionRef !== current.aggregate.request.contextProjectionRef ||
      command.contextProjectionDigest !== current.aggregate.request.contextProjectionDigest ||
      !sameValue(command.provider, current.aggregate.request.provider) ||
      !sameValue(command.environment, current.aggregate.request.environment)) {
    throw new Error('execution environment result does not match current canonical binding');
  }
  if (dispatch.status !== 'observed' || dispatch.result?.status !== 'observed' ||
      dispatch.result.draft === null) {
    throw new Error('execution environment result is not an attributable observation');
  }
}

export function materializeExecutorObservationV04(
  aggregate: ExecutionAggregateV04,
  dispatch: ExecutionEnvironmentDispatchResult,
) {
  const current = currentExecutionBinding(aggregate);
  assertDispatchMatchesCurrent(current, dispatch);
  const draft = dispatch.result!.draft!;
  if (draft.category !== 'execution_environment_observation_draft') {
    throw new Error('execution environment result is not an observation draft');
  }
  return executorObservationV04Schema.parse({
    protocolVersion: '0.4',
    id: draft.id,
    ownerId: current.aggregate.request.ownerId,
    attemptId: current.attempt.id,
    environment: current.aggregate.request.environment,
    leaseId: current.lease.id,
    fencingGeneration: current.attempt.fencingGeneration,
    cancellationGeneration: current.attempt.cancellationGeneration,
    sequence: draft.sequence,
    kind: draft.kind,
    payloadRef: draft.payloadRef,
    payloadDigest: draft.payloadDigest,
    observedAt: draft.observedAt,
  });
}

export function materializeExecutionReconciliationV04(
  aggregate: ExecutionAggregateV04,
  dispatch: ExecutionEnvironmentDispatchResult,
) {
  const current = currentExecutionBinding(aggregate);
  assertDispatchMatchesCurrent(current, dispatch);
  const draft = dispatch.result!.draft!;
  if (draft.category !== 'execution_environment_reconciliation_draft') {
    throw new Error('execution environment result is not a reconciliation draft');
  }
  return executionReconciliationV04Schema.parse({
    protocolVersion: '0.4',
    id: draft.id,
    ownerId: current.aggregate.request.ownerId,
    attemptId: current.attempt.id,
    leaseId: current.lease.id,
    fencingGeneration: current.attempt.fencingGeneration,
    cancellationGeneration: current.attempt.cancellationGeneration,
    state: draft.state,
    basisObservationIds: draft.basisObservationIds,
    checkedAt: draft.checkedAt,
  });
}
