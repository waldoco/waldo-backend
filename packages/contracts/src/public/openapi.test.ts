import { describe, expect, it } from 'vitest';
import { responsibilityHttpRouteManifestV01 } from '../protocol/responsibility-http-adapter-v0-1';
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
];

describe('public OpenAPI artifact', () => {
  it('publishes exactly the guarded responsibility route inventory', () => {
    const generated = buildPublicOpenApiDocument();
    const paths = generated.paths as Record<string, Record<string, PublicOperation>>;
    expect(Object.keys(paths).sort()).toEqual(
      [...new Set(responsibilityHttpRouteManifestV01.map((route) => route.path))].sort(),
    );
    expect(paths).not.toHaveProperty('/public/v1/briefs/morning/current');
    expect(paths).not.toHaveProperty('/v1/engagement-events');

    for (const route of responsibilityHttpRouteManifestV01) {
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
    expect(paths['/public/responsibilities/projection']!.get).not.toHaveProperty('requestBody');
    expect(paths['/public/responsibilities/planning-turns/projection']!.get)
      .not.toHaveProperty('requestBody');
    const components = generated.components as { schemas: Record<string, Record<string, unknown>> };
    expect(components.schemas.WorkUnitPlanningTurnResultV03!['x-waldo-presentation'])
      .toBe('inspectable-provenance');
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
};
