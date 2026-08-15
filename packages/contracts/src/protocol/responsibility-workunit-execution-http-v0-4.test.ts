import { describe, expect, it } from 'vitest';
import {
  canonicalizeWorkUnitExecutionStartRequestV04ForDigest,
  matchResponsibilityExecutionHttpRouteV04,
  responsibilityExecutionHttpMediaTypeV04,
  responsibilityExecutionHttpRouteManifestV04,
  workUnitExecutionStartRequestV04Schema,
  workUnitExecutionStartResultV04Schema,
} from './responsibility-workunit-execution-http-v0-4';

const request = {
  protocolVersion: '0.4',
  requestId: 'execution_start_request_01',
  commandType: 'work_unit.start_execution',
  presenceRegistrationId: 'presence_registration_01',
  aggregate: {
    kind: 'work_unit',
    id: 'work_unit_01',
    expectedRevision: 3,
  },
  clientIssuedAt: '2026-08-14T17:00:00.000Z',
} as const;

describe('public WorkUnit execution HTTP v0.4 contract', () => {
  it('publishes one additive start-only route without changing the older manifest', () => {
    expect(responsibilityExecutionHttpMediaTypeV04).toBe(
      'application/vnd.waldo.responsibility.v0.4+json',
    );
    expect(responsibilityExecutionHttpRouteManifestV04).toEqual([{
      id: 'execution_start',
      method: 'POST',
      path: '/public/responsibilities/work-units/executions',
      protocolVersions: ['0.4'],
    }]);
    expect(matchResponsibilityExecutionHttpRouteV04(
      'POST', '/public/responsibilities/work-units/executions',
    )).toEqual(responsibilityExecutionHttpRouteManifestV04[0]);
    expect(matchResponsibilityExecutionHttpRouteV04(
      'POST', '/public/responsibilities/work-units/executions/resume',
    )).toBeNull();
  });

  it('accepts only command identity, presence binding, WorkUnit id, and expected revision', () => {
    expect(workUnitExecutionStartRequestV04Schema.parse(request)).toEqual(request);
    expect(canonicalizeWorkUnitExecutionStartRequestV04ForDigest(request)).toBe(
      canonicalizeWorkUnitExecutionStartRequestV04ForDigest({
        clientIssuedAt: request.clientIssuedAt,
        aggregate: request.aggregate,
        presenceRegistrationId: request.presenceRegistrationId,
        commandType: request.commandType,
        requestId: request.requestId,
        protocolVersion: request.protocolVersion,
      }),
    );
    for (const hostile of [
      { ownerId: 'owner_attacker' },
      { outcomeId: 'outcome_attacker' },
      { provider: { id: 'provider_attacker' } },
      { environment: { id: 'environment_attacker' } },
      { authorityCeiling: { tools: ['shell'] } },
      { operationIntent: { ref: 'intent_attacker' } },
      { leaseId: 'lease_attacker' },
      { payload: { prompt: 'private prompt' } },
    ]) {
      expect(workUnitExecutionStartRequestV04Schema.safeParse({
        ...request,
        ...hostile,
      }).success).toBe(false);
    }
    expect(workUnitExecutionStartRequestV04Schema.safeParse({
      ...request,
      aggregate: { ...request.aggregate, expectedRevision: 0 },
    }).success).toBe(false);
  });

  it('returns bounded execution state without provider, environment, authority, or closure truth', () => {
    const started = {
      protocolVersion: '0.4',
      requestId: request.requestId,
      workUnit: { id: request.aggregate.id, revision: 3 },
      executionRequestId: 'execution_request_server_01',
      attemptId: 'execution_attempt_server_01',
      status: 'started',
      observation: { id: 'execution_observation_server_01', sequence: 1, kind: 'started' },
    } as const;
    const indeterminate = {
      ...started,
      status: 'indeterminate',
      observation: null,
    } as const;
    expect(workUnitExecutionStartResultV04Schema.parse(started)).toEqual(started);
    expect(workUnitExecutionStartResultV04Schema.parse(indeterminate)).toEqual(indeterminate);
    expect(workUnitExecutionStartResultV04Schema.safeParse({
      ...started,
      outcomeCompleted: true,
    }).success).toBe(false);
    expect(workUnitExecutionStartResultV04Schema.safeParse({
      ...started,
      provider: { id: 'provider_private' },
    }).success).toBe(false);
  });
});
