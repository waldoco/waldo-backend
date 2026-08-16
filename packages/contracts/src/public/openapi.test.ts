import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { responsibilityHttpRouteManifestV01 } from '../protocol/responsibility-http-adapter-v0-1';
import { responsibilityJudgmentAuthorityHttpRouteManifestV05 } from '../protocol/responsibility-judgment-authority-http-v0-5';
import { responsibilityExecutionHttpRouteManifestV04 } from '../protocol/responsibility-workunit-execution-http-v0-4';
import { responsibilityClosureHttpRouteManifestV06 } from '../protocol/responsibility-closure-http-v0-6';
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

function schemasForProperty(value: unknown, property: string): Array<Record<string, unknown>> {
  const matches: Array<Record<string, unknown>> = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const child of candidate) visit(child);
      return;
    }
    if (typeof candidate !== 'object' || candidate === null) return;
    const object = candidate as Record<string, unknown>;
    const properties = object.properties;
    if (typeof properties === 'object' && properties !== null) {
      const match = (properties as Record<string, unknown>)[property];
      if (typeof match === 'object' && match !== null) {
        matches.push(match as Record<string, unknown>);
      }
    }
    for (const child of Object.values(object)) visit(child);
  };
  visit(value);
  return matches;
}

describe('public OpenAPI artifact', () => {
  it('publishes exactly the guarded responsibility route inventory', () => {
    const generated = buildPublicOpenApiDocument();
    const paths = generated.paths as Record<string, Record<string, PublicOperation>>;
    const publicRoutes = [
      ...responsibilityHttpRouteManifestV01,
      ...responsibilityExecutionHttpRouteManifestV04,
      ...responsibilityJudgmentAuthorityHttpRouteManifestV05,
      ...responsibilityClosureHttpRouteManifestV06,
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
    for (const path of [
      '/public/responsibilities/closure/acceptance-checks',
      '/public/responsibilities/closure/evidence',
      '/public/responsibilities/closure/verifications',
      '/public/responsibilities/closure/acceptances',
    ]) {
      expect(Object.keys(paths[path]!.post!.requestBody!.content)).toEqual([
        'application/vnd.waldo.responsibility.v0.6+json',
      ]);
      expect(paths[path]!.post!['x-waldo-retry-semantics']).toEqual({
        identity: 'requestId',
        exactDuplicate: 'return_persisted_result_byte_for_byte',
        changedDuplicate: 'reject_request_conflict',
      });
    }
    const closureProjection = paths['/public/responsibilities/closure/projection']!.get!;
    expect(closureProjection).not.toHaveProperty('requestBody');
    expect(closureProjection.responses['200']!.content).toEqual({
      'application/vnd.waldo.responsibility.v0.6+json': {
        schema: { $ref: '#/components/schemas/ClosureProjectionPageV06' },
      },
    });
    expect(paths['/public/responsibilities/closure/acceptances']!.post!
      ['x-waldo-runtime-validation']).toEqual([
      'accept covers the exact server-derived complete active AcceptanceCheck set exactly once',
      'every passed available Verification and current Evidence envelope is owner-subject-check and digest exact',
      'verifier identity differs from every exact Evidence producer identity',
      'release is a distinct owner disposition and never claims verified acceptance',
    ]);
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
    for (const internal of [
      'AcceptanceCheckV06',
      'EvidenceV06',
      'VerificationV06',
      'AcceptanceV06',
      'VerifiedAcceptanceBindingV06',
      'ClosureDomainEventV06',
    ]) {
      expect(components.schemas).not.toHaveProperty(internal);
    }

    const publicCommandSchemas = [
      'AcceptanceCheckDeclarationRequestV06',
      'EvidenceAdmissionRequestV06',
      'VerificationRequestV06',
      'AcceptanceRecordRequestV06',
    ];
    for (const schemaName of publicCommandSchemas) {
      const serialized = JSON.stringify(components.schemas[schemaName]);
      for (const forbidden of [
        'ownerId',
        'actor',
        'collector',
        'source',
        'verifier',
        'policy',
        'authority',
        'credential',
        'clientIssuedAt',
        'clock',
        'rawHealth',
        'transcript',
        'prompt',
      ]) {
        expect(serialized, `${schemaName}:${forbidden}`).not.toContain(`"${forbidden}"`);
      }
    }
  });

  it('does not leak internal-only contract names or sensitive label fragments', () => {
    const artifact = JSON.stringify(buildPublicOpenApiDocument());
    for (const fragment of forbiddenFragments) expect(artifact).not.toContain(fragment);
  });

  it('expresses structural uniqueness and declares every closure runtime refinement', () => {
    const generated = buildPublicOpenApiDocument();
    const paths = generated.paths as Record<string, Record<string, PublicOperation>>;
    const components = generated.components as {
      schemas: Record<string, Record<string, unknown>>;
    };
    const verificationRequest = components.schemas.VerificationRequestV06!;
    const acceptanceRequest = components.schemas.AcceptanceRecordRequestV06!;
    expect(schemasForProperty(verificationRequest, 'evidence')).toEqual([
      expect.objectContaining({ minItems: 1, maxItems: 64, uniqueItems: true }),
    ]);
    for (const verificationRefs of schemasForProperty(acceptanceRequest, 'verifications')) {
      expect(verificationRefs).toEqual(
        expect.objectContaining({ maxItems: 32, uniqueItems: true }),
      );
    }

    const validateVerification = new Ajv2020({ strict: true, allErrors: true }).compile(
      verificationRequest,
    );
    const duplicateRef = { id: 'evidence', revision: 1, digest: `sha256:${'a'.repeat(64)}` };
    expect(validateVerification({
      protocolVersion: '0.6',
      requestId: 'verification',
      commandType: 'verification.request',
      presenceRegistrationId: 'presence',
      aggregate: { kind: 'acceptance_check', id: 'check', expectedRevision: 1 },
      payload: { evidence: [duplicateRef, duplicateRef] },
    })).toBe(false);

    expect(paths['/public/responsibilities/closure/acceptance-checks']!.post!
      ['x-waldo-runtime-validation']).toEqual([
      'target selector is owner-bound and reread to exact canonical subject revisions and digests',
      'criterion reference is reread server-side and no inline semantic content is admitted',
    ]);
    expect(paths['/public/responsibilities/closure/evidence']!.post!
      ['x-waldo-runtime-validation']).toEqual([
      'observation reference resolves to one exact canonical observation and server-derived provenance',
      'producer category and owner identity invariants are enforced without admitting inline Evidence',
    ]);
    expect(paths['/public/responsibilities/closure/verifications']!.post!
      ['x-waldo-runtime-validation']).toEqual([
      'Evidence references are strictly ordered after JSON-Schema uniqueness validation',
      'every Evidence reference resolves byte-and-digest-exact to current admitted owner-subject-check Evidence',
      'method, verifier, availability, and producer-independent identity are derived and validated server-side',
    ]);
    expect(paths['/public/responsibilities/closure/acceptances']!.post!
      ['x-waldo-runtime-validation']).toEqual([
      'accept covers the exact server-derived complete active AcceptanceCheck set exactly once',
      'every passed available Verification and current Evidence envelope is owner-subject-check and digest exact',
      'verifier identity differs from every exact Evidence producer identity',
      'release is a distinct owner disposition and never claims verified acceptance',
    ]);
    expect(paths['/public/responsibilities/closure/projection']!.get!
      ['x-waldo-runtime-validation']).toEqual([
      'every item owner matches the authenticated projection owner',
      'item cursors are strictly ordered within the snapshot and cursor envelope is coherent',
      'recordDigest and pageDigest equal SHA-256 of their canonical embedded values',
      'page item count and UTF-8 byte bounds are enforced',
    ]);
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
