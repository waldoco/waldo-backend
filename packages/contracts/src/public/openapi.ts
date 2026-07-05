import { z } from 'zod';
import {
  publicEngagementEventRequestSchema,
  publicEngagementEventResponseSchema,
  publicErrorSchema,
} from './dto';

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
      if (key === 'pattern' && source.format === 'date-time') {
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
      schemas: {
        PublicEngagementEventRequest: schemaFor(publicEngagementEventRequestSchema),
        PublicEngagementEventResponse: schemaFor(publicEngagementEventResponseSchema),
        PublicError: schemaFor(publicErrorSchema),
      },
    },
  };
}
