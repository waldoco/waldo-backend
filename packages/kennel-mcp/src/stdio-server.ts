import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createLoopbackKennelDelivery } from './delivery.js';

import { observationSchema, type ObservationKind, type ObservationServiceConfig } from './observation.js';
import { createKennelObservationMcp } from './server.js';

const observationKinds = observationSchema.options.map((schema) => schema.shape.kind.value) as ObservationKind[];

function configFromArgs(argv: readonly string[]): ObservationServiceConfig {
  const sessionIndex = argv.indexOf('--session-id');
  const allowedIndex = argv.indexOf('--allow');
  const sessionId = sessionIndex >= 0 ? argv[sessionIndex + 1] : undefined;
  const allowed = allowedIndex >= 0 ? argv[allowedIndex + 1] : undefined;
  const deliveryIndex = argv.indexOf('--kennel-delivery-url');
  const deliveryUrl = deliveryIndex >= 0 ? argv[deliveryIndex + 1] : undefined;

  if (sessionId === undefined || allowed === undefined) {
    throw new Error('Usage: stdio-server.js --session-id <linked-session-id> --allow <comma-separated-observation-kinds>');
  }

  const allowedObservations = allowed.split(',').filter((kind): kind is ObservationKind =>
    observationKinds.includes(kind as ObservationKind),
  );
  if (allowedObservations.length === 0 || allowedObservations.join(',') !== allowed) {
    throw new Error(`--allow must contain one or more supported kinds: ${observationKinds.join(', ')}`);
  }
  if (deliveryUrl === undefined) {
    return { sessionId, allowedObservations };
  }

  const token = process.env.KENNEL_DELIVERY_TOKEN;
  if (token === undefined) {
    throw new Error('KENNEL_DELIVERY_TOKEN is required when --kennel-delivery-url is set.');
  }

  return {
    sessionId,
    allowedObservations,
    kennelDelivery: createLoopbackKennelDelivery({ url: deliveryUrl, token }),
  };
}

const { server } = createKennelObservationMcp(configFromArgs(process.argv.slice(2)));
await server.connect(new StdioServerTransport());
