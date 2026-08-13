import { z } from 'zod';
import {
  executionAttemptV04Schema,
  executionCancelRequestV04Schema,
  executionEnvironmentRefV04Schema,
  executionLeaseV04Schema,
  executionReconciliationV04Schema,
  executionRequestV04Schema,
  executionSessionV04Schema,
  executorObservationV04Schema,
  providerRefV04Schema,
} from './responsibility-execution-v0-4';
const file = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const schema = (value: z.ZodType, name: string) => ({
  ...(z.toJSONSchema(value, { target: 'draft-2020-12', io: 'input', reused: 'ref' }) as object),
  $id: `urn:waldo:protocol:responsibility-execution:0.4:${name}`,
  'x-waldo-validation-level': 'structural-plus-runtime-invariants',
});
export function buildResponsibilityExecutionV04Bundle(
  hashHex: (value: string) => string,
): Record<string, string> {
  const digest = `sha256:${hashHex('fixture')}`;
  const manifest = { id: 'manifest_fixture', version: '1.0.0', digest };
  const provider = providerRefV04Schema.parse({
    category: 'provider',
    id: 'provider_fixture',
    version: '1.0.0',
    modelRef: 'model_fixture',
    manifest,
  });
  const environment = executionEnvironmentRefV04Schema.parse({
    category: 'execution_environment',
    id: 'environment_fixture',
    version: '1.0.0',
    environmentKind: 'local',
    manifest,
  });
  const ref = { id: 'aggregate_fixture', revision: 1, digest };
  const request = executionRequestV04Schema.parse({
    protocolVersion: '0.4',
    id: 'execution_request_fixture',
    ownerId: 'owner_fixture',
    outcome: ref,
    workUnit: ref,
    provider,
    environment,
    authorityCeiling: {
      tools: [],
      connectors: [],
      externalEffects: 'none',
      outcomeMutation: 'none',
      evidenceAdmission: 'none',
      verification: 'none',
      acceptance: 'none',
      closure: 'none',
    },
    contextProjectionRef: 'context_fixture',
    contextProjectionDigest: digest,
    cancellationGeneration: 1,
    requestedAt: '2026-08-13T12:00:00.000Z',
  });
  const lease = executionLeaseV04Schema.parse({
    protocolVersion: '0.4',
    id: 'lease_fixture',
    ownerId: 'owner_fixture',
    executionRequestId: request.id,
    attemptId: 'attempt_fixture',
    holder: environment,
    fencingGeneration: 1,
    cancellationGeneration: 1,
    acquiredAt: '2026-08-13T12:00:01.000Z',
    expiresAt: '2026-08-13T12:10:01.000Z',
  });
  const attempt = executionAttemptV04Schema.parse({
    protocolVersion: '0.4',
    id: 'attempt_fixture',
    ownerId: 'owner_fixture',
    executionRequestId: request.id,
    workUnit: ref,
    attemptNumber: 1,
    provider,
    environment,
    leaseId: lease.id,
    fencingGeneration: 1,
    cancellationGeneration: 1,
    state: 'running',
    createdAt: '2026-08-13T12:00:01.000Z',
    updatedAt: '2026-08-13T12:00:02.000Z',
  });
  const session = executionSessionV04Schema.parse({
    protocolVersion: '0.4',
    id: 'session_fixture',
    ownerId: 'owner_fixture',
    attemptId: attempt.id,
    provider,
    environment,
    providerSessionRef: 'provider_session_fixture',
    state: 'active',
    lastObservationSequence: 0,
  });
  const observation = executorObservationV04Schema.parse({
    protocolVersion: '0.4',
    id: 'observation_fixture',
    ownerId: 'owner_fixture',
    attemptId: attempt.id,
    environment,
    leaseId: lease.id,
    fencingGeneration: 1,
    cancellationGeneration: 1,
    sequence: 1,
    kind: 'ended',
    payloadRef: null,
    payloadDigest: null,
    observedAt: '2026-08-13T12:00:03.000Z',
  });
  const reconciliation = executionReconciliationV04Schema.parse({
    protocolVersion: '0.4',
    id: 'reconciliation_fixture',
    ownerId: 'owner_fixture',
    attemptId: attempt.id,
    leaseId: lease.id,
    fencingGeneration: 1,
    cancellationGeneration: 1,
    state: 'indeterminate',
    basisObservationIds: [observation.id],
    checkedAt: '2026-08-13T12:00:04.000Z',
  });
  const cancelRequest = executionCancelRequestV04Schema.parse({
    protocolVersion: '0.4',
    requestId: 'cancel_request_fixture',
    commandType: 'execution.cancel',
    presenceRegistrationId: 'presence_fixture',
    executionRequestId: request.id,
    expectedCancellationGeneration: 1,
    clientIssuedAt: '2026-08-13T12:00:04.000Z',
  });
  const valid = {
    'execution-request.valid.json': request,
    'execution-lease.valid.json': lease,
    'execution-attempt.valid.json': attempt,
    'execution-session.valid.json': session,
    'executor-observation.valid.json': observation,
    'execution-reconciliation.valid.json': reconciliation,
    'execution-cancel-request.valid.json': cancelRequest,
  };
  const bundle: Record<string, string> = {};
  const schemas = {
    'execution-request': executionRequestV04Schema,
    'execution-lease': executionLeaseV04Schema,
    'execution-attempt': executionAttemptV04Schema,
    'execution-session': executionSessionV04Schema,
    'executor-observation': executorObservationV04Schema,
    'execution-reconciliation': executionReconciliationV04Schema,
    'execution-cancel-request': executionCancelRequestV04Schema,
  };
  for (const [name, value] of Object.entries(schemas))
    bundle[`${name}.schema.json`] = file(schema(value, name));
  for (const [path, value] of Object.entries(valid)) bundle[path] = file(value);
  bundle['execution.rejections.json'] = file({
    protocolVersion: '0.4',
    cases: [
      { name: 'provider-environment-confusion', value: { ...request, provider: environment } },
      { name: 'stale-fence-observation', value: { ...observation, fencingGeneration: 2 } },
      {
        name: 'executor-done-closes-outcome',
        value: { ...observation, outcomeState: 'completed' },
      },
      {
        name: 'environment-manifest-drift',
        value: {
          ...observation,
          environment: {
            ...environment,
            manifest: { ...manifest, digest: `sha256:${'e'.repeat(64)}` },
          },
        },
      },
      {
        name: 'expired-lease-observation',
        value: {
          attempt,
          lease,
          observation,
          lastAdmittedSequence: 0,
          receivedAt: lease.expiresAt,
        },
      },
      {
        name: 'replayed-observation',
        value: {
          attempt,
          lease,
          observation,
          lastAdmittedSequence: observation.sequence,
          receivedAt: observation.observedAt,
        },
      },
      {
        name: 'cancel-client-owned-owner',
        value: { ...cancelRequest, ownerId: 'owner_attacker' },
      },
    ],
  });
  bundle['manifest.json'] = file({
    protocolVersion: '0.4',
    family: 'responsibility-execution',
    files: Object.fromEntries(Object.entries(bundle).map(([p, v]) => [p, `sha256:${hashHex(v)}`])),
  });
  return bundle;
}
