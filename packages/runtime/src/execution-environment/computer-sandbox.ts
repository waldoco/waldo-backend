import { iso8601Schema } from '@waldo/contracts';
import {
  parseExecutionEnvironmentCommandV1,
  parseExecutionEnvironmentDescriptorV1,
  type ExecutionEnvironmentCommandV1,
  type ExecutionEnvironmentDescriptorV1,
  type ExecutionEnvironmentPort,
} from './port';
import { verifyExecutionEnvironmentCommandIdentity } from './binding';
import {
  parseExecutionEnvironmentIssueResult,
  type EnvironmentDraft,
  type ExecutionEnvironmentIssueResult,
} from './conformance';

// Computer-tier spike (issue #775). Flag-off: nothing constructs this outside tests until a later slice wires it.
// Supports start, cancel and reconcile only; steer, pause and resume stay unsupported in the descriptor.
//
// Money. The cap is Waldo's own meter, not the provider's. It is constructor config with NO default, and nothing in
// this file can raise it. Spend is wall-clock seconds this adapter observed times the list rate below, so it counts a
// sandbox as running until Waldo has seen it stop. It ignores the plan's included allotment, which can only over-count.
// Rates: https://developers.cloudflare.com/containers/pricing/ (Workers Paid, fetched 2026-10-05):
//   $0.000020 per vCPU-second, $0.0000025 per GiB-second memory, $0.00000007 per GB-second disk.
// Stored in nano-dollars so the arithmetic stays integer.
export const CLOUDFLARE_CONTAINER_RATES_NANO_USD = Object.freeze({ vcpuSecond: 20_000, gibSecond: 2_500, gbSecond: 70 });
// standard-2 on the same page: 1 vCPU, 6 GiB memory, 12 GB disk.
export const STANDARD_2_INSTANCE = Object.freeze({ vcpu: 1, gib: 6, gb: 12 });

export type SandboxInstance = Readonly<{ vcpu: number; gib: number; gb: number }>;
export type SandboxHandle = Readonly<{ sandboxId: string; state: 'running' | 'exited' | 'killed' }>;
// The provider seam. `key` is the operation id: start must be idempotent on it and lookup(key) must find a sandbox that start created.
export interface SandboxClient {
  start(input: Readonly<{ key: string; instance: SandboxInstance }>): Promise<SandboxHandle>;
  lookup(key: string): Promise<SandboxHandle | null>;
  status(sandboxId: string): Promise<SandboxHandle | null>;
  kill(sandboxId: string): Promise<void>;
}

type LedgerEntry = {
  key: string;
  requestId: string;
  sandboxId: string | null;
  startedAtMs: number;
  endedAtMs: number | null;
  endReason: 'cancelled' | 'cap' | 'exited' | null;
  startObservationId: string;
};
type Receipt = Readonly<{ operationDigest: string; result: ExecutionEnvironmentIssueResult; checkedAt: string }>;
type HighWater = Readonly<{ leaseId: string; fencingGeneration: number; cancellationGeneration: number; adapter: string; environment: string }>;

export type ComputerSandboxStore = {
  readonly receipts: Map<string, Receipt>;
  readonly verified: Map<string, Readonly<{ operationDigest: string; canonical: string }>>;
  readonly highWater: Map<string, HighWater>;
  readonly ledger: Map<string, LedgerEntry>; // by executionRequestId
};
export const createComputerSandboxStore = (): ComputerSandboxStore => ({ receipts: new Map(), verified: new Map(), highWater: new Map(), ledger: new Map() });

export type CapKill = Readonly<{ requestId: string; sandboxId: string; draft: EnvironmentDraft }>;

export class ComputerSandboxEnvironment implements ExecutionEnvironmentPort {
  readonly descriptor: ExecutionEnvironmentDescriptorV1;
  readonly #client: SandboxClient;
  readonly #store: ComputerSandboxStore;
  readonly #capNano: number;
  readonly #instance: SandboxInstance;
  readonly #now: () => string;

  constructor(input: Readonly<{ descriptor: unknown; client: SandboxClient; store: ComputerSandboxStore; capNanoUsd: number; instance: SandboxInstance; now: () => string }>) {
    this.descriptor = parseExecutionEnvironmentDescriptorV1(input.descriptor);
    for (const action of ['steer', 'pause', 'resume'] as const) {
      if (this.descriptor.capabilities[action].mode !== 'unsupported') throw new Error(`computer sandbox does not support ${action}`);
    }
    if (!Number.isSafeInteger(input.capNanoUsd) || input.capNanoUsd <= 0) throw new Error('computer sandbox needs an explicit positive cap');
    this.#client = input.client;
    this.#store = input.store;
    this.#capNano = input.capNanoUsd;
    this.#instance = input.instance;
    this.#now = input.now;
  }

  get #ratePerSecondNano(): number {
    const r = CLOUDFLARE_CONTAINER_RATES_NANO_USD;
    return this.#instance.vcpu * r.vcpuSecond + this.#instance.gib * r.gibSecond + this.#instance.gb * r.gbSecond;
  }
  #nowMs(): number { return Date.parse(iso8601Schema.parse(this.#now())); }
  #seconds(entry: LedgerEntry, nowMs: number): number { return Math.max(0, Math.ceil(((entry.endedAtMs ?? nowMs) - entry.startedAtMs) / 1000)); }

  /** Nano-dollars spent so far across every sandbox this adapter started, running ones counted to now. */
  spentNanoUsd(): number {
    const nowMs = this.#nowMs();
    let total = 0;
    for (const entry of this.#store.ledger.values()) total += this.#seconds(entry, nowMs) * this.#ratePerSecondNano;
    return total;
  }

  /** When the host should wake to call enforceCap for the running sandbox, or null when none runs. */
  capDeadlineMs(): number | null {
    const running = [...this.#store.ledger.values()].find((e) => e.endedAtMs === null);
    if (running === undefined) return null;
    const spentOthers = [...this.#store.ledger.values()].filter((e) => e !== running).reduce((sum, e) => sum + this.#seconds(e, this.#nowMs()) * this.#ratePerSecondNano, 0);
    return running.startedAtMs + Math.floor(Math.max(0, this.#capNano - spentOthers) / this.#ratePerSecondNano) * 1000;
  }

  /** Kills any running sandbox whose spend reached the cap. Call at capDeadlineMs. Only ever reduces spend. */
  async enforceCap(): Promise<readonly CapKill[]> {
    const nowMs = this.#nowMs();
    const killed: CapKill[] = [];
    for (const [requestId, entry] of this.#store.ledger) {
      if (entry.endedAtMs !== null) continue;
      if (this.spentNanoUsd() < this.#capNano) continue;
      if (entry.sandboxId === null) {
        const found = await this.#client.lookup(entry.key);
        if (found === null) { entry.endedAtMs = nowMs; entry.endReason = 'cap'; continue; }
        entry.sandboxId = found.sandboxId;
      }
      await this.#client.kill(entry.sandboxId);
      entry.endedAtMs = nowMs;
      entry.endReason = 'cap';
      killed.push({ requestId, sandboxId: entry.sandboxId, draft: this.#observation(`obs_cap_${entry.sandboxId}`, 2, 'timed_out', nowMs) });
    }
    return killed;
  }

  #observation(id: string, sequence: number, kind: 'started' | 'ended' | 'failed' | 'timed_out', atMs: number): EnvironmentDraft {
    return { category: 'execution_environment_observation_draft', id, sequence, kind, payloadRef: null, payloadDigest: null, observedAt: new Date(atMs).toISOString() };
  }
  #issue(command: ExecutionEnvironmentCommandV1, draft: EnvironmentDraft): ExecutionEnvironmentIssueResult {
    return parseExecutionEnvironmentIssueResult({ protocolVersion: '0.4', category: 'execution_environment_issue_result', operationId: command.operationId, operationDigest: command.operationDigest, status: 'observed', draft });
  }
  #record(command: ExecutionEnvironmentCommandV1, result: ExecutionEnvironmentIssueResult): void {
    this.#store.receipts.set(command.operationId, Object.freeze({ operationDigest: command.operationDigest, result, checkedAt: iso8601Schema.parse(this.#now()) }));
  }

  #assertBinding(command: ExecutionEnvironmentCommandV1, requireActiveLease: boolean): void {
    const capability = this.descriptor.capabilities[command.action];
    if (JSON.stringify(command.adapter) !== JSON.stringify(this.descriptor.adapter) ||
        JSON.stringify(command.environment) !== JSON.stringify(this.descriptor.environment) ||
        capability.mode === 'unsupported' || command.capability.mode !== capability.mode || command.capability.version !== capability.version) {
      throw new Error('computer sandbox command does not match adapter descriptor');
    }
    if (requireActiveLease && this.#nowMs() >= Date.parse(command.leaseExpiresAt)) throw new Error('computer sandbox rejected an expired lease');
    const previous = this.#store.highWater.get(command.executionRequestId);
    const adapter = JSON.stringify(command.adapter);
    const environment = JSON.stringify(command.environment);
    if (previous !== undefined) {
      if (previous.adapter !== adapter || previous.environment !== environment) throw new Error('computer sandbox rejected adapter or environment drift');
      if (command.fencingGeneration < previous.fencingGeneration || command.cancellationGeneration < previous.cancellationGeneration ||
          (command.leaseId !== previous.leaseId && command.fencingGeneration <= previous.fencingGeneration)) {
        throw new Error('computer sandbox rejected stale or conflicting authority');
      }
    }
    if (previous === undefined || command.fencingGeneration > previous.fencingGeneration || command.cancellationGeneration > previous.cancellationGeneration) {
      this.#store.highWater.set(command.executionRequestId, Object.freeze({ leaseId: command.leaseId, fencingGeneration: command.fencingGeneration, cancellationGeneration: command.cancellationGeneration, adapter, environment }));
    }
  }

  // cancel (after the kill) and reconcile both report what the provider says now. Reading status never issues an effect.
  async #statusResult(command: ExecutionEnvironmentCommandV1, entry: LedgerEntry, nowMs: number): Promise<ExecutionEnvironmentIssueResult> {
    const handle = entry.sandboxId === null ? null : await this.#client.status(entry.sandboxId);
    const state = handle === null ? 'indeterminate' : handle.state === 'running' ? 'running' : handle.state === 'killed' ? 'cancelled' : 'settled';
    if (handle !== null && handle.state !== 'running' && entry.endedAtMs === null) { entry.endedAtMs = nowMs; entry.endReason = 'exited'; }
    return this.#issue(command, { category: 'execution_environment_reconciliation_draft', id: `rec_${command.operationId}`, state, basisObservationIds: [entry.startObservationId], checkedAt: new Date(nowMs).toISOString() });
  }

  async execute(commandValue: ExecutionEnvironmentCommandV1): Promise<unknown> {
    const command = parseExecutionEnvironmentCommandV1(commandValue);
    const verified = this.#store.verified.get(command.operationId);
    if (verified === undefined || verified.operationDigest !== command.operationDigest || verified.canonical !== JSON.stringify(command)) {
      throw new Error('computer sandbox execute requires matching recovered command identity');
    }
    this.#assertBinding(command, true);
    const existing = this.#store.receipts.get(command.operationId);
    if (existing !== undefined) {
      if (existing.operationDigest !== command.operationDigest) throw new Error('computer sandbox operation digest conflict');
      return existing.result;
    }
    const nowMs = this.#nowMs();
    const entry = this.#store.ledger.get(command.executionRequestId);
    if (command.action === 'start') {
      const refused = this.spentNanoUsd() >= this.#capNano || [...this.#store.ledger.values()].some((e) => e.endedAtMs === null);
      if (refused) {
        const result = this.#issue(command, this.#observation(`obs_${command.operationId}`, 1, 'failed', nowMs));
        this.#record(command, result);
        return result;
      }
      // Write ahead: spend is metered from here even if the process dies before the provider answers.
      const fresh: LedgerEntry = { key: command.operationId, requestId: command.executionRequestId, sandboxId: null, startedAtMs: nowMs, endedAtMs: null, endReason: null, startObservationId: `obs_${command.operationId}` };
      this.#store.ledger.set(command.executionRequestId, fresh);
      const handle = await this.#client.start({ key: command.operationId, instance: this.#instance });
      fresh.sandboxId = handle.sandboxId;
      const result = this.#issue(command, this.#observation(fresh.startObservationId, 1, 'started', nowMs));
      this.#record(command, result);
      return result;
    }
    if (entry === undefined) {
      const result = this.#issue(command, { category: 'execution_environment_reconciliation_draft', id: `rec_${command.operationId}`, state: 'failed', basisObservationIds: [], checkedAt: new Date(nowMs).toISOString() });
      this.#record(command, result);
      return result;
    }
    if (command.action === 'cancel') {
      if (entry.endedAtMs === null) {
        entry.sandboxId ??= (await this.#client.lookup(entry.key))?.sandboxId ?? null;
        if (entry.sandboxId !== null) await this.#client.kill(entry.sandboxId);
        entry.endedAtMs = nowMs;
        entry.endReason = 'cancelled';
      }
    }
    const result = await this.#statusResult(command, entry, nowMs);
    this.#record(command, result);
    return result;
  }

  async recover(commandValue: ExecutionEnvironmentCommandV1): Promise<unknown> {
    const command = await verifyExecutionEnvironmentCommandIdentity(commandValue);
    this.#assertBinding(command, false);
    const canonical = JSON.stringify(command);
    const prior = this.#store.verified.get(command.operationId);
    if (prior !== undefined && (prior.operationDigest !== command.operationDigest || prior.canonical !== canonical)) throw new Error('computer sandbox recovered command identity conflict');
    this.#store.verified.set(command.operationId, Object.freeze({ operationDigest: command.operationDigest, canonical }));
    const checkedAt = iso8601Schema.parse(this.#now());
    const base = { protocolVersion: '0.4', category: 'execution_environment_recovery_result', operationId: command.operationId, operationDigest: command.operationDigest, checkedAt } as const;
    const existing = this.#store.receipts.get(command.operationId);
    if (existing !== undefined) {
      if (existing.operationDigest !== command.operationDigest) throw new Error('computer sandbox operation digest conflict');
      return Object.freeze({ ...base, status: 'observed', result: existing.result, checkedAt: existing.checkedAt });
    }
    // Read-only: a start whose receipt was lost is found by its key at the provider and never issued again.
    if (command.action === 'start') {
      const entry = this.#store.ledger.get(command.executionRequestId);
      if (entry !== undefined && entry.key === command.operationId) {
        const found = await this.#client.lookup(command.operationId);
        if (found === null) return Object.freeze({ ...base, status: 'indeterminate', result: null });
        entry.sandboxId = found.sandboxId;
        const result = this.#issue(command, this.#observation(entry.startObservationId, 1, 'started', entry.startedAtMs));
        this.#record(command, result);
        return Object.freeze({ ...base, status: 'observed', result });
      }
    }
    if (command.action === 'reconcile') {
      const entry = this.#store.ledger.get(command.executionRequestId);
      if (entry !== undefined) {
        const result = await this.#statusResult(command, entry, this.#nowMs());
        this.#record(command, result);
        return Object.freeze({ ...base, status: 'observed', result });
      }
    }
    return Object.freeze({ ...base, status: 'known_not_applied', result: null });
  }
}
