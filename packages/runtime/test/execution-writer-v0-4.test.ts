import {
  buildResponsibilityExecutionV04Bundle,
  executionAttemptV04Schema,
  executionCancelRequestV04Schema,
  executionLeaseV04Schema,
  executionReconciliationV04Schema,
  executionRequestV04Schema,
  executionSessionV04Schema,
  executorObservationV04Schema,
} from '@waldo/contracts';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PlanningExecutionModule } from '../src/coordinator/planning-execution-module';
import { WaldoCoordinator } from '../src/coordinator/waldo-coordinator';
import { provisionDoSchema } from '../src/do-schema';
import type { RuntimeProbeDO } from '../src/index';
import type {
  ResponsibilityCanonicalAuthorityRegistration,
} from '../src/coordinator/identity-presence-module';

const FIXTURE_DIGEST = `sha256:${'a'.repeat(64)}`;
const bundle = buildResponsibilityExecutionV04Bundle(() => 'a'.repeat(64));
const request = executionRequestV04Schema.parse(JSON.parse(bundle['execution-request.valid.json']!));
const attempt = executionAttemptV04Schema.parse(JSON.parse(bundle['execution-attempt.valid.json']!));
const lease = executionLeaseV04Schema.parse(JSON.parse(bundle['execution-lease.valid.json']!));
const session = executionSessionV04Schema.parse(JSON.parse(bundle['execution-session.valid.json']!));
const observation = executorObservationV04Schema.parse(
  JSON.parse(bundle['executor-observation.valid.json']!),
);
const reconciliation = executionReconciliationV04Schema.parse(
  JSON.parse(bundle['execution-reconciliation.valid.json']!),
);
const cancelRequest = executionCancelRequestV04Schema.parse(
  JSON.parse(bundle['execution-cancel-request.valid.json']!),
);
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

let sequence = 0;
function freshStub(): DurableObjectStub<RuntimeProbeDO> {
  sequence += 1;
  return env.RUNTIME_DO.get(env.RUNTIME_DO.idFromName(`execution-writer-v04-${sequence}`));
}

const binding = Object.freeze({
  routedOwnerId: request.ownerId,
  outcome: request.outcome,
  workUnit: request.workUnit,
  provider: request.provider,
  environment: request.environment,
  authorityCeiling: request.authorityCeiling,
  contextProjectionRef: request.contextProjectionRef,
  contextProjectionDigest: request.contextProjectionDigest,
});
const admission = Object.freeze({
  id: request.id,
  outcomeId: request.outcome.id,
  workUnitId: request.workUnit.id,
});
const resolvedBinding = Object.freeze({
  provider: request.provider,
  environment: request.environment,
  contextProjectionRef: request.contextProjectionRef,
  contextProjectionDigest: request.contextProjectionDigest,
});
const claimAdmission = Object.freeze({
  executionRequestId: request.id,
  attemptId: attempt.id,
  leaseId: lease.id,
  sessionId: session.id,
  providerSessionRef: session.providerSessionRef,
});

function seedCanonicalProductState(
  storage: DurableObjectStorage,
  requestValue: typeof request = request,
): void {
  storage.sql.exec(
    `INSERT OR IGNORE INTO owner_roots (
      root_key, owner_id, created_at, authenticated_subject_ref, state,
      owner_policy_revision, owner_root_routing_version, updated_at
    ) VALUES (1, ?, ?, ?, 'active', ?, ?, ?)`,
    requestValue.ownerId,
    requestValue.requestedAt,
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
    requestValue.outcome.id,
    requestValue.ownerId,
    requestValue.outcome.revision,
    requestValue.requestedAt,
    requestValue.requestedAt,
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
    requestValue.workUnit.id,
    requestValue.ownerId,
    requestValue.outcome.id,
    requestValue.workUnit.revision,
    JSON.stringify(requestValue.authorityCeiling),
    requestValue.requestedAt,
    requestValue.requestedAt,
  );
}

function writer(storage: DurableObjectStorage): PlanningExecutionModule {
  provisionDoSchema(storage);
  seedCanonicalProductState(storage);
  return new PlanningExecutionModule(storage, () => 'event_unused');
}

function productDigestProof(
  module: PlanningExecutionModule,
  requestValue: typeof request = request,
) {
  const productMaterial = module.readExecutionProductDigestMaterialV04(
    requestValue.ownerId,
    requestValue.outcome.id,
    requestValue.workUnit.id,
  );
  return {
    ...productMaterial,
    outcomeDigest: requestValue.outcome.digest,
    workUnitDigest: requestValue.workUnit.digest,
  };
}

function admit(module: PlanningExecutionModule): void {
  module.admitExecutionRequestV04InCurrentTransaction({
    request,
    trustedBinding: binding,
    requestDigest: FIXTURE_DIGEST,
    productDigestProof: productDigestProof(module),
  });
}

function claim(module: PlanningExecutionModule): void {
  module.claimExecutionAttemptV04InCurrentTransaction({
    attempt,
    lease,
    session,
    claimedAt: attempt.updatedAt,
  });
}

function reconcile(
  module: PlanningExecutionModule,
  input: Readonly<{ reconciliation: unknown; reconciliationDigest: string }>,
  receivedAt?: string,
): void {
  const parsed = executionReconciliationV04Schema.parse(input.reconciliation);
  module.reconcileExecutionAttemptV04InCurrentTransaction({
    ...input,
    receivedAt: receivedAt ?? parsed.checkedAt,
  });
}

describe('responsibility execution v0.4 sole writer', () => {
  it('keeps transaction and canonical digest ownership in WaldoCoordinator', async () => {
    const stub = freshStub();
    const aggregate = await runInDurableObject(stub, async (_instance, state) => {
      provisionDoSchema(state.storage);
      seedCanonicalProductState(state.storage);
      let now: string = request.requestedAt;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => now,
        newId: (kind) => `${kind}_unused`,
        async resolveExecutionBindingV04() { return resolvedBinding; },
        async sha256Hex() { return 'a'.repeat(64); },
      });
      const authority = coordinator.admitCanonicalAuthority(authorityRegistration);
      const admitted = await coordinator.admitExecutionRequestV04(admission, authority);
      now = '2026-08-13T12:00:00.500Z';
      expect(await coordinator.admitExecutionRequestV04(admission, authority)).toEqual(admitted);
      now = attempt.updatedAt;
      coordinator.claimExecutionAttemptV04(claimAdmission);
      now = observation.observedAt;
      return coordinator.admitExecutorObservationV04(observation);
    });

    expect(executionRequestV04Schema.parse(aggregate.request)).toEqual(request);
    expect(executorObservationV04Schema.parse(aggregate.observations[0])).toEqual(observation);
  });

  it('replays an admitted command without rebinding it to later product revisions', async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_instance, state) => {
      provisionDoSchema(state.storage);
      seedCanonicalProductState(state.storage);
      let now: string = request.requestedAt;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => now,
        newId: (kind) => `${kind}_unused`,
        async resolveExecutionBindingV04() { return resolvedBinding; },
        async sha256Hex() { return 'a'.repeat(64); },
      });
      const authority = coordinator.admitCanonicalAuthority(authorityRegistration);
      const admitted = await coordinator.admitExecutionRequestV04(admission, authority);
      state.storage.sql.exec(
        'UPDATE outcomes SET revision = revision + 1 WHERE id = ?',
        request.outcome.id,
      );
      state.storage.sql.exec(
        'UPDATE work_units SET revision = revision + 1 WHERE id = ?',
        request.workUnit.id,
      );
      now = '2026-08-13T12:00:00.500Z';
      expect(await coordinator.admitExecutionRequestV04(admission, authority)).toEqual(admitted);
    });
  });

  it('converges concurrent duplicate admission on one persisted command result', async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_instance, state) => {
      provisionDoSchema(state.storage);
      seedCanonicalProductState(state.storage);
      let clockReads = 0;
      let hashCalls = 0;
      let releaseHashes!: () => void;
      const hashesReleased = new Promise<void>((resolve) => {
        releaseHashes = resolve;
      });
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => clockReads++ === 0
          ? request.requestedAt
          : '2026-08-13T12:00:00.500Z',
        newId: (kind) => `${kind}_unused`,
        async resolveExecutionBindingV04() { return resolvedBinding; },
        async sha256Hex() {
          hashCalls += 1;
          if (hashCalls === 4) releaseHashes();
          await hashesReleased;
          return 'a'.repeat(64);
        },
      });
      const authority = coordinator.admitCanonicalAuthority(authorityRegistration);
      const results = await Promise.all([
        coordinator.admitExecutionRequestV04(admission, authority),
        coordinator.admitExecutionRequestV04(admission, authority),
      ]);

      expect(results[1]).toEqual(results[0]);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM planning_execution_requests WHERE protocol_version = '0.4'",
      ).one().count).toBe(1);
    });
  });

  it('rejects caller-authored owner, product, authority, and cancellation presence', async () => {
    const stub = freshStub();
    const proof = await runInDurableObject(stub, async (_instance, state) => {
      provisionDoSchema(state.storage);
      const untrustedModule = new PlanningExecutionModule(state.storage, () => 'event_unused');
      expect(() => untrustedModule.admitExecutionRequestV04InCurrentTransaction({
        request,
        trustedBinding: binding,
        requestDigest: FIXTURE_DIGEST,
        productDigestProof: {
          outcomeMaterial: '{}',
          workUnitMaterial: '{}',
          outcomeDigest: request.outcome.digest,
          workUnitDigest: request.workUnit.digest,
        },
      })).toThrow(/canonical execution binding/i);

      seedCanonicalProductState(state.storage);
      let now: string = request.requestedAt;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => now,
        newId: (kind) => `${kind}_unused`,
        async resolveExecutionBindingV04() { return resolvedBinding; },
        async sha256Hex() { return 'a'.repeat(64); },
      });
      const authority = coordinator.admitCanonicalAuthority(authorityRegistration);
      await expect(coordinator.admitExecutionRequestV04(
        { ...admission, ownerId: 'owner_attacker' } as never,
        authority,
      )).rejects.toThrow(/unrecognized/i);
      await expect(coordinator.admitExecutionRequestV04(
        {
          ...admission,
          authorityCeiling: { ...request.authorityCeiling, tools: ['shell'] },
        } as never,
        authority,
      )).rejects.toThrow(/unrecognized/i);
      await expect(coordinator.admitExecutionRequestV04(
        { ...admission, outcome: { ...request.outcome, digest: `sha256:${'b'.repeat(64)}` } } as never,
        authority,
      )).rejects.toThrow(/unrecognized/i);
      await expect(coordinator.admitExecutionRequestV04(
        {
          ...admission,
          workUnit: { ...request.workUnit, digest: `sha256:${'b'.repeat(64)}` },
        } as never,
        authority,
      )).rejects.toThrow(/unrecognized/i);

      await coordinator.admitExecutionRequestV04(admission, authority);
      now = attempt.updatedAt;
      coordinator.claimExecutionAttemptV04(claimAdmission);
      now = '2026-08-13T12:00:05.000Z';
      await expect(coordinator.cancelExecutionV04({
        request: { ...cancelRequest, presenceRegistrationId: 'presence_attacker' },
        canonicalAuthority: authority,
      })).rejects.toThrow(/authority/i);
      state.storage.sql.exec(
        "UPDATE presence_registrations SET state = 'revoked' WHERE presence_registration_id = ?",
        authority.presenceRegistrationId,
      );
      await expect(coordinator.cancelExecutionV04({
        request: cancelRequest,
        canonicalAuthority: authority,
      })).rejects.toThrow(/authority/i);
      return state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM planning_execution_requests WHERE protocol_version = '0.4'",
      ).one().count;
    });

    expect(proof).toBe(1);
  });

  it('rejects a forged request even when the caller supplies a matching trusted binding', async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_instance, state) => {
      provisionDoSchema(state.storage);
      seedCanonicalProductState(state.storage);
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => request.requestedAt,
        newId: (kind) => `${kind}_unused`,
        async resolveExecutionBindingV04() { return resolvedBinding; },
        async sha256Hex() { return 'a'.repeat(64); },
      });
      const authority = coordinator.admitCanonicalAuthority(authorityRegistration);
      for (const forged of [
        {
          ...admission,
          request: { ...request, provider: { ...request.provider, modelRef: 'model_attacker' } },
          trustedBinding: {
            ...binding,
            provider: { ...binding.provider, modelRef: 'model_attacker' },
          },
        },
        { ...admission, provider: { ...request.provider, modelRef: 'model_attacker' } },
        {
          ...admission,
          environment: {
            ...request.environment,
            manifest: {
              ...request.environment.manifest,
              digest: `sha256:${'b'.repeat(64)}`,
            },
          },
        },
        { ...admission, contextProjectionDigest: `sha256:${'b'.repeat(64)}` },
      ]) {
        await expect(coordinator.admitExecutionRequestV04(
          forged,
          authority,
        )).rejects.toThrow(/unrecognized/i);
      }

      const unavailable = new WaldoCoordinator(state.storage, {
        now: () => request.requestedAt,
        newId: (kind) => `${kind}_unused`,
        async sha256Hex() { return 'a'.repeat(64); },
      });
      await expect(unavailable.admitExecutionRequestV04(admission, authority))
        .rejects.toThrow(/binding authority unavailable/i);

      const categorySubstitution = new WaldoCoordinator(state.storage, {
        now: () => request.requestedAt,
        newId: (kind) => `${kind}_unused`,
        async resolveExecutionBindingV04() {
          return { ...resolvedBinding, provider: request.environment };
        },
        async sha256Hex() { return 'a'.repeat(64); },
      });
      await expect(categorySubstitution.admitExecutionRequestV04(admission, authority))
        .rejects.toThrow();
    });
  });

  it('reasserts current owner authority after asynchronous binding resolution', async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_instance, state) => {
      provisionDoSchema(state.storage);
      seedCanonicalProductState(state.storage);
      let now: string = request.requestedAt;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => now,
        newId: (kind) => `${kind}_unused`,
        async resolveExecutionBindingV04() {
          now = authorityRegistration.authenticatedSessionExpiresAt;
          return resolvedBinding;
        },
        async sha256Hex() { return 'a'.repeat(64); },
      });
      const authority = coordinator.admitCanonicalAuthority(authorityRegistration);

      await expect(coordinator.admitExecutionRequestV04(admission, authority))
        .rejects.toThrow(/authority/i);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM planning_execution_requests WHERE protocol_version = '0.4'",
      ).one().count).toBe(0);
    });
  });

  it('derives observation receipt time from the trusted clock', async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_instance, state) => {
      provisionDoSchema(state.storage);
      seedCanonicalProductState(state.storage);
      let now: string = attempt.updatedAt;
      let advanceDuringHash = false;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => now,
        newId: (kind) => `${kind}_unused`,
        async resolveExecutionBindingV04() { return resolvedBinding; },
        async sha256Hex() {
          if (advanceDuringHash) now = '2026-08-13T12:10:02.000Z';
          return 'a'.repeat(64);
        },
      });
      const authority = coordinator.admitCanonicalAuthority(authorityRegistration);
      now = request.requestedAt;
      await coordinator.admitExecutionRequestV04(admission, authority);
      now = attempt.updatedAt;
      coordinator.claimExecutionAttemptV04(claimAdmission);
      now = observation.observedAt;
      advanceDuringHash = true;
      await expect(coordinator.admitExecutorObservationV04(observation))
        .rejects.toThrow(/observation rejected/i);
    });
  });

  it('rejects a running reconciliation received after lease expiry', async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_instance, state) => {
      provisionDoSchema(state.storage);
      seedCanonicalProductState(state.storage);
      let now: string = attempt.updatedAt;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => now,
        newId: (kind) => `${kind}_unused`,
        async resolveExecutionBindingV04() { return resolvedBinding; },
        async sha256Hex() { return 'a'.repeat(64); },
      });
      const authority = coordinator.admitCanonicalAuthority(authorityRegistration);
      now = request.requestedAt;
      await coordinator.admitExecutionRequestV04(admission, authority);
      now = attempt.updatedAt;
      coordinator.claimExecutionAttemptV04(claimAdmission);
      now = '2026-08-13T12:10:02.000Z';
      await expect(coordinator.reconcileExecutionAttemptV04({
        ...reconciliation,
        state: 'running',
        basisObservationIds: [],
        checkedAt: '2026-08-13T12:10:00.000Z',
      })).rejects.toThrow(/reconciliation state mismatch/i);
    });
  });

  it('rejects an unbounded caller-authored lease expiry', async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_instance, state) => {
      provisionDoSchema(state.storage);
      seedCanonicalProductState(state.storage);
      let now: string = request.requestedAt;
      const coordinator = new WaldoCoordinator(state.storage, {
        now: () => now,
        newId: (kind) => `${kind}_unused`,
        async resolveExecutionBindingV04() { return resolvedBinding; },
        async sha256Hex() { return 'a'.repeat(64); },
      });
      const authority = coordinator.admitCanonicalAuthority(authorityRegistration);
      await coordinator.admitExecutionRequestV04(admission, authority);
      now = attempt.updatedAt;
      expect(() => coordinator.claimExecutionAttemptV04({
        ...claimAdmission,
        expiresAt: '2099-01-01T00:00:00.000Z',
      })).toThrow(/unrecognized/i);
      const aggregate = coordinator.claimExecutionAttemptV04(claimAdmission);
      expect(aggregate.attempts[0]).toMatchObject({
        ownerId: request.ownerId,
        workUnit: request.workUnit,
        provider: request.provider,
        environment: request.environment,
        attemptNumber: 1,
        fencingGeneration: 1,
        cancellationGeneration: 1,
        createdAt: now,
        updatedAt: now,
      });
      expect(aggregate.leases[0]).toMatchObject({
        ownerId: request.ownerId,
        holder: request.environment,
        fencingGeneration: 1,
        cancellationGeneration: 1,
        acquiredAt: now,
        expiresAt: '2026-08-13T12:10:02.000Z',
      });
      now = '2026-08-13T12:00:03.000Z';
      expect(coordinator.claimExecutionAttemptV04(claimAdmission)).toEqual(aggregate);
    });
  });

  it('atomically admits an exact trusted request and replays only the same digest', async () => {
    const stub = freshStub();
    const result = await runInDurableObject(stub, (_instance, state) => {
      const module = writer(state.storage);
      state.storage.transactionSync(() => admit(module));
      state.storage.transactionSync(() => admit(module));
      expect(() => state.storage.transactionSync(() =>
        module.admitExecutionRequestV04InCurrentTransaction({
          request,
          trustedBinding: binding,
          requestDigest: `sha256:${'b'.repeat(64)}`,
          productDigestProof: productDigestProof(module),
        }))).toThrow(/digest conflict/i);
      return module.readExecutionAggregateV04(request.ownerId, request.id);
    });

    expect(executionRequestV04Schema.parse(result.request)).toEqual(request);
    expect(result.attempts).toEqual([]);
  });

  it('rejects changed request content even if an internal caller reuses the stored digest', async () => {
    const stub = freshStub();
    const count = await runInDurableObject(stub, (_instance, state) => {
      const module = writer(state.storage);
      admit(module);
      const changed = { ...request, contextProjectionRef: 'context_changed' };
      expect(() => module.admitExecutionRequestV04InCurrentTransaction({
        request: changed,
        trustedBinding: { ...binding, contextProjectionRef: 'context_changed' },
        requestDigest: FIXTURE_DIGEST,
        productDigestProof: productDigestProof(module),
      })).toThrow(/digest conflict/i);
      return state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM planning_execution_requests WHERE protocol_version = '0.4'",
      ).one().count;
    });

    expect(count).toBe(1);
  });

  it('rejects every trusted binding drift before the first write', async () => {
    const stub = freshStub();
    const result = await runInDurableObject(stub, (_instance, state) => {
      const module = writer(state.storage);
      const cyclicProvider = { ...binding.provider } as Record<string, unknown>;
      cyclicProvider.cycle = cyclicProvider;
      const drifts = [
        { ...binding, routedOwnerId: 'owner_attacker' },
        { ...binding, outcome: { ...binding.outcome, revision: 2 } },
        { ...binding, workUnit: { ...binding.workUnit, digest: `sha256:${'b'.repeat(64)}` } },
        { ...binding, provider: { ...binding.provider, modelRef: 'model_other' } },
        {
          ...binding,
          environment: {
            ...binding.environment,
            manifest: { ...binding.environment.manifest, digest: `sha256:${'b'.repeat(64)}` },
          },
        },
        { ...binding, authorityCeiling: { ...binding.authorityCeiling, tools: ['shell'] } },
        { ...binding, contextProjectionRef: 'context_other' },
        { ...binding, contextProjectionDigest: `sha256:${'b'.repeat(64)}` },
      ];
      for (const trustedBinding of drifts) {
        expect(() => module.admitExecutionRequestV04InCurrentTransaction({
          request,
          trustedBinding,
          requestDigest: FIXTURE_DIGEST,
          productDigestProof: productDigestProof(module),
        })).toThrow(/binding mismatch/i);
      }
      for (const trustedBinding of [
        { ...binding, provider: cyclicProvider as typeof binding.provider },
        { ...binding, contextProjectionRef: 'context_\ud800' },
      ]) {
        expect(() => module.admitExecutionRequestV04InCurrentTransaction({
          request,
          trustedBinding,
          requestDigest: FIXTURE_DIGEST,
          productDigestProof: productDigestProof(module),
        })).toThrow();
      }
      return state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM planning_execution_requests WHERE protocol_version = '0.4'",
      ).one().count;
    });

    expect(result).toBe(0);
  });

  it('keeps provider and execution-environment categories non-substitutable and payload-free', async () => {
    const stub = freshStub();
    const count = await runInDurableObject(stub, (_instance, state) => {
      const module = writer(state.storage);
      for (const hostile of [
        { ...request, provider: request.environment },
        { ...request, environment: request.provider },
        { ...request, credentials: 'secret' },
        { ...request, transcript: 'private transcript' },
      ]) {
        expect(() => module.admitExecutionRequestV04InCurrentTransaction({
          request: hostile,
          trustedBinding: binding,
          requestDigest: FIXTURE_DIGEST,
          productDigestProof: productDigestProof(module),
        })).toThrow();
      }
      return state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM planning_execution_requests WHERE protocol_version = '0.4'",
      ).one().count;
    });

    expect(count).toBe(0);
  });

  it('rolls back request admission with its surrounding transaction', async () => {
    const stub = freshStub();
    const count = await runInDurableObject(stub, (_instance, state) => {
      const module = writer(state.storage);
      expect(() => state.storage.transactionSync(() => {
        admit(module);
        throw new Error('injected failure');
      })).toThrow('injected failure');
      return state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM planning_execution_requests WHERE protocol_version = '0.4'",
      ).one().count;
    });

    expect(count).toBe(0);
  });

  it('atomically claims one exact Attempt, Lease, and Session', async () => {
    const stub = freshStub();
    const aggregate = await runInDurableObject(stub, (_instance, state) => {
      const module = writer(state.storage);
      state.storage.transactionSync(() => {
        admit(module);
        claim(module);
      });
      state.storage.transactionSync(() => claim(module));
      expect(() => state.storage.transactionSync(() =>
        module.claimExecutionAttemptV04InCurrentTransaction({
          attempt: { ...attempt, id: 'attempt_attacker' },
          lease: { ...lease, attemptId: 'attempt_attacker', id: 'lease_attacker' },
          session: { ...session, id: 'session_attacker', attemptId: 'attempt_attacker' },
          claimedAt: attempt.updatedAt,
        }))).toThrow(/already claimed/i);
      return module.readExecutionAggregateV04(request.ownerId, request.id);
    });

    expect(aggregate.attempts).toHaveLength(1);
    expect(executionAttemptV04Schema.parse(aggregate.attempts[0])).toEqual(attempt);
    expect(executionLeaseV04Schema.parse(aggregate.leases[0])).toEqual(lease);
    expect(executionSessionV04Schema.parse(aggregate.sessions[0])).toEqual(session);
  });

  it('rejects a terminal claim or a caller-authored observation high-water mark', async () => {
    const stub = freshStub();
    await runInDurableObject(stub, (_instance, state) => {
      const module = writer(state.storage);
      admit(module);
      expect(() => module.claimExecutionAttemptV04InCurrentTransaction({
        attempt: { ...attempt, state: 'settled' },
        lease,
        session,
        claimedAt: attempt.updatedAt,
      })).toThrow(/claim binding mismatch/i);
      expect(() => module.claimExecutionAttemptV04InCurrentTransaction({
        attempt,
        lease,
        session: { ...session, lastObservationSequence: 9 },
        claimedAt: attempt.updatedAt,
      })).toThrow(/claim binding mismatch/i);
    });
  });

  it('rejects inactive sessions and incoherent or expired claim chronology', async () => {
    const stub = freshStub();
    await runInDurableObject(stub, (_instance, state) => {
      const module = writer(state.storage);
      admit(module);
      for (const invalidClaim of [
        {
          attempt,
          lease,
          session: { ...session, state: 'ended' as const },
          claimedAt: attempt.updatedAt,
        },
        {
          attempt,
          lease: {
            ...lease,
            acquiredAt: '2026-08-13T11:59:00.000Z',
            expiresAt: '2026-08-13T12:09:00.000Z',
          },
          session,
          claimedAt: attempt.updatedAt,
        },
        {
          attempt,
          lease,
          session,
          claimedAt: lease.expiresAt,
        },
        {
          attempt,
          lease: { ...lease, expiresAt: '2099-01-01T00:00:00.000Z' },
          session,
          claimedAt: attempt.updatedAt,
        },
      ]) {
        expect(() => module.claimExecutionAttemptV04InCurrentTransaction(invalidClaim))
          .toThrow(/claim binding mismatch/i);
      }
    });
  });

  it('rejects stale, drifted, late, expired, replayed, and conflicting observations', async () => {
    const stub = freshStub();
    const aggregate = await runInDurableObject(stub, (_instance, state) => {
      const module = writer(state.storage);
      state.storage.transactionSync(() => {
        admit(module);
        claim(module);
        module.admitExecutorObservationV04InCurrentTransaction({
          observation,
          observationDigest: FIXTURE_DIGEST,
          receivedAt: observation.observedAt,
        });
      });
      module.admitExecutorObservationV04InCurrentTransaction({
        observation,
        observationDigest: FIXTURE_DIGEST,
        receivedAt: observation.observedAt,
      });
      expect(() => module.admitExecutorObservationV04InCurrentTransaction({
        observation,
        observationDigest: `sha256:${'b'.repeat(64)}`,
        receivedAt: observation.observedAt,
      })).toThrow(/digest conflict/i);
      expect(() => module.admitExecutorObservationV04InCurrentTransaction({
        observation: { ...observation, kind: 'failed' },
        observationDigest: FIXTURE_DIGEST,
        receivedAt: observation.observedAt,
      })).toThrow(/digest conflict/i);
      const rejected = [
        { value: { ...observation, id: 'observation_stale', fencingGeneration: 2 }, receivedAt: observation.observedAt },
        {
          value: {
            ...observation,
            id: 'observation_drifted',
            sequence: 2,
            environment: { ...observation.environment, environmentKind: 'cloud' as const },
          },
          receivedAt: observation.observedAt,
        },
        {
          value: { ...observation, id: 'observation_late', sequence: 2, observedAt: '2026-08-13T12:00:04.001Z' },
          receivedAt: '2026-08-13T12:00:04.000Z',
        },
        {
          value: { ...observation, id: 'observation_expired', sequence: 2, observedAt: lease.expiresAt },
          receivedAt: lease.expiresAt,
        },
        { value: { ...observation, id: 'observation_replay' }, receivedAt: observation.observedAt },
      ];
      for (const item of rejected) {
        expect(() => module.admitExecutorObservationV04InCurrentTransaction({
          observation: item.value,
          observationDigest: `sha256:${'c'.repeat(64)}`,
          receivedAt: item.receivedAt,
        })).toThrow(/observation rejected/i);
      }
      return module.readExecutionAggregateV04(request.ownerId, request.id);
    });

    expect(aggregate.observations).toHaveLength(1);
    expect(aggregate.sessions[0]?.lastObservationSequence).toBe(1);
    expect(aggregate.sessions[0]?.state).toBe('ended');
    expect(aggregate.attempts[0]?.state).toBe('settling');
  });

  it('does not let a later observation reopen a terminal execution activity state', async () => {
    const stub = freshStub();
    const aggregate = await runInDurableObject(stub, (_instance, state) => {
      const module = writer(state.storage);
      admit(module);
      claim(module);
      module.admitExecutorObservationV04InCurrentTransaction({
        observation,
        observationDigest: FIXTURE_DIGEST,
        receivedAt: observation.observedAt,
      });
      expect(() => module.admitExecutorObservationV04InCurrentTransaction({
        observation: {
          ...observation,
          id: 'observation_after_ended',
          sequence: 2,
          kind: 'activity',
          observedAt: '2026-08-13T12:00:04.000Z',
        },
        observationDigest: `sha256:${'e'.repeat(64)}`,
        receivedAt: '2026-08-13T12:00:04.000Z',
      })).toThrow(/observation rejected/i);
      return module.readExecutionAggregateV04(request.ownerId, request.id);
    });

    expect(aggregate.observations).toHaveLength(1);
    expect(aggregate.attempts[0]?.state).toBe('settling');
  });

  it('does not let indeterminate reconciliation overwrite terminal executor output', async () => {
    const stub = freshStub();
    const aggregate = await runInDurableObject(stub, (_instance, state) => {
      const module = writer(state.storage);
      admit(module);
      claim(module);
      module.admitExecutorObservationV04InCurrentTransaction({
        observation,
        observationDigest: FIXTURE_DIGEST,
        receivedAt: observation.observedAt,
      });
      expect(() => reconcile(module, {
        reconciliation: {
          ...reconciliation,
          state: 'indeterminate',
          basisObservationIds: [],
        },
        reconciliationDigest: `sha256:${'b'.repeat(64)}`,
      })).toThrow(/reconciliation state mismatch/i);
      return module.readExecutionAggregateV04(request.ownerId, request.id);
    });

    expect(aggregate.attempts[0]?.state).toBe('settling');
    expect(aggregate.sessions[0]?.state).toBe('ended');
    expect(aggregate.reconciliations).toEqual([]);
  });

  it('fences late output after cancellation and settles only execution activity by reconciliation', async () => {
    const stub = freshStub();
    const aggregate = await runInDurableObject(stub, (_instance, state) => {
      const module = writer(state.storage);
      state.storage.transactionSync(() => {
        admit(module);
        claim(module);
        module.cancelExecutionV04InCurrentTransaction({
          ownerId: request.ownerId,
          request: cancelRequest,
          requestDigest: FIXTURE_DIGEST,
          at: '2026-08-13T12:00:04.000Z',
        });
      });
      expect(module.cancelExecutionV04InCurrentTransaction({
        ownerId: request.ownerId,
        request: cancelRequest,
        requestDigest: FIXTURE_DIGEST,
        at: '2026-08-13T12:00:04.000Z',
      })).toBe(2);
      const cancelled = module.readExecutionAggregateV04(request.ownerId, request.id);
      expect(cancelled.attempts[0]?.cancellationGeneration).toBe(2);
      expect(cancelled.leases[0]?.cancellationGeneration).toBe(2);
      expect(cancelled.sessions[0]?.state).toBe('unknown');
      expect(() => module.cancelExecutionV04InCurrentTransaction({
        ownerId: request.ownerId,
        request: cancelRequest,
        requestDigest: `sha256:${'b'.repeat(64)}`,
        at: '2026-08-13T12:00:04.000Z',
      })).toThrow(/digest conflict/i);
      expect(() => module.admitExecutorObservationV04InCurrentTransaction({
        observation,
        observationDigest: FIXTURE_DIGEST,
        receivedAt: observation.observedAt,
      })).toThrow(/observation rejected/i);
      expect(() => reconcile(module, {
        reconciliation: { ...reconciliation, state: 'settled', basisObservationIds: [] },
        reconciliationDigest: `sha256:${'e'.repeat(64)}`,
      })).toThrow(/reconciliation binding mismatch/i);
      expect(() => reconcile(module, {
        reconciliation: {
          ...reconciliation,
          state: 'indeterminate',
          cancellationGeneration: 2,
          basisObservationIds: [],
        },
        reconciliationDigest: `sha256:${'e'.repeat(64)}`,
      })).toThrow(/reconciliation state mismatch/i);
      reconcile(module, {
        reconciliation: {
          ...reconciliation,
          state: 'cancelled',
          cancellationGeneration: 2,
          basisObservationIds: [],
        },
        reconciliationDigest: FIXTURE_DIGEST,
      });
      return module.readExecutionAggregateV04(request.ownerId, request.id);
    });

    expect(aggregate.request.cancellationGeneration).toBe(1);
    expect(aggregate.currentCancellationGeneration).toBe(2);
    expect(aggregate.attempts[0]?.state).toBe('cancelled');
    expect(aggregate.sessions[0]?.state).toBe('ended');
    expect(aggregate.reconciliations).toHaveLength(1);
  });

  it('conflicts when one cancellation command ID is reused for another execution request', async () => {
    const stub = freshStub();
    const aggregate = await runInDurableObject(stub, (_instance, state) => {
      const module = writer(state.storage);
      const secondRequest = executionRequestV04Schema.parse({
        ...request,
        id: 'execution_request_second',
        outcome: { ...request.outcome, id: 'outcome_second' },
        workUnit: { ...request.workUnit, id: 'work_unit_second' },
      });
      const secondBinding = {
        ...binding,
        outcome: secondRequest.outcome,
        workUnit: secondRequest.workUnit,
      };
      seedCanonicalProductState(state.storage, secondRequest);
      admit(module);
      module.admitExecutionRequestV04InCurrentTransaction({
        request: secondRequest,
        trustedBinding: secondBinding,
        requestDigest: `sha256:${'b'.repeat(64)}`,
        productDigestProof: productDigestProof(module, secondRequest),
      });
      module.cancelExecutionV04InCurrentTransaction({
        ownerId: request.ownerId,
        request: cancelRequest,
        requestDigest: FIXTURE_DIGEST,
        at: '2026-08-13T12:00:05.000Z',
      });
      expect(() => module.cancelExecutionV04InCurrentTransaction({
        ownerId: request.ownerId,
        request: {
          ...cancelRequest,
          executionRequestId: secondRequest.id,
        },
        requestDigest: `sha256:${'c'.repeat(64)}`,
        at: '2026-08-13T12:00:05.000Z',
      })).toThrow(/digest conflict/i);
      return module.readExecutionAggregateV04(secondRequest.ownerId, secondRequest.id);
    });

    expect(aggregate.currentCancellationGeneration).toBe(1);
  });

  it('represents running reconciliation without minting a new request state', async () => {
    const stub = freshStub();
    const aggregate = await runInDurableObject(stub, (_instance, state) => {
      const module = writer(state.storage);
      admit(module);
      claim(module);
      reconcile(module, {
        reconciliation: { ...reconciliation, state: 'running', basisObservationIds: [] },
        reconciliationDigest: FIXTURE_DIGEST,
      });
      return module.readExecutionAggregateV04(request.ownerId, request.id);
    });

    expect(aggregate.attempts[0]?.state).toBe('running');
    expect(aggregate.reconciliations[0]?.state).toBe('running');
  });

  it('keeps timeout indeterminate until reconciliation proves a terminal state', async () => {
    const stub = freshStub();
    const aggregate = await runInDurableObject(stub, (_instance, state) => {
      const module = writer(state.storage);
      admit(module);
      claim(module);
      module.admitExecutorObservationV04InCurrentTransaction({
        observation: { ...observation, kind: 'timed_out' },
        observationDigest: FIXTURE_DIGEST,
        receivedAt: observation.observedAt,
      });
      return module.readExecutionAggregateV04(request.ownerId, request.id);
    });

    expect(aggregate.attempts[0]?.state).toBe('indeterminate');
    expect(aggregate.sessions[0]?.state).toBe('lost');
  });

  it('rejects unsupported or time-travelling reconciliation and never reopens terminal output', async () => {
    const stub = freshStub();
    const aggregate = await runInDurableObject(stub, (_instance, state) => {
      const module = writer(state.storage);
      admit(module);
      claim(module);
      expect(() => reconcile(module, {
        reconciliation: {
          ...reconciliation,
          state: 'failed',
          basisObservationIds: [],
          checkedAt: '2026-08-13T12:00:03.000Z',
        },
        reconciliationDigest: FIXTURE_DIGEST,
      })).toThrow(/reconciliation (state|basis)/i);
      expect(() => reconcile(module, {
        reconciliation: {
          ...reconciliation,
          id: 'reconciliation_before_attempt',
          state: 'running',
          basisObservationIds: [],
          checkedAt: '2026-08-13T12:00:00.000Z',
        },
        reconciliationDigest: `sha256:${'b'.repeat(64)}`,
      })).toThrow(/reconciliation chronology/i);
      expect(() => reconcile(module, {
        reconciliation: {
          ...reconciliation,
          id: 'reconciliation_future_expiry_claim',
          state: 'failed',
          basisObservationIds: [],
          checkedAt: '2026-08-13T12:10:30.000Z',
        },
        reconciliationDigest: `sha256:${'b'.repeat(64)}`,
      }, '2026-08-13T12:00:04.000Z')).toThrow(/reconciliation chronology/i);

      module.admitExecutorObservationV04InCurrentTransaction({
        observation,
        observationDigest: FIXTURE_DIGEST,
        receivedAt: observation.observedAt,
      });
      expect(() => reconcile(module, {
        reconciliation: {
          ...reconciliation,
          id: 'reconciliation_reopens_ended',
          state: 'running',
          basisObservationIds: [],
        },
        reconciliationDigest: `sha256:${'c'.repeat(64)}`,
      })).toThrow(/reconciliation state/i);
      reconcile(module, {
        reconciliation: { ...reconciliation, state: 'settled' },
        reconciliationDigest: `sha256:${'d'.repeat(64)}`,
      });
      return module.readExecutionAggregateV04(request.ownerId, request.id);
    });

    expect(aggregate.attempts[0]?.state).toBe('settled');
    expect(aggregate.sessions[0]?.state).toBe('ended');
  });

  it('does not let the legacy v0.3 control path mutate a v0.4 aggregate', async () => {
    const stub = freshStub();
    const aggregate = await runInDurableObject(stub, (_instance, state) => {
      const module = writer(state.storage);
      admit(module);
      claim(module);
      expect(() => module.cancelInCurrentTransaction({
        ownerId: request.ownerId,
        requestId: 'legacy_cancel_attack',
        requestDigest: FIXTURE_DIGEST,
        executionRequestId: request.id,
        expectedCancellationGeneration: request.cancellationGeneration,
        at: '2026-08-13T12:00:03.000Z',
      })).toThrow(/planning execution not found/i);
      return module.readExecutionAggregateV04(request.ownerId, request.id);
    });

    expect(aggregate.currentCancellationGeneration).toBe(1);
    expect(aggregate.attempts[0]?.state).toBe('running');
  });

  it('requires reconciliation before a monotonically fenced retry attempt', async () => {
    const stub = freshStub();
    const aggregate = await runInDurableObject(stub, (_instance, state) => {
      const module = writer(state.storage);
      admit(module);
      claim(module);
      const attempt2 = {
        ...attempt,
        id: 'attempt_retry',
        attemptNumber: 2,
        leaseId: 'lease_retry',
        fencingGeneration: 2,
        createdAt: '2026-08-13T12:11:00.000Z',
        updatedAt: '2026-08-13T12:11:00.000Z',
      };
      const lease2 = {
        ...lease,
        id: 'lease_retry',
        attemptId: 'attempt_retry',
        fencingGeneration: 2,
        acquiredAt: '2026-08-13T12:11:00.000Z',
        expiresAt: '2026-08-13T12:21:00.000Z',
      };
      const session2 = {
        ...session,
        id: 'session_retry',
        attemptId: 'attempt_retry',
        providerSessionRef: null,
        state: 'starting' as const,
      };
      expect(() => module.claimExecutionAttemptV04InCurrentTransaction({
        attempt: attempt2,
        lease: lease2,
        session: session2,
        claimedAt: attempt2.updatedAt,
      })).toThrow(/already claimed/i);
      reconcile(module, {
        reconciliation: { ...reconciliation, state: 'indeterminate', basisObservationIds: [] },
        reconciliationDigest: FIXTURE_DIGEST,
      });
      expect(() => module.claimExecutionAttemptV04InCurrentTransaction({
        attempt: attempt2,
        lease: lease2,
        session: session2,
        claimedAt: attempt2.updatedAt,
      })).toThrow(/already claimed/i);
      reconcile(module, {
        reconciliation: {
          ...reconciliation,
          id: 'reconciliation_failed',
          state: 'failed',
          basisObservationIds: [],
          checkedAt: '2026-08-13T12:10:30.000Z',
        },
        reconciliationDigest: `sha256:${'f'.repeat(64)}`,
      });
      module.claimExecutionAttemptV04InCurrentTransaction({
        attempt: attempt2,
        lease: lease2,
        session: session2,
        claimedAt: attempt2.updatedAt,
      });
      expect(() => reconcile(module, {
        reconciliation: {
          ...reconciliation,
          id: 'reconciliation_late_old_attempt',
          state: 'settled',
          basisObservationIds: [],
          checkedAt: '2026-08-13T12:12:00.000Z',
        },
        reconciliationDigest: `sha256:${'e'.repeat(64)}`,
      })).toThrow(/reconciliation rejected/i);
      module.cancelExecutionV04InCurrentTransaction({
        ownerId: request.ownerId,
        request: cancelRequest,
        requestDigest: FIXTURE_DIGEST,
        at: '2026-08-13T12:11:01.000Z',
      });
      return module.readExecutionAggregateV04(request.ownerId, request.id);
    });

    expect(aggregate.attempts.map((value) => value.attemptNumber)).toEqual([1, 2]);
    expect(aggregate.leases.map((value) => value.fencingGeneration)).toEqual([1, 2]);
    expect(aggregate.attempts.map((value) => value.cancellationGeneration)).toEqual([1, 2]);
    expect(aggregate.leases.map((value) => value.cancellationGeneration)).toEqual([1, 2]);
    expect(aggregate.sessions.map((value) => value.state)).toEqual(['ended', 'unknown']);
  });

  it('does not let cancellation regress a reconciled terminal attempt', async () => {
    const stub = freshStub();
    await runInDurableObject(stub, (_instance, state) => {
      const module = writer(state.storage);
      admit(module);
      claim(module);
      module.admitExecutorObservationV04InCurrentTransaction({
        observation,
        observationDigest: FIXTURE_DIGEST,
        receivedAt: observation.observedAt,
      });
      reconcile(module, {
        reconciliation: { ...reconciliation, state: 'settled' },
        reconciliationDigest: FIXTURE_DIGEST,
      });
      expect(() => reconcile(module, {
        reconciliation: {
          ...reconciliation,
          id: 'reconciliation_reopen_terminal',
          state: 'running',
          basisObservationIds: [],
          checkedAt: '2026-08-13T12:00:04.500Z',
        },
        reconciliationDigest: `sha256:${'e'.repeat(64)}`,
      })).toThrow(/reconciliation rejected/i);
      expect(() => module.cancelExecutionV04InCurrentTransaction({
        ownerId: request.ownerId,
        request: cancelRequest,
        requestDigest: FIXTURE_DIGEST,
        at: '2026-08-13T12:00:05.000Z',
      })).toThrow(/cancellation rejected/i);
    });
  });

  it('keeps Outcome and WorkUnit truth byte-stable when execution settles', async () => {
    const stub = freshStub();
    const result = await runInDurableObject(stub, (_instance, state) => {
      const module = writer(state.storage);
      const sql = state.storage.sql;
      const before = {
        outcome: sql.exec('SELECT * FROM outcomes').one(),
        workUnit: sql.exec('SELECT * FROM work_units').one(),
      };
      admit(module);
      claim(module);
      module.admitExecutorObservationV04InCurrentTransaction({
        observation,
        observationDigest: FIXTURE_DIGEST,
        receivedAt: observation.observedAt,
      });
      reconcile(module, {
        reconciliation: { ...reconciliation, state: 'settled' },
        reconciliationDigest: FIXTURE_DIGEST,
      });
      return {
        before,
        after: {
          outcome: sql.exec('SELECT * FROM outcomes').one(),
          workUnit: sql.exec('SELECT * FROM work_units').one(),
        },
      };
    });

    expect(result.after).toEqual(result.before);
  });

  it('reconstructs the same contract records for independent fake consumers after restart', async () => {
    const stub = freshStub();
    const first = await runInDurableObject(stub, (_instance, state) => {
      const module = writer(state.storage);
      state.storage.transactionSync(() => {
        admit(module);
        claim(module);
      });
      return module.readExecutionAggregateV04(request.ownerId, request.id);
    });
    const restarted = await runInDurableObject(stub, (_instance, state) =>
      writer(state.storage).readExecutionAggregateV04(request.ownerId, request.id));

    const consumers = [
      (value: typeof restarted) => executionRequestV04Schema.parse(value.request),
      (value: typeof restarted) => executionAttemptV04Schema.parse(value.attempts[0]),
      (value: typeof restarted) => executionLeaseV04Schema.parse(value.leases[0]),
      (value: typeof restarted) => executionSessionV04Schema.parse(value.sessions[0]),
    ];
    expect(consumers.map((consume) => consume(JSON.parse(JSON.stringify(restarted)))))
      .toEqual([request, attempt, lease, session]);
    expect(restarted).toEqual(first);
  });

  it('round-trips every mutable aggregate record through independent contract consumers', async () => {
    const stub = freshStub();
    const aggregate = await runInDurableObject(stub, (_instance, state) => {
      const module = writer(state.storage);
      admit(module);
      claim(module);
      module.admitExecutorObservationV04InCurrentTransaction({
        observation,
        observationDigest: FIXTURE_DIGEST,
        receivedAt: observation.observedAt,
      });
      reconcile(module, {
        reconciliation: { ...reconciliation, state: 'settled' },
        reconciliationDigest: FIXTURE_DIGEST,
      });
      return module.readExecutionAggregateV04(request.ownerId, request.id);
    });
    const transported = JSON.parse(JSON.stringify(aggregate)) as typeof aggregate;

    expect(executionRequestV04Schema.safeParse(transported.request).success).toBe(true);
    expect(executionAttemptV04Schema.safeParse(transported.attempts[0]).success).toBe(true);
    expect(executionLeaseV04Schema.safeParse(transported.leases[0]).success).toBe(true);
    expect(executionSessionV04Schema.safeParse(transported.sessions[0]).success).toBe(true);
    expect(executorObservationV04Schema.safeParse(transported.observations[0]).success).toBe(true);
    expect(executionReconciliationV04Schema.safeParse(
      transported.reconciliations[0],
    ).success).toBe(true);
  });

  it('property-checks that no stale or non-increasing sequence advances the high-water mark', async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 1_000 }), async (sequenceValue) => {
      const stub = freshStub();
      const highWater = await runInDurableObject(stub, (_instance, state) => {
        const module = writer(state.storage);
        state.storage.transactionSync(() => {
          admit(module);
          claim(module);
          module.admitExecutorObservationV04InCurrentTransaction({
            observation: { ...observation, sequence: sequenceValue },
            observationDigest: FIXTURE_DIGEST,
            receivedAt: observation.observedAt,
          });
        });
        const staleSequence = Math.max(1, sequenceValue - 1);
        expect(() => module.admitExecutorObservationV04InCurrentTransaction({
          observation: { ...observation, id: `replay_${sequenceValue}`, sequence: staleSequence },
          observationDigest: `sha256:${'d'.repeat(64)}`,
          receivedAt: observation.observedAt,
        })).toThrow(/observation rejected/i);
        return module.readExecutionAggregateV04(request.ownerId, request.id)
          .sessions[0]!.lastObservationSequence;
      });
      expect(highWater).toBe(sequenceValue);
    }), { numRuns: 20 });
  });
});
