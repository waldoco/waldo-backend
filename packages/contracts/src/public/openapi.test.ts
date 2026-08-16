import { describe, expect, it } from 'vitest';
import { responsibilityHttpRouteManifestV01 } from '../protocol/responsibility-http-adapter-v0-1';
import { responsibilityJudgmentAuthorityHttpRouteManifestV05 } from '../protocol/responsibility-judgment-authority-http-v0-5';
import { responsibilityExecutionHttpRouteManifestV04 } from '../protocol/responsibility-workunit-execution-http-v0-4';
import { buildPublicOpenApiDocument } from './openapi';

const forbiddenFragments = [
  'agent_reasoning_capsule',
  'audit_source_refs',
  'Mint',
  'service_role',
  'connector_token',
  'raw_health',
  'hrv_ms',
  'payload_hash',
  'trace_id',
  'sql',
  'table_name',
  'working_memory',
  'session_state',
  'durable_object',
  '"authenticatedSessionId":',
  '"ownerRootRoutingVersion":',
  '"providerId":',
  '"modelId":',
  '"executorRef":',
  '"credential":',
  '"transcript":',
];

describe('public OpenAPI artifact', () => {
  it('publishes exactly the guarded responsibility route inventory', () => {
    const generated = buildPublicOpenApiDocument();
    const paths = generated.paths as Record<string, Record<string, PublicOperation>>;
    const publicRoutes = [
      ...responsibilityHttpRouteManifestV01,
      ...responsibilityExecutionHttpRouteManifestV04,
      ...responsibilityJudgmentAuthorityHttpRouteManifestV05,
    ];
    expect(Object.keys(paths).sort()).toEqual(
      [...new Set(publicRoutes.map((route) => route.path))].sort(),
    );
    expect(paths).not.toHaveProperty('/public/v1/briefs/morning/current');
    expect(paths).not.toHaveProperty('/v1/engagement-events');

    for (const route of publicRoutes) {
      const operation = paths[route.path]![route.method.toLowerCase()]!;
      expect(operation).toBeDefined();
      expect(operation.security).toEqual([{ bearerAuth: [] }]);
      expect(operation['x-waldo-feature-gate']).toEqual({
        environmentVariable: 'RESPONSIBILITY_PUBLIC_API_ENABLED',
        enabledValue: 'true',
        default: 'disabled',
      });
      expect(operation['x-waldo-protocol-versions']).toEqual(route.protocolVersions);
      expect(operation.responses).toHaveProperty(route.id === 'capture' ? '201' : '200');
      for (const status of ['400', '401', '404', '406', '409', '429', '500', '503']) {
        expect(operation.responses[status]!.content).toEqual(expect.objectContaining({
          'application/problem+json': {
            schema: { $ref: `#/components/schemas/ResponsibilityHttpProblem${status}V01` },
          },
        }));
        expect(operation.responses[status]!.headers).toEqual(expect.objectContaining({
          'Cache-Control': expect.objectContaining({ schema: { const: 'no-store' } }),
          Vary: expect.objectContaining({ schema: { const: 'Authorization, Accept' } }),
        }));
      }
      expect(operation.responses['429']!.headers).toHaveProperty('Retry-After');
      expect(operation.responses['404']!.content).toHaveProperty('text/plain');
    }
  });

  it('pins request and response representations to the existing protocol schemas', () => {
    const generated = buildPublicOpenApiDocument();
    const paths = generated.paths as Record<string, Record<string, PublicOperation>>;
    const capture = paths['/public/responsibilities']!.post!;
    expect(Object.keys(capture.requestBody!.content).sort()).toEqual([
      'application/vnd.waldo.responsibility.v0.1+json',
      'application/vnd.waldo.responsibility.v0.2+json',
    ]);
    expect(Object.keys(capture.responses['201']!.content!).sort()).toEqual([
      'application/vnd.waldo.responsibility.v0.1+json',
      'application/vnd.waldo.responsibility.v0.2+json',
    ]);

    for (const path of [
      '/public/responsibilities/planning-turns',
      '/public/responsibilities/planning-turns/cancel',
    ]) {
      expect(Object.keys(paths[path]!.post!.requestBody!.content)).toEqual([
        'application/vnd.waldo.responsibility.v0.3+json',
      ]);
    }
    const execution = paths['/public/responsibilities/work-units/executions']!.post!;
    expect(Object.keys(execution.requestBody!.content)).toEqual([
      'application/vnd.waldo.responsibility.v0.4+json',
    ]);
    expect(Object.keys(execution.responses['200']!.content!)).toEqual([
      'application/vnd.waldo.responsibility.v0.4+json',
    ]);
    const judgmentProjection = paths[
      '/public/responsibilities/judgments/projection'
    ]!.get!;
    const judgmentAnswer = paths['/public/responsibilities/judgments/answers']!.post!;
    expect(judgmentProjection).not.toHaveProperty('requestBody');
    expect(Object.keys(judgmentProjection.responses['200']!.content!)).toEqual([
      'application/vnd.waldo.responsibility.v0.5+json',
    ]);
    expect(Object.keys(judgmentAnswer.requestBody!.content)).toEqual([
      'application/vnd.waldo.responsibility.v0.5+json',
    ]);
    expect(Object.keys(judgmentAnswer.responses['200']!.content!)).toEqual([
      'application/vnd.waldo.responsibility.v0.5+json',
    ]);
    expect(judgmentProjection.responses['200']!.content).toEqual({
      'application/vnd.waldo.responsibility.v0.5+json': {
        schema: { $ref: '#/components/schemas/JudgmentProjectionPageV05' },
      },
    });
    expect(judgmentProjection['x-waldo-runtime-validation']).toEqual([
      'displayedRequestDigest equals SHA-256 of canonical embedded JudgmentRequestV05',
    ]);
    expect(judgmentAnswer.requestBody!.content).toEqual({
      'application/vnd.waldo.responsibility.v0.5+json': {
        schema: { $ref: '#/components/schemas/JudgmentAnswerRequestV05' },
      },
    });
    expect(judgmentAnswer.responses['200']!.content).toEqual({
      'application/vnd.waldo.responsibility.v0.5+json': {
        schema: { $ref: '#/components/schemas/JudgmentAnswerResultV05' },
      },
    });
    expect(judgmentAnswer['x-waldo-retry-semantics']).toEqual({
      identity: 'requestId',
      exactDuplicate: 'return_persisted_result_byte_for_byte',
      changedDuplicate: 'reject_request_conflict',
    });
    expect(paths).not.toHaveProperty('/public/responsibilities/judgments');
    expect(paths['/public/responsibilities/projection']!.get).not.toHaveProperty('requestBody');
    expect(paths['/public/responsibilities/planning-turns/projection']!.get)
      .not.toHaveProperty('requestBody');
    const components = generated.components as { schemas: Record<string, Record<string, unknown>> };
    expect(components.schemas.WorkUnitPlanningTurnResultV03!['x-waldo-presentation'])
      .toBe('inspectable-provenance');
    for (const internal of [
      'JudgmentDecisionV05',
      'AuthorityGrantV05',
      'JudgmentAuthorityBindingV05',
      'AuthorityAdmissionV05',
      'JudgmentRequestV05',
    ]) {
      expect(components.schemas).not.toHaveProperty(internal);
    }
  });

  it('does not leak internal-only contract names or sensitive label fragments', () => {
    const artifact = JSON.stringify(buildPublicOpenApiDocument());
    for (const fragment of forbiddenFragments) expect(artifact).not.toContain(fragment);
  });

  it('generates byte-identically across repeated builds', () => {
    expect(JSON.stringify(buildPublicOpenApiDocument())).toBe(
      JSON.stringify(buildPublicOpenApiDocument()),
    );
  });
});

type PublicOperation = {
  security: Array<Record<string, unknown>>;
  requestBody?: { content: Record<string, unknown> };
  responses: Record<
    string,
    { content?: Record<string, unknown>; headers?: Record<string, unknown> }
  >;
  'x-waldo-feature-gate': Record<string, unknown>;
  'x-waldo-protocol-versions': readonly string[];
  'x-waldo-retry-semantics'?: Record<string, unknown>;
  'x-waldo-runtime-validation'?: readonly string[];
};
