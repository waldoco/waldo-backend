import {
  executionEnvironmentIdentityKey,
  parseExecutionEnvironmentDescriptorV1,
  type ExecutionEnvironmentPort,
  type RegisteredExecutionEnvironment,
} from './port';
import {
  buildExecutionEnvironmentCommand,
  currentExecutionBinding,
  parseExecutionEnvironmentDispatchInput,
  type ExecutionEnvironmentDispatchInput,
} from './binding';
import {
  iso8601Schema,
  protocolDigestSchema,
  protocolIdSchema,
  protocolRevisionSchema,
} from '@waldo/contracts';
import type { ExecutionAggregateV04 } from '../coordinator/planning-execution-module';

export class ExecutionEnvironmentRegistry {
  readonly #ports = new Map<string, RegisteredExecutionEnvironment>();

  register(
    expectedDescriptorValue: unknown,
    port: ExecutionEnvironmentPort,
  ): RegisteredExecutionEnvironment {
    const descriptor = parseExecutionEnvironmentDescriptorV1(expectedDescriptorValue);
    const adapterDescriptor = parseExecutionEnvironmentDescriptorV1(port.descriptor);
    if (JSON.stringify(adapterDescriptor) !== JSON.stringify(descriptor)) {
      throw new Error('execution environment adapter descriptor does not match server pin');
    }
    const key = executionEnvironmentIdentityKey(descriptor.environment);
    if (this.#ports.has(key)) {
      throw new Error('execution environment adapter is already registered');
    }
    const registered = Object.freeze({
      descriptor,
      execute: (command: Parameters<ExecutionEnvironmentPort['execute']>[0]) =>
        port.execute(command),
      recover: (command: Parameters<ExecutionEnvironmentPort['recover']>[0]) =>
        port.recover(command),
    });
    this.#ports.set(key, registered);
    return registered;
  }

  resolve(environment: unknown): RegisteredExecutionEnvironment {
    const registered = this.#ports.get(executionEnvironmentIdentityKey(environment));
    if (registered === undefined) {
      throw new Error('execution environment adapter is not registered');
    }
    return registered;
  }
}

const observationKinds = new Set([
  'started', 'activity', 'candidate_artifact', 'candidate_evidence',
  'ended', 'failed', 'timed_out', 'unknown',
]);
const reconciliationStates = new Set([
  'running', 'cancelled', 'settled', 'failed', 'indeterminate',
]);

export type ExecutionEnvironmentObservationDraft = Readonly<{
  category: 'execution_environment_observation_draft';
  id: string;
  sequence: number;
  kind: 'started' | 'activity' | 'candidate_artifact' | 'candidate_evidence' |
    'ended' | 'failed' | 'timed_out' | 'unknown';
  payloadRef: string | null;
  payloadDigest: string | null;
  observedAt: string;
}>;

export type ExecutionEnvironmentReconciliationDraft = Readonly<{
  category: 'execution_environment_reconciliation_draft';
  id: string;
  state: 'running' | 'cancelled' | 'settled' | 'failed' | 'indeterminate';
  basisObservationIds: readonly string[];
  checkedAt: string;
}>;

export type EnvironmentDraft =
  | ExecutionEnvironmentObservationDraft
  | ExecutionEnvironmentReconciliationDraft;

export type ExecutionEnvironmentIssueResult = Readonly<{
  protocolVersion: '0.4';
  category: 'execution_environment_issue_result';
  operationId: string;
  operationDigest: string;
  status: 'observed' | 'indeterminate';
  draft: EnvironmentDraft | null;
}>;

export type ExecutionEnvironmentRecoveryResult = Readonly<{
  protocolVersion: '0.4';
  category: 'execution_environment_recovery_result';
  operationId: string;
  operationDigest: string;
  status: 'known_not_applied' | 'observed' | 'indeterminate';
  result: ExecutionEnvironmentIssueResult | null;
  checkedAt: string;
}>;

function strictResult(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a strict object`);
  }
  return value as Record<string, unknown>;
}

function exactResultKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (Object.keys(value).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${label} contains unrecognized or missing fields`);
  }
}

function parseDraft(value: unknown): EnvironmentDraft {
  const draft = strictResult(value, 'execution environment draft');
  if (draft.category === 'execution_environment_observation_draft') {
    exactResultKeys(draft, [
      'category', 'id', 'sequence', 'kind', 'payloadRef', 'payloadDigest', 'observedAt',
    ], 'execution environment observation draft');
    if (!observationKinds.has(String(draft.kind))) {
      throw new Error('execution environment observation kind is invalid');
    }
    if ((draft.payloadRef === null) !== (draft.payloadDigest === null)) {
      throw new Error('execution environment observation payload binding is incomplete');
    }
    const sequence = protocolRevisionSchema.parse(draft.sequence);
    if (sequence < 1) throw new Error('observation sequence must be positive');
    return Object.freeze({
      category: draft.category,
      id: protocolIdSchema.parse(draft.id),
      sequence,
      kind: draft.kind as ExecutionEnvironmentObservationDraft['kind'],
      payloadRef: draft.payloadRef === null ? null : protocolIdSchema.parse(draft.payloadRef),
      payloadDigest: draft.payloadDigest === null
        ? null
        : protocolDigestSchema.parse(draft.payloadDigest),
      observedAt: iso8601Schema.parse(draft.observedAt),
    });
  }
  if (draft.category === 'execution_environment_reconciliation_draft') {
    exactResultKeys(draft, [
      'category', 'id', 'state', 'basisObservationIds', 'checkedAt',
    ], 'execution environment reconciliation draft');
    if (!reconciliationStates.has(String(draft.state))) {
      throw new Error('execution environment reconciliation state is invalid');
    }
    if (!Array.isArray(draft.basisObservationIds) || draft.basisObservationIds.length > 64) {
      throw new Error('execution environment reconciliation basis is invalid');
    }
    return Object.freeze({
      category: draft.category,
      id: protocolIdSchema.parse(draft.id),
      state: draft.state as ExecutionEnvironmentReconciliationDraft['state'],
      basisObservationIds: Object.freeze(
        draft.basisObservationIds.map((id) => protocolIdSchema.parse(id)),
      ),
      checkedAt: iso8601Schema.parse(draft.checkedAt),
    });
  }
  throw new Error('execution environment draft category is invalid');
}

export function parseExecutionEnvironmentIssueResult(
  value: unknown,
): ExecutionEnvironmentIssueResult {
  const input = strictResult(value, 'execution environment issue result');
  exactResultKeys(input, [
    'protocolVersion', 'category', 'operationId', 'operationDigest', 'status', 'draft',
  ], 'execution environment issue result');
  if (input.protocolVersion !== '0.4' ||
      input.category !== 'execution_environment_issue_result' ||
      (input.status !== 'observed' && input.status !== 'indeterminate')) {
    throw new Error('execution environment issue result discriminator is invalid');
  }
  if ((input.status === 'observed') !== (input.draft !== null)) {
    throw new Error('execution environment issue result draft is contradictory');
  }
  return Object.freeze({
    protocolVersion: '0.4',
    category: 'execution_environment_issue_result',
    operationId: protocolIdSchema.parse(input.operationId),
    operationDigest: protocolDigestSchema.parse(input.operationDigest),
    status: input.status,
    draft: input.draft === null ? null : parseDraft(input.draft),
  });
}

export function parseExecutionEnvironmentRecoveryResult(
  value: unknown,
): ExecutionEnvironmentRecoveryResult {
  const input = strictResult(value, 'execution environment recovery result');
  exactResultKeys(input, [
    'protocolVersion', 'category', 'operationId', 'operationDigest',
    'status', 'result', 'checkedAt',
  ], 'execution environment recovery result');
  if (input.protocolVersion !== '0.4' ||
      input.category !== 'execution_environment_recovery_result' ||
      (input.status !== 'known_not_applied' && input.status !== 'observed' &&
        input.status !== 'indeterminate')) {
    throw new Error('execution environment recovery result discriminator is invalid');
  }
  if ((input.status === 'observed') !== (input.result !== null)) {
    throw new Error('execution environment recovery result is contradictory');
  }
  const result = input.result === null ? null : parseExecutionEnvironmentIssueResult(input.result);
  if (result !== null && result.status !== 'observed') {
    throw new Error('execution environment recovered result is not observed');
  }
  const operationId = protocolIdSchema.parse(input.operationId);
  const operationDigest = protocolDigestSchema.parse(input.operationDigest);
  if (result !== null &&
      (result.operationId !== operationId || result.operationDigest !== operationDigest)) {
    throw new Error('execution environment recovered operation identity mismatch');
  }
  return Object.freeze({
    protocolVersion: '0.4',
    category: 'execution_environment_recovery_result',
    operationId,
    operationDigest,
    status: input.status,
    result,
    checkedAt: iso8601Schema.parse(input.checkedAt),
  });
}

function assertOperationIdentity(
  expected: Readonly<{ operationId: string; operationDigest: string }>,
  actual: Readonly<{ operationId: string; operationDigest: string }>,
): void {
  if (actual.operationId !== expected.operationId ||
      actual.operationDigest !== expected.operationDigest) {
    throw new Error('execution environment operation identity mismatch');
  }
}

export type ExecutionEnvironmentDispatchResult = Readonly<{
  command: Awaited<ReturnType<typeof buildExecutionEnvironmentCommand>>;
  support: Readonly<{
    action: ExecutionEnvironmentDispatchInput['action'];
    mode: 'native' | 'emulated';
    version: string;
  }>;
  status: 'known_not_applied' | 'observed' | 'indeterminate';
  result: ExecutionEnvironmentIssueResult | null;
  checkedAt: string | null;
}>;

export class ExecutionEnvironmentBoundary {
  readonly #registered: RegisteredExecutionEnvironment;
  readonly #dependencies: Readonly<{
    readCurrentAggregate(
      ownerId: string,
      executionRequestId: string,
    ): ExecutionAggregateV04 | Promise<ExecutionAggregateV04>;
    now(): string;
  }>;

  constructor(
    registered: RegisteredExecutionEnvironment,
    dependencies: Readonly<{
      readCurrentAggregate(
        ownerId: string,
        executionRequestId: string,
      ): ExecutionAggregateV04 | Promise<ExecutionAggregateV04>;
      now(): string;
    }>,
  ) {
    this.#registered = registered;
    this.#dependencies = dependencies;
  }

  #assertLeaseActive(expiresAt: string): void {
    const now = iso8601Schema.parse(this.#dependencies.now());
    if (Date.parse(now) >= Date.parse(expiresAt)) {
      throw new Error('execution environment lease is expired');
    }
  }

  async #readCurrentForCommand(
    ownerId: string,
    command: Awaited<ReturnType<typeof buildExecutionEnvironmentCommand>>,
  ): Promise<ReturnType<typeof currentExecutionBinding>> {
    const aggregate = await this.#dependencies.readCurrentAggregate(
      ownerId,
      command.executionRequestId,
    );
    const current = currentExecutionBinding(aggregate);
    if (current.aggregate.request.id !== command.executionRequestId ||
        current.attempt.id !== command.attemptId ||
        current.lease.id !== command.leaseId ||
        current.session.id !== command.sessionId ||
        current.attempt.fencingGeneration !== command.fencingGeneration ||
        current.attempt.cancellationGeneration !== command.cancellationGeneration ||
        current.aggregate.currentCancellationGeneration !== command.cancellationGeneration ||
        current.lease.expiresAt !== command.leaseExpiresAt ||
        executionEnvironmentIdentityKey(current.aggregate.request.environment) !==
          executionEnvironmentIdentityKey(command.environment) ||
        JSON.stringify(current.aggregate.request.provider) !== JSON.stringify(command.provider) ||
        current.aggregate.request.contextProjectionRef !== command.contextProjectionRef ||
        current.aggregate.request.contextProjectionDigest !== command.contextProjectionDigest ||
        (command.action === 'cancel' && current.attempt.state !== 'cancelling') ||
        (command.action !== 'cancel' && command.action !== 'reconcile' &&
          current.attempt.state !== 'running')) {
      throw new Error('execution environment aggregate is stale before external I/O');
    }
    this.#assertLeaseActive(current.lease.expiresAt);
    return current;
  }

  async dispatch(
    aggregate: ExecutionAggregateV04,
    input: ExecutionEnvironmentDispatchInput,
  ): Promise<ExecutionEnvironmentDispatchResult> {
    const parsedInput = parseExecutionEnvironmentDispatchInput(input);
    const capability = this.#registered.descriptor.capabilities[parsedInput.action];
    if (capability === undefined || capability.mode === 'unsupported') {
      throw new Error(`execution environment ${parsedInput.action} capability is unsupported`);
    }
    const recoveryCapability = this.#registered.descriptor.capabilities.reconcile;
    if (recoveryCapability.mode === 'unsupported') {
      throw new Error('execution environment reconciliation capability is unsupported');
    }
    const supplied = currentExecutionBinding(aggregate);
    const currentAggregate = await this.#dependencies.readCurrentAggregate(
      supplied.aggregate.request.ownerId,
      supplied.aggregate.request.id,
    );
    const current = currentExecutionBinding(currentAggregate);
    if (current.aggregate.request.ownerId !== supplied.aggregate.request.ownerId ||
        current.aggregate.request.id !== supplied.aggregate.request.id ||
        current.attempt.id !== supplied.attempt.id ||
        current.lease.id !== supplied.lease.id ||
        current.session.id !== supplied.session.id ||
        current.attempt.state !== supplied.attempt.state ||
        current.attempt.fencingGeneration !== supplied.attempt.fencingGeneration ||
        current.attempt.cancellationGeneration !== supplied.attempt.cancellationGeneration ||
        current.aggregate.currentCancellationGeneration !==
          supplied.aggregate.currentCancellationGeneration ||
        executionEnvironmentIdentityKey(current.aggregate.request.environment) !==
          executionEnvironmentIdentityKey(supplied.aggregate.request.environment) ||
        JSON.stringify(current.aggregate.request.provider) !==
          JSON.stringify(supplied.aggregate.request.provider) ||
        current.aggregate.request.contextProjectionRef !==
          supplied.aggregate.request.contextProjectionRef ||
        current.aggregate.request.contextProjectionDigest !==
          supplied.aggregate.request.contextProjectionDigest) {
      throw new Error('execution environment aggregate is stale before external I/O');
    }
    const command = await buildExecutionEnvironmentCommand(
      current.aggregate,
      parsedInput,
      {
        adapter: this.#registered.descriptor.adapter,
        capability: {
          action: parsedInput.action,
          mode: capability.mode,
          version: capability.version,
        },
      },
    );
    if (executionEnvironmentIdentityKey(command.environment) !==
        executionEnvironmentIdentityKey(this.#registered.descriptor.environment)) {
      throw new Error('execution environment command does not match registered adapter');
    }
    const support = Object.freeze({
      action: parsedInput.action,
      mode: capability.mode,
      version: capability.version,
    }) as ExecutionEnvironmentDispatchResult['support'];
    await this.#readCurrentForCommand(current.aggregate.request.ownerId, command);
    const recovery = parseExecutionEnvironmentRecoveryResult(
      await this.#registered.recover(command),
    );
    assertOperationIdentity(command, recovery);
    const afterRecovery = await this.#readCurrentForCommand(
      current.aggregate.request.ownerId,
      command,
    );
    if (recovery.status !== 'known_not_applied') {
      return Object.freeze({
        command,
        support,
        status: recovery.status,
        result: recovery.result,
        checkedAt: recovery.checkedAt,
      });
    }
    if (parsedInput.action === 'reconcile') {
      return Object.freeze({
        command,
        support,
        status: recovery.status,
        result: null,
        checkedAt: recovery.checkedAt,
      });
    }
    if (parsedInput.action === 'start' && afterRecovery.session.lastObservationSequence > 0) {
      throw new Error('execution environment start was already observed');
    }
    const result = parseExecutionEnvironmentIssueResult(
      await this.#registered.execute(command),
    );
    assertOperationIdentity(command, result);
    await this.#readCurrentForCommand(current.aggregate.request.ownerId, command);
    return Object.freeze({
      command,
      support,
      status: result.status,
      result,
      checkedAt: null,
    });
  }
}
