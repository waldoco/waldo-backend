import {
  buildResponsibilityExecutionV04Bundle,
  executionAttemptV04Schema,
  executionLeaseV04Schema,
  executionRequestV04Schema,
  executionSessionV04Schema,
} from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import {
  CLOUDFLARE_CONTAINER_RATES_NANO_USD,
  ComputerSandboxEnvironment,
  ExecutionEnvironmentBoundary,
  ExecutionEnvironmentRegistry,
  STANDARD_2_INSTANCE,
  createComputerSandboxStore,
  type SandboxClient,
  type SandboxHandle,
} from '../src/execution-environment';

const bundle = buildResponsibilityExecutionV04Bundle(() => 'a'.repeat(64));
const request = executionRequestV04Schema.parse(JSON.parse(bundle['execution-request.valid.json']!));
const attempt = executionAttemptV04Schema.parse(JSON.parse(bundle['execution-attempt.valid.json']!));
const lease = executionLeaseV04Schema.parse(JSON.parse(bundle['execution-lease.valid.json']!));
const session = executionSessionV04Schema.parse(JSON.parse(bundle['execution-session.valid.json']!));
const aggregate = Object.freeze({
  request, currentCancellationGeneration: request.cancellationGeneration,
  attempts: Object.freeze([attempt]), leases: Object.freeze([lease]), sessions: Object.freeze([session]),
  observations: Object.freeze([]), reconciliations: Object.freeze([]),
});
const descriptor = {
  protocolVersion: '0.4',
  adapter: { id: 'computer_sandbox_adapter', version: 'spike-v1' },
  environment: request.environment,
  capabilities: {
    start: { mode: 'native', version: 'start-v1' },
    resume: { mode: 'unsupported', version: 'resume-v1' },
    steer: { mode: 'unsupported', version: 'steer-v1' },
    pause: { mode: 'unsupported', version: 'pause-v1' },
    cancel: { mode: 'native', version: 'cancel-v1' },
    reconcile: { mode: 'native', version: 'reconcile-v1' },
  },
};
const RATE = STANDARD_2_INSTANCE.vcpu * CLOUDFLARE_CONTAINER_RATES_NANO_USD.vcpuSecond
  + STANDARD_2_INSTANCE.gib * CLOUDFLARE_CONTAINER_RATES_NANO_USD.gibSecond
  + STANDARD_2_INSTANCE.gb * CLOUDFLARE_CONTAINER_RATES_NANO_USD.gbSecond;
const CAP_SECONDS = 300; // inside the fixture lease (10 minutes); the cap value itself is test config, not a product number
const CAP = CAP_SECONDS * RATE;
const T0 = Date.parse(attempt.updatedAt);
const intent = (input: { action: string; control: { payloadRef: string } | null }) => ({ ref: `server_intent_${input.action}`, digest: `sha256:${'c'.repeat(64)}` });

class FakeSandboxClient implements SandboxClient {
  readonly byKey = new Map<string, { sandboxId: string; state: SandboxHandle['state'] }>();
  starts = 0;
  kills: string[] = [];
  crashAfterStart = false;
  async start({ key }: { key: string }) {
    let box = this.byKey.get(key);
    if (box === undefined) { this.starts += 1; box = { sandboxId: `sbx_${this.starts}`, state: 'running' }; this.byKey.set(key, box); }
    if (this.crashAfterStart) { this.crashAfterStart = false; throw new Error('connection lost after provider applied start'); }
    return { ...box };
  }
  async lookup(key: string) { const b = this.byKey.get(key); return b === undefined ? null : { ...b }; }
  async status(id: string) { const b = [...this.byKey.values()].find((x) => x.sandboxId === id); return b === undefined ? null : { ...b }; }
  async kill(id: string) { this.kills.push(id); const b = [...this.byKey.values()].find((x) => x.sandboxId === id); if (b) b.state = 'killed'; }
}

function rig(client = new FakeSandboxClient(), store = createComputerSandboxStore(), clock = { ms: T0 }) {
  const adapter = new ComputerSandboxEnvironment({ descriptor, client, store, capNanoUsd: CAP, instance: STANDARD_2_INSTANCE, now: () => new Date(clock.ms).toISOString() });
  const registered = new ExecutionEnvironmentRegistry().register(adapter.descriptor, adapter);
  const boundary = new ExecutionEnvironmentBoundary(registered, { readCurrentAggregate: () => aggregate, now: () => new Date(clock.ms).toISOString(), resolveOperationIntent: (_a, i) => intent(i) });
  return { client, store, clock, adapter, boundary };
}

describe('computer-tier sandbox adapter (flag-off spike)', () => {
  it('journey 1: start runs one sandbox, the meter counts seconds at the published rate, reconcile reports running', async () => {
    const r = rig();
    const started = await r.boundary.dispatch(aggregate, { action: 'start', control: null });
    expect(started.status).toBe('observed');
    expect(started.result?.draft).toMatchObject({ kind: 'started', sequence: 1 });
    expect(r.client.starts).toBe(1);
    r.clock.ms += 60_000;
    expect(r.adapter.spentNanoUsd()).toBe(60 * RATE);
    const recon = await r.boundary.dispatch(aggregate, { action: 'reconcile', control: null });
    expect(recon.result?.draft).toMatchObject({ state: 'running' });
    expect(r.client.starts).toBe(1);
  });

  it('journey 2: a runaway sandbox is killed at the cap, spend never exceeds it, and no new run starts', async () => {
    const r = rig();
    await r.boundary.dispatch(aggregate, { action: 'start', control: null });
    expect(r.adapter.capDeadlineMs()).toBe(T0 + CAP_SECONDS * 1000);
    r.clock.ms = T0 + (CAP_SECONDS - 1) * 1000;
    expect(await r.adapter.enforceCap()).toEqual([]);
    expect(r.client.kills).toEqual([]);
    r.clock.ms = T0 + CAP_SECONDS * 1000;
    const killed = await r.adapter.enforceCap();
    expect(killed).toHaveLength(1);
    expect(killed[0]!.draft).toMatchObject({ kind: 'timed_out', sequence: 2 });
    expect(r.client.kills).toEqual(['sbx_1']);
    r.clock.ms += 3_600_000; // an hour later the meter has stopped
    expect(r.adapter.spentNanoUsd()).toBe(CAP);
    expect(r.adapter.spentNanoUsd()).toBeLessThanOrEqual(CAP);
    expect(r.adapter.capDeadlineMs()).toBeNull();
  });

  it('journey 2b: a start is refused while the cap is already spent, and nothing reaches the provider', async () => {
    const store = createComputerSandboxStore();
    store.ledger.set('earlier_request', { key: 'k', requestId: 'earlier_request', sandboxId: 'sbx_old', startedAtMs: T0 - CAP_SECONDS * 1000, endedAtMs: T0, endReason: 'cap', startObservationId: 'obs_old' });
    const r = rig(new FakeSandboxClient(), store);
    expect(r.adapter.spentNanoUsd()).toBe(CAP);
    const refused = await r.boundary.dispatch(aggregate, { action: 'start', control: null });
    expect(refused.result?.draft).toMatchObject({ kind: 'failed' });
    expect(r.client.starts).toBe(0);
  });

  it('journey 3: a start whose receipt is lost is found by key on recovery, not issued twice, and is metered meanwhile', async () => {
    const client = new FakeSandboxClient();
    const store = createComputerSandboxStore();
    const clock = { ms: T0 };
    client.crashAfterStart = true;
    const first = rig(client, store, clock);
    await expect(first.boundary.dispatch(aggregate, { action: 'start', control: null })).rejects.toThrow(/connection lost/);
    expect(client.starts).toBe(1);
    clock.ms += 30_000;
    expect(first.adapter.spentNanoUsd()).toBe(30 * RATE); // write-ahead ledger: the unknown start is already counted
    const second = rig(client, store, clock);
    const recovered = await second.boundary.dispatch(aggregate, { action: 'start', control: null });
    expect(recovered.status).toBe('observed');
    expect(recovered.result?.draft).toMatchObject({ kind: 'started' });
    expect(client.starts).toBe(1);
    expect(second.adapter.spentNanoUsd()).toBe(30 * RATE);
  });

  it('cancel kills the sandbox and stops the meter; steer, pause and resume are unsupported', async () => {
    const r = rig();
    await r.boundary.dispatch(aggregate, { action: 'start', control: null });
    r.clock.ms += 10_000;
    const nextAttempt = executionAttemptV04Schema.parse({ ...attempt, fencingGeneration: attempt.fencingGeneration + 1, cancellationGeneration: attempt.cancellationGeneration + 1, state: 'cancelling' });
    const nextLease = executionLeaseV04Schema.parse({ ...lease, fencingGeneration: lease.fencingGeneration + 1, cancellationGeneration: lease.cancellationGeneration + 1 });
    const cancelling = { ...aggregate, currentCancellationGeneration: aggregate.currentCancellationGeneration + 1, attempts: [nextAttempt], leases: [nextLease] };
    const boundary = new ExecutionEnvironmentBoundary(new ExecutionEnvironmentRegistry().register(r.adapter.descriptor, r.adapter), { readCurrentAggregate: () => cancelling, now: () => new Date(r.clock.ms).toISOString(), resolveOperationIntent: (_a, i) => intent(i) });
    const cancelled = await boundary.dispatch(cancelling, { action: 'cancel', control: null });
    expect(cancelled.result?.draft).toMatchObject({ state: 'cancelled' });
    expect(r.client.kills).toEqual(['sbx_1']);
    r.clock.ms += 120_000;
    expect(r.adapter.spentNanoUsd()).toBe(10 * RATE);
    for (const action of ['pause', 'resume'] as const) await expect(r.boundary.dispatch(aggregate, { action, control: null })).rejects.toThrow(/unsupported/i);
  });

  it('refuses to construct without an explicit positive cap or with a supported steer', () => {
    const base = { descriptor, client: new FakeSandboxClient(), store: createComputerSandboxStore(), instance: STANDARD_2_INSTANCE, now: () => attempt.updatedAt };
    expect(() => new ComputerSandboxEnvironment({ ...base, capNanoUsd: 0 })).toThrow(/explicit positive cap/);
    expect(() => new ComputerSandboxEnvironment({ ...base, capNanoUsd: Number.NaN })).toThrow(/explicit positive cap/);
    expect(() => new ComputerSandboxEnvironment({ ...base, capNanoUsd: CAP, descriptor: { ...descriptor, capabilities: { ...descriptor.capabilities, steer: { mode: 'native', version: 'steer-v1' } } } })).toThrow(/does not support steer/);
  });
});
