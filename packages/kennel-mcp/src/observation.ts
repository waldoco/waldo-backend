import { z } from 'zod';

import type { KennelDelivery } from './delivery.js';

const boundedIdentifier = z.string().min(1).max(128);

const sessionStartedSchema = z.strictObject({
  kind: z.literal('session_started'),
  provider: z.literal('codex'),
  sessionId: boundedIdentifier,
  workingDirectoryName: z.string().min(1).max(255),
  startSource: z.string().min(1).max(64),
  initialState: z.enum(['working', 'waiting', 'stale']),
});

const permissionRequestedSchema = z.strictObject({
  kind: z.literal('permission_requested'),
  provider: z.literal('codex'),
  sessionId: boundedIdentifier,
  judgmentId: boundedIdentifier,
  toolName: z.string().min(1).max(128),
  reason: z.string().min(1).max(1_024).optional(),
});

const turnStartedSchema = z.strictObject({
  kind: z.literal('turn_started'),
  provider: z.literal('codex'),
  sessionId: boundedIdentifier,
});

const turnCompletedSchema = z.strictObject({
  kind: z.literal('turn_completed'),
  provider: z.literal('codex'),
  sessionId: boundedIdentifier,
  result: z.enum(['completed', 'interrupted', 'failed']),
  evidence: z.string().min(1).max(1_024).optional(),
});

export const observationSchema = z.discriminatedUnion('kind', [
  sessionStartedSchema,
  permissionRequestedSchema,
  turnStartedSchema,
  turnCompletedSchema,
]);

export const observationEnvelopeSchema = z.strictObject({
  eventId: boundedIdentifier,
  schemaVersion: z.literal('1.0'),
  occurredAt: z.iso.datetime(),
  observation: observationSchema,
});

export type ObservationEnvelope = z.infer<typeof observationEnvelopeSchema>;
export type ObservationKind = ObservationEnvelope['observation']['kind'];

export type SessionProjection = {
  sessionId: string;
  state: 'inactive' | 'working' | 'waiting' | 'needs_user' | 'stopped' | 'failed' | 'stale';
  attention: 'quiet' | 'needs_you';
  observedEvents: number;
};

type AdmissionFailureCode =
  | 'INPUT_INVALID'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNLINKED_SESSION'
  | 'OBSERVATION_NOT_ALLOWED'
  | 'EVENT_ID_COLLISION'
  | 'KENNEL_DELIVERY_FAILED';

export type AdmissionResult =
  | {
      accepted: true;
      deduplicated: boolean;
      projection: SessionProjection;
    }
  | {
      accepted: false;
      code: AdmissionFailureCode;
      message: string;
      projection: SessionProjection;
    };

export type ObservationServiceConfig = {
  sessionId: string;
  allowedObservations: readonly ObservationKind[];
  maxPayloadBytes?: number;
  kennelDelivery?: KennelDelivery;
};

export type ObservationStatus = {
  linkedSessionId: string;
  allowedObservations: readonly ObservationKind[];
  projection: SessionProjection;
  kennelDelivery: 'delivered_to_configured_loopback_receiver' | 'simulated_until_kennel_receiver_is_configured';
};

const defaultPayloadLimit = 64 * 1024;

function initialProjection(sessionId: string): SessionProjection {
  return {
    sessionId,
    state: 'inactive',
    attention: 'quiet',
    observedEvents: 0,
  };
}

function fingerprint(input: ObservationEnvelope): string {
  return JSON.stringify(input);
}

function updateProjection(current: SessionProjection, observation: ObservationEnvelope['observation']): SessionProjection {
  const next = {
    ...current,
    observedEvents: current.observedEvents + 1,
  };

  switch (observation.kind) {
    case 'session_started':
      return { ...next, state: observation.initialState, attention: 'quiet' };
    case 'permission_requested':
      return { ...next, state: 'needs_user', attention: 'needs_you' };
    case 'turn_started':
      return { ...next, state: 'working', attention: 'quiet' };
    case 'turn_completed':
      return {
        ...next,
        state: observation.result === 'failed' ? 'failed' : 'stopped',
        attention: 'quiet',
      };
  }
}

export function createObservationService(config: ObservationServiceConfig) {
  const maxPayloadBytes = config.maxPayloadBytes ?? defaultPayloadLimit;
  const seenEvents = new Map<string, string>();
  let projection = initialProjection(config.sessionId);

  function rejected(code: AdmissionFailureCode, message: string): AdmissionResult {
    return { accepted: false, code, message, projection };
  }

  return {
    async publish(input: unknown): Promise<AdmissionResult> {
      const serialized = JSON.stringify(input);
      if (Buffer.byteLength(serialized, 'utf8') > maxPayloadBytes) {
        return rejected('PAYLOAD_TOO_LARGE', `Observation payload exceeds ${maxPayloadBytes} bytes.`);
      }

      const parsed = observationEnvelopeSchema.safeParse(input);
      if (!parsed.success) {
        return rejected('INPUT_INVALID', 'Observation does not match the v1 minimized event contract.');
      }

      const envelope = parsed.data;
      if (envelope.observation.sessionId !== config.sessionId) {
        return rejected('UNLINKED_SESSION', 'Observation session is not linked to this local MCP process.');
      }

      if (!config.allowedObservations.includes(envelope.observation.kind)) {
        return rejected('OBSERVATION_NOT_ALLOWED', 'Consent does not allow this observation type.');
      }

      const eventFingerprint = fingerprint(envelope);
      const existingFingerprint = seenEvents.get(envelope.eventId);
      if (existingFingerprint !== undefined) {
        if (existingFingerprint !== eventFingerprint) {
          return rejected('EVENT_ID_COLLISION', 'eventId was already used with different observation content.');
        }

        return { accepted: true, deduplicated: true, projection };
      }

      if (config.kennelDelivery !== undefined) {
        try {
          await config.kennelDelivery.deliver(envelope);
        } catch {
          return rejected(
            'KENNEL_DELIVERY_FAILED',
            'Kennel did not accept this local observation. Confirm its loopback receiver is running, then retry the same eventId.',
          );
        }
      }

      seenEvents.set(envelope.eventId, eventFingerprint);
      projection = updateProjection(projection, envelope.observation);
      return { accepted: true, deduplicated: false, projection };
    },

    status(): ObservationStatus {
      return {
        linkedSessionId: config.sessionId,
        allowedObservations: config.allowedObservations,
        projection,
        kennelDelivery:
          config.kennelDelivery === undefined
            ? 'simulated_until_kennel_receiver_is_configured'
            : 'delivered_to_configured_loopback_receiver',
      };
    },
  };
}
