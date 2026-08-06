import {
  canonicalizeResponsibilityCaptureRequestV02ForDigest,
  canonicalizeSurfaceCommandRequestForDigest,
  responsibilityHttpMediaTypeV01,
  responsibilityHttpMediaTypeV02,
  responsibilityHttpProblemV01,
  responsibilityCaptureRequestSchema,
  responsibilityCaptureRequestV02Schema,
  responsibilityCaptureResultV01CompatibilitySchema,
  responsibilityCaptureResultV02Schema,
  responsibilityCaptureTrustedEnvelopeSchema,
  responsibilityCaptureTrustedEnvelopeV02Schema,
  responsibilityProjectionPageV01CompatibilitySchema,
  responsibilityProjectionPageV02Schema,
  type ActorRef,
} from '@waldo/contracts';
import type {
  ResponsibilityCaptureAdmission,
  ResponsibilityProjectionRead,
} from '../coordinator/waldo-coordinator';
import { responsibilityBoundaryStatus } from './errors';
import { parseResponsibilityJsonBytes, readBoundedResponsibilityBody } from './raw-json';

export type ResponsibilityProtocolVersion = '0.1' | '0.2';

export type TrustedResponsibilityContext = Readonly<{
  ownerId: string;
  authenticatedSubjectRef: string;
  actor: ActorRef;
  presenceId: string;
  presenceRegistrationId: string;
  authenticatedSessionId: string;
  authenticatedSessionExpiresAt: string;
  ownerPolicyRevision: number;
  authAssurance: string;
  ownerRootRoutingVersion: number;
}>;

export interface ResponsibilityAuthority {
  authenticate(request: Request): Promise<TrustedResponsibilityContext | null>;
}

export interface ResponsibilityOwnerRoot {
  capture(input: ResponsibilityCaptureAdmission, ingress: ResponsibilityIngressContext): Promise<unknown>;
  readProjection(input: ResponsibilityProjectionRead, ingress: ResponsibilityIngressContext): Promise<unknown>;
}

export type ResponsibilityIngressContext = Readonly<{
  authenticatedSubjectRef: string;
  authenticatedSessionId: string;
  authenticatedSessionExpiresAt: string;
  ownerPolicyRevision: number;
}>;

export interface ResponsibilityWorkerAdapter {
  fetch(request: Request): Promise<Response>;
}

export type ResponsibilityWorkerAdapterDependencies = Readonly<{
  authority: ResponsibilityAuthority;
  edgeRateLimit: Readonly<{ admit(request: Request): Promise<boolean> }>;
  failureReporter: Readonly<{
    report(code: 'edge_rate_unavailable' | 'authority_unavailable' | 'owner_root_failure', error: unknown): void;
  }>;
  ownerRootFor(context: TrustedResponsibilityContext): Promise<ResponsibilityOwnerRoot>;
  now: () => string;
  newId(kind: 'command' | 'correlation'): string;
}>;

const CAPTURE_PATH = '/public/responsibilities';
const PROJECTION_PATH = '/public/responsibilities/projection';
const MEDIA_TYPES: Readonly<Record<ResponsibilityProtocolVersion, string>> = Object.freeze({
  '0.1': responsibilityHttpMediaTypeV01,
  '0.2': responsibilityHttpMediaTypeV02,
});

export function createResponsibilityWorkerAdapter(
  dependencies: ResponsibilityWorkerAdapterDependencies,
): ResponsibilityWorkerAdapter {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const capture = request.method === 'POST' && url.pathname === CAPTURE_PATH;
      const projection = request.method === 'GET' && url.pathname === PROJECTION_PATH;
      if (!capture && !projection) return problem(404);

      const version = selectedVersion(request.headers.get('accept'));
      if (version === null) return problem(406);
      if (capture && normalizedMediaType(request.headers.get('content-type')) !== MEDIA_TYPES[version]) {
        return problem(406);
      }
      if (capture && ![null, 'identity'].includes(request.headers.get('content-encoding'))) {
        return problem(400);
      }
      try {
        if (!(await dependencies.edgeRateLimit.admit(request))) return problem(429);
      } catch (error) {
        dependencies.failureReporter.report('edge_rate_unavailable', error);
        return problem(503);
      }
      if (capture && url.search !== '') return problem(400);
      if (projection && (
        url.search.length > 1_024 || boundedQueryParameterCount(url.searchParams, 3) === null
      )) return problem(400);

      let body: unknown = null;
      if (capture) {
        const declaredLength = request.headers.get('content-length');
        if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > 24_576)) {
          return problem(400);
        }
        try {
          body = parseResponsibilityJsonBytes(await readBoundedResponsibilityBody(request));
        } catch {
          return problem(400);
        }
      }

      let context: TrustedResponsibilityContext | null;
      try {
        context = await dependencies.authority.authenticate(request);
      } catch (error) {
        dependencies.failureReporter.report('authority_unavailable', error);
        return problem(503);
      }
      if (context === null) return problem(401);

      try {
        if (capture) {
          const requestSchema = version === '0.1'
            ? responsibilityCaptureRequestSchema
            : responsibilityCaptureRequestV02Schema;
          const parsed = requestSchema.safeParse(body);
          if (!parsed.success) {
            const bodyVersion = isRecord(body) ? body.protocolVersion : undefined;
            return bodyVersion !== undefined && bodyVersion !== version ? problem(406) : problem(400);
          }
          if (parsed.data.presenceRegistrationId !== context.presenceRegistrationId) {
            return problem(401);
          }
          if (parsed.data.aggregate !== undefined) return problem(400);
          const ownerRoot = await dependencies.ownerRootFor(context);
          const canonical = version === '0.1'
            ? canonicalizeSurfaceCommandRequestForDigest(parsed.data)
            : canonicalizeResponsibilityCaptureRequestV02ForDigest(parsed.data);
          const requestDigest = `sha256:${await sha256Hex(canonical)}` as const;
          const envelopeBase = {
            protocolVersion: version,
            commandId: dependencies.newId('command'),
            commandType: 'responsibility.capture' as const,
            ownerId: context.ownerId,
            actor: context.actor,
            presenceId: context.presenceId,
            authenticatedSessionId: context.authenticatedSessionId,
            ownerPolicyRevision: context.ownerPolicyRevision,
            authAssurance: context.authAssurance,
            ownerRootRoutingVersion: context.ownerRootRoutingVersion,
            requestDigest,
            correlationId: parsed.data.correlationId ?? dependencies.newId('correlation'),
            receivedAt: dependencies.now(),
            payload: parsed.data.payload,
          };
          const trustedEnvelope = version === '0.1'
            ? responsibilityCaptureTrustedEnvelopeSchema.parse(envelopeBase)
            : responsibilityCaptureTrustedEnvelopeV02Schema.parse(envelopeBase);
          const result = await ownerRoot.capture(
            {
              routedOwnerId: context.ownerId,
              request: parsed.data,
              trustedEnvelope,
            },
            ingressContext(context),
          );
          const publicResult = version === '0.1'
            ? responsibilityCaptureResultV01CompatibilitySchema.parse(result)
            : responsibilityCaptureResultV02Schema.parse(result);
          if (publicResult.ownerId !== context.ownerId || publicResult.protocolVersion !== version) {
            throw new Error('responsibility response authority mismatch');
          }
          return json(publicResult, 201, version);
        }

        const queryKeys = [...url.searchParams.keys()];
        if (queryKeys.some((key) =>
          !['fromExclusiveCursor', 'limit', 'snapshotId'].includes(key))) {
          return problem(400);
        }
        if (
          url.searchParams.getAll('fromExclusiveCursor').length !== 1 ||
          url.searchParams.getAll('limit').length !== 1 ||
          url.searchParams.getAll('snapshotId').length > 1
        ) return problem(400);
        const cursor = boundedInteger(url.searchParams.get('fromExclusiveCursor'), 0, Number.MAX_SAFE_INTEGER);
        const limit = boundedInteger(url.searchParams.get('limit'), 1, 256);
        if (cursor === null || limit === null) return problem(400);
        const snapshotId = url.searchParams.get('snapshotId');
        if (snapshotId !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(snapshotId)) {
          return problem(400);
        }
        const ownerRoot = await dependencies.ownerRootFor(context);
        const result = await ownerRoot.readProjection(
          {
            routedOwnerId: context.ownerId,
            protocolVersion: version,
            fromExclusiveCursor: cursor,
            limit,
            ...(snapshotId === null ? {} : { snapshotId }),
          },
          ingressContext(context),
        );
        const publicResult = version === '0.1'
          ? responsibilityProjectionPageV01CompatibilitySchema.parse(result)
          : responsibilityProjectionPageV02Schema.parse(result);
        if (publicResult.ownerId !== context.ownerId || publicResult.protocolVersion !== version) {
          throw new Error('responsibility response authority mismatch');
        }
        return json(publicResult, 200, version);
      } catch (error) {
        const publicStatus = responsibilityBoundaryStatus(error);
        if (publicStatus !== null) return problem(publicStatus);
        dependencies.failureReporter.report('owner_root_failure', error);
        return problem(500);
      }
    },
  };
}

function selectedVersion(accept: string | null): ResponsibilityProtocolVersion | null {
  const mediaType = accept?.trim().toLowerCase() ?? null;
  if (mediaType === MEDIA_TYPES['0.1']) return '0.1';
  if (mediaType === MEDIA_TYPES['0.2']) return '0.2';
  return null;
}

function normalizedMediaType(value: string | null): string | null {
  return value?.split(';', 1)[0]?.trim().toLowerCase() ?? null;
}

function boundedInteger(value: string | null, minimum: number, maximum: number): number | null {
  if (value === null || !/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function boundedQueryParameterCount(
  parameters: URLSearchParams,
  maximum: number,
): number | null {
  let count = 0;
  for (const _entry of parameters) {
    count += 1;
    if (count > maximum) return null;
  }
  return count;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function json(body: unknown, status: number, version: ResponsibilityProtocolVersion): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'cache-control': 'private, no-store',
      'content-type': `${MEDIA_TYPES[version]}; charset=utf-8`,
      'vary': 'Authorization, Accept',
      'waldo-offline-commands': 'none',
      'waldo-protocol-version': version,
    },
  });
}

function problem(status: 400 | 401 | 404 | 406 | 409 | 429 | 500 | 503): Response {
  return new Response(JSON.stringify(responsibilityHttpProblemV01(status)), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/problem+json; charset=utf-8',
      ...(status === 429 ? { 'retry-after': '60' } : {}),
      'vary': 'Authorization, Accept',
    },
  });
}

function ingressContext(context: TrustedResponsibilityContext): ResponsibilityIngressContext {
  return Object.freeze({
    authenticatedSubjectRef: context.authenticatedSubjectRef,
    authenticatedSessionId: context.authenticatedSessionId,
    authenticatedSessionExpiresAt: context.authenticatedSessionExpiresAt,
    ownerPolicyRevision: context.ownerPolicyRevision,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
