import { z } from 'zod';
import {
  responsibilityCaptureRequestSchema,
} from '../protocol/responsibility-handshake-v0-1';
import {
  responsibilityCaptureRequestV02Schema,
  responsibilityCaptureResultV01CompatibilitySchema,
  responsibilityCaptureResultV02Schema,
  responsibilityProjectionPageV01CompatibilitySchema,
  responsibilityProjectionPageV02Schema,
} from '../protocol/responsibility-handshake-v0-2';
import {
  responsibilityHttpMediaTypeV01,
  responsibilityHttpMediaTypeV02,
  responsibilityHttpMediaTypeV03,
  responsibilityHttpProblemSchemasV01,
  responsibilityHttpRouteManifestV01,
  type ResponsibilityHttpRouteV01,
} from '../protocol/responsibility-http-adapter-v0-1';
import {
  workUnitPlanningCancelRequestV03Schema,
  workUnitPlanningCancelResultV03Schema,
  workUnitPlanningProjectionPageV03Schema,
  workUnitPlanningTurnRequestV03Schema,
  workUnitPlanningTurnResultV03Schema,
} from '../protocol/responsibility-planning-turn-v0-3';
import {
  responsibilityExecutionHttpMediaTypeV04,
  responsibilityExecutionHttpRouteManifestV04,
  workUnitExecutionStartRequestV04Schema,
  workUnitExecutionStartResultV04Schema,
  type ResponsibilityExecutionHttpRouteV04,
} from '../protocol/responsibility-workunit-execution-http-v0-4';
import {
  judgmentAnswerRequestV05Schema,
  judgmentAnswerResultV05Schema,
  judgmentAnswerRetrySemanticsV05,
  judgmentProjectionPageV05Schema,
} from '../protocol/responsibility-judgment-authority-v0-5';
import {
  responsibilityJudgmentAuthorityHttpMediaTypeV05,
  responsibilityJudgmentAuthorityHttpRouteManifestV05,
  type ResponsibilityJudgmentAuthorityHttpRouteV05,
} from '../protocol/responsibility-judgment-authority-http-v0-5';

type JsonRecord = Record<string, unknown>;
type ProtocolVersion = '0.1' | '0.2' | '0.3' | '0.4' | '0.5';
type PublicResponsibilityRoute =
  | ResponsibilityHttpRouteV01
  | ResponsibilityExecutionHttpRouteV04
  | ResponsibilityJudgmentAuthorityHttpRouteV05;

const mediaTypes: Readonly<Record<ProtocolVersion, string>> = Object.freeze({
  '0.1': responsibilityHttpMediaTypeV01,
  '0.2': responsibilityHttpMediaTypeV02,
  '0.3': responsibilityHttpMediaTypeV03,
  '0.4': responsibilityExecutionHttpMediaTypeV04,
  '0.5': responsibilityJudgmentAuthorityHttpMediaTypeV05,
});

const operationMetadata = Object.freeze({
  capture: {
    operationId: 'captureResponsibility',
    summary: 'Capture one owner-bound responsibility',
    successStatus: '201',
    requestSchemas: {
      '0.1': 'ResponsibilityCaptureRequestV01',
      '0.2': 'ResponsibilityCaptureRequestV02',
    },
    responseSchemas: {
      '0.1': 'ResponsibilityCaptureResultV01',
      '0.2': 'ResponsibilityCaptureResultV02',
    },
  },
  projection: {
    operationId: 'readResponsibilityProjection',
    summary: 'Read the owner-bound responsibility projection',
    successStatus: '200',
    responseSchemas: {
      '0.1': 'ResponsibilityProjectionPageV01',
      '0.2': 'ResponsibilityProjectionPageV02',
    },
  },
  planning_turn: {
    operationId: 'requestWorkUnitPlanningTurn',
    summary: 'Request one zero-effect WorkUnit planning turn',
    successStatus: '200',
    requestSchemas: { '0.3': 'WorkUnitPlanningTurnRequestV03' },
    responseSchemas: { '0.3': 'WorkUnitPlanningTurnResultV03' },
  },
  planning_cancel: {
    operationId: 'cancelWorkUnitPlanningTurn',
    summary: 'Cancel one WorkUnit planning turn',
    successStatus: '200',
    requestSchemas: { '0.3': 'WorkUnitPlanningCancelRequestV03' },
    responseSchemas: { '0.3': 'WorkUnitPlanningCancelResultV03' },
  },
  planning_projection: {
    operationId: 'readWorkUnitPlanningProjection',
    summary: 'Read the owner-bound WorkUnit planning projection',
    successStatus: '200',
    responseSchemas: { '0.3': 'WorkUnitPlanningProjectionPageV03' },
  },
  execution_start: {
    operationId: 'startWorkUnitExecution',
    summary: 'Start one owner-bound WorkUnit execution',
    successStatus: '200',
    requestSchemas: { '0.4': 'WorkUnitExecutionStartRequestV04' },
    responseSchemas: { '0.4': 'WorkUnitExecutionStartResultV04' },
  },
  judgment_projection: {
    operationId: 'readJudgmentProjection',
    summary: 'Read the owner-bound Needs You judgment projection',
    successStatus: '200',
    responseSchemas: { '0.5': 'JudgmentProjectionPageV05' },
    runtimeValidation: [
      'displayedRequestDigest equals SHA-256 of canonical embedded JudgmentRequestV05',
    ],
  },
  judgment_answer: {
    operationId: 'answerJudgment',
    summary: 'Answer one exact owner-bound JudgmentRequest revision',
    successStatus: '200',
    requestSchemas: { '0.5': 'JudgmentAnswerRequestV05' },
    responseSchemas: { '0.5': 'JudgmentAnswerResultV05' },
    retrySemantics: judgmentAnswerRetrySemanticsV05,
  },
} as const);

const publicResponsibilityRouteManifest = Object.freeze([
  ...responsibilityHttpRouteManifestV01,
  ...responsibilityExecutionHttpRouteManifestV04,
  ...responsibilityJudgmentAuthorityHttpRouteManifestV05,
]);

function stripGeneratedSchemaNoise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripGeneratedSchemaNoise);
  if (value && typeof value === 'object') {
    const result: JsonRecord = {};
    for (const [key, child] of Object.entries(value as JsonRecord)) {
      if (key !== '$schema') result[key] = stripGeneratedSchemaNoise(child);
    }
    return result;
  }
  return value;
}

function schemaFor(schema: z.ZodType): JsonRecord {
  return stripGeneratedSchemaNoise(z.toJSONSchema(schema)) as JsonRecord;
}

function schemaContent(
  versions: readonly ProtocolVersion[],
  schemas: Readonly<Partial<Record<ProtocolVersion, string>>>,
): JsonRecord {
  return Object.fromEntries(versions.map((version) => [
    mediaTypes[version],
    { schema: { $ref: `#/components/schemas/${schemas[version]}` } },
  ]));
}

function problemResponse(status: keyof typeof responsibilityHttpProblemSchemasV01): JsonRecord {
  const schemaName = `ResponsibilityHttpProblem${status}V01`;
  return {
    description: status === 404
      ? 'Content-free not-found problem, or an indistinguishable plain 404 while the route gate is disabled'
      : 'Content-free responsibility problem',
    headers: {
      'Cache-Control': { required: true, schema: { const: 'no-store' } },
      Vary: { required: true, schema: { const: 'Authorization, Accept' } },
      ...(status === 429
        ? { 'Retry-After': { required: true, schema: { const: '60' } } }
        : {}),
    },
    content: {
      'application/problem+json': {
        schema: { $ref: `#/components/schemas/${schemaName}` },
      },
      ...(status === 404 ? { 'text/plain': { schema: { const: 'not found' } } } : {}),
    },
  };
}

function successHeaders(route: PublicResponsibilityRoute): JsonRecord {
  return {
    'Cache-Control': { required: true, schema: { const: 'private, no-store' } },
    Vary: { required: true, schema: { const: 'Authorization, Accept' } },
    'Waldo-Offline-Commands': { required: true, schema: { const: 'none' } },
    'Waldo-Protocol-Version': {
      required: true,
      schema: { enum: route.protocolVersions },
    },
  };
}

function projectionParameters(): JsonRecord[] {
  return [
    {
      name: 'fromExclusiveCursor', in: 'query', required: true,
      schema: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    },
    {
      name: 'limit', in: 'query', required: true,
      schema: { type: 'integer', minimum: 1, maximum: 256 },
    },
    {
      name: 'snapshotId', in: 'query', required: false,
      schema: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' },
    },
  ];
}

function operationFor(route: PublicResponsibilityRoute): JsonRecord {
  const metadata = operationMetadata[route.id];
  const versions = route.protocolVersions as readonly ProtocolVersion[];
  const responseSchemas = metadata.responseSchemas as Readonly<
    Partial<Record<ProtocolVersion, string>>
  >;
  const requestSchemas = 'requestSchemas' in metadata
    ? metadata.requestSchemas as Readonly<Partial<Record<ProtocolVersion, string>>>
    : undefined;
  const retrySemantics = 'retrySemantics' in metadata
    ? metadata.retrySemantics
    : undefined;
  const runtimeValidation = 'runtimeValidation' in metadata
    ? metadata.runtimeValidation
    : undefined;
  return {
    operationId: metadata.operationId,
    summary: metadata.summary,
    description:
      'Available only when RESPONSIBILITY_PUBLIC_API_ENABLED is exactly true. ' +
      'Authentication, admission, owner routing, and response validation fail closed.',
    security: [{ bearerAuth: [] }],
    'x-waldo-feature-gate': {
      environmentVariable: 'RESPONSIBILITY_PUBLIC_API_ENABLED',
      enabledValue: 'true',
      default: 'disabled',
    },
    'x-waldo-protocol-versions': route.protocolVersions,
    ...(retrySemantics === undefined
      ? {}
      : { 'x-waldo-retry-semantics': retrySemantics }),
    ...(runtimeValidation === undefined
      ? {}
      : { 'x-waldo-runtime-validation': runtimeValidation }),
    parameters: [
      {
        name: 'Accept', in: 'header', required: true,
        schema: { enum: versions.map((version) => mediaTypes[version]) },
      },
      ...(route.method === 'GET' ? projectionParameters() : []),
    ],
    ...(requestSchemas === undefined ? {} : {
      requestBody: { required: true, content: schemaContent(versions, requestSchemas) },
    }),
    responses: {
      [metadata.successStatus]: {
        description: 'Schema-validated owner-bound result',
        headers: successHeaders(route),
        content: schemaContent(versions, responseSchemas),
      },
      ...Object.fromEntries(
        ([400, 401, 404, 406, 409, 429, 500, 503] as const)
          .map((status) => [status, problemResponse(status)]),
      ),
    },
  };
}

export function buildPublicOpenApiDocument(
  routeManifest: readonly PublicResponsibilityRoute[] = publicResponsibilityRouteManifest,
): JsonRecord {
  const paths: JsonRecord = {};
  for (const route of routeManifest) {
    const path = (paths[route.path] ??= {}) as JsonRecord;
    path[route.method.toLowerCase()] = operationFor(route);
  }

  return {
    openapi: '3.1.0',
    info: { title: 'Waldo Public API', version: '0.3.0' },
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http', scheme: 'bearer', bearerFormat: 'JWT',
          description: 'Project Woof ES256 access token',
        },
      },
      schemas: {
        ResponsibilityCaptureRequestV01: schemaFor(responsibilityCaptureRequestSchema),
        ResponsibilityCaptureRequestV02: schemaFor(responsibilityCaptureRequestV02Schema),
        ResponsibilityCaptureResultV01: schemaFor(
          responsibilityCaptureResultV01CompatibilitySchema,
        ),
        ResponsibilityCaptureResultV02: schemaFor(responsibilityCaptureResultV02Schema),
        ResponsibilityProjectionPageV01: schemaFor(
          responsibilityProjectionPageV01CompatibilitySchema,
        ),
        ResponsibilityProjectionPageV02: schemaFor(responsibilityProjectionPageV02Schema),
        WorkUnitPlanningTurnRequestV03: schemaFor(workUnitPlanningTurnRequestV03Schema),
        WorkUnitPlanningTurnResultV03: {
          ...schemaFor(workUnitPlanningTurnResultV03Schema),
          description:
            'Owner-visible planning result. Provider invocation fields are inspectable execution provenance, not default product presentation.',
          'x-waldo-presentation': 'inspectable-provenance',
        },
        WorkUnitPlanningCancelRequestV03: schemaFor(workUnitPlanningCancelRequestV03Schema),
        WorkUnitPlanningCancelResultV03: schemaFor(workUnitPlanningCancelResultV03Schema),
        WorkUnitPlanningProjectionPageV03: schemaFor(workUnitPlanningProjectionPageV03Schema),
        WorkUnitExecutionStartRequestV04: schemaFor(workUnitExecutionStartRequestV04Schema),
        WorkUnitExecutionStartResultV04: schemaFor(workUnitExecutionStartResultV04Schema),
        JudgmentAnswerRequestV05: schemaFor(judgmentAnswerRequestV05Schema),
        JudgmentAnswerResultV05: schemaFor(judgmentAnswerResultV05Schema),
        JudgmentProjectionPageV05: schemaFor(judgmentProjectionPageV05Schema),
        ...Object.fromEntries(
          Object.entries(responsibilityHttpProblemSchemasV01).map(([status, schema]) => [
            `ResponsibilityHttpProblem${status}V01`,
            schemaFor(schema),
          ]),
        ),
      },
    },
  };
}
