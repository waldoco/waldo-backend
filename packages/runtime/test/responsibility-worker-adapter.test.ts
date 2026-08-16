import { describe, expect, it } from 'vitest';
import { ROSTER_REFS } from '@waldo/contracts';
import worker, { responsibilityEdgeRateKey } from '../src/index';
import {
  ResponsibilityAuthorityDeniedError,
  ResponsibilityDigestConflictError,
  ResponsibilityOwnerRootMismatchError,
  ResponsibilityPlanningConflictError,
  ResponsibilityProjectionCursorError,
  ResponsibilityProjectionMissingError,
} from '../src/responsibility/errors';
import { parseResponsibilityJsonBytes } from '../src/responsibility/raw-json';
import {
  createResponsibilityWorkerAdapter,
  type ResponsibilityAuthority,
  type ResponsibilityOwnerRoot,
  type TrustedResponsibilityContext,
} from '../src/responsibility/worker-adapter';

const trustedContext: TrustedResponsibilityContext = Object.freeze({
  ownerId: 'owner_server_01',
  authenticatedSubjectRef: `supabase_subject_${'a'.repeat(64)}`,
  actor: { kind: 'presence' as const, id: 'presence_server_01' },
  presenceId: 'presence_server_01',
  presenceRegistrationId: 'presence_registration_01',
  authenticatedSessionId: 'authenticated_session_01',
  authenticatedSessionExpiresAt: '2026-08-06T13:00:00.000Z',
  ownerPolicyRevision: 7,
  authAssurance: 'supabase_verified_session',
  ownerRootRoutingVersion: 2,
});

const captureBody = {
  protocolVersion: '0.2',
  requestId: 'request_capture_01',
  commandType: 'responsibility.capture',
  presenceRegistrationId: 'presence_registration_01',
  clientIssuedAt: '2026-08-06T12:00:00.000Z',
  payload: { userStatement: 'Prepare a reviewable update, but do not publish it.' },
};

function request(body: string | object, headers: Record<string, string> = {}): Request {
  return new Request('https://api.heywaldo.com/public/responsibilities', {
    method: 'POST',
    headers: {
      authorization: 'Bearer session-token',
      accept: 'application/vnd.waldo.responsibility.v0.2+json',
      'content-type': 'application/vnd.waldo.responsibility.v0.2+json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function planningRequest(body: string | object): Request {
  return new Request('https://api.heywaldo.com/public/responsibilities/planning-turns', {
    method: 'POST',
    headers: {
      authorization: 'Bearer session-token',
      accept: 'application/vnd.waldo.responsibility.v0.3+json',
      'content-type': 'application/vnd.waldo.responsibility.v0.3+json',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function planningCancelRequest(body: string | object): Request {
  return new Request('https://api.heywaldo.com/public/responsibilities/planning-turns/cancel', {
    method: 'POST',
    headers: {
      authorization: 'Bearer session-token',
      accept: 'application/vnd.waldo.responsibility.v0.3+json',
      'content-type': 'application/vnd.waldo.responsibility.v0.3+json',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function executionStartRequest(body: string | object): Request {
  return new Request('https://api.heywaldo.com/public/responsibilities/work-units/executions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer session-token',
      accept: 'application/vnd.waldo.responsibility.v0.4+json',
      'content-type': 'application/vnd.waldo.responsibility.v0.4+json',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function judgmentAnswerRequest(body: string | object): Request {
  return new Request('https://api.heywaldo.com/public/responsibilities/judgments/answers', {
    method: 'POST',
    headers: {
      authorization: 'Bearer session-token',
      accept: 'application/vnd.waldo.responsibility.v0.5+json',
      'content-type': 'application/vnd.waldo.responsibility.v0.5+json',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function judgmentProjectionRequest(search = 'fromExclusiveCursor=0&limit=25'): Request {
  return new Request(
    `https://api.heywaldo.com/public/responsibilities/judgments/projection?${search}`,
    {
      method: 'GET',
      headers: {
        authorization: 'Bearer session-token',
        accept: 'application/vnd.waldo.responsibility.v0.5+json',
      },
    },
  );
}

function harness(options: {
  authority?: ResponsibilityAuthority;
  ownerRoot?: ResponsibilityOwnerRoot;
} = {}) {
  const calls: Array<{ ownerId: string; input: unknown }> = [];
  const failures: string[] = [];
  let ownerRootCalls = 0;
  const ownerRoot = options.ownerRoot ?? {
    async capture(input) {
      calls.push({ ownerId: trustedContext.ownerId, input });
      return {
        protocolVersion: '0.2', ownerId: trustedContext.ownerId,
        requestId: captureBody.requestId,
        outcome: {
          id: 'outcome_01', ownerId: trustedContext.ownerId, revision: 1,
          userStatement: captureBody.payload.userStatement, state: 'captured',
          createdAt: '2026-08-06T12:00:01.000Z', updatedAt: '2026-08-06T12:00:01.000Z',
        },
        mission: null, workUnits: [], projectionCursor: 1,
      };
    },
    async readProjection() {
      throw new Error('not used');
    },
  } satisfies ResponsibilityOwnerRoot;
  const adapter = createResponsibilityWorkerAdapter({
    authority: options.authority ?? { authenticate: async () => trustedContext },
    edgeRateLimit: { admit: async () => true },
    failureReporter: { report: (kind) => { failures.push(kind); } },
    ownerRootFor: async (context) => {
      ownerRootCalls += 1;
      expect(context).toEqual(trustedContext);
      return ownerRoot;
    },
    now: () => '2026-08-06T12:00:01.000Z',
    newId: (kind) => `${kind}_server_01`,
  });
  return { adapter, calls, failures, ownerRootCalls: () => ownerRootCalls };
}

describe('responsibility Worker adapter', () => {
  it('admits only the strict authenticated v0.5 JudgmentAnswer surface', async () => {
    const body = {
      protocolVersion: '0.5',
      requestId: 'answer_judgment_public_01',
      commandType: 'judgment.answer',
      presenceRegistrationId: trustedContext.presenceRegistrationId,
      aggregate: { kind: 'judgment_request', id: 'judgment_request_01', expectedRevision: 1 },
      clientIssuedAt: '2026-08-06T12:00:00.000Z',
      payload: {
        selectedOptionId: 'option_refuse',
        displayedRequestDigest: `sha256:${'a'.repeat(64)}`,
      },
    } as const;
    let admitted: unknown;
    const ownerRoot: ResponsibilityOwnerRoot = {
      async capture() { throw new Error('not used'); },
      async readProjection() { throw new Error('not used'); },
      async answerJudgment(input) {
        admitted = input;
        return {
          protocolVersion: '0.5',
          requestId: body.requestId,
          judgmentRequest: { id: body.aggregate.id, revision: 2 },
          judgmentDecision: { id: 'judgment_decision_01', revision: 1 },
          selectedOptionId: body.payload.selectedOptionId,
          projectionCursor: 4,
          authorityDisposition: 'refused',
        };
      },
    };
    const { adapter } = harness({ ownerRoot });
    const response = await adapter.fetch(judgmentAnswerRequest(body));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'application/vnd.waldo.responsibility.v0.5+json; charset=utf-8',
    );
    expect(admitted).toEqual({ routedOwnerId: trustedContext.ownerId, request: body });

    const smuggled = await adapter.fetch(judgmentAnswerRequest({
      ...body,
      ownerId: 'owner_attacker',
      actor: { kind: 'owner', id: 'owner_attacker' },
      grantee: { kind: 'service', id: 'attacker' },
    }));
    expect(smuggled.status).toBe(400);
  });

  it('reads only the bounded authenticated v0.5 Needs You projection query', async () => {
    let admitted: unknown;
    const ownerRoot: ResponsibilityOwnerRoot = {
      async capture() { throw new Error('not used'); },
      async readProjection() { throw new Error('not used'); },
      async readJudgmentProjection(input) {
        admitted = input;
        return {
          protocolVersion: '0.5',
          ownerId: trustedContext.ownerId,
          projectionName: 'judgment.needs_you',
          snapshotId: 'judgment_snapshot_01',
          snapshotBaseCursor: 0,
          fromExclusiveCursor: 0,
          highWaterCursor: 0,
          nextCursor: 0,
          items: [],
          hasMore: false,
          generatedAt: '2026-08-06T12:00:01.000Z',
        };
      },
    };
    const { adapter } = harness({ ownerRoot });
    const response = await adapter.fetch(judgmentProjectionRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'application/vnd.waldo.responsibility.v0.5+json; charset=utf-8',
    );
    expect(admitted).toEqual({
      routedOwnerId: trustedContext.ownerId,
      query: { protocolVersion: '0.5', fromExclusiveCursor: 0, limit: 25 },
    });
    expect((await adapter.fetch(judgmentProjectionRequest(
      'fromExclusiveCursor=0&limit=25&ownerId=owner_attacker',
    ))).status).toBe(400);
  });

  it('admits one bounded execution start command without caller-owned authority', async () => {
    const body = {
      protocolVersion: '0.4',
      requestId: 'execution_start_request_01',
      commandType: 'work_unit.start_execution',
      presenceRegistrationId: trustedContext.presenceRegistrationId,
      aggregate: { kind: 'work_unit', id: 'work_unit_01', expectedRevision: 3 },
      clientIssuedAt: '2026-08-06T12:00:00.000Z',
    };
    let admitted: unknown;
    const ownerRoot: ResponsibilityOwnerRoot = {
      async capture() { throw new Error('not used'); },
      async readProjection() { throw new Error('not used'); },
      async startExecution(input) {
        admitted = input;
        return {
          protocolVersion: '0.4',
          requestId: body.requestId,
          workUnit: { id: body.aggregate.id, revision: body.aggregate.expectedRevision },
          executionRequestId: 'execution_request_server_01',
          attemptId: 'execution_attempt_server_01',
          status: 'started',
          observation: {
            id: 'execution_observation_server_01', sequence: 1, kind: 'started',
          },
        };
      },
    };
    const { adapter } = harness({ ownerRoot });
    const response = await adapter.fetch(executionStartRequest(body));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'application/vnd.waldo.responsibility.v0.4+json; charset=utf-8',
    );
    expect(await response.json()).toMatchObject({
      requestId: body.requestId,
      executionRequestId: 'execution_request_server_01',
      status: 'started',
    });
    expect(admitted).toEqual({ routedOwnerId: trustedContext.ownerId, request: body });

    for (const hostile of [
      { ownerId: 'owner_attacker' },
      { provider: { id: 'provider_attacker' } },
      { operationIntent: { ref: 'intent_attacker' } },
      { leaseId: 'lease_attacker' },
      { payload: { prompt: 'private prompt' } },
    ]) {
      const rejected = await adapter.fetch(executionStartRequest({ ...body, ...hostile }));
      expect(rejected.status).toBe(400);
    }
  });

  it('exposes authenticated idempotent planning cancellation without client-owned authority', async () => {
    const body = {
      protocolVersion: '0.3', requestId: 'planning_cancel_01',
      commandType: 'work_unit.cancel_planning_turn',
      presenceRegistrationId: trustedContext.presenceRegistrationId,
      executionRequestId: 'execution_request_01', expectedCancellationGeneration: 0,
      clientIssuedAt: '2026-08-07T08:00:00.000Z',
    };
    let admitted: unknown;
    const ownerRoot: ResponsibilityOwnerRoot = {
      async capture() { throw new Error('not used'); },
      async readProjection() { throw new Error('not used'); },
      async cancelPlanning(input) {
        admitted = input;
        return {
          protocolVersion: '0.3', ownerId: trustedContext.ownerId,
          requestId: body.requestId, executionRequestId: body.executionRequestId,
          status: 'cancelled', cancellationGeneration: 1, projectionCursor: 3,
          cancelledAt: '2026-08-07T08:00:01.000Z',
        };
      },
    };
    const { adapter } = harness({ ownerRoot });
    const response = await adapter.fetch(planningCancelRequest(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ownerId: trustedContext.ownerId, status: 'cancelled', cancellationGeneration: 1,
    });
    expect(admitted).toEqual({ routedOwnerId: trustedContext.ownerId, request: body });
    const smuggled = await adapter.fetch(planningCancelRequest({
      ...body, ownerId: 'owner_attacker', provider: { modelRef: 'attacker' },
    }));
    expect(smuggled.status).toBe(400);
  });

  it('derives all planning execution authority server-side and returns only a validated v0.3 result', async () => {
    const governedContent = 'Bounded release fixture.';
    const contentDigest = await crypto.subtle.digest(
      'SHA-256', new TextEncoder().encode(governedContent),
    );
    const digest = `sha256:${Array.from(new Uint8Array(contentDigest), (byte) =>
      byte.toString(16).padStart(2, '0')).join('')}`;
    const body = {
      protocolVersion: '0.3', requestId: 'planning_request_01',
      commandType: 'work_unit.request_planning_turn',
      presenceRegistrationId: trustedContext.presenceRegistrationId,
      aggregate: { kind: 'work_unit', id: 'work_unit_01', expectedRevision: 1 },
      clientIssuedAt: '2026-08-06T12:00:00.000Z',
      payload: { governedInputs: [{ ref: 'fixture_release', digest, content: governedContent }] },
    };
    let admitted: any;
    const result = {
      protocolVersion: '0.3', ownerId: trustedContext.ownerId,
      requestId: body.requestId, outcomeId: 'outcome_01', workUnitId: 'work_unit_01',
      workUnitRevision: 2, workUnitState: 'planning_authorized',
      executionRequestId: 'execution_request_01', agentSessionId: 'agent_session_01',
      sessionStatus: 'completed',
      providerInvocation: {
        executionRequestId: 'execution_request_01', invocationKey: `sha256:${'c'.repeat(64)}`,
        provider: {
          adapterId: 'runtime_llm_provider', adapterVersion: '1.0.0',
          modelRef: ROSTER_REFS.primary,
          capabilityManifest: {
            id: 'planning_provider_empty_v1', revision: 1, digest: `sha256:${'d'.repeat(64)}`,
          },
        },
        status: 'completed', resultDigest: `sha256:${'e'.repeat(64)}`,
        startedAt: '2026-08-06T12:00:01.000Z', completedAt: '2026-08-06T12:00:02.000Z',
      },
      candidatePlan: {
        summary: 'Prepare a reviewable update plan.', proposedSteps: ['Draft it.'],
        openQuestions: [], constraints: ['Do not publish.'],
      },
      projectionCursor: 4,
    };
    let returnedResult: any;
    const ownerRoot: ResponsibilityOwnerRoot = {
      async capture() { throw new Error('not used'); },
      async readProjection() { throw new Error('not used'); },
      async plan(input) {
        admitted = input;
        returnedResult = {
          ...result,
          providerInvocation: {
            ...result.providerInvocation,
            provider: (input.trustedEnvelope as any).provider,
          },
        };
        return returnedResult;
      },
    };
    const { adapter } = harness({ ownerRoot });
    const response = await adapter.fetch(planningRequest(body));
    expect(response.status).toBe(200);
    expect(response.headers.get('waldo-protocol-version')).toBe('0.3');
    expect(await response.json()).toEqual(returnedResult);
    expect(admitted.trustedEnvelope).toMatchObject({
      ownerId: trustedContext.ownerId,
      authenticatedSessionId: trustedContext.authenticatedSessionId,
      aggregate: body.aggregate,
      capabilityManifest: { tools: [], connectors: [], externalEffects: 'none' },
      authorityCeiling: {
        providerPlanningTurns: 1, tools: 'none', connectors: 'none',
        externalEffects: 'none', outcomeMutation: 'none', verification: 'none',
        acceptance: 'none', closure: 'none',
      },
      provider: { modelRef: ROSTER_REFS.primary },
      executor: { executorId: 'run_loop_planning_executor' },
      payload: { governedInputs: [{ ref: 'fixture_release', digest }] },
    });
    expect(JSON.stringify(admitted.trustedEnvelope)).not.toContain(governedContent);

    const smuggled = await adapter.fetch(planningRequest({
      ...body, provider: { modelRef: 'evil' },
    }));
    expect(smuggled.status).toBe(400);
  });

  it('maps a planning idempotency digest mismatch to a content-free 409', async () => {
    const governedContent = 'Bounded fixture.';
    const digestBytes = await crypto.subtle.digest(
      'SHA-256', new TextEncoder().encode(governedContent),
    );
    const body = {
      protocolVersion: '0.3', requestId: 'planning_digest_conflict_01',
      commandType: 'work_unit.request_planning_turn',
      presenceRegistrationId: trustedContext.presenceRegistrationId,
      aggregate: { kind: 'work_unit', id: 'work_unit_01', expectedRevision: 1 },
      clientIssuedAt: '2026-08-07T08:00:00.000Z',
      payload: { governedInputs: [{
        ref: 'fixture_digest_conflict',
        digest: `sha256:${Array.from(new Uint8Array(digestBytes), (byte) =>
          byte.toString(16).padStart(2, '0')).join('')}`,
        content: governedContent,
      }] },
    };
    const ownerRoot: ResponsibilityOwnerRoot = {
      async capture() { throw new Error('not used'); },
      async readProjection() { throw new Error('not used'); },
      async plan() { throw new ResponsibilityDigestConflictError(); },
    };
    const response = await harness({ ownerRoot }).adapter.fetch(planningRequest(body));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      type: 'https://api.heywaldo.com/problems/request-conflict',
      title: 'Request conflict', status: 409, code: 'request_conflict',
    });
  });

  it.each([
    {
      name: 'unknown WorkUnit', operation: 'plan' as const,
      error: new ResponsibilityProjectionMissingError(), status: 404,
    },
    {
      name: 'unsupported WorkUnit capabilities', operation: 'plan' as const,
      error: new ResponsibilityPlanningConflictError('unsupported capabilities'), status: 409,
    },
    {
      name: 'unknown planning execution', operation: 'cancel' as const,
      error: new ResponsibilityPlanningConflictError('unknown planning execution'), status: 409,
    },
  ])('maps $name to a bounded client error without failure amplification', async ({
    operation, error, status,
  }) => {
    const content = 'Bounded fixture.';
    const digestBytes = await crypto.subtle.digest(
      'SHA-256', new TextEncoder().encode(content),
    );
    const digest = `sha256:${Array.from(new Uint8Array(digestBytes), (byte) =>
      byte.toString(16).padStart(2, '0')).join('')}`;
    const ownerRoot: ResponsibilityOwnerRoot = {
      async capture() { throw new Error('not used'); },
      async readProjection() { throw new Error('not used'); },
      async plan() { throw error; },
      async cancelPlanning() { throw error; },
    };
    const { adapter, failures } = harness({ ownerRoot });
    const response = await adapter.fetch(operation === 'plan'
      ? planningRequest({
        protocolVersion: '0.3', requestId: `planning_${operation}_client_error_01`,
        commandType: 'work_unit.request_planning_turn',
        presenceRegistrationId: trustedContext.presenceRegistrationId,
        aggregate: { kind: 'work_unit', id: 'work_unit_unknown', expectedRevision: 1 },
        clientIssuedAt: '2026-08-07T08:00:00.000Z',
        payload: { governedInputs: [{ ref: 'fixture', digest, content }] },
      })
      : planningCancelRequest({
        protocolVersion: '0.3', requestId: `planning_${operation}_client_error_01`,
        commandType: 'work_unit.cancel_planning_turn',
        presenceRegistrationId: trustedContext.presenceRegistrationId,
        executionRequestId: 'execution_request_unknown',
        expectedCancellationGeneration: 0,
        clientIssuedAt: '2026-08-07T08:00:00.000Z',
      }));

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ status });
    expect(failures).toEqual([]);
  });
  it('keeps the production route behind an explicit fail-closed deployment switch', async () => {
    const disabled = await worker.fetch(request(captureBody), {} as Cloudflare.Env);
    expect(disabled.status).toBe(404);
    expect(disabled.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(disabled.headers.get('cache-control')).toBe('no-store');
    expect(disabled.headers.get('vary')).toBe('Authorization, Accept');
    expect(await disabled.text()).toBe('not found');
    const unconfigured = await worker.fetch(request(captureBody), {
      RESPONSIBILITY_PUBLIC_API_ENABLED: 'true',
    } as Cloudflare.Env);
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.headers.get('vary')).toBe('Authorization, Accept');
  });

  it('applies the edge rate limit before body parsing or authentication', async () => {
    let authCalls = 0;
    const adapter = createResponsibilityWorkerAdapter({
      authority: { authenticate: async () => { authCalls += 1; return trustedContext; } },
      edgeRateLimit: { admit: async () => false },
      failureReporter: { report: () => undefined },
      ownerRootFor: async () => { throw new Error('must not route'); },
      now: () => '2026-08-06T12:00:01.000Z',
      newId: (kind) => `${kind}_server_01`,
    });
    const response = await adapter.fetch(request('{invalid-json'));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(authCalls).toBe(0);
  });

  it('does not let rotating invalid credentials bypass the trusted edge-source bucket', async () => {
    const first = await responsibilityEdgeRateKey(new Request('https://api.heywaldo.com', {
      headers: { authorization: 'Bearer attacker-token-one', 'cf-connecting-ip': '203.0.113.7' },
    }));
    const second = await responsibilityEdgeRateKey(new Request('https://api.heywaldo.com', {
      headers: { authorization: 'Bearer attacker-token-two', 'cf-connecting-ip': '203.0.113.7' },
    }));
    expect(second).toBe(first);
    await expect(responsibilityEdgeRateKey(new Request('https://api.heywaldo.com')))
      .rejects.toThrow('edge source unavailable');
  });

  it('derives every trusted envelope field from authenticated server context', async () => {
    const { adapter, calls } = harness();
    const response = await adapter.fetch(request(captureBody));

    expect(response.status).toBe(201);
    expect(response.headers.get('waldo-protocol-version')).toBe('0.2');
    expect(await response.json()).toMatchObject({ ownerId: trustedContext.ownerId });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({
      routedOwnerId: trustedContext.ownerId,
      trustedEnvelope: {
        ownerId: trustedContext.ownerId,
        actor: trustedContext.actor,
        presenceId: trustedContext.presenceId,
        authenticatedSessionId: trustedContext.authenticatedSessionId,
        ownerPolicyRevision: trustedContext.ownerPolicyRevision,
        ownerRootRoutingVersion: trustedContext.ownerRootRoutingVersion,
        payload: captureBody.payload,
      },
    });
  });

  it('keeps released v0.1 capture version-pinned without downgrading v0.2', async () => {
    const admissions: unknown[] = [];
    const ownerRoot: ResponsibilityOwnerRoot = {
      async capture(input) {
        admissions.push(input);
        return {
          protocolVersion: '0.1', ownerId: trustedContext.ownerId,
          requestId: captureBody.requestId,
          outcome: {
            id: 'outcome_01', ownerId: trustedContext.ownerId, revision: 1,
            userStatement: captureBody.payload.userStatement, state: 'captured',
            createdAt: '2026-08-06T12:00:01.000Z', updatedAt: '2026-08-06T12:00:01.000Z',
          },
          mission: null, workUnits: [], projectionCursor: 1,
        };
      },
      async readProjection() { throw new Error('not used'); },
    };
    const { adapter } = harness({ ownerRoot });
    const response = await adapter.fetch(request({ ...captureBody, protocolVersion: '0.1' }, {
      accept: 'application/vnd.waldo.responsibility.v0.1+json',
      'content-type': 'application/vnd.waldo.responsibility.v0.1+json',
    }));
    expect(response.status).toBe(201);
    expect(response.headers.get('waldo-protocol-version')).toBe('0.1');
    expect(admissions).toEqual([expect.objectContaining({
      trustedEnvelope: expect.objectContaining({ protocolVersion: '0.1' }),
    })]);
  });

  it('validates the owner-root RPC response before public serialization', async () => {
    const ownerRoot: ResponsibilityOwnerRoot = {
      async capture() {
        return { protocolVersion: '0.2', ownerId: trustedContext.ownerId, secret: 'leak' };
      },
      async readProjection() { throw new Error('not used'); },
    };
    const { adapter } = harness({ ownerRoot });
    const response = await adapter.fetch(request(captureBody));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('secret');
  });

  it('maps digest conflicts, stale cursors, and unbound owners without leaking internals', async () => {
    const cases: Array<{ ownerRoot: ResponsibilityOwnerRoot; request: Request; status: number }> = [
      {
        ownerRoot: {
          async capture() { throw new ResponsibilityDigestConflictError(); },
          async readProjection() { throw new Error('not used'); },
        },
        request: request(captureBody), status: 409,
      },
      {
        ownerRoot: {
          async capture() { throw new Error('not used'); },
          async readProjection() { throw new ResponsibilityProjectionCursorError('cursor_ahead'); },
        },
        request: new Request(
          'https://api.heywaldo.com/public/responsibilities/projection?fromExclusiveCursor=1&limit=25&snapshotId=snapshot_01',
          { headers: { authorization: 'Bearer session-token', accept: 'application/vnd.waldo.responsibility.v0.2+json' } },
        ), status: 409,
      },
      {
        ownerRoot: {
          async capture() { throw new Error('not used'); },
          async readProjection() { throw new ResponsibilityOwnerRootMismatchError(); },
        },
        request: new Request(
          'https://api.heywaldo.com/public/responsibilities/projection?fromExclusiveCursor=0&limit=25',
          { headers: { authorization: 'Bearer session-token', accept: 'application/vnd.waldo.responsibility.v0.2+json' } },
        ), status: 404,
      },
    ];
    for (const entry of cases) {
      const { adapter } = harness({ ownerRoot: entry.ownerRoot });
      const response = await adapter.fetch(entry.request);
      expect(response.status).toBe(entry.status);
      expect(JSON.stringify(await response.json())).not.toContain('secret');
    }
  });

  it('preserves exact retry and rejects a changed digest at the HTTP seam', async () => {
    let storedDigest: string | null = null;
    const result = {
      protocolVersion: '0.2', ownerId: trustedContext.ownerId,
      requestId: captureBody.requestId,
      outcome: {
        id: 'outcome_01', ownerId: trustedContext.ownerId, revision: 1,
        userStatement: captureBody.payload.userStatement, state: 'captured',
        createdAt: '2026-08-06T12:00:01.000Z', updatedAt: '2026-08-06T12:00:01.000Z',
      }, mission: null, workUnits: [], projectionCursor: 1,
    };
    const ownerRoot: ResponsibilityOwnerRoot = {
      async capture(input) {
        const digest = (input.trustedEnvelope as { requestDigest: string }).requestDigest;
        if (storedDigest !== null && digest !== storedDigest) {
          throw new ResponsibilityDigestConflictError();
        }
        storedDigest = digest;
        return result;
      },
      async readProjection() { throw new Error('not used'); },
    };
    const { adapter } = harness({ ownerRoot });
    const first = await adapter.fetch(request(captureBody));
    expect(first.status).toBe(201);
    await first.text();
    const retry = await adapter.fetch(request(captureBody));
    expect(retry.status).toBe(201);
    await retry.text();
    const conflict = await adapter.fetch(request({
      ...captureBody,
      payload: { userStatement: 'A changed statement under the same request ID.' },
    }));
    expect(conflict.status).toBe(409);
    await conflict.text();
  });

  it.each([
    ['top-level duplicate', '{"protocolVersion":"0.2","protocolVersion":"0.1"}'],
    ['nested duplicate', '{"protocolVersion":"0.2","payload":{"userStatement":"a","userStatement":"b"}}'],
    ['escaped-equivalent duplicate', '{"protocolVersion":"0.2","payload":{"ownerId":"a","\\u006fwnerId":"b"}}'],
    ['unpaired surrogate', JSON.stringify(captureBody).replace('Prepare', '\\ud800Prepare')],
    ['terminal unpaired surrogate', '{"__proto__":"\\ud800"}'],
  ])('rejects %s from raw JSON before routing', async (_name, body) => {
    const { adapter, calls } = harness();
    const response = await adapter.fetch(request(body));
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
    expect(Object.keys(await response.json()).sort()).toEqual(['code', 'status', 'title', 'type']);
  });

  it('rejects a terminal escaped high surrogate in the raw-byte admission layer', () => {
    const bytes = new TextEncoder().encode('{"__proto__":"\\ud800"}');
    expect(() => parseResponsibilityJsonBytes(bytes)).toThrow('responsibility JSON rejected');
  });

  it('rejects a media/body protocol mismatch instead of downgrading', async () => {
    const { adapter, calls } = harness();
    const response = await adapter.fetch(request({ ...captureBody, protocolVersion: '0.1' }));
    expect(response.status).toBe(406);
    expect(calls).toEqual([]);
  });

  it.each([
    'application/vnd.waldo.responsibility.v0.2+json;q=0',
    'application/vnd.waldo.responsibility.v0.2+json, application/json',
    'application/vnd.waldo.responsibility.v0.1+json;q=1',
  ])('rejects ambiguous or qualified negotiation %s', async (accept) => {
    const { adapter, calls } = harness();
    const response = await adapter.fetch(request(captureBody, { accept }));
    expect(response.status).toBe(406);
    expect(calls).toEqual([]);
  });

  it('uses one non-enumerating denial for absent, expired, revoked, and mismatched presence authority', async () => {
    for (const authenticate of [
      async () => null,
      async () => ({ ...trustedContext, presenceRegistrationId: 'presence_registration_other' }),
    ]) {
      const { adapter, calls } = harness({ authority: { authenticate } });
      const response = await adapter.fetch(request(captureBody));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        type: 'https://api.heywaldo.com/problems/unauthorized',
        title: 'Authentication required',
        status: 401,
        code: 'unauthorized',
      });
      expect(calls).toEqual([]);
    }
  });

  it('maps a canonical Waldo authority denial to the same non-enumerating response', async () => {
    const { adapter } = harness({
      ownerRoot: {
        async capture() {
          throw new ResponsibilityAuthorityDeniedError();
        },
        async readProjection() { throw new Error('not used'); },
      },
    });
    const response = await adapter.fetch(request(captureBody));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      type: 'https://api.heywaldo.com/problems/unauthorized',
      title: 'Authentication required',
      status: 401,
      code: 'unauthorized',
    });
  });

  it('rejects server-owned field smuggling without routing', async () => {
    const { adapter, calls } = harness();
    const response = await adapter.fetch(request({ ...captureBody, ownerId: 'owner_attacker' }));
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('rejects v0.1 aggregate targeting before owner routing', async () => {
    const { adapter, calls } = harness();
    const response = await adapter.fetch(request({
      ...captureBody,
      protocolVersion: '0.1',
      aggregate: { kind: 'outcome', id: 'outcome_other', expectedRevision: 1 },
    }, {
      accept: 'application/vnd.waldo.responsibility.v0.1+json',
      'content-type': 'application/vnd.waldo.responsibility.v0.1+json',
    }));
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('bounds a streamed body before authentication or routing', async () => {
    let authCalls = 0;
    const adapter = createResponsibilityWorkerAdapter({
      authority: { authenticate: async () => { authCalls += 1; return trustedContext; } },
      edgeRateLimit: { admit: async () => true },
      failureReporter: { report: () => undefined },
      ownerRootFor: async () => { throw new Error('must not route'); },
      now: () => '2026-08-06T12:00:01.000Z',
      newId: (kind) => `${kind}_server_01`,
    });
    const response = await adapter.fetch(request('x'.repeat(24_577)));
    expect(response.status).toBe(400);
    expect(authCalls).toBe(0);
  });

  it('rejects unknown projection parameters instead of accepting route substitution', async () => {
    const { adapter, calls, ownerRootCalls } = harness();
    const response = await adapter.fetch(new Request(
      'https://api.heywaldo.com/public/responsibilities/projection?fromExclusiveCursor=0&limit=25&ownerId=owner_attacker',
      { headers: {
        authorization: 'Bearer session-token',
        accept: 'application/vnd.waldo.responsibility.v0.2+json',
      } },
    ));
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
    expect(ownerRootCalls()).toBe(0);
  });

  it('rejects every capture query after edge rate limiting but before auth or owner routing', async () => {
    let rateCalls = 0;
    let authCalls = 0;
    let routeCalls = 0;
    const adapter = createResponsibilityWorkerAdapter({
      authority: { authenticate: async () => { authCalls += 1; return trustedContext; } },
      edgeRateLimit: { admit: async () => { rateCalls += 1; return true; } },
      failureReporter: { report: () => undefined },
      ownerRootFor: async () => { routeCalls += 1; throw new Error('must not route'); },
      now: () => '2026-08-06T12:00:01.000Z',
      newId: (kind) => `${kind}_server_01`,
    });
    const response = await adapter.fetch(new Request(
      'https://api.heywaldo.com/public/responsibilities?ownerId=owner_attacker',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer session-token',
          accept: 'application/vnd.waldo.responsibility.v0.2+json',
          'content-type': 'application/vnd.waldo.responsibility.v0.2+json',
        },
        body: JSON.stringify(captureBody),
      },
    ));

    expect(response.status).toBe(400);
    expect({ rateCalls, authCalls, routeCalls }).toEqual({
      rateCalls: 1, authCalls: 0, routeCalls: 0,
    });
  });

  it('bounds projection query bytes before authentication or owner routing', async () => {
    const { adapter, calls, ownerRootCalls } = harness();
    const response = await adapter.fetch(new Request(
      `https://api.heywaldo.com/public/responsibilities/projection?fromExclusiveCursor=0&limit=25&snapshotId=${'a'.repeat(2_049)}`,
      { headers: {
        authorization: 'Bearer session-token',
        accept: 'application/vnd.waldo.responsibility.v0.2+json',
      } },
    ));
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
    expect(ownerRootCalls()).toBe(0);
  });

  it('rejects duplicate projection parameters instead of choosing an attacker-controlled value', async () => {
    const { adapter, calls, ownerRootCalls } = harness();
    const response = await adapter.fetch(new Request(
      'https://api.heywaldo.com/public/responsibilities/projection?fromExclusiveCursor=0&fromExclusiveCursor=99&limit=25',
      { headers: {
        authorization: 'Bearer session-token',
        accept: 'application/vnd.waldo.responsibility.v0.2+json',
      } },
    ));
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
    expect(ownerRootCalls()).toBe(0);
  });

  it('reads only the authenticated owner projection with version-pinned pagination', async () => {
    const reads: unknown[] = [];
    const ownerRoot: ResponsibilityOwnerRoot = {
      async capture() { throw new Error('not used'); },
      async readProjection(input) {
        reads.push(input);
        return {
          protocolVersion: '0.1', ownerId: trustedContext.ownerId,
          projectionName: 'responsibility.summary', snapshotId: 'snapshot_01',
          snapshotBaseCursor: 0, fromExclusiveCursor: 0, highWaterCursor: 0,
          nextCursor: 0, items: [], hasMore: false,
          generatedAt: '2026-08-06T12:00:01.000Z',
        };
      },
    };
    const { adapter } = harness({ ownerRoot });
    const response = await adapter.fetch(new Request(
      'https://api.heywaldo.com/public/responsibilities/projection?fromExclusiveCursor=0&limit=25',
      { headers: {
        authorization: 'Bearer session-token',
        accept: 'application/vnd.waldo.responsibility.v0.1+json',
      } },
    ));
    expect(response.status).toBe(200);
    expect(reads).toEqual([{
      routedOwnerId: trustedContext.ownerId,
      protocolVersion: '0.1',
      fromExclusiveCursor: 0,
      limit: 25,
    }]);
  });
});
