import { iso8601Schema } from '@waldo/contracts';
import {
  parseExecutionEnvironmentCommandV1,
  parseExecutionEnvironmentDescriptorV1,
  type ExecutionEnvironmentAction,
  type ExecutionEnvironmentCommandV1,
  type ExecutionEnvironmentDescriptorV1,
  type ExecutionEnvironmentPort,
} from './port';
import { verifyExecutionEnvironmentCommandIdentity } from './binding';
import {
  parseExecutionEnvironmentIssueResult,
  type ExecutionEnvironmentIssueResult,
} from './conformance';

type FakeReceipt = Readonly<{
  operationDigest: string;
  result: ExecutionEnvironmentIssueResult;
  checkedAt: string;
}>;

type FakeAuthorityHighWater = Readonly<{
  adapterId: string;
  adapterVersion: string;
  environmentIdentity: string;
  leaseId: string;
  fencingGeneration: number;
  cancellationGeneration: number;
}>;

type FakeVerifiedCommand = Readonly<{
  operationDigest: string;
  canonicalCommand: string;
}>;

export type DeterministicFakeExecutionEnvironmentStore = {
  readonly receipts: Map<string, FakeReceipt>;
  readonly authorityHighWater: Map<string, FakeAuthorityHighWater>;
  readonly verifiedCommands: Map<string, FakeVerifiedCommand>;
  readonly unresolvedOperations: Map<string, Map<ExecutionEnvironmentAction, string>>;
  physicalIssues: number;
  executeCalls: number;
  recoverCalls: number;
};

export type DeterministicFakeExecutionEnvironmentScript = Readonly<
  Partial<Record<ExecutionEnvironmentAction, Readonly<{
    status: 'observed' | 'indeterminate';
    draft: unknown | null;
    disconnectAfterApply?: boolean;
  }>>>
>;

export function createDeterministicFakeExecutionEnvironmentStore():
DeterministicFakeExecutionEnvironmentStore {
  return {
    receipts: new Map(),
    authorityHighWater: new Map(),
    verifiedCommands: new Map(),
    unresolvedOperations: new Map(),
    physicalIssues: 0,
    executeCalls: 0,
    recoverCalls: 0,
  };
}

export class DeterministicFakeExecutionEnvironment implements ExecutionEnvironmentPort {
  readonly descriptor: ExecutionEnvironmentDescriptorV1;
  readonly #store: DeterministicFakeExecutionEnvironmentStore;
  readonly #script: DeterministicFakeExecutionEnvironmentScript;
  readonly #now: () => string;

  constructor(input: Readonly<{
    descriptor: unknown;
    store: DeterministicFakeExecutionEnvironmentStore;
    script: DeterministicFakeExecutionEnvironmentScript;
    now: () => string;
  }>) {
    this.descriptor = parseExecutionEnvironmentDescriptorV1(input.descriptor);
    this.#store = input.store;
    this.#script = Object.freeze(Object.fromEntries(
      Object.entries(input.script).map(([action, script]) => [
        action,
        script === undefined ? undefined : Object.freeze({
          ...script,
          draft: structuredClone(script.draft),
        }),
      ]),
    ));
    this.#now = input.now;
  }

  async execute(commandValue: ExecutionEnvironmentCommandV1): Promise<unknown> {
    this.#store.executeCalls += 1;
    const command = parseExecutionEnvironmentCommandV1(commandValue);
    const verified = this.#store.verifiedCommands.get(command.operationId);
    if (verified === undefined || verified.operationDigest !== command.operationDigest ||
        verified.canonicalCommand !== JSON.stringify(command)) {
      throw new Error('execution environment execute requires matching recovered command identity');
    }
    this.#assertCommandBinding(command, true);
    const existing = this.#store.receipts.get(command.operationId);
    if (existing !== undefined) {
      if (existing.operationDigest !== command.operationDigest) {
        throw new Error('execution environment operation digest conflict');
      }
      return existing.result;
    }
    const script = this.#script[command.action];
    if (script === undefined) {
      throw new Error(`deterministic fake has no ${command.action} script`);
    }
    if ((script.status === 'observed') !== (script.draft !== null)) {
      throw new Error('deterministic fake script is contradictory');
    }
    this.#store.physicalIssues += 1;
    const checkedAt = iso8601Schema.parse(this.#now());
    const result = parseExecutionEnvironmentIssueResult({
      protocolVersion: '0.4',
      category: 'execution_environment_issue_result',
      operationId: command.operationId,
      operationDigest: command.operationDigest,
      status: script.status,
      draft: script.draft,
    });
    this.#store.receipts.set(command.operationId, Object.freeze({
      operationDigest: command.operationDigest,
      result,
      checkedAt,
    }));
    let unresolved = this.#store.unresolvedOperations.get(command.executionRequestId);
    if (result.status === 'indeterminate') {
      if (unresolved === undefined) {
        unresolved = new Map();
        this.#store.unresolvedOperations.set(command.executionRequestId, unresolved);
      }
      unresolved.set(command.action, command.operationId);
    } else if (unresolved?.get(command.action) === command.operationId) {
      unresolved.delete(command.action);
      if (unresolved.size === 0) {
        this.#store.unresolvedOperations.delete(command.executionRequestId);
      }
    }
    if (script.disconnectAfterApply === true) {
      throw new Error('deterministic fake disconnected after external apply');
    }
    return result;
  }

  async recover(commandValue: ExecutionEnvironmentCommandV1): Promise<unknown> {
    this.#store.recoverCalls += 1;
    const command = await verifyExecutionEnvironmentCommandIdentity(commandValue);
    this.#assertCommandBinding(command, false);
    const unresolved = this.#store.unresolvedOperations.get(command.executionRequestId);
    const unresolvedForAction = unresolved?.get(command.action);
    if (unresolvedForAction !== undefined && unresolvedForAction !== command.operationId) {
      throw new Error('execution environment fake requires reconciliation before reissue');
    }
    if (command.action !== 'cancel' && command.action !== 'reconcile' &&
        unresolved !== undefined &&
        [...unresolved.values()].some((operationId) => operationId !== command.operationId)) {
      throw new Error('execution environment fake requires reconciliation before new effect');
    }
    const canonicalCommand = JSON.stringify(command);
    const verified = this.#store.verifiedCommands.get(command.operationId);
    if (verified !== undefined &&
        (verified.operationDigest !== command.operationDigest ||
          verified.canonicalCommand !== canonicalCommand)) {
      throw new Error('execution environment recovered command identity conflict');
    }
    this.#store.verifiedCommands.set(command.operationId, Object.freeze({
      operationDigest: command.operationDigest,
      canonicalCommand,
    }));
    const existing = this.#store.receipts.get(command.operationId);
    if (existing === undefined) {
      const reconcileScript = command.action === 'reconcile'
        ? this.#script.reconcile
        : undefined;
      if (reconcileScript !== undefined) {
        if (reconcileScript.disconnectAfterApply === true) {
          throw new Error('recovery cannot issue or apply an external operation');
        }
        if ((reconcileScript.status === 'observed') !== (reconcileScript.draft !== null)) {
          throw new Error('deterministic fake reconciliation script is contradictory');
        }
        const checkedAt = iso8601Schema.parse(this.#now());
        const result = parseExecutionEnvironmentIssueResult({
          protocolVersion: '0.4',
          category: 'execution_environment_issue_result',
          operationId: command.operationId,
          operationDigest: command.operationDigest,
          status: reconcileScript.status,
          draft: reconcileScript.draft,
        });
        this.#store.receipts.set(command.operationId, Object.freeze({
          operationDigest: command.operationDigest,
          result,
          checkedAt,
        }));
        return Object.freeze({
          protocolVersion: '0.4',
          category: 'execution_environment_recovery_result',
          operationId: command.operationId,
          operationDigest: command.operationDigest,
          status: result.status,
          result: result.status === 'observed' ? result : null,
          checkedAt,
        });
      }
      return Object.freeze({
        protocolVersion: '0.4',
        category: 'execution_environment_recovery_result',
        operationId: command.operationId,
        operationDigest: command.operationDigest,
        status: 'known_not_applied',
        result: null,
        checkedAt: iso8601Schema.parse(this.#now()),
      });
    }
    if (existing.operationDigest !== command.operationDigest) {
      throw new Error('execution environment operation digest conflict');
    }
    return Object.freeze({
      protocolVersion: '0.4',
      category: 'execution_environment_recovery_result',
      operationId: command.operationId,
      operationDigest: command.operationDigest,
      status: existing.result.status,
      result: existing.result.status === 'observed' ? existing.result : null,
      checkedAt: existing.checkedAt,
    });
  }

  #assertCommandBinding(
    command: ExecutionEnvironmentCommandV1,
    requireActiveLease: boolean,
  ): void {
    const capability = this.descriptor.capabilities[command.action];
    if (JSON.stringify(command.adapter) !== JSON.stringify(this.descriptor.adapter) ||
        JSON.stringify(command.environment) !== JSON.stringify(this.descriptor.environment) ||
        capability.mode === 'unsupported' ||
        command.capability.action !== command.action ||
        command.capability.mode !== capability.mode ||
        command.capability.version !== capability.version) {
      throw new Error('execution environment command does not match adapter descriptor');
    }
    const now = iso8601Schema.parse(this.#now());
    if (requireActiveLease && Date.parse(now) >= Date.parse(command.leaseExpiresAt)) {
      throw new Error('execution environment fake rejected an expired lease');
    }
    const previous = this.#store.authorityHighWater.get(command.executionRequestId);
    if (previous !== undefined &&
        (command.adapter.id !== previous.adapterId ||
          command.adapter.version !== previous.adapterVersion ||
          JSON.stringify(command.environment) !== previous.environmentIdentity)) {
      throw new Error('execution environment fake rejected adapter or environment authority drift');
    }
    if (previous !== undefined &&
        (command.fencingGeneration < previous.fencingGeneration ||
          command.cancellationGeneration < previous.cancellationGeneration ||
          (command.leaseId !== previous.leaseId &&
            command.fencingGeneration <= previous.fencingGeneration))) {
      throw new Error('execution environment fake rejected stale or conflicting authority');
    }
    if (previous === undefined ||
        command.fencingGeneration > previous.fencingGeneration ||
        command.cancellationGeneration > previous.cancellationGeneration) {
      this.#store.authorityHighWater.set(command.executionRequestId, Object.freeze({
        adapterId: command.adapter.id,
        adapterVersion: command.adapter.version,
        environmentIdentity: JSON.stringify(command.environment),
        leaseId: command.leaseId,
        fencingGeneration: command.fencingGeneration,
        cancellationGeneration: command.cancellationGeneration,
      }));
    }
  }
}
