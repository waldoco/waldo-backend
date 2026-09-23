import {
  canonicalizeResponsibilityCaptureRequestV02ForDigest,
  canonicalizeSurfaceCommandRequestForDigest,
  responsibilityHttpMediaTypeV01,
  responsibilityHttpMediaTypeV02,
  responsibilityHttpMediaTypeV03,
  responsibilityExecutionHttpMediaTypeV04,
  responsibilityHttpProblemV01,
  matchResponsibilityHttpRouteV01,
  matchResponsibilityExecutionHttpRouteV04,
  matchResponsibilityJudgmentAuthorityHttpRouteV05,
  responsibilityJudgmentAuthorityHttpMediaTypeV05,
  judgmentAnswerRequestV05Schema,
  judgmentAnswerResultV05Schema,
  judgmentProjectionPageV05Schema,
  judgmentProjectionQueryV05Schema,
  responsibilityCaptureRequestSchema,
  responsibilityCaptureRequestV02Schema,
  responsibilityCaptureResultV01CompatibilitySchema,
  responsibilityCaptureResultV02Schema,
  responsibilityCaptureTrustedEnvelopeSchema,
  responsibilityCaptureTrustedEnvelopeV02Schema,
  responsibilityProjectionPageV01CompatibilitySchema,
  responsibilityProjectionPageV02Schema,
  canonicalizeWorkUnitPlanningTurnRequestV03ForDigest,
  canonicalizeWorkUnitPlanningCancelRequestV03ForDigest,
  emptyPlanningCapabilityManifestV03Schema,
  workUnitPlanningAuthorityCeilingV03Schema,
  workUnitPlanningTurnRequestV03Schema,
  workUnitPlanningCancelRequestV03Schema,
  workUnitPlanningCancelResultV03Schema,
  workUnitPlanningTurnResultV03Schema,
  workUnitPlanningTurnTrustedEnvelopeV03Schema,
  workUnitPlanningProjectionPageV03Schema,
  workUnitExecutionStartRequestV04Schema,
  workUnitExecutionStartResultV04Schema,
  ROSTER,
  ROSTER_REFS,
  type ActorRef,
} from '@waldo/contracts';
import type {
  ResponsibilityCaptureAdmission,
  ResponsibilityProjectionRead,
  WorkUnitPlanningAdmission,
  WorkUnitPlanningCancelAdmission,
  WorkUnitPlanningProjectionRead,
  JudgmentAnswerAdmissionV05,
  JudgmentProjectionReadV05,
} from '../coordinator/waldo-coordinator';
import { responsibilityBoundaryStatus } from './errors';
import { parseResponsibilityJsonBytes, readBoundedResponsibilityBody } from './raw-json';

export type ResponsibilityProtocolVersion = '0.1' | '0.2' | '0.3' | '0.4' | '0.5';

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
  plan?(input: WorkUnitPlanningAdmission, ingress: ResponsibilityIngressContext): Promise<unknown>;
  cancelPlanning?(
    input: WorkUnitPlanningCancelAdmission,
    ingress: ResponsibilityIngressContext,
  ): Promise<unknown>;
  readPlanningProjection?(
    input: WorkUnitPlanningProjectionRead,
    ingress: ResponsibilityIngressContext,
  ): Promise<unknown>;
  startExecution?(
    input: Readonly<{ routedOwnerId: string; request: unknown }>,
    ingress: ResponsibilityIngressContext,
  ): Promise<unknown>;
  answerJudgment?(
    input: JudgmentAnswerAdmissionV05,
    ingress: ResponsibilityIngressContext,
  ): Promise<unknown>;
  readJudgmentProjection?(
    input: JudgmentProjectionReadV05,
    ingress: ResponsibilityIngressContext,
  ): Promise<unknown>;
}

export type ResponsibilityIngressContext = Readonly<{
  authenticatedSubjectRef: string;
  authenticatedSessionId: string;
  authenticatedSessionExpiresAt: string;
  ownerPolicyRevision: number;
  authAssurance: string;
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

const MEDIA_TYPES: Readonly<Record<ResponsibilityProtocolVersion, string>> = Object.freeze({
  '0.1': responsibilityHttpMediaTypeV01,
  '0.2': responsibilityHttpMediaTypeV02,
  '0.3': responsibilityHttpMediaTypeV03,
  '0.4': responsibilityExecutionHttpMediaTypeV04,
  '0.5': responsibilityJudgmentAuthorityHttpMediaTypeV05,
});

export function createResponsibilityWorkerAdapter(
  dependencies: ResponsibilityWorkerAdapterDependencies,
): ResponsibilityWorkerAdapter {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const route = matchResponsibilityHttpRouteV01(request.method, url.pathname) ??
        matchResponsibilityExecutionHttpRouteV04(request.method, url.pathname) ??
        matchResponsibilityJudgmentAuthorityHttpRouteV05(request.method, url.pathname);
      if (route === null) return problem(404);
      const capture = route.id === 'capture';
      const planningTurn = route.id === 'planning_turn';
      const planningCancel = route.id === 'planning_cancel';
      const projection = route.id === 'projection';
      const planningProjection = route.id === 'planning_projection';
      const executionStart = route.id === 'execution_start';
      const judgmentAnswer = route.id === 'judgment_answer';
      const judgmentProjection = route.id === 'judgment_projection';

      const version = selectedVersion(request.headers.get('accept'));
      if (version === null) return problem(406);
      if (!route.protocolVersions.some((supported) => supported === version)) {
        return problem(406);
      }
      const writesBody = capture || planningTurn || planningCancel || executionStart ||
        judgmentAnswer;
      if (writesBody && normalizedMediaType(request.headers.get('content-type')) !== MEDIA_TYPES[version]) {
        return problem(406);
      }
      if (writesBody && ![null, 'identity'].includes(request.headers.get('content-encoding'))) {
        return problem(400);
      }
      try {
        if (!(await dependencies.edgeRateLimit.admit(request))) return problem(429);
      } catch (error) {
        dependencies.failureReporter.report('edge_rate_unavailable', error);
        return problem(503);
      }
      if (writesBody && url.search !== '') return problem(400);
      if ((projection || planningProjection || judgmentProjection) && (
        url.search.length > 1_024 || boundedQueryParameterCount(url.searchParams, 3) === null
      )) return problem(400);

      let body: unknown = null;
      if (writesBody) {
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
        if (route.id === 'judgment_answer') {
          const parsed = judgmentAnswerRequestV05Schema.safeParse(body);
          if (!parsed.success) {
            const bodyVersion = isRecord(body) ? body.protocolVersion : undefined;
            return bodyVersion !== undefined && bodyVersion !== version ? problem(406) : problem(400);
          }
          if (parsed.data.presenceRegistrationId !== context.presenceRegistrationId) {
            return problem(401);
          }
          const ownerRoot = await dependencies.ownerRootFor(context);
          if (ownerRoot.answerJudgment === undefined) {
            throw new Error('judgment answer owner root unavailable');
          }
          const result = await ownerRoot.answerJudgment({
            routedOwnerId: context.ownerId,
            request: parsed.data,
          }, ingressContext(context));
          const publicResult = judgmentAnswerResultV05Schema.parse(result);
          if (
            publicResult.requestId !== parsed.data.requestId ||
            publicResult.judgmentRequest.id !== parsed.data.aggregate.id ||
            publicResult.selectedOptionId !== parsed.data.payload.selectedOptionId
          ) {
            throw new Error('judgment answer response authority mismatch');
          }
          return json(publicResult, 200, '0.5');
        }
        if (route.id === 'judgment_projection') {
          const query = parseProjectionQuery(url.searchParams);
          if (query === null) return problem(400);
          const parsedQuery = judgmentProjectionQueryV05Schema.parse({
            protocolVersion: '0.5',
            ...query,
          });
          const ownerRoot = await dependencies.ownerRootFor(context);
          if (ownerRoot.readJudgmentProjection === undefined) {
            throw new Error('judgment projection owner root unavailable');
          }
          const result = await ownerRoot.readJudgmentProjection({
            routedOwnerId: context.ownerId,
            query: parsedQuery,
          }, ingressContext(context));
          const publicResult = judgmentProjectionPageV05Schema.parse(result);
          if (publicResult.ownerId !== context.ownerId) {
            throw new Error('judgment projection authority mismatch');
          }
          return json(publicResult, 200, '0.5');
        }
        if (route.id === 'execution_start') {
          const parsed = workUnitExecutionStartRequestV04Schema.safeParse(body);
          if (!parsed.success) {
            const bodyVersion = isRecord(body) ? body.protocolVersion : undefined;
            return bodyVersion !== undefined && bodyVersion !== version ? problem(406) : problem(400);
          }
          if (parsed.data.presenceRegistrationId !== context.presenceRegistrationId) {
            return problem(401);
          }
          const ownerRoot = await dependencies.ownerRootFor(context);
          if (ownerRoot.startExecution === undefined) {
            throw new Error('execution start owner root unavailable');
          }
          const result = await ownerRoot.startExecution({
            routedOwnerId: context.ownerId,
            request: parsed.data,
          }, ingressContext(context));
          const publicResult = workUnitExecutionStartResultV04Schema.parse(result);
          if (publicResult.requestId !== parsed.data.requestId ||
              publicResult.workUnit.id !== parsed.data.aggregate.id ||
              publicResult.workUnit.revision !== parsed.data.aggregate.expectedRevision) {
            throw new Error('execution start response authority mismatch');
          }
          return json(publicResult, 200, '0.4');
        }
        if (route.id === 'planning_cancel') {
          const parsed = workUnitPlanningCancelRequestV03Schema.safeParse(body);
          if (!parsed.success) {
            const bodyVersion = isRecord(body) ? body.protocolVersion : undefined;
            return bodyVersion !== undefined && bodyVersion !== version ? problem(406) : problem(400);
          }
          if (parsed.data.presenceRegistrationId !== context.presenceRegistrationId) {
            return problem(401);
          }
          const ownerRoot = await dependencies.ownerRootFor(context);
          if (ownerRoot.cancelPlanning === undefined) {
            throw new Error('planning cancellation owner root unavailable');
          }
          const result = await ownerRoot.cancelPlanning({
            routedOwnerId: context.ownerId,
            request: parsed.data,
          }, ingressContext(context));
          const publicResult = workUnitPlanningCancelResultV03Schema.parse(result);
          if (publicResult.ownerId !== context.ownerId ||
              publicResult.requestId !== parsed.data.requestId ||
              publicResult.executionRequestId !== parsed.data.executionRequestId) {
            throw new Error('planning cancellation authority mismatch');
          }
          return json(publicResult, 200, '0.3');
        }
        if (route.id === 'planning_turn') {
          const parsed = workUnitPlanningTurnRequestV03Schema.safeParse(body);
          if (!parsed.success) {
            const bodyVersion = isRecord(body) ? body.protocolVersion : undefined;
            return bodyVersion !== undefined && bodyVersion !== version ? problem(406) : problem(400);
          }
          if (parsed.data.presenceRegistrationId !== context.presenceRegistrationId) {
            return problem(401);
          }
          const ownerRoot = await dependencies.ownerRootFor(context);
          if (ownerRoot.plan === undefined) throw new Error('planning owner root unavailable');
          const requestDigest = `sha256:${await sha256Hex(
            canonicalizeWorkUnitPlanningTurnRequestV03ForDigest(parsed.data),
          )}` as const;
          const capabilityManifest = emptyPlanningCapabilityManifestV03Schema.parse({
            schemaVersion: '0.3', tools: [], connectors: [], filesystem: 'none',
            shell: 'none', network: 'none', externalEffects: 'none',
          });
          const manifestDigest = `sha256:${await sha256Hex(JSON.stringify(capabilityManifest))}` as const;
          const trustedEnvelope = workUnitPlanningTurnTrustedEnvelopeV03Schema.parse({
            protocolVersion: '0.3',
            commandId: dependencies.newId('command'),
            commandType: 'work_unit.request_planning_turn',
            ownerId: context.ownerId,
            actor: context.actor,
            presenceId: context.presenceId,
            authenticatedSessionId: context.authenticatedSessionId,
            ownerPolicyRevision: context.ownerPolicyRevision,
            authAssurance: context.authAssurance,
            ownerRootRoutingVersion: context.ownerRootRoutingVersion,
            aggregate: parsed.data.aggregate,
            requestDigest,
            correlationId: parsed.data.correlationId ?? dependencies.newId('correlation'),
            receivedAt: dependencies.now(),
            provider: {
              adapterId: 'runtime_llm_provider', adapterVersion: '1.0.0',
              modelRef: ROSTER_REFS.primary,
              capabilityManifest: { id: 'planning_provider_empty_v1', revision: 1, digest: manifestDigest },
            },
            executor: {
              executorId: 'run_loop_planning_executor', executorVersion: '1.0.0',
              capabilityManifest: { id: 'planning_executor_empty_v1', revision: 1, digest: manifestDigest },
            },
            capabilityManifest,
            authorityCeiling: workUnitPlanningAuthorityCeilingV03Schema.parse({
              providerPlanningTurns: 1, tools: 'none', connectors: 'none',
              externalEffects: 'none', outcomeMutation: 'none', evidence: 'none',
              verification: 'none', acceptance: 'none', closure: 'none',
            }),
            payload: {
              governedInputs: parsed.data.payload.governedInputs.map(({ ref, digest }) => ({
                ref, digest,
              })),
            },
          });
          const result = await ownerRoot.plan({
            routedOwnerId: context.ownerId,
            request: parsed.data,
            trustedEnvelope,
          }, ingressContext(context));
          const publicResult = workUnitPlanningTurnResultV03Schema.parse(result);
          if (publicResult.ownerId !== context.ownerId || publicResult.protocolVersion !== '0.3' ||
              publicResult.requestId !== parsed.data.requestId ||
              publicResult.workUnitId !== parsed.data.aggregate.id ||
              JSON.stringify(publicResult.providerInvocation.provider) !==
                JSON.stringify(trustedEnvelope.provider)) {
            throw new Error('planning response authority mismatch');
          }
          return json(publicResult, 200, '0.3');
        }
        if (route.id === 'capture') {
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

        if (route.id === 'planning_projection') {
          const query = parseProjectionQuery(url.searchParams);
          if (query === null) return problem(400);
          const ownerRoot = await dependencies.ownerRootFor(context);
          if (ownerRoot.readPlanningProjection === undefined) {
            throw new Error('planning projection owner root unavailable');
          }
          const result = await ownerRoot.readPlanningProjection({
            routedOwnerId: context.ownerId, ...query,
          }, ingressContext(context));
          const publicResult = workUnitPlanningProjectionPageV03Schema.parse(result);
          if (publicResult.ownerId !== context.ownerId) {
            throw new Error('planning projection authority mismatch');
          }
          return json(publicResult, 200, '0.3');
        }

        if (route.id === 'projection') {
          const query = parseProjectionQuery(url.searchParams);
          if (query === null) return problem(400);
          const ownerRoot = await dependencies.ownerRootFor(context);
          const projectionVersion = version === '0.1' ? '0.1' : '0.2';
          const result = await ownerRoot.readProjection(
            {
              routedOwnerId: context.ownerId,
              protocolVersion: projectionVersion,
              ...query,
            },
            ingressContext(context),
          );
          const publicResult = projectionVersion === '0.1'
            ? responsibilityProjectionPageV01CompatibilitySchema.parse(result)
            : responsibilityProjectionPageV02Schema.parse(result);
          if (publicResult.ownerId !== context.ownerId || publicResult.protocolVersion !== projectionVersion) {
            throw new Error('responsibility response authority mismatch');
          }
          return json(publicResult, 200, projectionVersion);
        }

        return unreachableResponsibilityRoute(route);
      } catch (error) {
        const publicStatus = responsibilityBoundaryStatus(error);
        if (publicStatus !== null) return problem(publicStatus);
        dependencies.failureReporter.report('owner_root_failure', error);
        return problem(500);
      }
    },
  };
}

function unreachableResponsibilityRoute(route: never): never {
  throw new Error(`unhandled responsibility route: ${JSON.stringify(route)}`);
}

function selectedVersion(accept: string | null): ResponsibilityProtocolVersion | null {
  const mediaType = accept?.trim().toLowerCase() ?? null;
  if (mediaType === MEDIA_TYPES['0.1']) return '0.1';
  if (mediaType === MEDIA_TYPES['0.2']) return '0.2';
  if (mediaType === MEDIA_TYPES['0.3']) return '0.3';
  if (mediaType === MEDIA_TYPES['0.4']) return '0.4';
  if (mediaType === MEDIA_TYPES['0.5']) return '0.5';
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

function parseProjectionQuery(parameters: URLSearchParams): Readonly<{
  fromExclusiveCursor: number;
  limit: number;
  snapshotId?: string;
}> | null {
  const queryKeys = [...parameters.keys()];
  if (queryKeys.some((key) => !['fromExclusiveCursor', 'limit', 'snapshotId'].includes(key)) ||
      parameters.getAll('fromExclusiveCursor').length !== 1 ||
      parameters.getAll('limit').length !== 1 ||
      parameters.getAll('snapshotId').length > 1) return null;
  const fromExclusiveCursor = boundedInteger(
    parameters.get('fromExclusiveCursor'), 0, Number.MAX_SAFE_INTEGER,
  );
  const limit = boundedInteger(parameters.get('limit'), 1, 256);
  if (fromExclusiveCursor === null || limit === null) return null;
  const snapshotId = parameters.get('snapshotId');
  if (snapshotId !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(snapshotId)) {
    return null;
  }
  return Object.freeze({
    fromExclusiveCursor,
    limit,
    ...(snapshotId === null ? {} : { snapshotId }),
  });
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
    authAssurance: context.authAssurance,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
