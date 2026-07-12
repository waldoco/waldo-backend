import { describe, expect, it } from 'vitest';
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
  it('publishes the authenticated current morning-Brief read contract', () => {
    const generated = buildPublicOpenApiDocument();
    const paths = generated.paths as Record<string, { get: MorningBriefOperation }>;
    const operation = paths['/public/v1/briefs/morning/current']!.get;

    expect(generated.paths).toHaveProperty('/public/v1/briefs/morning/current');
    expect(operation.security).toEqual([{ bearerAuth: [] }]);
    expect(operation).not.toHaveProperty('requestBody');
    expect(Object.keys(operation.responses).sort()).toEqual([
      '200',
      '304',
      '401',
      '403',
      '406',
      '429',
      '500',
      '503',
    ]);
    expect(operation.responses['304']).not.toHaveProperty('content');
    for (const status of ['200', '304']) {
      expect(operation.responses[status]!.headers).toEqual(
        expect.objectContaining({
          'Cache-Control': expect.objectContaining({ schema: { const: 'private, no-cache' } }),
          Vary: expect.objectContaining({ schema: { const: 'Authorization, Accept' } }),
        }),
      );
    }
    expect(operation.responses['200']!.content).toHaveProperty(
      'application/vnd.waldo.morning-brief.v1+json',
    );
    const problemSchemas = {
      '401': 'WaldoUnauthorizedProblemV1',
      '403': 'WaldoForbiddenProblemV1',
      '406': 'WaldoNotAcceptableProblemV1',
      '429': 'WaldoRateLimitedProblemV1',
      '500': 'WaldoInternalErrorProblemV1',
      '503': 'WaldoTemporarilyUnavailableProblemV1',
    } as const;
    for (const [status, schema] of Object.entries(problemSchemas)) {
      expect(operation.responses[status]!.content).toEqual({
        'application/problem+json': {
          schema: { $ref: `#/components/schemas/${schema}` },
        },
      });
    }
    for (const status of ['429', '503']) {
      expect(operation.responses[status]!.headers).toHaveProperty('Retry-After');
    }
    expect(generated.components).toEqual(
      expect.objectContaining({
        securitySchemes: expect.objectContaining({
          bearerAuth: expect.objectContaining({ type: 'http', scheme: 'bearer' }),
        }),
      }),
    );

    const components = generated.components as { schemas: Record<string, unknown> };
    const readySchema = components.schemas.PublicMorningBriefReady as {
      properties: Record<string, { pattern?: string }>;
      'x-waldo-invariants': string[];
    };
    for (const timestamp of ['generated_at', 'source_updated_at', 'stale_at', 'as_of']) {
      expect(readySchema.properties[timestamp]!.pattern).toContain('Z');
    }
    expect(readySchema['x-waldo-invariants']).toEqual(
      expect.arrayContaining([
        'source_updated_at <= generated_at',
        'generated_at <= as_of',
        'generated_at < stale_at',
      ]),
    );
    const morningSurface = JSON.stringify({
      operation,
      response: components.schemas.PublicMorningBriefResponse,
      problem: components.schemas.WaldoProblemV1,
    });
    for (const forbidden of [
      'user_id',
      'userId',
      'tenant',
      'durable_object',
      'run_id',
      'journal',
      'outbox',
      'provider',
      'model',
      'raw_health',
      'notification_log',
      'read_state',
    ]) {
      expect(morningSurface).not.toContain(forbidden);
    }
    expect(morningSurface).not.toContain('"null"');
  });

  it('emits the public engagement endpoint from independent public DTOs', () => {
    const generated = buildPublicOpenApiDocument();
    expect(generated.paths).toHaveProperty('/v1/engagement-events');
    expect(generated.components).toEqual(
      expect.objectContaining({
        schemas: expect.objectContaining({
          PublicEngagementEventRequest: expect.any(Object),
          PublicEngagementEventResponse: expect.any(Object),
          PublicError: expect.any(Object),
        }),
      }),
    );
  });

  it('does not leak internal-only contract names or sensitive label fragments', () => {
    const artifact = JSON.stringify(buildPublicOpenApiDocument());
    for (const fragment of forbiddenFragments) {
      expect(artifact).not.toContain(fragment);
    }
  });

  it('generates byte-identically across repeated builds', () => {
    expect(JSON.stringify(buildPublicOpenApiDocument())).toBe(
      JSON.stringify(buildPublicOpenApiDocument()),
    );
  });
});

type MorningBriefOperation = {
  security: Array<Record<string, unknown>>;
  responses: Record<
    string,
    { content?: Record<string, unknown>; headers?: Record<string, unknown> }
  >;
};
