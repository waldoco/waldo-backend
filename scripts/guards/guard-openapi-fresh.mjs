#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'guard-openapi-fresh';
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const contractsRoot = join(repoRoot, 'packages', 'contracts');
const requireFromContracts = createRequire(join(contractsRoot, 'package.json'));
const { z } = requireFromContracts('zod');

const artifactPath = join(contractsRoot, 'openapi', 'waldo-public-api.json');
const freshnessPath = join(contractsRoot, 'openapi', 'waldo-public-api.sha256');

function stripGeneratedSchemaNoise(value) {
  if (Array.isArray(value)) return value.map(stripGeneratedSchemaNoise);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === '$schema') continue;
      if (key === 'pattern' && value.format === 'date-time') continue;
      result[key] = stripGeneratedSchemaNoise(child);
    }
    return result;
  }
  return value;
}

function schemaFor(schema) {
  return stripGeneratedSchemaNoise(z.toJSONSchema(schema));
}

const pushClassSchema = z.enum([
  'brief',
  'fetch_alert',
  'adjustment',
  'pre_activity_spot',
  'constellation_first',
  'constellation_update',
  'spot_digest',
  'intervention_knock',
  'sync_error',
  'system_consent',
]);

const engagementChannelSchema = z.enum(['apns', 'telegram', 'in_app']);
const engagementKindSchema = z.enum([
  'delivered',
  'opened',
  'reply',
  'callback_tap',
  'thumbs_up',
  'thumbs_down',
  'mute',
  'disable',
]);

const publicEngagementEventRequestSchema = z.strictObject({
  push_class: pushClassSchema,
  channel: engagementChannelSchema,
  kind: engagementKindSchema,
  occurred_at: z.string().datetime({ offset: true }),
  run_id: z.string().min(1).optional(),
});

const publicEngagementEventResponseSchema = z.strictObject({
  accepted: z.literal(true),
});

const publicErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().min(1),
    message: z.string().min(1),
  }),
});

function ref(name) {
  return { $ref: `#/components/schemas/${name}` };
}

function buildPublicOpenApiDocument() {
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
                schema: ref('PublicEngagementEventRequest'),
              },
            },
          },
          responses: {
            '202': {
              description: 'Accepted',
              content: {
                'application/json': {
                  schema: ref('PublicEngagementEventResponse'),
                },
              },
            },
            '400': {
              description: 'Invalid request',
              content: {
                'application/json': {
                  schema: ref('PublicError'),
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

const generated = `${JSON.stringify(buildPublicOpenApiDocument(), null, 2)}\n`;
const artifact = readFileSync(artifactPath, 'utf8').replace(/\r\n/g, '\n');
if (artifact !== generated) {
  process.stderr.write(`${NAME}: ${artifactPath} is stale; regenerate it from public DTOs\n`);
  process.exit(1);
}

const freshness = readFileSync(freshnessPath, 'utf8').replace(/\r\n/g, '\n');
const hash = createHash('sha256').update(artifact).digest('hex');
if (freshness !== `${hash}\n`) {
  process.stderr.write(`${NAME}: ${freshnessPath} is stale; expected ${hash}\n`);
  process.exit(1);
}

process.stdout.write(`${NAME}: ok\n`);
