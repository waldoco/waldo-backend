import { iso8601Schema } from '@waldo/contracts';
import {
  parseExecutionEnvironmentCommandV1,
  parseExecutionEnvironmentDescriptorV1,
  type ExecutionEnvironmentAction,
  type ExecutionEnvironmentCommandV1,
  type ExecutionEnvironmentDescriptorV1,
  type ExecutionEnvironmentPort,
} from './port';

type FakeIssueResult = Readonly<{
  protocolVersion: '0.4';
  category: 'execution_environment_issue_result';
  operationId: string;
  operationDigest: string;
  status: 'observed' | 'indeterminate';
  draft: unknown | null;
}>;

type FakeReceipt = Readonly<{
  operationDigest: string;
  result: FakeIssueResult;
  checkedAt: string;
}>;

export type DeterministicFakeExecutionEnvironmentStore = {
  readonly receipts: Map<string, FakeReceipt>;
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
    this.#script = Object.freeze({ ...input.script });
    this.#now = input.now;
  }

  async execute(commandValue: ExecutionEnvironmentCommandV1): Promise<unknown> {
    this.#store.executeCalls += 1;
    const command = parseExecutionEnvironmentCommandV1(commandValue);
    this.#assertCommandBinding(command);
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
    const result: FakeIssueResult = Object.freeze({
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
    if (script.disconnectAfterApply === true) {
      throw new Error('deterministic fake disconnected after external apply');
    }
    return result;
  }

  async recover(commandValue: ExecutionEnvironmentCommandV1): Promise<unknown> {
    this.#store.recoverCalls += 1;
    const command = parseExecutionEnvironmentCommandV1(commandValue);
    this.#assertCommandBinding(command);
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
        const result: FakeIssueResult = Object.freeze({
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

  #assertCommandBinding(command: ExecutionEnvironmentCommandV1): void {
    const capability = this.descriptor.capabilities[command.action];
    if (JSON.stringify(command.adapter) !== JSON.stringify(this.descriptor.adapter) ||
        JSON.stringify(command.environment) !== JSON.stringify(this.descriptor.environment) ||
        capability.mode === 'unsupported' ||
        command.capability.action !== command.action ||
        command.capability.mode !== capability.mode ||
        command.capability.version !== capability.version) {
      throw new Error('execution environment command does not match adapter descriptor');
    }
  }
}
