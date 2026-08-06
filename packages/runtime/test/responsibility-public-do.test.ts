import {
  canonicalizeResponsibilityCaptureTrustedEnvelopeForDigest,
  canonicalizeResponsibilityCaptureRequestV02ForDigest,
  canonicalizeResponsibilityCaptureTrustedEnvelopeV02ForDigest,
  canonicalizeSurfaceCommandRequestForDigest,
  responsibilityCaptureRequestSchema,
  responsibilityCaptureTrustedEnvelopeSchema,
  responsibilityCaptureRequestV02Schema,
  responsibilityCaptureTrustedEnvelopeV02Schema,
} from '@waldo/contracts';
import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { responsibilityOwnerRootName } from '../src/index';
import {
  signResponsibilityIngress,
  type SignedResponsibilityIngressContext,
} from '../src/responsibility/ingress-signature';
import type { RunLoopDO } from '../src/run-loop/do';

let sequence = 0;
const TEST_INGRESS_SECRET = 'test-responsibility-ingress-hmac-secret-000000000000';
const ingress = {
  authenticatedSessionId: `authenticated_session_${'a'.repeat(64)}`,
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
  const name = `${await responsibilityOwnerRootName(ownerId, 2)}:test:${sequence}`;
  return env.RUN_LOOP_DO.get(env.RUN_LOOP_DO.idFromName(name));
}

describe('production responsibility RunLoopDO RPC', () => {
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

  it('rejects session/policy substitution before owner state is admitted', async () => {
    const ownerId = 'owner_public_authority_01';
    const stub = await stubFor(ownerId);
    const input = await admission(ownerId, 'request_public_authority_01');
    const changedIngress = await signedCaptureIngress(ownerId, input, {
      ownerPolicyRevision: ingress.ownerPolicyRevision + 1,
    });
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.captureResponsibilityFromWorker(input, changedIngress))
        .rejects.toThrow('authority mismatch');
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
    await runInDurableObject(stub, async (instance) => {
      await expect(Promise.resolve().then(() =>
        instance.readResponsibilityProjectionFromWorker({
          routedOwnerId: ownerId, ...projectionInput,
        }, projectionIngress),
      )).rejects.toThrow('rate limited');
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
    await runInDurableObject(stub, async (instance) => {
      await expect(Promise.resolve().then(() => instance.readResponsibilityProjectionFromWorker({
        routedOwnerId: ownerId, ...projectionInput,
      }, overflow))).rejects.toThrow('rate limited');
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

  it('derives stable, owner- and version-isolated routing names', async () => {
    const first = await responsibilityOwnerRootName('owner_route_01', 2);
    expect(await responsibilityOwnerRootName('owner_route_01', 2)).toBe(first);
    expect(await responsibilityOwnerRootName('owner_route_02', 2)).not.toBe(first);
    expect(await responsibilityOwnerRootName('owner_route_01', 3)).not.toBe(first);
    expect(first).not.toContain('owner_route_01');
  });
});

async function signedCaptureIngress(
  ownerId: string,
  input: Awaited<ReturnType<typeof admission>>,
  overrides: Partial<typeof ingress> = {},
  signature: Readonly<{ issuedAt?: number; secret?: string }> = {},
): Promise<SignedResponsibilityIngressContext> {
  return signResponsibilityIngress({
    context: {
      ...ingress,
      ...overrides,
      ownerId,
      presenceId: 'presence_01',
      presenceRegistrationId: 'presence_registration_01',
      ownerRootRoutingVersion: 2,
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
  overrides: Partial<typeof ingress> = {},
): Promise<SignedResponsibilityIngressContext> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([
    input.protocolVersion, input.fromExclusiveCursor, input.limit, input.snapshotId ?? null,
  ])));
  return signResponsibilityIngress({
    context: {
      ...ingress,
      ...overrides,
      ownerId,
      presenceId: 'presence_01',
      presenceRegistrationId: 'presence_registration_01',
      ownerRootRoutingVersion: 2,
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

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
