import {
  workUnitExecutionStartResultV04Schema,
  type WorkUnitExecutionStartResultV04,
} from '@waldo/contracts';
import {
  WaldoCoordinator,
} from '../coordinator/waldo-coordinator';
import type {
  ExecutionAggregateV04,
} from '../coordinator/planning-execution-module';
import type { ResponsibilityCanonicalAuthority } from '../coordinator/identity-presence-module';
import {
  ExecutionEnvironmentBoundary,
} from '../execution-environment/conformance';
import { materializeExecutorObservationV04 } from '../execution-environment/binding';
import type { RegisteredExecutionEnvironment } from '../execution-environment/port';
import { ResponsibilityPlanningConflictError } from '../responsibility/errors';
import {
  createDeterministicFakeExecutionEnvironmentStore,
  DeterministicFakeExecutionEnvironment,
  type DeterministicFakeExecutionEnvironmentStore,
} from '../execution-environment/deterministic-fake';
import { ExecutionEnvironmentRegistry } from '../execution-environment/conformance';

export type WorkUnitExecutionStartAdmission = Readonly<{
  requestId: string;
  workUnitId: string;
  expectedWorkUnitRevision: number;
}>;

export type WorkUnitExecutionBridgeDependencies = Readonly<{
  coordinator: WaldoCoordinator;
  registeredEnvironmentFor(aggregate: ExecutionAggregateV04): RegisteredExecutionEnvironment;
  now(): string;
  newId(kind: 'execution_attempt' | 'execution_lease' | 'execution_session'): string;
  sha256Hex(value: string): Promise<string>;
}>;

export class WorkUnitExecutionBridge {
  readonly #dependencies: WorkUnitExecutionBridgeDependencies;

  constructor(dependencies: WorkUnitExecutionBridgeDependencies) {
    this.#dependencies = dependencies;
  }

  async start(
    admission: WorkUnitExecutionStartAdmission,
    authority: ResponsibilityCanonicalAuthority,
  ): Promise<WorkUnitExecutionStartResultV04> {
    const executionRequestId = `execution_request_${await this.#dependencies.sha256Hex(
      `work-unit-execution-start-v0.4\0${authority.ownerId}\0${admission.requestId}`,
    )}`;
    let aggregate = await this.#dependencies.coordinator.admitPublicExecutionRequestV04({
      id: executionRequestId,
      workUnitId: admission.workUnitId,
      expectedWorkUnitRevision: admission.expectedWorkUnitRevision,
    }, authority);
    if (aggregate.attempts.length === 0) {
      try {
        aggregate = this.#dependencies.coordinator.claimExecutionAttemptV04({
          executionRequestId,
          attemptId: this.#dependencies.newId('execution_attempt'),
          leaseId: this.#dependencies.newId('execution_lease'),
          sessionId: this.#dependencies.newId('execution_session'),
          providerSessionRef: null,
        });
      } catch (error) {
        if (!(error instanceof ResponsibilityPlanningConflictError) ||
            error.message !== 'execution request already claimed') throw error;
        aggregate = this.#dependencies.coordinator.readExecutionAggregateV04(
          authority.ownerId,
          executionRequestId,
        );
      }
    }
    const currentAttempt = aggregate.attempts.at(-1);
    if (currentAttempt === undefined) throw new Error('execution start claim unavailable');
    const started = aggregate.observations.find(
      (observation) => observation.attemptId === currentAttempt.id &&
        observation.kind === 'started',
    );
    if (started !== undefined) {
      return workUnitExecutionStartResultV04Schema.parse({
        protocolVersion: '0.4',
        requestId: admission.requestId,
        workUnit: {
          id: aggregate.request.workUnit.id,
          revision: aggregate.request.workUnit.revision,
        },
        executionRequestId,
        attemptId: currentAttempt.id,
        status: 'started',
        observation: { id: started.id, sequence: started.sequence, kind: 'started' },
      });
    }

    const boundary = new ExecutionEnvironmentBoundary(
      this.#dependencies.registeredEnvironmentFor(aggregate),
      {
        readCurrentAggregate: (ownerId, requestId) =>
          this.#dependencies.coordinator.readCurrentExecutionAggregateV04(ownerId, requestId),
        resolveOperationIntent: (current, input) => {
          if (input.action !== 'start' || input.control !== null) {
            throw new Error('public execution bridge supports only start');
          }
          return this.#dependencies.coordinator.resolveExecutionStartIntentV04(
            current.request.ownerId,
            current.request.id,
          );
        },
        now: this.#dependencies.now,
      },
    );
    const dispatch = await boundary.dispatch(aggregate, { action: 'start', control: null });
    if (dispatch.status === 'indeterminate') {
      return workUnitExecutionStartResultV04Schema.parse({
        protocolVersion: '0.4',
        requestId: admission.requestId,
        workUnit: {
          id: aggregate.request.workUnit.id,
          revision: aggregate.request.workUnit.revision,
        },
        executionRequestId,
        attemptId: currentAttempt.id,
        status: 'indeterminate',
        observation: null,
      });
    }
    const observation = materializeExecutorObservationV04(aggregate, dispatch);
    if (observation.kind !== 'started') {
      throw new Error('execution start adapter returned a non-start observation');
    }
    const observed = await this.#dependencies.coordinator.admitExecutorObservationV04(observation);
    const admitted = observed.observations.find((value) => value.id === observation.id);
    if (admitted === undefined || admitted.kind !== 'started') {
      throw new Error('execution start observation admission failed');
    }
    return workUnitExecutionStartResultV04Schema.parse({
      protocolVersion: '0.4',
      requestId: admission.requestId,
      workUnit: {
        id: observed.request.workUnit.id,
        revision: observed.request.workUnit.revision,
      },
      executionRequestId,
      attemptId: currentAttempt.id,
      status: 'started',
      observation: { id: admitted.id, sequence: admitted.sequence, kind: 'started' },
    });
  }
}

const LOCAL_PROOF_DIGEST = `sha256:${'d'.repeat(64)}` as const;
const localProofStore = createDeterministicFakeExecutionEnvironmentStore();

const localProofProvider = Object.freeze({
  category: 'provider' as const,
  id: 'local_execution_proof_provider',
  version: '1.0.0',
  modelRef: 'local_execution_proof_model',
  manifest: Object.freeze({
    id: 'local_execution_proof_provider_manifest',
    version: '1.0.0',
    digest: LOCAL_PROOF_DIGEST,
  }),
});

const localProofEnvironment = Object.freeze({
  category: 'execution_environment' as const,
  id: 'local_execution_proof_environment',
  version: '1.0.0',
  environmentKind: 'local' as const,
  manifest: Object.freeze({
    id: 'local_execution_proof_environment_manifest',
    version: '1.0.0',
    digest: LOCAL_PROOF_DIGEST,
  }),
});

const localProofDescriptor = Object.freeze({
  protocolVersion: '0.4' as const,
  adapter: Object.freeze({ id: 'deterministic_fake_execution_environment', version: '1.0.0' }),
  environment: localProofEnvironment,
  capabilities: Object.freeze({
    start: Object.freeze({ mode: 'native' as const, version: '1.0.0' }),
    resume: Object.freeze({ mode: 'unsupported' as const, version: '1.0.0' }),
    steer: Object.freeze({ mode: 'unsupported' as const, version: '1.0.0' }),
    pause: Object.freeze({ mode: 'unsupported' as const, version: '1.0.0' }),
    cancel: Object.freeze({ mode: 'unsupported' as const, version: '1.0.0' }),
    reconcile: Object.freeze({ mode: 'native' as const, version: '1.0.0' }),
  }),
});

export function localWorkUnitExecutionBinding(
  input: Readonly<{ ownerId: string; outcomeId: string; workUnitId: string }>,
  contextProjectionDigest: string,
) {
  return Object.freeze({
    provider: localProofProvider,
    environment: localProofEnvironment,
    contextProjectionRef: `execution_context_${input.workUnitId}`,
    contextProjectionDigest,
  });
}

export function localWorkUnitExecutionEnvironmentFor(
  aggregate: ExecutionAggregateV04,
  now: () => string,
  store: DeterministicFakeExecutionEnvironmentStore = localProofStore,
): RegisteredExecutionEnvironment {
  const fake = new DeterministicFakeExecutionEnvironment({
    descriptor: localProofDescriptor,
    store,
    script: {
      start: {
        status: 'observed',
        draft: {
          category: 'execution_environment_observation_draft',
          id: `execution_observation_${aggregate.request.id}`,
          sequence: 1,
          kind: 'started',
          payloadRef: null,
          payloadDigest: null,
          observedAt: now(),
        },
      },
    },
    now,
  });
  return new ExecutionEnvironmentRegistry().register(localProofDescriptor, fake);
}

export function localWorkUnitExecutionProofStats(): Readonly<{
  physicalIssues: number;
  executeCalls: number;
  recoverCalls: number;
}> {
  return Object.freeze({
    physicalIssues: localProofStore.physicalIssues,
    executeCalls: localProofStore.executeCalls,
    recoverCalls: localProofStore.recoverCalls,
  });
}
