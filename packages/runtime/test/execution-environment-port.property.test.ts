import {
  buildResponsibilityExecutionV04Bundle,
  executionAttemptV04Schema,
  executionLeaseV04Schema,
  executionRequestV04Schema,
  executionSessionV04Schema,
} from '@waldo/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createDeterministicFakeExecutionEnvironmentStore,
  DeterministicFakeExecutionEnvironment,
  EXECUTION_ENVIRONMENT_ACTIONS,
  ExecutionEnvironmentBoundary,
  ExecutionEnvironmentRegistry,
  materializeExecutorObservationV04,
  type ExecutionEnvironmentAction,
  type ExecutionEnvironmentPort,
  type ExecutionEnvironmentSupportMode,
} from '../src/execution-environment';

function registerEnvironment(adapter: ExecutionEnvironmentPort) {
  return new ExecutionEnvironmentRegistry().register(adapter.descriptor, adapter);
}

const bundle = buildResponsibilityExecutionV04Bundle(() => 'a'.repeat(64));
const request = executionRequestV04Schema.parse(
  JSON.parse(bundle['execution-request.valid.json']!),
);
const fixtureAttempt = executionAttemptV04Schema.parse(
  JSON.parse(bundle['execution-attempt.valid.json']!),
);
const fixtureLease = executionLeaseV04Schema.parse(
  JSON.parse(bundle['execution-lease.valid.json']!),
);
const fixtureSession = executionSessionV04Schema.parse(
  JSON.parse(bundle['execution-session.valid.json']!),
);

function aggregateFor(action: ExecutionEnvironmentAction) {
  const generation = action === 'cancel' ? 2 : 1;
  const attempt = executionAttemptV04Schema.parse({
    ...fixtureAttempt,
    cancellationGeneration: generation,
    state: action === 'cancel' ? 'cancelling' : 'running',
  });
  const lease = executionLeaseV04Schema.parse({
    ...fixtureLease,
    cancellationGeneration: generation,
  });
  const session = executionSessionV04Schema.parse({
    ...fixtureSession,
    state: action === 'cancel' ? 'unknown' : 'active',
  });
  return Object.freeze({
    request,
    currentCancellationGeneration: generation,
    attempts: Object.freeze([attempt]),
    leases: Object.freeze([lease]),
    sessions: Object.freeze([session]),
    observations: Object.freeze([]),
    reconciliations: Object.freeze([]),
  });
}

function descriptorFor(
  action: ExecutionEnvironmentAction,
  mode: ExecutionEnvironmentSupportMode,
) {
  const capability = (name: ExecutionEnvironmentAction) => Object.freeze({
    mode: name === action ? mode : 'native' as const,
    version: `${name}-v1`,
  });
  return Object.freeze({
    protocolVersion: '0.4' as const,
    adapter: Object.freeze({ id: 'property_fake_adapter', version: 'property-v1' }),
    environment: request.environment,
    capabilities: Object.freeze({
      start: capability('start'),
      resume: capability('resume'),
      steer: capability('steer'),
      pause: capability('pause'),
      cancel: capability('cancel'),
      reconcile: capability('reconcile'),
    }),
  });
}

function draftFor(action: ExecutionEnvironmentAction, suffix: number) {
  if (action === 'cancel' || action === 'reconcile') {
    return {
      category: 'execution_environment_reconciliation_draft',
      id: `reconciliation_property_${suffix}`,
      state: action === 'cancel' ? 'cancelled' : 'running',
      basisObservationIds: [],
      checkedAt: fixtureAttempt.updatedAt,
    };
  }
  return {
    category: 'execution_environment_observation_draft',
    id: `observation_property_${suffix}`,
    sequence: 1,
    kind: action === 'start' ? 'started' : 'activity',
    payloadRef: null,
    payloadDigest: null,
    observedAt: fixtureAttempt.updatedAt,
  };
}

describe('execution environment conformance properties', () => {
  it('keeps capability truth and at-most-one issue across every action and support mode', async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom(...EXECUTION_ENVIRONMENT_ACTIONS),
      fc.constantFrom<ExecutionEnvironmentSupportMode>('native', 'emulated', 'unsupported'),
      fc.integer({ min: 1, max: 1_000_000 }),
      async (action, mode, suffix) => {
        const store = createDeterministicFakeExecutionEnvironmentStore();
        const fake = new DeterministicFakeExecutionEnvironment({
          descriptor: descriptorFor(action, mode),
          store,
          script: {
            [action]: { status: 'observed', draft: draftFor(action, suffix) },
          },
          now: () => fixtureAttempt.updatedAt,
        });
        const currentAggregate = aggregateFor(action);
        const boundary = new ExecutionEnvironmentBoundary(
          registerEnvironment(fake),
          {
            readCurrentAggregate: () => currentAggregate,
            now: () => fixtureAttempt.updatedAt,
          },
        );
        const input = {
          action,
          control: action === 'steer'
            ? {
                payloadRef: `steer_property_${suffix}`,
                payloadDigest: `sha256:${'b'.repeat(64)}`,
              }
            : null,
        } as const;
        if (mode === 'unsupported') {
          await expect(boundary.dispatch(currentAggregate, input))
            .rejects.toThrow(/unsupported/i);
          expect(store).toMatchObject({ physicalIssues: 0, executeCalls: 0, recoverCalls: 0 });
          return;
        }
        const first = await boundary.dispatch(currentAggregate, input);
        const replay = await boundary.dispatch(currentAggregate, input);
        expect(first.support.mode).toBe(mode);
        expect(replay.support.mode).toBe(mode);
        expect(first.command.operationId).toBe(replay.command.operationId);
        expect(first.command.operationDigest).toBe(replay.command.operationDigest);
        expect(store.physicalIssues).toBe(action === 'reconcile' ? 0 : 1);
        expect(store.executeCalls).toBe(action === 'reconcile' ? 0 : 1);
      },
    ), { numRuns: 72 });
  });

  it('rejects any result materialized against a later fence or cancellation generation', async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 10_000 }),
      async (delta) => {
        const aggregate = aggregateFor('start');
        const store = createDeterministicFakeExecutionEnvironmentStore();
        const boundary = new ExecutionEnvironmentBoundary(
          registerEnvironment(
            new DeterministicFakeExecutionEnvironment({
              descriptor: descriptorFor('start', 'native'),
              store,
              script: {
                start: {
                  status: 'observed',
                  draft: draftFor('start', delta),
                },
              },
              now: () => fixtureAttempt.updatedAt,
            }),
          ),
          { readCurrentAggregate: () => aggregate, now: () => fixtureAttempt.updatedAt },
        );
        const dispatch = await boundary.dispatch(aggregate, {
          action: 'start',
          control: null,
        });
        const nextGeneration = fixtureAttempt.fencingGeneration + delta;
        const nextCancellation = fixtureAttempt.cancellationGeneration + delta;
        const staleAgainst = {
          ...aggregate,
          currentCancellationGeneration: nextCancellation,
          attempts: [executionAttemptV04Schema.parse({
            ...fixtureAttempt,
            fencingGeneration: nextGeneration,
            cancellationGeneration: nextCancellation,
          })],
          leases: [executionLeaseV04Schema.parse({
            ...fixtureLease,
            fencingGeneration: nextGeneration,
            cancellationGeneration: nextCancellation,
          })],
        };
        expect(() => materializeExecutorObservationV04(staleAgainst, dispatch))
          .toThrow(/current canonical binding/i);
      },
    ), { numRuns: 32 });
  });
});
