import { z } from 'zod';
import { ROSTER_REFS } from '../model/roster';
import {
  canonicalizeWorkUnitPlanningTurnRequestV03ForDigest,
  workUnitPlanningCancelRequestV03Schema,
  workUnitPlanningCancelResultV03Schema,
  emptyPlanningCapabilityManifestV03Schema,
  workUnitPlanningAuthorityCeilingV03Schema,
  workUnitPlanningProjectionPageV03Schema,
  workUnitPlanningTurnRequestV03Schema,
  workUnitPlanningTurnResultV03Schema,
  workUnitPlanningTurnTrustedEnvelopeV03Schema,
} from './responsibility-planning-turn-v0-3';

type HashHex = (input: string) => string;
const file = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const schema = (value: z.ZodType, name: string) => ({
  ...(z.toJSONSchema(value, { target: 'draft-2020-12', io: 'input', reused: 'ref' }) as object),
  $id: `urn:waldo:protocol:responsibility-planning-turn:0.3:${name}`,
  'x-waldo-validation-level': 'structural-plus-runtime-invariants',
  'x-waldo-offline-commands': 'none',
});

export function buildResponsibilityPlanningTurnV03Bundle(hashHex: HashHex): Record<string, string> {
  const content = 'Fixture: release notes are ready for review.';
  const request = workUnitPlanningTurnRequestV03Schema.parse({
    protocolVersion: '0.3', requestId: 'planning_fixture_01',
    commandType: 'work_unit.request_planning_turn',
    presenceRegistrationId: 'presence_registration_01',
    aggregate: { kind: 'work_unit', id: 'work_unit_01', expectedRevision: 1 },
    clientIssuedAt: '2026-08-07T08:00:00.000Z',
    payload: { governedInputs: [{
      ref: 'fixture_release_notes', digest: `sha256:${hashHex(content)}`, content,
    }] },
  });
  const manifest = emptyPlanningCapabilityManifestV03Schema.parse({
    schemaVersion: '0.3', tools: [], connectors: [], filesystem: 'none', shell: 'none',
    network: 'none', externalEffects: 'none',
  });
  const manifestDigest = `sha256:${hashHex(JSON.stringify(manifest))}`;
  const provider = {
    adapterId: 'runtime_llm_provider', adapterVersion: '1.0.0',
    modelRef: ROSTER_REFS.primary,
    capabilityManifest: { id: 'planning_provider_empty_v1', revision: 1, digest: manifestDigest },
  };
  const authority = workUnitPlanningAuthorityCeilingV03Schema.parse({
    providerPlanningTurns: 1, tools: 'none', connectors: 'none', externalEffects: 'none',
    outcomeMutation: 'none', evidence: 'none', verification: 'none', acceptance: 'none',
    closure: 'none',
  });
  const trusted = workUnitPlanningTurnTrustedEnvelopeV03Schema.parse({
    protocolVersion: '0.3', commandId: 'command_planning_fixture_01',
    commandType: request.commandType, ownerId: 'owner_fixture_01',
    actor: { kind: 'presence', id: 'presence_01' }, presenceId: 'presence_01',
    authenticatedSessionId: 'authenticated_session_fixture_01', ownerPolicyRevision: 1,
    authAssurance: 'verified_session', ownerRootRoutingVersion: 2,
    aggregate: request.aggregate,
    requestDigest: `sha256:${hashHex(canonicalizeWorkUnitPlanningTurnRequestV03ForDigest(request))}`,
    correlationId: 'correlation_planning_fixture_01', receivedAt: '2026-08-07T08:00:01.000Z',
    provider,
    executor: {
      executorId: 'run_loop_planning_executor', executorVersion: '1.0.0',
      capabilityManifest: { id: 'planning_executor_empty_v1', revision: 1, digest: manifestDigest },
    },
    capabilityManifest: manifest, authorityCeiling: authority,
    payload: { governedInputs: request.payload.governedInputs.map(({ ref, digest }) => ({ ref, digest })) },
  });
  const candidatePlan = {
    summary: 'Prepare a reviewable product update plan without publishing it.',
    proposedSteps: ['Draft the update from the supplied fixture.', 'Present it for review.'],
    openQuestions: ['Who is the primary audience?'],
    constraints: ['Do not publish or perform an external effect.'],
  };
  const result = workUnitPlanningTurnResultV03Schema.parse({
    protocolVersion: '0.3', ownerId: trusted.ownerId, requestId: request.requestId,
    outcomeId: 'outcome_01', workUnitId: request.aggregate.id, workUnitRevision: 2,
    workUnitState: 'planning_authorized', executionRequestId: 'execution_request_01',
    agentSessionId: 'agent_session_01', sessionStatus: 'completed',
    providerInvocation: {
      executionRequestId: 'execution_request_01', invocationKey: `sha256:${'a'.repeat(64)}`,
      provider, status: 'completed',
      resultDigest: `sha256:${hashHex(JSON.stringify(candidatePlan))}`,
      startedAt: '2026-08-07T08:00:02.000Z', completedAt: '2026-08-07T08:00:03.000Z',
    },
    candidatePlan, projectionCursor: 6,
  });
  const cancellationRequest = workUnitPlanningCancelRequestV03Schema.parse({
    protocolVersion: '0.3', requestId: 'planning_cancel_fixture_01',
    commandType: 'work_unit.cancel_planning_turn',
    presenceRegistrationId: 'presence_registration_01',
    executionRequestId: 'execution_request_01', expectedCancellationGeneration: 0,
    clientIssuedAt: '2026-08-07T08:00:03.000Z',
  });
  const cancellationResult = workUnitPlanningCancelResultV03Schema.parse({
    protocolVersion: '0.3', ownerId: trusted.ownerId, requestId: cancellationRequest.requestId,
    executionRequestId: cancellationRequest.executionRequestId, status: 'cancelled',
    cancellationGeneration: 1, projectionCursor: 5,
    cancelledAt: '2026-08-07T08:00:04.000Z',
  });
  const projection = workUnitPlanningProjectionPageV03Schema.parse({
    protocolVersion: '0.3', ownerId: trusted.ownerId,
    projectionName: 'work_unit.planning_activity', snapshotId: 'snapshot_01',
    snapshotBaseCursor: 0, fromExclusiveCursor: 0, highWaterCursor: 6, nextCursor: 6,
    items: [{
      cursor: 6, itemType: 'work_unit_candidate_plan', outcomeId: result.outcomeId,
      workUnitId: result.workUnitId, executionRequestId: result.executionRequestId,
      agentSessionId: result.agentSessionId, resultDigest: result.providerInvocation.resultDigest,
      candidatePlan, createdAt: result.providerInvocation.completedAt,
    }],
    hasMore: false, generatedAt: '2026-08-07T08:00:04.000Z',
  });
  const files: Record<string, string> = {
    'planning-turn-request.schema.json': file(schema(workUnitPlanningTurnRequestV03Schema, 'request')),
    'planning-turn-request.valid.json': file(request),
    'planning-turn-trusted-envelope.schema.json': file(schema(workUnitPlanningTurnTrustedEnvelopeV03Schema, 'trusted-envelope')),
    'planning-turn-trusted-envelope.valid.json': file(trusted),
    'planning-turn-result.schema.json': file(schema(workUnitPlanningTurnResultV03Schema, 'result')),
    'planning-turn-result.valid.json': file(result),
    'planning-cancel-request.schema.json': file(schema(workUnitPlanningCancelRequestV03Schema, 'cancel-request')),
    'planning-cancel-request.valid.json': file(cancellationRequest),
    'planning-cancel-result.schema.json': file(schema(workUnitPlanningCancelResultV03Schema, 'cancel-result')),
    'planning-cancel-result.valid.json': file(cancellationResult),
    'planning-projection-page.schema.json': file(schema(workUnitPlanningProjectionPageV03Schema, 'projection-page')),
    'planning-projection-page.valid.json': file(projection),
    'planning-turn.rejections.json': file({ protocolVersion: '0.3', cases: [
      { name: 'client-owned-provider', value: { ...request, provider: { modelRef: 'attacker' } } },
      { name: 'stale-revision', value: { ...request, aggregate: { ...request.aggregate, expectedRevision: 2 } } },
      { name: 'non-empty-tools', value: { ...trusted, capabilityManifest: { ...manifest, tools: ['shell'] } } },
      { name: 'schema-invalid-candidate', value: { summary: 42, proposedSteps: [] } },
    ] }),
  };
  return {
    ...files,
    'manifest.json': file({
      protocolName: 'responsibility-planning-turn', protocolVersion: '0.3',
      mediaType: 'application/vnd.waldo.responsibility.v0.3+json',
      offlineCommands: 'none', proofLevel: 'adapter_conformance_fixture',
      files: Object.keys(files).sort().map((path) => ({ path, sha256: `sha256:${hashHex(files[path]!)}` })),
    }),
  };
}
