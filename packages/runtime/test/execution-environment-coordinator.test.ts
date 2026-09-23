import {
  buildResponsibilityExecutionV04Bundle,
  executionAttemptV04Schema,
  executionCancelRequestV04Schema,
  executionRequestV04Schema,
  executionSessionV04Schema,
  executorObservationV04Schema,
  workUnitExecutionStartResultV04Schema,
} from '@waldo/contracts';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  WaldoCoordinator,
  type CoordinatorDependencies,
} from '../src/coordinator/waldo-coordinator';
import type { ResponsibilityCanonicalAuthorityRegistration } from
  '../src/coordinator/identity-presence-module';
import { provisionDoSchema } from '../src/do-schema';
import {
  createDeterministicFakeExecutionEnvironmentStore,
  DeterministicFakeExecutionEnvironment,
  ExecutionEnvironmentBoundary,
  ExecutionEnvironmentRegistry,
  materializeExecutorObservationV04,
  materializeExecutionReconciliationV04,
  type ExecutionEnvironmentPort,
} from '../src/execution-environment';
import type { RuntimeProbeDO } from '../src/index';
import { WorkUnitExecutionBridge } from '../src/run-loop/work-unit-execution';

function registerEnvironment(adapter: ExecutionEnvironmentPort) {
  return new ExecutionEnvironmentRegistry().register(adapter.descriptor, adapter);
}

function defaultOperationIntent(input: Readonly<{
  action: string;
  control: Readonly<{ payloadRef: string }> | null;
}>) {
  return {
    ref: `server_intent_${input.action}_${input.control?.payloadRef ?? 'default'}`,
    digest: `sha256:${'c'.repeat(64)}`,
  };
}

const bundle = buildResponsibilityExecutionV04Bundle(() => 'a'.repeat(64));
const request = executionRequestV04Schema.parse(
  JSON.parse(bundle['execution-request.valid.json']!),
);
const attempt = executionAttemptV04Schema.parse(
  JSON.parse(bundle['execution-attempt.valid.json']!),
);
const session = executionSessionV04Schema.parse(
  JSON.parse(bundle['execution-session.valid.json']!),
);
const fixtureObservation = executorObservationV04Schema.parse(
  JSON.parse(bundle['executor-observation.valid.json']!),
);
const cancelRequest = executionCancelRequestV04Schema.parse(
  JSON.parse(bundle['execution-cancel-request.valid.json']!),
);
const admission = Object.freeze({
  id: request.id,
  outcomeId: request.outcome.id,
  workUnitId: request.workUnit.id,
});
const claim = Object.freeze({
  executionRequestId: request.id,
  attemptId: attempt.id,
  leaseId: attempt.leaseId,
  sessionId: session.id,
  providerSessionRef: session.providerSessionRef,
});
const resolvedBinding = Object.freeze({
  provider: request.provider,
  environment: request.environment,
  contextProjectionRef: request.contextProjectionRef,
  contextProjectionDigest: request.contextProjectionDigest,
});
const authorityRegistration: ResponsibilityCanonicalAuthorityRegistration = Object.freeze({
  ownerId: request.ownerId,
  authenticatedSubjectRef: `supabase_subject_${'a'.repeat(64)}`,
  presenceId: 'presence_fixture',
  presenceRegistrationId: cancelRequest.presenceRegistrationId,
  authenticatedSessionId: `authenticated_session_${'b'.repeat(64)}`,
  ownerPolicyRevision: 1,
  ownerRootRoutingVersion: 2,
  authenticatedSessionExpiresAt: '2026-08-13T13:00:00.000Z',
  presenceState: 'active',
  at: '2026-08-13T11:59:00.000Z',
});
const descriptor = Object.freeze({
  protocolVersion: '0.4' as const,
  adapter: Object.freeze({ id: 'fake_environment_adapter', version: 'fake-v1' }),
  environment: request.environment,
  capabilities: Object.freeze({
    start: Object.freeze({ mode: 'native' as const, version: 'start-v1' }),
    resume: Object.freeze({ mode: 'native' as const, version: 'resume-v1' }),
    steer: Object.freeze({ mode: 'emulated' as const, version: 'steer-v1' }),
    pause: Object.freeze({ mode: 'unsupported' as const, version: 'pause-v1' }),
    cancel: Object.freeze({ mode: 'native' as const, version: 'cancel-v1' }),
    reconcile: Object.freeze({ mode: 'native' as const, version: 'reconcile-v1' }),
  }),
});

let sequence = 0;
function freshStub(): DurableObjectStub<RuntimeProbeDO> {
  sequence += 1;
  return env.RUNTIME_DO.get(env.RUNTIME_DO.idFromName(`execution-environment-${sequence}`));
}

function seedCanonicalProductState(storage: DurableObjectStorage): void {
  storage.sql.exec(
    `INSERT OR IGNORE INTO owner_roots (
      root_key, owner_id, created_at, authenticated_subject_ref, state,
      owner_policy_revision, owner_root_routing_version, updated_at
    ) VALUES (1, ?, ?, ?, 'active', ?, ?, ?)`,
    request.ownerId,
    request.requestedAt,
    authorityRegistration.authenticatedSubjectRef,
    authorityRegistration.ownerPolicyRevision,
    authorityRegistration.ownerRootRoutingVersion,
    authorityRegistration.at,
  );
  storage.sql.exec(
    `INSERT OR IGNORE INTO presence_registrations (
      presence_registration_id, owner_id, presence_id, state, created_at, updated_at
    ) VALUES (?, ?, ?, 'active', ?, ?)`,
    cancelRequest.presenceRegistrationId,
    request.ownerId,
    authorityRegistration.presenceId,
    authorityRegistration.at,
    authorityRegistration.at,
  );
  storage.sql.exec(
    `INSERT OR IGNORE INTO outcomes (
      id, owner_id, revision, user_statement, state, created_at, updated_at
    ) VALUES (?, ?, ?, 'Canonical execution outcome.', 'captured', ?, ?)`,
    request.outcome.id,
    request.ownerId,
    request.outcome.revision,
    request.requestedAt,
    request.requestedAt,
  );
  storage.sql.exec(
    `INSERT OR IGNORE INTO work_units (
      id, owner_id, outcome_id, mission_id, position, revision, responsibility,
      inputs_json, dependency_ids_json, expected_evidence_json,
      required_capabilities_json, authority_ceiling_json, budget_json,
      isolation_json, stop_conditions_json, assignee, session_ids_json,
      state, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, 0, ?, 'Canonical execution work.', '[]', '[]', '[]', '[]',
      ?, '{"maxProviderTurns":0,"maxExternalEffects":0,"maxDurationMs":0}',
      '{"mode":"unassigned","egress":"deny_all","credentials":"none"}',
      '[]', NULL, '[]', 'planned', ?, ?)`,
    request.workUnit.id,
    request.ownerId,
    request.outcome.id,
    request.workUnit.revision,
    JSON.stringify(request.authorityCeiling),
    request.requestedAt,
    request.requestedAt,
  );
}

describe('execution environment to sole-writer conformance', () => {
  it('composes public start through commit, recover-first issue, and public observation admission', async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_instance, state) => {
      provisionDoSchema(state.storage);
      seedCanonicalProductState(state.storage);
      const timeline: string[] = [];
      const now = request.requestedAt;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => now,
        newId: (kind) => `${kind}_unused`,
        async sha256Hex() { return 'a'.repeat(64); },
        async resolveExecutionBindingV04() { return resolvedBinding; },
        afterWrite(stage) { timeline.push(stage); },
      });
      const authority = coordinator.admitCanonicalAuthority(authorityRegistration);
      const productBefore = JSON.stringify({
        outcome: state.storage.sql.exec('SELECT * FROM outcomes').toArray(),
        workUnit: state.storage.sql.exec('SELECT * FROM work_units').toArray(),
      });
      const store = createDeterministicFakeExecutionEnvironmentStore();
      const bridge = new WorkUnitExecutionBridge({
        coordinator,
        now: () => now,
        newId: (kind) => `${kind}_public_01`,
        async sha256Hex() { return 'a'.repeat(64); },
        registeredEnvironmentFor() {
          const fake = new DeterministicFakeExecutionEnvironment({
            descriptor,
            store,
            script: {
              start: {
                status: 'observed',
                draft: {
                  category: 'execution_environment_observation_draft',
                  id: 'execution_observation_public_01',
                  sequence: 1,
                  kind: 'started',
                  payloadRef: null,
                  payloadDigest: null,
                  observedAt: now,
                },
              },
            },
            now: () => now,
          });
          return registerEnvironment({
            descriptor: fake.descriptor,
            async recover(command) {
              timeline.push('adapter_recover');
              return fake.recover(command);
            },
            async execute(command) {
              timeline.push('adapter_execute');
              return fake.execute(command);
            },
          });
        },
      });
      const admission = {
        requestId: 'public_execution_start_01',
        publicCommandDigest: `sha256:${'b'.repeat(64)}`,
        workUnitId: request.workUnit.id,
        expectedWorkUnitRevision: request.workUnit.revision,
      };
      const [result, concurrent] = await Promise.all([
        bridge.start(admission, authority),
        bridge.start(admission, authority),
      ]);
      expect(concurrent).toEqual(result);
      expect(workUnitExecutionStartResultV04Schema.parse(result)).toEqual(result);
      expect(result).toMatchObject({
        requestId: admission.requestId,
        executionRequestId: expect.stringMatching(/^er_[A-Za-z0-9_-]{43}_[A-Za-z0-9_-]{43}$/),
        attemptId: 'execution_attempt_public_01',
        status: 'started',
      });
      expect(timeline.indexOf('execution_attempt')).toBeLessThan(
        timeline.indexOf('adapter_recover'),
      );
      expect(timeline.indexOf('adapter_execute')).toBeLessThan(
        timeline.indexOf('execution_observation'),
      );
      expect(store.physicalIssues).toBe(1);
      expect(await bridge.start(admission, authority)).toEqual(result);
      expect(store.physicalIssues).toBe(1);
      expect(JSON.stringify({
        outcome: state.storage.sql.exec('SELECT * FROM outcomes').toArray(),
        workUnit: state.storage.sql.exec('SELECT * FROM work_units').toArray(),
      })).toBe(productBefore);
    });
  });

  it('blocks physical issue when canonical WorkUnit state changes after recovery', async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_instance, state) => {
      provisionDoSchema(state.storage);
      seedCanonicalProductState(state.storage);
      const now = request.requestedAt;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => now,
        newId: (kind) => `${kind}_unused`,
        async sha256Hex() { return 'a'.repeat(64); },
        async resolveExecutionBindingV04() { return resolvedBinding; },
      });
      const authority = coordinator.admitCanonicalAuthority(authorityRegistration);
      const store = createDeterministicFakeExecutionEnvironmentStore();
      let mutated = false;
      const bridge = new WorkUnitExecutionBridge({
        coordinator,
        now: () => now,
        newId: (kind) => `${kind}_stale_product_01`,
        async sha256Hex() { return 'a'.repeat(64); },
        registeredEnvironmentFor() {
          const fake = new DeterministicFakeExecutionEnvironment({
            descriptor,
            store,
            script: {
              start: {
                status: 'observed',
                draft: {
                  category: 'execution_environment_observation_draft',
                  id: 'execution_observation_stale_product_01',
                  sequence: 1,
                  kind: 'started',
                  payloadRef: null,
                  payloadDigest: null,
                  observedAt: now,
                },
              },
            },
            now: () => now,
          });
          return registerEnvironment({
            descriptor: fake.descriptor,
            async recover(command) {
              const recovered = await fake.recover(command);
              if (!mutated) {
                mutated = true;
                state.storage.sql.exec(
                  'UPDATE work_units SET revision = revision + 1 WHERE id = ?',
                  request.workUnit.id,
                );
              }
              return recovered;
            },
            execute: (command) => fake.execute(command),
          });
        },
      });
      await expect(bridge.start({
        requestId: 'public_execution_stale_product_01',
        publicCommandDigest: `sha256:${'b'.repeat(64)}`,
        workUnitId: request.workUnit.id,
        expectedWorkUnitRevision: request.workUnit.revision,
      }, authority)).rejects.toThrow('digest conflict');
      expect(store).toMatchObject({ physicalIssues: 0, executeCalls: 0, recoverCalls: 1 });
      expect(state.storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM execution_observations',
      ).one().count).toBe(0);
    });
  });


  it('claims before I/O and admits only a canonically bound observation through Coordinator', async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_instance, state) => {
      provisionDoSchema(state.storage);
      seedCanonicalProductState(state.storage);
      let now: string = request.requestedAt;
      const timeline: string[] = [];
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => now,
        newId: (kind) => `${kind}_unused`,
        async sha256Hex() { return 'a'.repeat(64); },
        async resolveExecutionBindingV04() { return resolvedBinding; },
        afterWrite(stage) { timeline.push(stage); },
      });
      const authority = coordinator.admitCanonicalAuthority(authorityRegistration);
      await coordinator.admitExecutionRequestV04(admission, authority);
      const productBefore = JSON.stringify({
        outcome: state.storage.sql.exec('SELECT * FROM outcomes').toArray(),
        workUnit: state.storage.sql.exec('SELECT * FROM work_units').toArray(),
      });
      now = attempt.updatedAt;
      const claimed = coordinator.claimExecutionAttemptV04(claim);
      const store = createDeterministicFakeExecutionEnvironmentStore();
      const fake = new DeterministicFakeExecutionEnvironment({
        descriptor,
        store,
        script: {
          start: {
            status: 'observed',
            draft: {
              category: 'execution_environment_observation_draft',
              id: 'environment_started_fixture',
              sequence: 1,
              kind: 'started',
              payloadRef: null,
              payloadDigest: null,
              observedAt: attempt.updatedAt,
            },
          },
        },
        now: () => now,
      });
      const traced: ExecutionEnvironmentPort = {
        descriptor: fake.descriptor,
        async recover(command) {
          timeline.push('adapter_recover');
          return fake.recover(command);
        },
        async execute(command) {
          timeline.push('adapter_execute');
          return fake.execute(command);
        },
      };
      const boundary = new ExecutionEnvironmentBoundary(
        registerEnvironment(traced),
        { readCurrentAggregate: () => coordinator.readExecutionAggregateV04(
          request.ownerId, request.id,
        ), now: () => now, resolveOperationIntent: (_aggregate, input) => defaultOperationIntent(input) },
      );
      const dispatched = await boundary.dispatch(claimed, {
        action: 'start',
        control: null,
      });
      const observation = materializeExecutorObservationV04(claimed, dispatched);
      const observed = await coordinator.admitExecutorObservationV04(observation);

      expect(timeline.indexOf('execution_attempt')).toBeLessThan(
        timeline.indexOf('adapter_recover'),
      );
      expect(timeline.indexOf('adapter_execute')).toBeLessThan(
        timeline.indexOf('execution_observation'),
      );
      expect(executorObservationV04Schema.parse(observed.observations[0])).toEqual(observation);
      expect(store.physicalIssues).toBe(1);

      const replay = await boundary.dispatch(claimed, {
        action: 'start',
        control: null,
      });
      await coordinator.admitExecutorObservationV04(
        materializeExecutorObservationV04(claimed, replay),
      );
      expect(store.physicalIssues).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM execution_observations',
      ).one().count).toBe(1);

      now = '2026-08-13T12:00:03.500Z';
      const candidateStore = createDeterministicFakeExecutionEnvironmentStore();
      const candidateBoundary = new ExecutionEnvironmentBoundary(
        registerEnvironment(
          new DeterministicFakeExecutionEnvironment({
            descriptor,
            store: candidateStore,
            script: {
              steer: {
                status: 'observed',
                draft: {
                  category: 'execution_environment_observation_draft',
                  id: 'candidate_evidence_observation_fixture',
                  sequence: 2,
                  kind: 'candidate_evidence',
                  payloadRef: 'candidate_evidence_ref_fixture',
                  payloadDigest: `sha256:${'e'.repeat(64)}`,
                  observedAt: now,
                },
              },
            },
            now: () => now,
          }),
        ),
        { readCurrentAggregate: () => coordinator.readExecutionAggregateV04(
          request.ownerId, request.id,
        ), now: () => now, resolveOperationIntent: (_aggregate, input) => defaultOperationIntent(input) },
      );
      const candidate = await candidateBoundary.dispatch(observed, {
        action: 'steer',
        control: {
          payloadRef: 'steer_instruction_ref_fixture',
          payloadDigest: `sha256:${'d'.repeat(64)}`,
        },
      });
      expect(candidate.support.mode).toBe('emulated');
      const withCandidate = await coordinator.admitExecutorObservationV04(
        materializeExecutorObservationV04(observed, candidate),
      );
      expect(withCandidate.observations[1]).toMatchObject({
        kind: 'candidate_evidence',
        payloadRef: 'candidate_evidence_ref_fixture',
      });

      expect(() => coordinator.claimExecutionAttemptV04({
        ...claim,
        attemptId: 'attempt_second_claimant',
        leaseId: 'lease_second_claimant',
        sessionId: 'session_second_claimant',
      })).toThrow(/already claimed/i);
      expect(store.physicalIssues).toBe(1);
      expect(JSON.stringify({
        outcome: state.storage.sql.exec('SELECT * FROM outcomes').toArray(),
        workUnit: state.storage.sql.exec('SELECT * FROM work_units').toArray(),
      })).toBe(productBefore);
    });
  });

  it('commits cancellation before I/O and settles only current execution activity', async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_instance, state) => {
      provisionDoSchema(state.storage);
      seedCanonicalProductState(state.storage);
      let now: string = request.requestedAt;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => now,
        newId: (kind) => `${kind}_unused`,
        async sha256Hex() { return 'a'.repeat(64); },
        async resolveExecutionBindingV04() { return resolvedBinding; },
      });
      const authority = coordinator.admitCanonicalAuthority(authorityRegistration);
      await coordinator.admitExecutionRequestV04(admission, authority);
      now = attempt.updatedAt;
      const beforeCancel = coordinator.claimExecutionAttemptV04(claim);
      now = '2026-08-13T12:00:04.000Z';
      const cancelling = await coordinator.cancelExecutionV04({
        request: cancelRequest,
        canonicalAuthority: authority,
      });
      expect(cancelling.currentCancellationGeneration).toBe(2);
      expect(cancelling.attempts[0]?.state).toBe('cancelling');

      await expect(coordinator.admitExecutorObservationV04(fixtureObservation))
        .rejects.toThrow(/observation rejected/i);

      const contradictoryStore = createDeterministicFakeExecutionEnvironmentStore();
      const contradictory = new ExecutionEnvironmentBoundary(
        registerEnvironment(
          new DeterministicFakeExecutionEnvironment({
            descriptor,
            store: contradictoryStore,
            script: {
              cancel: {
                status: 'observed',
                draft: {
                  category: 'execution_environment_reconciliation_draft',
                  id: 'reconciliation_false_settled',
                  state: 'settled',
                  basisObservationIds: [],
                  checkedAt: now,
                },
              },
            },
            now: () => now,
          }),
        ),
        { readCurrentAggregate: () => coordinator.readExecutionAggregateV04(
          request.ownerId, request.id,
        ), now: () => now, resolveOperationIntent: (_aggregate, input) => defaultOperationIntent(input) },
      );
      const falseSettlement = await contradictory.dispatch(cancelling, {
        action: 'cancel',
        control: null,
      });
      await expect(coordinator.reconcileExecutionAttemptV04(
        materializeExecutionReconciliationV04(cancelling, falseSettlement),
      )).rejects.toThrow(/state mismatch/i);
      expect(state.storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM execution_reconciliations',
      ).one().count).toBe(0);

      const cancelStore = createDeterministicFakeExecutionEnvironmentStore();
      const cancelBoundary = new ExecutionEnvironmentBoundary(
        registerEnvironment(
          new DeterministicFakeExecutionEnvironment({
            descriptor,
            store: cancelStore,
            script: {
              cancel: {
                status: 'observed',
                draft: {
                  category: 'execution_environment_reconciliation_draft',
                  id: 'reconciliation_cancelled_fixture',
                  state: 'cancelled',
                  basisObservationIds: [],
                  checkedAt: now,
                },
              },
            },
            now: () => now,
          }),
        ),
        { readCurrentAggregate: () => coordinator.readExecutionAggregateV04(
          request.ownerId, request.id,
        ), now: () => now, resolveOperationIntent: (_aggregate, input) => defaultOperationIntent(input) },
      );
      const cancellation = await cancelBoundary.dispatch(cancelling, {
        action: 'cancel',
        control: null,
      });
      expect(() => materializeExecutionReconciliationV04(beforeCancel, cancellation))
        .toThrow(/binding|generation/i);
      const terminal = await coordinator.reconcileExecutionAttemptV04(
        materializeExecutionReconciliationV04(cancelling, cancellation),
      );
      expect(terminal.attempts[0]?.state).toBe('cancelled');
      expect(terminal.sessions[0]?.state).toBe('ended');

      now = '2026-08-13T12:00:04.500Z';
      const reconcileStore = createDeterministicFakeExecutionEnvironmentStore();
      const reconcileBoundary = new ExecutionEnvironmentBoundary(
        registerEnvironment(
          new DeterministicFakeExecutionEnvironment({
            descriptor,
            store: reconcileStore,
            script: {
              reconcile: {
                status: 'observed',
                draft: {
                  category: 'execution_environment_reconciliation_draft',
                  id: 'reconciliation_reopens_terminal',
                  state: 'running',
                  basisObservationIds: [],
                  checkedAt: now,
                },
              },
            },
            now: () => now,
          }),
        ),
        { readCurrentAggregate: () => coordinator.readExecutionAggregateV04(
          request.ownerId, request.id,
        ), now: () => now, resolveOperationIntent: (_aggregate, input) => defaultOperationIntent(input) },
      );
      const reopening = await reconcileBoundary.dispatch(terminal, {
        action: 'reconcile',
        control: null,
      });
      expect(reconcileStore.physicalIssues).toBe(0);
      await expect(coordinator.reconcileExecutionAttemptV04(
        materializeExecutionReconciliationV04(terminal, reopening),
      )).rejects.toThrow(/reconciliation rejected/i);
      expect(coordinator.readExecutionAggregateV04(request.ownerId, request.id)
        .attempts[0]?.state).toBe('cancelled');
    });
  });

  it('reconstructs a claimed attempt from SQLite and reconciles before any restart reissue', async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_instance, state) => {
      provisionDoSchema(state.storage);
      seedCanonicalProductState(state.storage);
      let now: string = request.requestedAt;
      const dependencies: CoordinatorDependencies = {
        now: () => now,
        newId: (kind) => `${kind}_unused`,
        async sha256Hex() { return 'a'.repeat(64); },
        async resolveExecutionBindingV04() { return resolvedBinding; },
      };
      const coordinator = new WaldoCoordinator(state.storage, dependencies);
      const authority = coordinator.admitCanonicalAuthority(authorityRegistration);
      await coordinator.admitExecutionRequestV04(admission, authority);
      now = attempt.updatedAt;
      const claimed = coordinator.claimExecutionAttemptV04(claim);
      const store = createDeterministicFakeExecutionEnvironmentStore();
      const beforeRestart = new ExecutionEnvironmentBoundary(
        registerEnvironment(
          new DeterministicFakeExecutionEnvironment({
            descriptor,
            store,
            script: {
              start: {
                status: 'observed',
                draft: {
                  category: 'execution_environment_observation_draft',
                  id: 'observation_restart_fixture',
                  sequence: 1,
                  kind: 'started',
                  payloadRef: null,
                  payloadDigest: null,
                  observedAt: now,
                },
                disconnectAfterApply: true,
              },
            },
            now: () => now,
          }),
        ),
        { readCurrentAggregate: () => coordinator.readExecutionAggregateV04(
          request.ownerId, request.id,
        ), now: () => now, resolveOperationIntent: (_aggregate, input) => defaultOperationIntent(input) },
      );
      await expect(beforeRestart.dispatch(claimed, {
        action: 'start',
        control: null,
      })).rejects.toThrow(/disconnected/i);
      expect(store.physicalIssues).toBe(1);

      const reconstructedCoordinator = new WaldoCoordinator(state.storage, dependencies);
      const reconstructedAggregate = reconstructedCoordinator.readExecutionAggregateV04(
        request.ownerId,
        request.id,
      );
      expect(reconstructedAggregate.attempts[0]?.state).toBe('running');
      const afterRestart = new ExecutionEnvironmentBoundary(
        registerEnvironment(
          new DeterministicFakeExecutionEnvironment({
            descriptor,
            store,
            script: {},
            now: () => now,
          }),
        ),
        { readCurrentAggregate: () => coordinator.readExecutionAggregateV04(
          request.ownerId, request.id,
        ), now: () => now, resolveOperationIntent: (_aggregate, input) => defaultOperationIntent(input) },
      );
      const recovered = await afterRestart.dispatch(reconstructedAggregate, {
        action: 'start',
        control: null,
      });
      const finalAggregate = await reconstructedCoordinator.admitExecutorObservationV04(
        materializeExecutorObservationV04(reconstructedAggregate, recovered),
      );
      expect(store).toMatchObject({ physicalIssues: 1, executeCalls: 1, recoverCalls: 2 });
      expect(finalAggregate.observations[0]?.id).toBe('observation_restart_fixture');
    });
  });

  it('does not settle unknown, contradictory, or time-travelling reconciliation', async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_instance, state) => {
      provisionDoSchema(state.storage);
      seedCanonicalProductState(state.storage);
      let now: string = request.requestedAt;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => now,
        newId: (kind) => `${kind}_unused`,
        async sha256Hex() { return 'a'.repeat(64); },
        async resolveExecutionBindingV04() { return resolvedBinding; },
      });
      const authority = coordinator.admitCanonicalAuthority(authorityRegistration);
      await coordinator.admitExecutionRequestV04(admission, authority);
      now = attempt.updatedAt;
      const claimed = coordinator.claimExecutionAttemptV04(claim);
      now = '2026-08-13T12:00:04.000Z';

      const cases = [
        {
          name: 'unknown-state',
          draft: {
            category: 'execution_environment_reconciliation_draft',
            id: 'reconciliation_unknown_state',
            state: 'mystery',
            basisObservationIds: [],
            checkedAt: now,
          },
          boundaryError: /state is invalid/i,
        },
        {
          name: 'unknown-basis',
          draft: {
            category: 'execution_environment_reconciliation_draft',
            id: 'reconciliation_unknown_basis',
            state: 'running',
            basisObservationIds: ['observation_not_admitted'],
            checkedAt: now,
          },
          writerError: /basis mismatch/i,
        },
        {
          name: 'future-time',
          draft: {
            category: 'execution_environment_reconciliation_draft',
            id: 'reconciliation_future_time',
            state: 'running',
            basisObservationIds: [],
            checkedAt: '2026-08-13T12:00:05.000Z',
          },
          writerError: /chronology mismatch/i,
        },
        {
          name: 'unsupported-settlement',
          draft: {
            category: 'execution_environment_reconciliation_draft',
            id: 'reconciliation_unsupported_settlement',
            state: 'settled',
            basisObservationIds: [],
            checkedAt: now,
          },
          writerError: /state mismatch/i,
        },
      ];
      for (const item of cases) {
        const store = createDeterministicFakeExecutionEnvironmentStore();
        const boundary = new ExecutionEnvironmentBoundary(
          registerEnvironment(
            new DeterministicFakeExecutionEnvironment({
              descriptor,
              store,
              script: { reconcile: { status: 'observed', draft: item.draft } },
              now: () => now,
            }),
          ),
          { readCurrentAggregate: () => coordinator.readExecutionAggregateV04(
            request.ownerId, request.id,
          ), now: () => now, resolveOperationIntent: (_aggregate, input) => defaultOperationIntent(input) },
        );
        const dispatchPromise = boundary.dispatch(claimed, {
          action: 'reconcile',
          control: null,
        });
        if (item.boundaryError !== undefined) {
          await expect(dispatchPromise).rejects.toThrow(item.boundaryError);
        } else {
          const dispatch = await dispatchPromise;
          await expect(coordinator.reconcileExecutionAttemptV04(
            materializeExecutionReconciliationV04(claimed, dispatch),
          )).rejects.toThrow(item.writerError);
        }
        expect(store.physicalIssues).toBe(0);
      }
      expect(state.storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM execution_reconciliations',
      ).one().count).toBe(0);
    });
  });
});
