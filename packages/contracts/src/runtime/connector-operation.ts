import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import { idempotencyKeySchema } from './outbox';
import type { ConnectionModule } from './connection';

const primaryCalendarSchema = z.literal('primary');
const timeRangeSchema = z.strictObject({ from: iso8601Schema, to: iso8601Schema });

export const googleConnectorOperationSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('google.calendar.freebusy.read'),
    effectClass: z.literal('read'),
    responseClass: z.literal('calendar_freebusy'),
    resource: primaryCalendarSchema,
    parameters: timeRangeSchema,
  }),
  z.strictObject({
    operation: z.literal('google.calendar.events.owned.read'),
    effectClass: z.literal('read'),
    responseClass: z.literal('calendar_events'),
    resource: primaryCalendarSchema,
    parameters: timeRangeSchema,
  }),
  z.strictObject({
    operation: z.literal('google.calendar.event.create'),
    effectClass: z.literal('approved_effect'),
    responseClass: z.literal('calendar_event_receipt'),
    resource: primaryCalendarSchema,
    parameters: z.strictObject({
      eventId: z.string().regex(/^[a-v0-9]{5,1024}$/),
      title: z.string().min(1).max(1024),
      start: iso8601Schema,
      end: iso8601Schema,
      timeZone: z.string().min(1).max(100),
      sendUpdates: z.literal('none'),
      approvalRef: z.string().min(1),
      approvedDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    }),
  }),
]);
export type GoogleConnectorOperation = z.infer<typeof googleConnectorOperationSchema>;

export const connectorOperationEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  ownerId: z.string().min(1),
  connectionId: z.string().min(1),
  provider: z.literal('google'),
  capabilityManifestDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  credentialGeneration: z.int().nonnegative(),
  revocationGeneration: z.int().nonnegative(),
  consentEpoch: z.int().nonnegative(),
  idempotencyKey: idempotencyKeySchema,
  expiresAt: z.int().nonnegative(),
  request: googleConnectorOperationSchema,
  signature: z.string().min(1),
});
export type ConnectorOperationEnvelope = z.infer<typeof connectorOperationEnvelopeSchema>;
export type UnsignedConnectorOperationEnvelope = Omit<ConnectorOperationEnvelope, 'signature'>;

const operationRequirements: Readonly<Record<GoogleConnectorOperation['operation'], {
  scopes: readonly string[];
  dataClasses: readonly string[];
}>> = {
  'google.calendar.freebusy.read': {
    scopes: ['calendar.freebusy'], dataClasses: ['calendar_availability'],
  },
  'google.calendar.events.owned.read': {
    scopes: ['calendar.events.owned.readonly'], dataClasses: ['calendar_metadata'],
  },
  'google.calendar.event.create': {
    scopes: ['calendar.events.owned'], dataClasses: ['calendar_metadata'],
  },
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalizeConnectorEnvelope(envelope: UnsignedConnectorOperationEnvelope): string {
  return canonical(envelope);
}

export interface GoogleConnectorExecutor {
  execute(input: Readonly<{
    ownerId: string;
    providerAccountId: string;
    credentialHandle: string;
    request: GoogleConnectorOperation;
    idempotencyKey: string;
  }>): Promise<unknown>;
}

export class GoogleConnectorProxy {
  private readonly completed = new Map<string, { digest: string; result: unknown }>();

  constructor(private readonly options: Readonly<{
    connections: ConnectionModule;
    verifySignature: (digest: string, signature: string) => boolean;
    authorizeManifest: (digest: string, operation: GoogleConnectorOperation['operation']) => boolean;
    executor: GoogleConnectorExecutor;
    now?: () => number;
  }>) {}

  async dispatch(authenticatedOwnerId: string, input: unknown): Promise<unknown> {
    const envelope = connectorOperationEnvelopeSchema.parse(input);
    if (envelope.ownerId !== authenticatedOwnerId) throw new Error('connector owner mismatch');
    if (envelope.expiresAt <= (this.options.now?.() ?? Date.now())) throw new Error('connector envelope expired');
    const { signature, ...unsigned } = envelope;
    const signedPayload = canonicalizeConnectorEnvelope(unsigned);
    if (!this.options.verifySignature(signedPayload, signature)) throw new Error('connector signature invalid');
    if (!this.options.authorizeManifest(envelope.capabilityManifestDigest, envelope.request.operation)) {
      throw new Error('connector operation not authorized');
    }
    const prior = this.completed.get(envelope.idempotencyKey);
    if (prior) {
      if (prior.digest !== signedPayload) throw new Error('connector idempotency conflict');
      return prior.result;
    }
    const requirements = operationRequirements[envelope.request.operation];
    const connection = this.options.connections.assertUsable(authenticatedOwnerId, envelope.connectionId, {
      ...requirements,
      credentialGeneration: envelope.credentialGeneration,
      revocationGeneration: envelope.revocationGeneration,
      consentEpoch: envelope.consentEpoch,
    });
    if (connection.provider !== 'google') throw new Error('connector provider mismatch');
    const result = await this.options.executor.execute({
      ownerId: authenticatedOwnerId,
      providerAccountId: connection.providerAccountId,
      credentialHandle: connection.credentialHandle,
      request: envelope.request,
      idempotencyKey: envelope.idempotencyKey,
    });
    this.completed.set(envelope.idempotencyKey, { digest: signedPayload, result });
    return result;
  }
}
