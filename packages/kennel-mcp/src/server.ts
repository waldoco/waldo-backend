import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import {
  createObservationService,
  observationEnvelopeSchema,
  observationSchema,
  type ObservationKind,
  type ObservationServiceConfig,
} from './observation.js';

const observationKinds = observationSchema.options.map((schema) => schema.shape.kind.value) as ObservationKind[];

function response(result: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    structuredContent: result as Record<string, unknown>,
    ...(isError ? { isError: true } : {}),
  };
}

export function createKennelObservationMcp(config: ObservationServiceConfig) {
  const observationService = createObservationService(config);
  const server = new McpServer(
    { name: 'waldo-kennel-observation', version: '0.1.0' },
    {
      instructions:
        'This is a local, observation-only Kennel bridge. Send only minimized Codex lifecycle observations. It cannot execute commands, approve actions, close loops, or perform exact return.',
    },
  );

  server.registerTool(
    'kennel_get_observation_status',
    {
      title: 'Get Kennel observation status',
      description: 'Read the linked local session, consented observation kinds, and derived semantic projection.',
      annotations: { readOnlyHint: true },
    },
    async () => response(observationService.status()),
  );

  server.registerTool(
    'kennel_publish_observation',
    {
      title: 'Publish a minimized Codex observation',
      description:
        'Publish one consented Codex lifecycle event. Raw prompts, transcripts, command text, paths, and previews are rejected by the v1 contract.',
      inputSchema: observationEnvelopeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      const result = await observationService.publish(input);
      return response(result, !result.accepted);
    },
  );

  return { server, observationService };
}

function parseConfig(argv: readonly string[]): ObservationServiceConfig {
  const sessionIndex = argv.indexOf('--session-id');
  const allowedIndex = argv.indexOf('--allow');
  const sessionId = sessionIndex >= 0 ? argv[sessionIndex + 1] : undefined;
  const allowed = allowedIndex >= 0 ? argv[allowedIndex + 1] : undefined;

  if (sessionId === undefined || allowed === undefined) {
    throw new Error('Usage: server.js --session-id <linked-session-id> --allow <comma-separated-observation-kinds>');
  }

  const allowedObservations = allowed.split(',').filter((kind): kind is ObservationKind =>
    observationKinds.includes(kind as ObservationKind),
  );
  if (allowedObservations.length === 0 || allowedObservations.join(',') !== allowed) {
    throw new Error(`--allow must contain one or more supported kinds: ${observationKinds.join(', ')}`);
  }

  return { sessionId, allowedObservations };
}

async function main() {
  const { server } = createKennelObservationMcp(parseConfig(process.argv.slice(2)));
  await server.connect(new StdioServerTransport());
}

if (process.argv[1]?.endsWith('/server.js')) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Unable to start Kennel observation MCP.'}\n`);
    process.exitCode = 1;
  });
}
