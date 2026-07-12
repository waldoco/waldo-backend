import { z } from 'zod';
import {
  publicEngagementEventRequestSchema,
  publicEngagementEventResponseSchema,
  publicErrorSchema,
} from './dto';
import {
  publicMorningBriefEmptySchema,
  publicMorningBriefPendingSchema,
  publicMorningBriefReadySchema,
  publicMorningBriefResponseSchema,
  waldoForbiddenProblemV1Schema,
  waldoInternalErrorProblemV1Schema,
  waldoNotAcceptableProblemV1Schema,
  waldoNotFoundProblemV1Schema,
  waldoProblemV1Schema,
  waldoRateLimitedProblemV1Schema,
  waldoTemporarilyUnavailableProblemV1Schema,
  waldoUnauthorizedProblemV1Schema,
} from './morning-brief';

type JsonRecord = Record<string, unknown>;

function stripGeneratedSchemaNoise(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripGeneratedSchemaNoise);
  }

  if (value && typeof value === 'object') {
    const source = value as JsonRecord;
    const result: JsonRecord = {};
    for (const [key, child] of Object.entries(source)) {
      if (key === '$schema') {
        continue;
      }
      result[key] = stripGeneratedSchemaNoise(child);
    }
    return result;
  }

  return value;
}

function schemaFor(schema: z.ZodType): JsonRecord {
  return stripGeneratedSchemaNoise(z.toJSONSchema(schema)) as JsonRecord;
}

export function buildPublicOpenApiDocument(): JsonRecord {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Waldo Public API',
      version: '0.1.0',
    },
    paths: {
      '/public/v1/briefs/morning/current': {
        get: {
          operationId: 'getCurrentMorningBrief',
          summary: 'Read the current committed morning Brief projection',
          description:
            'Side-effect-free projection read. The ETag is opaque and subject-bound; 304 is valid only for the same verified subject.',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'Accept',
              in: 'header',
              required: true,
              schema: { const: 'application/vnd.waldo.morning-brief.v1+json' },
            },
            {
              name: 'If-None-Match',
              in: 'header',
              required: false,
              description: 'Malformed validators are ignored as cache misses; they never produce 304.',
              schema: { type: 'string', pattern: '^"[A-Za-z0-9_-]{32,128}"$' },
            },
          ],
          responses: {
            '200': {
              description: 'Ready, pending, or empty current morning Brief state',
              headers: {
                ETag: {
                  required: true,
                  description: 'Opaque validator bound to the verified subject and projection revision',
                  schema: { type: 'string', pattern: '^"[A-Za-z0-9_-]{32,128}"$' },
                },
                'Cache-Control': {
                  required: true,
                  schema: { const: 'private, no-cache' },
                },
                Vary: {
                  required: true,
                  schema: { const: 'Authorization, Accept' },
                },
              },
              content: {
                'application/vnd.waldo.morning-brief.v1+json': {
                  schema: { $ref: '#/components/schemas/PublicMorningBriefResponse' },
                },
              },
            },
            '304': {
              description: 'Not modified for this verified subject; no response body and no side effect',
              headers: {
                ETag: {
                  required: true,
                  schema: { type: 'string', pattern: '^"[A-Za-z0-9_-]{32,128}"$' },
                },
                'Cache-Control': {
                  required: true,
                  schema: { const: 'private, no-cache' },
                },
                Vary: {
                  required: true,
                  schema: { const: 'Authorization, Accept' },
                },
              },
            },
            '401': problemResponse('Authentication failed', 'WaldoUnauthorizedProblemV1'),
            '403': problemResponse('Access forbidden', 'WaldoForbiddenProblemV1'),
            '406': problemResponse('Unsupported representation', 'WaldoNotAcceptableProblemV1'),
            '429': problemResponse('Rate limited', 'WaldoRateLimitedProblemV1', true),
            '500': problemResponse('Internal failure', 'WaldoInternalErrorProblemV1'),
            '503': problemResponse(
              'Temporarily unavailable',
              'WaldoTemporarilyUnavailableProblemV1',
              true,
            ),
          },
        },
      },
      '/v1/engagement-events': {
        post: {
          operationId: 'createEngagementEvent',
          summary: 'Record a redacted engagement event',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PublicEngagementEventRequest' },
              },
            },
          },
          responses: {
            '202': {
              description: 'Accepted',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/PublicEngagementEventResponse' },
                },
              },
            },
            '400': {
              description: 'Invalid request',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/PublicError' },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Project Woof ES256 access token',
        },
      },
      schemas: {
        PublicEngagementEventRequest: schemaFor(publicEngagementEventRequestSchema),
        PublicEngagementEventResponse: schemaFor(publicEngagementEventResponseSchema),
        PublicError: schemaFor(publicErrorSchema),
        PublicMorningBriefReady: {
          ...(schemaFor(publicMorningBriefReadySchema) as JsonRecord),
          'x-waldo-invariants': [
            'source_updated_at <= generated_at',
            'generated_at <= as_of',
            'generated_at < stale_at',
            'freshness = fresh iff as_of < stale_at; otherwise stale',
          ],
        },
        PublicMorningBriefPending: schemaFor(publicMorningBriefPendingSchema),
        PublicMorningBriefEmpty: schemaFor(publicMorningBriefEmptySchema),
        PublicMorningBriefResponse: {
          ...(schemaFor(publicMorningBriefResponseSchema) as JsonRecord),
          'x-waldo-invariants': [
            'ready.source_updated_at <= ready.generated_at',
            'ready.generated_at <= ready.as_of',
            'ready.generated_at < ready.stale_at',
            'ready.freshness = fresh iff ready.as_of < ready.stale_at; otherwise stale',
          ],
        },
        WaldoProblemV1: schemaFor(waldoProblemV1Schema),
        WaldoUnauthorizedProblemV1: schemaFor(waldoUnauthorizedProblemV1Schema),
        WaldoForbiddenProblemV1: schemaFor(waldoForbiddenProblemV1Schema),
        WaldoNotFoundProblemV1: schemaFor(waldoNotFoundProblemV1Schema),
        WaldoNotAcceptableProblemV1: schemaFor(waldoNotAcceptableProblemV1Schema),
        WaldoRateLimitedProblemV1: schemaFor(waldoRateLimitedProblemV1Schema),
        WaldoInternalErrorProblemV1: schemaFor(waldoInternalErrorProblemV1Schema),
        WaldoTemporarilyUnavailableProblemV1: schemaFor(
          waldoTemporarilyUnavailableProblemV1Schema,
        ),
      },
    },
  };
}

function problemResponse(
  description: string,
  schemaName: string,
  retryAfter = false,
): JsonRecord {
  return {
    description,
    ...(retryAfter
      ? {
          headers: {
            'Retry-After': {
              required: true,
              description: 'Must equal retry_after_seconds in the WaldoProblemV1 body.',
              schema: { type: 'integer', minimum: 1, maximum: 300 },
            },
          },
        }
      : {}),
    content: {
      'application/problem+json': {
        schema: { $ref: `#/components/schemas/${schemaName}` },
      },
    },
  };
}
