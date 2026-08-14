import {
  canonicalizeResponsibilityCaptureTrustedEnvelopeForDigest,
  ROSTER_REFS,
  canonicalizeResponsibilityCaptureRequestV02ForDigest,
  canonicalizeResponsibilityCaptureTrustedEnvelopeV02ForDigest,
  canonicalizeSurfaceCommandRequestForDigest,
  canonicalizeWorkUnitPlanningTurnRequestV03ForDigest,
  canonicalizeWorkUnitPlanningTurnTrustedEnvelopeV03ForDigest,
  canonicalizeWorkUnitExecutionStartRequestV04ForDigest,
  responsibilityCaptureRequestSchema,
  responsibilityCaptureTrustedEnvelopeSchema,
  responsibilityCaptureRequestV02Schema,
  responsibilityCaptureTrustedEnvelopeV02Schema,
  workUnitPlanningTurnRequestV03Schema,
  workUnitPlanningTurnTrustedEnvelopeV03Schema,
  workUnitExecutionStartRequestV04Schema,
} from '@waldo/contracts';
import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { responsibilityOwnerRootName } from '../src/index';
import {
  canonicalizePlanningProjectionIngressForDigest,
  canonicalizeResponsibilityProjectionIngressForDigest,
  signResponsibilityIngress,
  type SignedResponsibilityIngressContext,
} from '../src/responsibility/ingress-signature';
import type { RunLoopDO } from '../src/run-loop/do';
import { localWorkUnitExecutionProofStats } from '../src/run-loop/work-unit-execution';
import {
  createResponsibilityWorkerAdapter,
  type ResponsibilityOwnerRoot,
  type TrustedResponsibilityContext,
} from '../src/responsibility/worker-adapter';

let sequence = 0;
const TEST_INGRESS_SECRET = 'test-responsibility-ingress-hmac-secret-000000000000';
const ingress = {
  authenticatedSubjectRef: `supabase_subject_${'a'.repeat(64)}`,
  authenticatedSessionId: `authenticated_session_${'a'.repeat(64)}`,
  authenticatedSessionExpiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
  ownerPolicyRevision: 7,
};

async function admission(
  ownerId: string,
  requestId: string,
  authenticatedSessionId = ingress.authenticatedSessionId,
) {
  const request = responsibilityCaptureRequestV02Schema.parse({
    protocolVersion: '0.2', requestId, commandType: 'responsibility.capture',
    presenceRegistrationId: 'presence_registration_01',
    clientIssuedAt: '2026-08-06T12:00:00.000Z',
    payload: { userStatement: 'Prepare a reviewable update, but do not publish it.' },
  });
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalizeResponsibilityCaptureRequestV02ForDigest(request)),
  );
  const requestDigest = `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
  const trustedEnvelope = responsibilityCaptureTrustedEnvelopeV02Schema.parse({
    protocolVersion: '0.2', commandId: `command_${requestId}`,
    commandType: 'responsibility.capture', ownerId,
    actor: { kind: 'presence', id: 'presence_01' }, presenceId: 'presence_01',
    authenticatedSessionId,
    ownerPolicyRevision: ingress.ownerPolicyRevision,
    authAssurance: 'supabase_verified_session', ownerRootRoutingVersion: 2,
    requestDigest, correlationId: `correlation_${requestId}`,
    receivedAt: '2026-08-06T12:00:01.000Z', payload: request.payload,
  });
  return { routedOwnerId: ownerId, request, trustedEnvelope };
}

async function stubFor(ownerId: string): Promise<DurableObjectStub<RunLoopDO>> {
  sequence += 1;
  const name = `${await responsibilityOwnerRootName(ownerId)}:test:${sequence}`;
  return env.RUN_LOOP_DO.get(env.RUN_LOOP_DO.idFromName(name));
}

describe('production responsibility RunLoopDO RPC', () => {
  it('starts one canonical WorkUnit through signed owner RPC and recovers after eviction', async () => {
    const ownerId = 'owner_public_execution_rpc_01';
    const stub = await stubFor(ownerId);
    const captureRequest = responsibilityCaptureRequestV02Schema.parse({
      protocolVersion: '0.2',
      requestId: 'capture_public_execution_rpc_01',
      commandType: 'responsibility.capture',
      presenceRegistrationId: 'presence_registration_01',
      clientIssuedAt: '2026-08-14T17:00:00.000Z',
      payload: {
        userStatement: 'Prepare one bounded local execution proof.',
        workUnits: [{
          responsibility: 'Start the bounded proof executor.',
          inputs: [], dependencyPositions: [], expectedEvidence: [],
          requiredCapabilities: [], stopConditions: ['Do not publish.'],
        }],
      },
    });
    const captureDigest = `sha256:${await sha256Hex(
      canonicalizeResponsibilityCaptureRequestV02ForDigest(captureRequest),
    )}` as const;
    const captureEnvelope = responsibilityCaptureTrustedEnvelopeV02Schema.parse({
      protocolVersion: '0.2', commandId: 'command_public_execution_capture_01',
      commandType: 'responsibility.capture', ownerId,
      actor: { kind: 'presence', id: 'presence_01' }, presenceId: 'presence_01',
      authenticatedSessionId: ingress.authenticatedSessionId,
      ownerPolicyRevision: ingress.ownerPolicyRevision,
      authAssurance: 'supabase_verified_session', ownerRootRoutingVersion: 2,
      requestDigest: captureDigest, correlationId: 'correlation_public_execution_capture_01',
      receivedAt: '2026-08-14T17:00:01.000Z', payload: captureRequest.payload,
    });
    const captureInput = {
      routedOwnerId: ownerId, request: captureRequest, trustedEnvelope: captureEnvelope,
    };
    const captured = await stub.captureResponsibilityFromWorker(
      captureInput,
      await signedCaptureIngress(ownerId, captureInput),
    );
    const workUnit = captured.workUnits[0]!;
    const request = workUnitExecutionStartRequestV04Schema.parse({
      protocolVersion: '0.4',
      requestId: 'public_execution_start_rpc_01',
      commandType: 'work_unit.start_execution',
      presenceRegistrationId: 'presence_registration_01',
      aggregate: { kind: 'work_unit', id: workUnit.id, expectedRevision: workUnit.revision },
      clientIssuedAt: '2026-08-14T17:00:02.000Z',
    });
    const trustedContext: TrustedResponsibilityContext = Object.freeze({
      ownerId,
      authenticatedSubjectRef: ingress.authenticatedSubjectRef,
      actor: { kind: 'presence' as const, id: 'presence_01' },
      presenceId: 'presence_01',
      presenceRegistrationId: 'presence_registration_01',
      authenticatedSessionId: ingress.authenticatedSessionId,
      authenticatedSessionExpiresAt: ingress.authenticatedSessionExpiresAt,
      ownerPolicyRevision: ingress.ownerPolicyRevision,
      authAssurance: 'supabase_verified_session',
      ownerRootRoutingVersion: 2,
    });
    const ownerRoot: ResponsibilityOwnerRoot = {
      async capture() { throw new Error('not used'); },
      async readProjection() { throw new Error('not used'); },
      async startExecution(input) {
        const admittedRequest = workUnitExecutionStartRequestV04Schema.parse(input.request);
        return stub.startExecutionFromWorker(
          input,
          await signedExecutionStartIngress(ownerId, admittedRequest),
        );
      },
    };
    const adapter = createResponsibilityWorkerAdapter({
      authority: { authenticate: async () => trustedContext },
      edgeRateLimit: { admit: async () => true },
      failureReporter: { report() {} },
      ownerRootFor: async () => ownerRoot,
      now: () => '2026-08-14T17:00:03.000Z',
      newId: (kind) => `${kind}_public_execution_01`,
    });
    const publicRequest = (body: unknown = request) => new Request(
      'https://api.heywaldo.com/public/responsibilities/work-units/executions',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer session-token',
          accept: 'application/vnd.waldo.responsibility.v0.4+json',
          'content-type': 'application/vnd.waldo.responsibility.v0.4+json',
        },
        body: JSON.stringify(body),
      },
    );
    const beforeStats = localWorkUnitExecutionProofStats();
    const firstResponse = await adapter.fetch(publicRequest());
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json();
    expect(first).toMatchObject({
      protocolVersion: '0.4', requestId: request.requestId,
      workUnit: { id: workUnit.id, revision: workUnit.revision }, status: 'started',
    });
    await evictDurableObject(stub);
    const retryResponse = await adapter.fetch(publicRequest());
    expect(retryResponse.status).toBe(200);
    expect(await retryResponse.json()).toEqual(first);
    const afterStats = localWorkUnitExecutionProofStats();
    expect(afterStats.physicalIssues - beforeStats.physicalIssues).toBe(1);
    const stale = await adapter.fetch(publicRequest({
      ...request,
      requestId: 'public_execution_start_stale_01',
      aggregate: { ...request.aggregate, expectedRevision: request.aggregate.expectedRevision + 1 },
    }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      type: 'https://api.heywaldo.com/problems/request-conflict',
      title: 'Request conflict', status: 409, code: 'request_conflict',
    });
    const missing = await adapter.fetch(publicRequest({
      ...request,
      requestId: 'public_execution_start_missing_01',
      aggregate: { ...request.aggregate, id: 'work_unit_not_owned_01' },
    }));
    expect(missing.status).toBe(404);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM planning_execution_requests',
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM execution_attempts',
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM execution_observations',
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ state: string }>(
        'SELECT state FROM work_units WHERE id = ?', workUnit.id,
      ).one().state).toBe('planned');
    });
  });

  it('persists capture/idempotency/projection through the non-test Worker RPC', async () => {
    const ownerId = 'owner_public_rpc_01';
    const stub = await stubFor(ownerId);
    const input = await admission(ownerId, 'request_public_rpc_01');
    const captureIngress = await signedCaptureIngress(ownerId, input);
    const projectionIngress = await signedProjectionIngress(ownerId, {
      protocolVersion: '0.2', fromExclusiveCursor: 0, limit: 25,
    });

    const first = await stub.captureResponsibilityFromWorker(input, captureIngress);
    const duplicate = await stub.captureResponsibilityFromWorker(input, captureIngress);
    const page = await stub.readResponsibilityProjectionFromWorker({
      routedOwnerId: ownerId, protocolVersion: '0.2', fromExclusiveCursor: 0, limit: 25,
    }, projectionIngress);

    expect(duplicate).toEqual(first);
    expect(page).toMatchObject({ ownerId, highWaterCursor: 1, nextCursor: 1 });
  });

  it('executes the authenticated v0.3 planning turn through the owner-derived RunLoopDO', async () => {
    const ownerId = 'owner_public_planning_rpc_01';
    const stub = await stubFor(ownerId);
    const captureRequest = responsibilityCaptureRequestV02Schema.parse({
      protocolVersion: '0.2', requestId: 'capture_public_planning_rpc_01',
      commandType: 'responsibility.capture', presenceRegistrationId: 'presence_registration_01',
      clientIssuedAt: '2026-08-07T08:00:00.000Z',
      payload: {
        userStatement: 'Prepare a reviewable product update, but do not publish it.',
        workUnits: [{ responsibility: 'Prepare its candidate plan.', inputs: [],
          dependencyPositions: [], expectedEvidence: [], requiredCapabilities: [],
          stopConditions: ['Do not publish.'] }],
      },
    });
    const captureDigest = `sha256:${await sha256Hex(
      canonicalizeResponsibilityCaptureRequestV02ForDigest(captureRequest),
    )}` as const;
    const captureEnvelope = responsibilityCaptureTrustedEnvelopeV02Schema.parse({
      protocolVersion: '0.2', commandId: 'command_public_planning_capture_01',
      commandType: 'responsibility.capture', ownerId,
      actor: { kind: 'presence', id: 'presence_01' }, presenceId: 'presence_01',
      authenticatedSessionId: ingress.authenticatedSessionId,
      ownerPolicyRevision: ingress.ownerPolicyRevision,
      authAssurance: 'supabase_verified_session', ownerRootRoutingVersion: 2,
      requestDigest: captureDigest, correlationId: 'correlation_public_planning_capture_01',
      receivedAt: '2026-08-07T08:00:01.000Z', payload: captureRequest.payload,
    });
    const captureInput = { routedOwnerId: ownerId, request: captureRequest, trustedEnvelope: captureEnvelope };
    const captured = await stub.captureResponsibilityFromWorker(
      captureInput,
      await signedCaptureIngress(ownerId, captureInput),
    );
    const content = 'Fixture: release notes are review-ready.';
    const planningRequest = workUnitPlanningTurnRequestV03Schema.parse({
      protocolVersion: '0.3', requestId: 'planning_public_rpc_01',
      commandType: 'work_unit.request_planning_turn',
      presenceRegistrationId: 'presence_registration_01',
      aggregate: { kind: 'work_unit', id: captured.workUnits[0]!.id, expectedRevision: 1 },
      clientIssuedAt: '2026-08-07T08:00:02.000Z',
      payload: { governedInputs: [{
        ref: 'fixture_public_release', digest: `sha256:${await sha256Hex(content)}`, content,
      }] },
    });
    const manifest = {
      schemaVersion: '0.3', tools: [], connectors: [], filesystem: 'none', shell: 'none',
      network: 'none', externalEffects: 'none',
    } as const;
    const manifestDigest = `sha256:${await sha256Hex(JSON.stringify(manifest))}`;
    const planningEnvelope = workUnitPlanningTurnTrustedEnvelopeV03Schema.parse({
      protocolVersion: '0.3', commandId: 'command_public_planning_01',
      commandType: 'work_unit.request_planning_turn', ownerId,
      actor: { kind: 'presence', id: 'presence_01' }, presenceId: 'presence_01',
      authenticatedSessionId: ingress.authenticatedSessionId,
      ownerPolicyRevision: ingress.ownerPolicyRevision,
      authAssurance: 'supabase_verified_session', ownerRootRoutingVersion: 2,
      aggregate: planningRequest.aggregate,
      requestDigest: `sha256:${await sha256Hex(
        canonicalizeWorkUnitPlanningTurnRequestV03ForDigest(planningRequest),
      )}`,
      correlationId: 'correlation_public_planning_01', receivedAt: '2026-08-07T08:00:03.000Z',
      provider: {
        adapterId: 'runtime_llm_provider', adapterVersion: '1.0.0',
        modelRef: ROSTER_REFS.primary,
        capabilityManifest: { id: 'planning_provider_empty_v1', revision: 1, digest: manifestDigest },
      },
      executor: {
        executorId: 'run_loop_planning_executor', executorVersion: '1.0.0',
        capabilityManifest: { id: 'planning_executor_empty_v1', revision: 1, digest: manifestDigest },
      },
      capabilityManifest: manifest,
      authorityCeiling: {
        providerPlanningTurns: 1, tools: 'none', connectors: 'none', externalEffects: 'none',
        outcomeMutation: 'none', evidence: 'none', verification: 'none', acceptance: 'none',
        closure: 'none',
      },
      payload: { governedInputs: planningRequest.payload.governedInputs.map(({ ref, digest }) => ({ ref, digest })) },
    });
    const planningInput = { routedOwnerId: ownerId, request: planningRequest, trustedEnvelope: planningEnvelope };
    const signed = await signedPlanningIngress(ownerId, planningInput);
    const first = await stub.executePlanningTurnFromWorker(planningInput, signed);
    const retry = await stub.executePlanningTurnFromWorker(planningInput, signed);
    expect(retry).toEqual(first);
    expect(first).toMatchObject({
      ownerId, workUnitId: captured.workUnits[0]!.id, sessionStatus: 'completed',
      candidatePlan: { constraints: expect.arrayContaining(['Do not publish or perform any external effect.']) },
    });
    const firstPageInput = { routedOwnerId: ownerId, fromExclusiveCursor: 0, limit: 2 };
    const firstPage = await stub.readPlanningProjectionFromWorker(
      firstPageInput,
      await signedPlanningProjectionIngress(ownerId, firstPageInput),
    );
    expect(firstPage.items.map((item) => item.itemType)).toEqual([
      'planning_authorized', 'agent_session_activity',
    ]);
    expect(firstPage.hasMore).toBe(true);
    const secondPageInput = {
      routedOwnerId: ownerId, fromExclusiveCursor: firstPage.nextCursor,
      limit: 2, snapshotId: firstPage.snapshotId,
    };
    const secondPage = await stub.readPlanningProjectionFromWorker(
      secondPageInput,
      await signedPlanningProjectionIngress(ownerId, secondPageInput),
    );
    expect(secondPage.items.map((item) => item.itemType)).toEqual([
      'agent_session_activity', 'work_unit_candidate_plan',
    ]);
    expect(secondPage.hasMore).toBe(false);
    await runInDurableObject(stub, async (instance) => {
      const staleInput = {
        routedOwnerId: ownerId, fromExclusiveCursor: firstPage.nextCursor, limit: 2,
      };
      await expect(instance.readPlanningProjectionFromWorker(
        staleInput,
        await signedPlanningProjectionIngress(ownerId, staleInput),
      )).rejects.toThrow('snapshot_replaced');
      await expect(instance.executePlanningTurnFromWorker(
        { ...planningInput, routedOwnerId: 'owner_substituted' }, signed,
      )).rejects.toThrow('authority mismatch');
    });
  });

  it('binds the released v0.1 trusted envelope across the signed Worker RPC', async () => {
    const ownerId = 'owner_public_rpc_v01_01';
    const stub = await stubFor(ownerId);
    const request = responsibilityCaptureRequestSchema.parse({
      protocolVersion: '0.1', requestId: 'request_public_rpc_v01_01',
      commandType: 'responsibility.capture',
      presenceRegistrationId: 'presence_registration_01',
      clientIssuedAt: '2026-08-06T12:00:00.000Z',
      payload: { userStatement: 'Prepare a reviewable update, but do not publish it.' },
    });
    const requestDigest = `sha256:${await sha256Hex(
      canonicalizeSurfaceCommandRequestForDigest(request),
    )}` as const;
    const trustedEnvelope = responsibilityCaptureTrustedEnvelopeSchema.parse({
      protocolVersion: '0.1', commandId: 'command_public_rpc_v01_01',
      commandType: 'responsibility.capture', ownerId,
      actor: { kind: 'presence', id: 'presence_01' }, presenceId: 'presence_01',
      authenticatedSessionId: ingress.authenticatedSessionId,
      ownerPolicyRevision: ingress.ownerPolicyRevision,
      authAssurance: 'supabase_verified_session', ownerRootRoutingVersion: 2,
      requestDigest, correlationId: 'correlation_public_rpc_v01_01',
      receivedAt: '2026-08-06T12:00:01.000Z', payload: request.payload,
    });
    const input = { routedOwnerId: ownerId, request, trustedEnvelope };
    const signed = await signResponsibilityIngress({
      context: {
        ...ingress, ownerId, presenceId: 'presence_01',
        presenceRegistrationId: 'presence_registration_01', ownerRootRoutingVersion: 2,
      },
      operation: 'capture', requestDigest,
      operationDigest: `sha256:${await sha256Hex(
        canonicalizeResponsibilityCaptureTrustedEnvelopeForDigest(trustedEnvelope),
      )}`,
      issuedAt: Date.now(), secret: TEST_INGRESS_SECRET,
    });

    const first = await stub.captureResponsibilityFromWorker(input, signed);
    expect(first).toMatchObject({ protocolVersion: '0.1', ownerId });
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.captureResponsibilityFromWorker({
        ...input,
        trustedEnvelope: { ...trustedEnvelope, actor: { kind: 'service', id: 'forged' } },
      }, signed)).rejects.toThrow('authority mismatch');
    });
  });

  it('rejects signed claims that do not match Waldo-owned canonical authority', async () => {
    const ownerId = 'owner_public_authority_01';
    const stub = await stubFor(ownerId);
    const input = await admission(ownerId, 'request_public_authority_01');
    await stub.captureResponsibilityFromWorker(
      input,
      await signedCaptureIngress(ownerId, input),
    );
    await runInDurableObject(stub, async (instance) => {
      for (const [envelopeChange, ingressChange] of [
        [{ ownerPolicyRevision: 8 }, { ownerPolicyRevision: 8 }],
        [
          { actor: { kind: 'presence', id: 'presence_substituted' }, presenceId: 'presence_substituted' },
          { presenceId: 'presence_substituted' },
        ],
        [{}, { authenticatedSubjectRef: `supabase_subject_${'c'.repeat(64)}` }],
      ] as const) {
        const changed = {
          ...input,
          trustedEnvelope: { ...input.trustedEnvelope, ...envelopeChange },
        };
        const changedIngress = await signedCaptureIngress(ownerId, changed, ingressChange);
        await expect(instance.captureResponsibilityFromWorker(changed, changedIngress))
          .rejects.toMatchObject({ name: 'ResponsibilityAuthorityDeniedError' });
      }
      const unsupportedRouting = {
        ...input,
        trustedEnvelope: { ...input.trustedEnvelope, ownerRootRoutingVersion: 3 },
      };
      await expect(instance.captureResponsibilityFromWorker(
        unsupportedRouting,
        await signedCaptureIngress(ownerId, unsupportedRouting, {
          ownerRootRoutingVersion: 3,
        }),
      )).rejects.toThrow('responsibility ingress authority mismatch');
    });
  });

  it('admits a renewed login session only for the stable canonical Presence', async () => {
    const ownerId = 'owner_public_session_rotation_01';
    const stub = await stubFor(ownerId);
    const firstInput = await admission(ownerId, 'request_public_session_initial_01');
    await stub.captureResponsibilityFromWorker(
      firstInput,
      await signedCaptureIngress(ownerId, firstInput),
    );
    const renewedSessionId = `authenticated_session_${'d'.repeat(64)}`;
    const renewedInput = await admission(
      ownerId,
      'request_public_session_rotation_01',
      renewedSessionId,
    );
    await expect(stub.captureResponsibilityFromWorker(
      renewedInput,
      await signedCaptureIngress(ownerId, renewedInput, {
        authenticatedSessionId: renewedSessionId,
      }),
    )).resolves.toMatchObject({ ownerId });

    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{
        authenticated_subject_ref: string;
        owner_policy_revision: number;
        owner_root_routing_version: number;
      }>(
        `SELECT authenticated_subject_ref, owner_policy_revision,
                owner_root_routing_version FROM owner_roots`,
      ).one()).toEqual({
        authenticated_subject_ref: ingress.authenticatedSubjectRef,
        owner_policy_revision: ingress.ownerPolicyRevision,
        owner_root_routing_version: 2,
      });
      expect(state.storage.sql.exec(
        'SELECT presence_registration_id, presence_id FROM presence_registrations',
      ).toArray()).toEqual([{
        presence_registration_id: 'presence_registration_01',
        presence_id: 'presence_01',
      }]);
      expect(state.storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM presence_sessions',
      ).one().count).toBe(2);
    });
  });

  it('denies invalid signed admission without creating canonical or rate state', async () => {
    const ownerId = 'owner_public_invalid_admission_01';
    const stub = await stubFor(ownerId);
    const input = await admission(ownerId, 'request_public_invalid_admission_01');
    const signed = await signedCaptureIngress(ownerId, input, {}, {
      secret: 'wrong-responsibility-ingress-secret-000000000000000000',
    });

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.captureResponsibilityFromWorker(input, signed))
        .rejects.toThrow('authority mismatch');
      expect(state.storage.sql.exec('SELECT * FROM owner_roots').toArray()).toEqual([]);
      expect(state.storage.sql.exec('SELECT * FROM presence_registrations').toArray()).toEqual([]);
      expect(state.storage.sql.exec('SELECT * FROM presence_sessions').toArray()).toEqual([]);
      expect(state.storage.sql.exec('SELECT * FROM outcomes').toArray()).toEqual([]);
      expect(state.storage.sql.exec('SELECT * FROM responsibility_ingress_rate').toArray())
        .toEqual([]);
    });
  });

  it('rejects trusted-envelope provenance substitution under a captured valid ingress signature', async () => {
    const ownerId = 'owner_public_provenance_01';
    const stub = await stubFor(ownerId);
    const input = await admission(ownerId, 'request_public_provenance_01');
    const signed = await signedCaptureIngress(ownerId, input);
    const substituted = {
      ...input,
      trustedEnvelope: {
        ...input.trustedEnvelope,
        actor: { kind: 'service', id: 'forged_service' },
        authAssurance: 'forged_assurance',
        correlationId: 'forged_correlation',
      },
    };
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.captureResponsibilityFromWorker(substituted, signed))
        .rejects.toThrow('authority mismatch');
    });
  });

  it('rejects wrong secrets, stale/future signatures, and signed-field mutation', async () => {
    const ownerId = 'owner_public_signature_01';
    const stub = await stubFor(ownerId);
    const input = await admission(ownerId, 'request_public_signature_01');
    const valid = await signedCaptureIngress(ownerId, input);
    const wrongSecret = await signedCaptureIngress(ownerId, input, {}, {
      secret: 'wrong-responsibility-ingress-secret-000000000000000000',
    });
    const stale = await signedCaptureIngress(ownerId, input, {}, { issuedAt: Date.now() - 60_001 });
    const future = await signedCaptureIngress(ownerId, input, {}, { issuedAt: Date.now() + 60_000 });
    const mutations: SignedResponsibilityIngressContext[] = [
      wrongSecret,
      stale,
      future,
      { ...valid, ownerId: 'owner_substituted_01' },
      { ...valid, presenceId: 'presence_substituted_01' },
      { ...valid, ownerRootRoutingVersion: 3 },
      { ...valid, operation: 'projection' },
      { ...valid, requestDigest: `sha256:${'0'.repeat(64)}` },
      { ...valid, operationDigest: `sha256:${'0'.repeat(64)}` },
    ];
    await runInDurableObject(stub, async (instance) => {
      for (const candidate of mutations) {
        await expect(instance.captureResponsibilityFromWorker(input, candidate))
          .rejects.toThrow('authority mismatch');
      }
    });
  });

  it('rate-limits one authenticated owner session before extra capture work', async () => {
    const ownerId = 'owner_public_rate_01';
    const stub = await stubFor(ownerId);
    const input = await admission(ownerId, 'request_public_rate_01');
    const captureIngress = await signedCaptureIngress(ownerId, input);
    const projectionInput = {
      protocolVersion: '0.2' as const, fromExclusiveCursor: 0, limit: 1,
    };
    const projectionIngress = await signedProjectionIngress(ownerId, projectionInput);
    for (let index = 0; index < 60; index += 1) {
      if (index === 0) await stub.captureResponsibilityFromWorker(input, captureIngress);
      else await stub.readResponsibilityProjectionFromWorker({
        routedOwnerId: ownerId, ...projectionInput,
      }, projectionIngress);
    }
    await runInDurableObject(stub, async (instance, state) => {
      const before = {
        authority: state.storage.sql.exec(
          'SELECT * FROM presence_sessions ORDER BY authenticated_session_id',
        ).toArray(),
        rates: state.storage.sql.exec(
          'SELECT * FROM responsibility_ingress_rate ORDER BY rate_key, bucket',
        ).toArray(),
      };
      await expect(Promise.resolve().then(() =>
        instance.readResponsibilityProjectionFromWorker({
          routedOwnerId: ownerId, ...projectionInput,
        }, projectionIngress),
      )).rejects.toThrow('rate limited');
      expect({
        authority: state.storage.sql.exec(
          'SELECT * FROM presence_sessions ORDER BY authenticated_session_id',
        ).toArray(),
        rates: state.storage.sql.exec(
          'SELECT * FROM responsibility_ingress_rate ORDER BY rate_key, bucket',
        ).toArray(),
      }).toEqual(before);
    });
  });

  it('enforces the owner-global ceiling across authenticated sessions', async () => {
    const ownerId = 'owner_public_global_rate_01';
    const stub = await stubFor(ownerId);
    const firstSessionId = `authenticated_session_${'0'.repeat(64)}`;
    const captureInput = await admission(ownerId, 'request_public_global_rate_01', firstSessionId);
    await stub.captureResponsibilityFromWorker(
      captureInput,
      await signedCaptureIngress(ownerId, captureInput, {
        authenticatedSessionId: firstSessionId,
      }),
    );
    const projectionInput = {
      protocolVersion: '0.2' as const, fromExclusiveCursor: 0, limit: 1,
    };
    for (let session = 0; session < 4; session += 1) {
      const authenticatedSessionId = `authenticated_session_${String(session).repeat(64)}`;
      const projectionIngress = await signedProjectionIngress(ownerId, projectionInput, {
        authenticatedSessionId,
      });
      const requests = session === 0 ? 59 : 60;
      for (let request = 0; request < requests; request += 1) {
        await stub.readResponsibilityProjectionFromWorker({
          routedOwnerId: ownerId, ...projectionInput,
        }, projectionIngress);
      }
    }
    const overflow = await signedProjectionIngress(ownerId, projectionInput, {
      authenticatedSessionId: `authenticated_session_${'f'.repeat(64)}`,
    });
    await runInDurableObject(stub, async (instance, state) => {
      const authorityBefore = {
        root: state.storage.sql.exec('SELECT * FROM owner_roots').toArray(),
        presences: state.storage.sql.exec('SELECT * FROM presence_registrations').toArray(),
        sessions: state.storage.sql.exec('SELECT * FROM presence_sessions ORDER BY authenticated_session_id').toArray(),
        rates: state.storage.sql.exec(
          'SELECT * FROM responsibility_ingress_rate ORDER BY rate_key, bucket',
        ).toArray(),
      };
      await expect(Promise.resolve().then(() => instance.readResponsibilityProjectionFromWorker({
        routedOwnerId: ownerId, ...projectionInput,
      }, overflow))).rejects.toThrow('rate limited');
      expect({
        root: state.storage.sql.exec('SELECT * FROM owner_roots').toArray(),
        presences: state.storage.sql.exec('SELECT * FROM presence_registrations').toArray(),
        sessions: state.storage.sql.exec('SELECT * FROM presence_sessions ORDER BY authenticated_session_id').toArray(),
        rates: state.storage.sql.exec(
          'SELECT * FROM responsibility_ingress_rate ORDER BY rate_key, bucket',
        ).toArray(),
      }).toEqual(authorityBefore);
    });
  });

  it('reconstructs signed-RPC idempotency and projection after eviction', async () => {
    const ownerId = 'owner_public_eviction_01';
    const stub = await stubFor(ownerId);
    const input = await admission(ownerId, 'request_public_eviction_01');
    const captureIngress = await signedCaptureIngress(ownerId, input);
    const first = await stub.captureResponsibilityFromWorker(input, captureIngress);

    await evictDurableObject(stub);

    const retry = await stub.captureResponsibilityFromWorker(input, captureIngress);
    const projectionInput = {
      protocolVersion: '0.2' as const, fromExclusiveCursor: 0, limit: 25,
    };
    const page = await stub.readResponsibilityProjectionFromWorker({
      routedOwnerId: ownerId, ...projectionInput,
    }, await signedProjectionIngress(ownerId, projectionInput));
    expect(retry).toEqual(first);
    expect(page).toMatchObject({ ownerId, highWaterCursor: 1, nextCursor: 1 });
  });

  it('derives exactly one stable routing name from the owner identity', async () => {
    const first = await responsibilityOwnerRootName('owner_route_01');
    expect(await responsibilityOwnerRootName('owner_route_01')).toBe(first);
    expect(await responsibilityOwnerRootName('owner_route_02')).not.toBe(first);
    expect(first).not.toContain('owner_route_01');
  });
});

async function signedCaptureIngress(
  ownerId: string,
  input: Awaited<ReturnType<typeof admission>>,
  overrides: IngressOverrides = {},
  signature: Readonly<{ issuedAt?: number; secret?: string }> = {},
): Promise<SignedResponsibilityIngressContext> {
  return signResponsibilityIngress({
    context: {
      ownerId,
      presenceId: 'presence_01',
      presenceRegistrationId: 'presence_registration_01',
      ownerRootRoutingVersion: 2,
      ...ingress,
      ...overrides,
    },
    operation: 'capture',
    requestDigest: input.trustedEnvelope.requestDigest as `sha256:${string}`,
    operationDigest: `sha256:${await sha256Hex(canonicalizeResponsibilityCaptureTrustedEnvelopeV02ForDigest(
      input.trustedEnvelope,
    ))}`,
    issuedAt: signature.issuedAt ?? Date.now(),
    secret: signature.secret ?? TEST_INGRESS_SECRET,
  });
}

async function signedProjectionIngress(
  ownerId: string,
  input: { protocolVersion: '0.1' | '0.2'; fromExclusiveCursor: number; limit: number; snapshotId?: string },
  overrides: IngressOverrides = {},
): Promise<SignedResponsibilityIngressContext> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalizeResponsibilityProjectionIngressForDigest(input)),
  );
  return signResponsibilityIngress({
    context: {
      ownerId,
      presenceId: 'presence_01',
      presenceRegistrationId: 'presence_registration_01',
      ownerRootRoutingVersion: 2,
      ...ingress,
      ...overrides,
    },
    operation: 'projection',
    requestDigest: `sha256:${Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')}` as const,
    operationDigest: `sha256:${Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')}` as const,
    issuedAt: Date.now(),
    secret: TEST_INGRESS_SECRET,
  });
}

async function signedPlanningIngress(
  ownerId: string,
  input: Readonly<{ trustedEnvelope: { requestDigest: string } }>,
): Promise<SignedResponsibilityIngressContext> {
  return signResponsibilityIngress({
    context: {
      ownerId, presenceId: 'presence_01', presenceRegistrationId: 'presence_registration_01',
      ownerRootRoutingVersion: 2, ...ingress,
    },
    operation: 'planning_turn',
    requestDigest: input.trustedEnvelope.requestDigest as `sha256:${string}`,
    operationDigest: `sha256:${await sha256Hex(
      canonicalizeWorkUnitPlanningTurnTrustedEnvelopeV03ForDigest(input.trustedEnvelope),
    )}`,
    issuedAt: Date.now(), secret: TEST_INGRESS_SECRET,
  });
}

async function signedExecutionStartIngress(
  ownerId: string,
  request: ReturnType<typeof workUnitExecutionStartRequestV04Schema.parse>,
): Promise<SignedResponsibilityIngressContext> {
  const digest = `sha256:${await sha256Hex(
    canonicalizeWorkUnitExecutionStartRequestV04ForDigest(request),
  )}` as const;
  return signResponsibilityIngress({
    context: {
      ownerId, presenceId: 'presence_01', presenceRegistrationId: 'presence_registration_01',
      ownerRootRoutingVersion: 2, ...ingress,
    },
    operation: 'execution_start', requestDigest: digest, operationDigest: digest,
    issuedAt: Date.now(), secret: TEST_INGRESS_SECRET,
  });
}

async function signedPlanningProjectionIngress(
  ownerId: string,
  input: Readonly<{ fromExclusiveCursor: number; limit: number; snapshotId?: string }>,
): Promise<SignedResponsibilityIngressContext> {
  const digest = `sha256:${await sha256Hex(
    canonicalizePlanningProjectionIngressForDigest(input),
  )}` as const;
  return signResponsibilityIngress({
    context: {
      ownerId, presenceId: 'presence_01', presenceRegistrationId: 'presence_registration_01',
      ownerRootRoutingVersion: 2, ...ingress,
    },
    operation: 'planning_projection', requestDigest: digest, operationDigest: digest,
    issuedAt: Date.now(), secret: TEST_INGRESS_SECRET,
  });
}

type IngressOverrides = Partial<typeof ingress> & Readonly<{
  presenceId?: string;
  presenceRegistrationId?: string;
  ownerRootRoutingVersion?: number;
}>;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
