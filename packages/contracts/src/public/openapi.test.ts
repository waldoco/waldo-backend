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
});
