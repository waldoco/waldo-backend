import {
  buildResponsibilityExecutionV04Bundle,
  executionAttemptV04Schema,
  executionLeaseV04Schema,
  executionRequestV04Schema,
  executionSessionV04Schema,
  executorObservationV04Schema,
} from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import {
  ExecutionEnvironmentRegistry,
  ExecutionEnvironmentBoundary,
  DeterministicFakeExecutionEnvironment,
  buildExecutionEnvironmentCommand,
  createDeterministicFakeExecutionEnvironmentStore,
  materializeExecutorObservationV04,
  type ExecutionEnvironmentPort,
} from '../src/execution-environment';

const bundle = buildResponsibilityExecutionV04Bundle(() => 'a'.repeat(64));
const request = executionRequestV04Schema.parse(
  JSON.parse(bundle['execution-request.valid.json']!),
);
const attempt = executionAttemptV04Schema.parse(
  JSON.parse(bundle['execution-attempt.valid.json']!),
);
const lease = executionLeaseV04Schema.parse(
  JSON.parse(bundle['execution-lease.valid.json']!),
);
const session = executionSessionV04Schema.parse(
  JSON.parse(bundle['execution-session.valid.json']!),
);
const aggregate = Object.freeze({
  request,
  currentCancellationGeneration: request.cancellationGeneration,
  attempts: Object.freeze([attempt]),
  leases: Object.freeze([lease]),
  sessions: Object.freeze([session]),
  observations: Object.freeze([]),
  reconciliations: Object.freeze([]),
});

const capabilities = Object.freeze({
  start: Object.freeze({ mode: 'native' as const, version: 'start-v1' }),
  resume: Object.freeze({ mode: 'native' as const, version: 'resume-v1' }),
  steer: Object.freeze({ mode: 'emulated' as const, version: 'steer-v1' }),
  pause: Object.freeze({ mode: 'unsupported' as const, version: 'pause-v1' }),
  cancel: Object.freeze({ mode: 'native' as const, version: 'cancel-v1' }),
  reconcile: Object.freeze({ mode: 'native' as const, version: 'reconcile-v1' }),
});

function port(
  descriptor: unknown = {
    protocolVersion: '0.4',
    adapter: { id: 'fake_environment_adapter', version: 'fake-v1' },
    environment: request.environment,
    capabilities,
  },
): ExecutionEnvironmentPort {
  return {
    descriptor: descriptor as ExecutionEnvironmentPort['descriptor'],
    async execute() { throw new Error('not exercised'); },
    async recover() { throw new Error('not exercised'); },
  };
}

function registerEnvironment(
  adapter: ExecutionEnvironmentPort,
  expectedDescriptor: unknown = adapter.descriptor,
) {
  return new ExecutionEnvironmentRegistry().register(expectedDescriptor, adapter);
}

describe('execution environment port conformance', () => {
  it('registers one adapter by complete environment identity and rejects descriptor drift', () => {
    const registry = new ExecutionEnvironmentRegistry();
    const adapter = port();
    const registered = registry.register(adapter.descriptor, adapter);

    expect(registry.resolve(request.environment)).toBe(registered);
    expect(registered.descriptor).toEqual({
      protocolVersion: '0.4',
      adapter: { id: 'fake_environment_adapter', version: 'fake-v1' },
      environment: request.environment,
      capabilities,
    });
    expect(() => registry.register(adapter.descriptor, port())).toThrow(/already registered/i);
    expect(() => registerEnvironment(port({
      protocolVersion: '0.4',
      adapter: { id: 'fake_environment_adapter', version: 'fake-v1' },
      environment: request.environment,
      capabilities,
      ownerId: request.ownerId,
    }))).toThrow(/unrecognized/i);
    expect(() => registerEnvironment(port({
      ...adapter.descriptor,
      capabilities: {
        ...adapter.descriptor.capabilities,
        start: { mode: 'emulated', version: 'start-v1' },
      },
    }), adapter.descriptor)).toThrow(/server pin/i);
    expect(() => registry.resolve({
      ...request.environment,
      manifest: { ...request.environment.manifest, digest: `sha256:${'b'.repeat(64)}` },
    })).toThrow(/not registered/i);
  });

  it('fails unsupported actions closed and preserves emulated support through strict drafts', async () => {
    let recoverCalls = 0;
    let executeCalls = 0;
    let hostile = false;
    const adapter = port();
    adapter.recover = async (command) => {
      recoverCalls += 1;
      return {
        protocolVersion: '0.4',
        category: 'execution_environment_recovery_result',
        operationId: command.operationId,
        operationDigest: command.operationDigest,
        status: 'known_not_applied',
        result: null,
        checkedAt: attempt.updatedAt,
      };
    };
    adapter.execute = async (command) => {
      executeCalls += 1;
      return {
        protocolVersion: '0.4',
        category: 'execution_environment_issue_result',
        operationId: command.operationId,
        operationDigest: command.operationDigest,
        status: 'observed',
        draft: {
          category: 'execution_environment_observation_draft',
          id: 'observation_steer_fixture',
          sequence: 1,
          kind: 'activity',
          payloadRef: 'steer_result_fixture',
          payloadDigest: `sha256:${'d'.repeat(64)}`,
          observedAt: attempt.updatedAt,
          ...(hostile ? { ownerId: request.ownerId } : {}),
        },
      };
    };
    const boundary = new ExecutionEnvironmentBoundary(
      registerEnvironment(adapter),
      { readCurrentAggregate: () => aggregate, now: () => attempt.updatedAt },
    );

    await expect(boundary.dispatch(aggregate, {
      action: 'pause',
      control: null,
    })).rejects.toThrow(/unsupported/i);
    expect({ recoverCalls, executeCalls }).toEqual({ recoverCalls: 0, executeCalls: 0 });

    const result = await boundary.dispatch(aggregate, {
      action: 'steer',
      control: {
        payloadRef: 'steer_instruction_fixture',
        payloadDigest: `sha256:${'e'.repeat(64)}`,
      },
    });
    expect(result.support).toEqual({
      action: 'steer',
      mode: 'emulated',
      version: 'steer-v1',
    });
    expect({ recoverCalls, executeCalls }).toEqual({ recoverCalls: 1, executeCalls: 1 });

    hostile = true;
    await expect(boundary.dispatch(aggregate, {
      action: 'steer',
      control: {
        payloadRef: 'steer_instruction_fixture',
        payloadDigest: `sha256:${'e'.repeat(64)}`,
      },
    })).rejects.toThrow(/unrecognized/i);
  });

  it('recovers a disconnect by stable operation identity without a second external issue', async () => {
    const descriptor = port().descriptor;
    const store = createDeterministicFakeExecutionEnvironmentStore();
    const observationDraft = Object.freeze({
      category: 'execution_environment_observation_draft',
      id: 'observation_start_fixture',
      sequence: 1,
      kind: 'started',
      payloadRef: null,
      payloadDigest: null,
      observedAt: attempt.updatedAt,
    });
    const first = new ExecutionEnvironmentBoundary(
      registerEnvironment(
        new DeterministicFakeExecutionEnvironment({
          descriptor,
          store,
          script: {
            start: {
              status: 'observed',
              draft: observationDraft,
              disconnectAfterApply: true,
            },
          },
          now: () => attempt.updatedAt,
        }),
      ),
      { readCurrentAggregate: () => aggregate, now: () => attempt.updatedAt },
    );

    await expect(first.dispatch(aggregate, {
      action: 'start',
      control: null,
    })).rejects.toThrow(/disconnected/i);
    expect(store.physicalIssues).toBe(1);

    const reconstructedAdapter = new DeterministicFakeExecutionEnvironment({
      descriptor,
      store,
      script: {},
      now: () => attempt.updatedAt,
    });
    const reconstructed = new ExecutionEnvironmentBoundary(
      registerEnvironment(reconstructedAdapter),
      { readCurrentAggregate: () => aggregate, now: () => attempt.updatedAt },
    );
    const recovered = await reconstructed.dispatch(aggregate, {
      action: 'start',
      control: null,
    });

    expect(recovered.status).toBe('observed');
    expect(recovered.result?.draft).toEqual(observationDraft);
    expect(store).toMatchObject({ physicalIssues: 1, executeCalls: 1, recoverCalls: 2 });
    expect(recovered.command).not.toHaveProperty('ownerId');
    expect(recovered.command).not.toHaveProperty('outcome');
    expect(recovered.command).not.toHaveProperty('workUnit');
    expect(recovered.command).not.toHaveProperty('credentials');
    expect(recovered.command.provider.category).toBe('provider');
    expect(recovered.command.environment.category).toBe('execution_environment');
    expect(executorObservationV04Schema.parse(
      materializeExecutorObservationV04(aggregate, recovered),
    )).toEqual({
      protocolVersion: '0.4',
      id: 'observation_start_fixture',
      ownerId: request.ownerId,
      attemptId: attempt.id,
      environment: request.environment,
      leaseId: lease.id,
      fencingGeneration: attempt.fencingGeneration,
      cancellationGeneration: attempt.cancellationGeneration,
      sequence: 1,
      kind: 'started',
      payloadRef: null,
      payloadDigest: null,
      observedAt: attempt.updatedAt,
    });
    expect(() => materializeExecutorObservationV04({
      ...aggregate,
      currentCancellationGeneration: aggregate.currentCancellationGeneration + 1,
    }, recovered)).toThrow(/binding|generation/i);

    await expect(reconstructedAdapter.execute({
      ...recovered.command,
      operationDigest: `sha256:${'f'.repeat(64)}`,
    })).rejects.toThrow(/operation identity|digest conflict/i);
    await expect(reconstructedAdapter.execute({
      ...recovered.command,
      contextProjectionDigest: `sha256:${'f'.repeat(64)}`,
    })).rejects.toThrow(/operation identity/i);
    expect(store.physicalIssues).toBe(1);
  });

  it('keeps timeout or unknown delivery indeterminate and blocks blind reissue', async () => {
    const store = createDeterministicFakeExecutionEnvironmentStore();
    const boundary = new ExecutionEnvironmentBoundary(
      registerEnvironment(
        new DeterministicFakeExecutionEnvironment({
          descriptor: port().descriptor,
          store,
          script: { start: { status: 'indeterminate', draft: null } },
          now: () => attempt.updatedAt,
        }),
      ),
      { readCurrentAggregate: () => aggregate, now: () => attempt.updatedAt },
    );
    const first = await boundary.dispatch(aggregate, {
      action: 'start',
      control: null,
    });
    expect(first.status).toBe('indeterminate');
    expect(() => materializeExecutorObservationV04(aggregate, first))
      .toThrow(/not an attributable observation/i);

    const replay = await boundary.dispatch(aggregate, {
      action: 'start',
      control: null,
    });
    expect(replay.status).toBe('indeterminate');
    expect(store).toMatchObject({ physicalIssues: 1, executeCalls: 1, recoverCalls: 2 });
  });

  it('rejects authority-bearing output, provider receipts, and forged operation identity', async () => {
    const validDraft = {
      category: 'execution_environment_observation_draft',
      id: 'observation_hostile_fixture',
      sequence: 1,
      kind: 'activity',
      payloadRef: null,
      payloadDigest: null,
      observedAt: attempt.updatedAt,
    };
    const hostileDrafts = [
      { ...validDraft, ownerId: request.ownerId },
      { ...validDraft, outcome: request.outcome },
      { ...validDraft, workUnit: request.workUnit },
      { ...validDraft, authority: request.authorityCeiling },
      { ...validDraft, provider: request.provider },
      { ...validDraft, environment: request.environment },
      { ...validDraft, contextProjectionDigest: `sha256:${'f'.repeat(64)}` },
      { ...validDraft, credentials: { token: 'must-not-enter-the-boundary' } },
      { ...validDraft, category: 'provider_receipt' },
      { ...validDraft },
    ];
    for (const [index, draft] of hostileDrafts.entries()) {
      const adapter = port();
      adapter.recover = async (command) => ({
        protocolVersion: '0.4',
        category: 'execution_environment_recovery_result',
        operationId: command.operationId,
        operationDigest: command.operationDigest,
        status: 'known_not_applied',
        result: null,
        checkedAt: attempt.updatedAt,
      });
      adapter.execute = async (command) => ({
        protocolVersion: '0.4',
        category: 'execution_environment_issue_result',
        operationId: index === hostileDrafts.length - 1
          ? 'forged_operation_identity'
          : command.operationId,
        operationDigest: command.operationDigest,
        status: 'observed',
        draft,
      });
      const boundary = new ExecutionEnvironmentBoundary(
        registerEnvironment(adapter),
        { readCurrentAggregate: () => aggregate, now: () => attempt.updatedAt },
      );
      await expect(boundary.dispatch(aggregate, {
        action: 'start',
        control: null,
      })).rejects.toThrow(/unrecognized|category|identity/i);
    }
  });

  it('rechecks the current canonical fence and generation before adapter I/O', async () => {
    let recoverCalls = 0;
    let executeCalls = 0;
    const adapter = port();
    adapter.recover = async () => {
      recoverCalls += 1;
      throw new Error('must not reach adapter recovery');
    };
    adapter.execute = async () => {
      executeCalls += 1;
      throw new Error('must not reach adapter issue');
    };
    const nextAttempt = executionAttemptV04Schema.parse({
      ...attempt,
      fencingGeneration: attempt.fencingGeneration + 1,
      cancellationGeneration: attempt.cancellationGeneration + 1,
      state: 'cancelling',
    });
    const nextLease = executionLeaseV04Schema.parse({
      ...lease,
      fencingGeneration: lease.fencingGeneration + 1,
      cancellationGeneration: lease.cancellationGeneration + 1,
    });
    const nextSession = executionSessionV04Schema.parse({ ...session, state: 'unknown' });
    const current = {
      ...aggregate,
      currentCancellationGeneration: aggregate.currentCancellationGeneration + 1,
      attempts: [nextAttempt],
      leases: [nextLease],
      sessions: [nextSession],
    };
    const boundary = new ExecutionEnvironmentBoundary(
      registerEnvironment(adapter),
      { readCurrentAggregate: () => current, now: () => attempt.updatedAt },
    );

    await expect(boundary.dispatch(aggregate, {
      action: 'start',
      control: null,
      credentials: { token: 'must-not-enter-the-command' },
    } as never)).rejects.toThrow(/unrecognized/i);
    await expect(boundary.dispatch(aggregate, {
      action: 'start',
      control: null,
    })).rejects.toThrow(/stale before external I\/O/i);
    expect({ recoverCalls, executeCalls }).toEqual({ recoverCalls: 0, executeCalls: 0 });
  });

  it('rejects a recovered nested result whose operation identity was substituted', async () => {
    let executeCalls = 0;
    const adapter = port();
    adapter.recover = async (command) => ({
      protocolVersion: '0.4',
      category: 'execution_environment_recovery_result',
      operationId: command.operationId,
      operationDigest: command.operationDigest,
      status: 'observed',
      result: {
        protocolVersion: '0.4',
        category: 'execution_environment_issue_result',
        operationId: 'substituted_operation_identity',
        operationDigest: command.operationDigest,
        status: 'observed',
        draft: {
          category: 'execution_environment_observation_draft',
          id: 'substituted_recovered_observation',
          sequence: 1,
          kind: 'started',
          payloadRef: null,
          payloadDigest: null,
          observedAt: attempt.updatedAt,
        },
      },
      checkedAt: attempt.updatedAt,
    });
    adapter.execute = async () => {
      executeCalls += 1;
      throw new Error('must not issue after substituted recovery');
    };
    const boundary = new ExecutionEnvironmentBoundary(
      registerEnvironment(adapter),
      { readCurrentAggregate: () => aggregate, now: () => attempt.updatedAt },
    );

    await expect(boundary.dispatch(aggregate, {
      action: 'start',
      control: null,
    })).rejects.toThrow(/operation identity/i);
    expect(executeCalls).toBe(0);
  });

  it('fails closed when the lease is expired or expires at trusted now', async () => {
    for (const now of [lease.expiresAt, '2099-01-01T00:00:00.000Z']) {
      let recoverCalls = 0;
      let executeCalls = 0;
      const adapter = port();
      adapter.recover = async (command) => {
        recoverCalls += 1;
        return {
          protocolVersion: '0.4',
          category: 'execution_environment_recovery_result',
          operationId: command.operationId,
          operationDigest: command.operationDigest,
          status: 'known_not_applied',
          result: null,
          checkedAt: attempt.updatedAt,
        };
      };
      adapter.execute = async () => {
        executeCalls += 1;
        throw new Error('must not issue under an expired lease');
      };
      const boundary = new ExecutionEnvironmentBoundary(
        registerEnvironment(adapter),
        { readCurrentAggregate: () => aggregate, now: () => now },
      );

      await expect(boundary.dispatch(aggregate, {
        action: 'start',
        control: null,
      })).rejects.toThrow(/lease.*expired/i);
      expect({ recoverCalls, executeCalls }).toEqual({ recoverCalls: 1, executeCalls: 0 });
    }

    let now = attempt.updatedAt;
    let executeCalls = 0;
    const expiringAdapter = port();
    expiringAdapter.recover = async (command) => {
      now = lease.expiresAt;
      return {
        protocolVersion: '0.4',
        category: 'execution_environment_recovery_result',
        operationId: command.operationId,
        operationDigest: command.operationDigest,
        status: 'known_not_applied',
        result: null,
        checkedAt: attempt.updatedAt,
      };
    };
    expiringAdapter.execute = async () => {
      executeCalls += 1;
      throw new Error('must not issue after lease expiry during recovery');
    };
    const expiringBoundary = new ExecutionEnvironmentBoundary(
      registerEnvironment(expiringAdapter),
      { readCurrentAggregate: () => aggregate, now: () => now },
    );
    await expect(expiringBoundary.dispatch(aggregate, {
      action: 'start',
      control: null,
    })).rejects.toThrow(/lease.*expired/i);
    expect(executeCalls).toBe(0);
  });

  it('permits read-only receipt recovery and reconciliation after lease expiry', async () => {
    let now = attempt.updatedAt;
    const store = createDeterministicFakeExecutionEnvironmentStore();
    const fake = new DeterministicFakeExecutionEnvironment({
      descriptor: port().descriptor,
      store,
      script: {
        start: {
          status: 'observed',
          draft: {
            category: 'execution_environment_observation_draft',
            id: 'post_expiry_recovered_observation',
            sequence: 1,
            kind: 'started',
            payloadRef: null,
            payloadDigest: null,
            observedAt: attempt.updatedAt,
          },
        },
        reconcile: {
          status: 'observed',
          draft: {
            category: 'execution_environment_reconciliation_draft',
            id: 'post_expiry_reconciliation',
            state: 'failed',
            basisObservationIds: [],
            checkedAt: lease.expiresAt,
          },
        },
      },
      now: () => now,
    });
    const expiringInFlightAdapter: ExecutionEnvironmentPort = {
      descriptor: fake.descriptor,
      recover: (command) => fake.recover(command),
      async execute(command) {
        const result = await fake.execute(command);
        now = lease.expiresAt;
        return result;
      },
    };
    const boundary = new ExecutionEnvironmentBoundary(
      registerEnvironment(expiringInFlightAdapter),
      { readCurrentAggregate: () => aggregate, now: () => now },
    );
    const issued = await boundary.dispatch(aggregate, { action: 'start', control: null });
    expect(issued.status).toBe('observed');

    const recovered = await boundary.dispatch(aggregate, { action: 'start', control: null });
    expect(recovered.status).toBe('observed');
    const reconciled = await boundary.dispatch(aggregate, { action: 'reconcile', control: null });
    expect(reconciled).toMatchObject({
      status: 'observed',
      result: { draft: { state: 'failed', checkedAt: lease.expiresAt } },
    });
    expect(store.physicalIssues).toBe(1);
  });

  it('rechecks cancellation and fence authority after recovery before issue', async () => {
    let current = aggregate;
    let executeCalls = 0;
    const adapter = port();
    adapter.recover = async (command) => {
      current = {
        ...aggregate,
        currentCancellationGeneration: aggregate.currentCancellationGeneration + 1,
        attempts: [executionAttemptV04Schema.parse({
          ...attempt,
          cancellationGeneration: attempt.cancellationGeneration + 1,
          state: 'cancelling',
        })],
        leases: [executionLeaseV04Schema.parse({
          ...lease,
          cancellationGeneration: lease.cancellationGeneration + 1,
        })],
        sessions: [executionSessionV04Schema.parse({ ...session, state: 'unknown' })],
      };
      return {
        protocolVersion: '0.4',
        category: 'execution_environment_recovery_result',
        operationId: command.operationId,
        operationDigest: command.operationDigest,
        status: 'known_not_applied',
        result: null,
        checkedAt: attempt.updatedAt,
      };
    };
    adapter.execute = async () => {
      executeCalls += 1;
      throw new Error('stale command reached external issue');
    };
    const boundary = new ExecutionEnvironmentBoundary(
      registerEnvironment(adapter),
      { readCurrentAggregate: () => current, now: () => attempt.updatedAt },
    );

    await expect(boundary.dispatch(aggregate, {
      action: 'start',
      control: null,
    })).rejects.toThrow(/stale before external I\/O/i);
    expect(executeCalls).toBe(0);
  });

  it('does not acknowledge an adapter result after authority changes in flight', async () => {
    let current = aggregate;
    const adapter = port();
    adapter.recover = async (command) => ({
      protocolVersion: '0.4',
      category: 'execution_environment_recovery_result',
      operationId: command.operationId,
      operationDigest: command.operationDigest,
      status: 'known_not_applied',
      result: null,
      checkedAt: attempt.updatedAt,
    });
    adapter.execute = async (command) => {
      current = {
        ...aggregate,
        currentCancellationGeneration: aggregate.currentCancellationGeneration + 1,
        attempts: [executionAttemptV04Schema.parse({
          ...attempt,
          cancellationGeneration: attempt.cancellationGeneration + 1,
          state: 'cancelling',
        })],
        leases: [executionLeaseV04Schema.parse({
          ...lease,
          cancellationGeneration: lease.cancellationGeneration + 1,
        })],
        sessions: [executionSessionV04Schema.parse({ ...session, state: 'unknown' })],
      };
      return {
        protocolVersion: '0.4',
        category: 'execution_environment_issue_result',
        operationId: command.operationId,
        operationDigest: command.operationDigest,
        status: 'observed',
        draft: {
          category: 'execution_environment_observation_draft',
          id: 'stale_in_flight_observation',
          sequence: 1,
          kind: 'started',
          payloadRef: null,
          payloadDigest: null,
          observedAt: attempt.updatedAt,
        },
      };
    };
    const boundary = new ExecutionEnvironmentBoundary(
      registerEnvironment(adapter),
      { readCurrentAggregate: () => current, now: () => attempt.updatedAt },
    );

    await expect(boundary.dispatch(aggregate, { action: 'start', control: null }))
      .rejects.toThrow(/stale before external I\/O/i);
  });

  it('keeps restart identity canonical without caller-provided identity metadata', async () => {
    const store = createDeterministicFakeExecutionEnvironmentStore();
    const fake = new DeterministicFakeExecutionEnvironment({
      descriptor: port().descriptor,
      store,
      script: { start: { status: 'indeterminate', draft: null } },
      now: () => attempt.updatedAt,
    });
    const boundary = new ExecutionEnvironmentBoundary(
      registerEnvironment(fake),
      { readCurrentAggregate: () => aggregate, now: () => attempt.updatedAt },
    );
    const first = await boundary.dispatch(aggregate, {
      action: 'start',
      control: null,
    });
    const recovered = await boundary.dispatch(aggregate, {
      action: 'start',
      control: null,
    });

    expect(recovered.command.operationId).toBe(first.command.operationId);
    expect(store.physicalIssues).toBe(1);
  });

  it('enforces adapter-side generation high-water and one claimant per lease generation', async () => {
    const descriptor = port().descriptor;
    const store = createDeterministicFakeExecutionEnvironmentStore();
    const fake = new DeterministicFakeExecutionEnvironment({
      descriptor,
      store,
      script: {
        start: { status: 'indeterminate', draft: null },
        cancel: { status: 'indeterminate', draft: null },
      },
      now: () => attempt.updatedAt,
    });
    const operationBinding = (action: 'start' | 'cancel') => ({
      adapter: descriptor.adapter,
      capability: {
        action,
        mode: 'native' as const,
        version: descriptor.capabilities[action].version,
      },
    });
    const staleStart = await buildExecutionEnvironmentCommand(
      aggregate,
      { action: 'start', control: null },
      operationBinding('start'),
    );
    const nextAttempt = executionAttemptV04Schema.parse({
      ...attempt,
      cancellationGeneration: attempt.cancellationGeneration + 1,
      state: 'cancelling',
    });
    const nextLease = executionLeaseV04Schema.parse({
      ...lease,
      cancellationGeneration: lease.cancellationGeneration + 1,
    });
    const cancellingAggregate = {
      ...aggregate,
      currentCancellationGeneration: aggregate.currentCancellationGeneration + 1,
      attempts: [nextAttempt],
      leases: [nextLease],
      sessions: [executionSessionV04Schema.parse({ ...session, state: 'unknown' })],
    };
    const cancel = await buildExecutionEnvironmentCommand(
      cancellingAggregate,
      { action: 'cancel', control: null },
      operationBinding('cancel'),
    );

    await fake.execute(cancel);
    await expect(fake.execute(staleStart)).rejects.toThrow(/stale|authority/i);

    const conflictingLease = executionLeaseV04Schema.parse({
      ...nextLease,
      id: 'conflicting_lease_fixture',
    });
    const conflictingAttempt = executionAttemptV04Schema.parse({
      ...nextAttempt,
      leaseId: conflictingLease.id,
    });
    const conflictingSession = executionSessionV04Schema.parse({
      ...session,
      id: 'conflicting_session_fixture',
      attemptId: conflictingAttempt.id,
      state: 'unknown',
    });
    const conflictingCommand = await buildExecutionEnvironmentCommand({
      ...cancellingAggregate,
      attempts: [conflictingAttempt],
      leases: [conflictingLease],
      sessions: [conflictingSession],
    }, { action: 'cancel', control: null }, operationBinding('cancel'));
    await expect(fake.recover(conflictingCommand)).rejects.toThrow(/conflicting authority/i);
    expect(store.physicalIssues).toBe(1);
  });

  it('keeps fake receipts immutable when caller-owned script objects mutate', async () => {
    const mutableDraft = {
      category: 'execution_environment_observation_draft',
      id: 'immutable_observation_fixture',
      sequence: 1,
      kind: 'started',
      payloadRef: null,
      payloadDigest: null,
      observedAt: attempt.updatedAt,
    };
    const fake = new DeterministicFakeExecutionEnvironment({
      descriptor: port().descriptor,
      store: createDeterministicFakeExecutionEnvironmentStore(),
      script: { start: { status: 'observed', draft: mutableDraft } },
      now: () => attempt.updatedAt,
    });
    const boundary = new ExecutionEnvironmentBoundary(
      registerEnvironment(fake),
      { readCurrentAggregate: () => aggregate, now: () => attempt.updatedAt },
    );
    const first = await boundary.dispatch(aggregate, { action: 'start', control: null });
    mutableDraft.id = 'mutated_observation_fixture';
    mutableDraft.kind = 'failed';
    const recovered = await boundary.dispatch(aggregate, { action: 'start', control: null });

    expect(recovered.result?.draft).toEqual(first.result?.draft);
    expect(recovered.result?.draft).toMatchObject({
      id: 'immutable_observation_fixture',
      kind: 'started',
    });
  });
});
