import { describe, expect, it } from 'vitest';

import { createObservationService, type ObservationEnvelope } from './observation.js';

const sessionId = 'codex-session-1';
const allObservations = ['session_started', 'permission_requested', 'turn_started', 'turn_completed'] as const;

function envelope(observation: ObservationEnvelope['observation'], eventId: string): ObservationEnvelope {
  return {
    eventId,
    schemaVersion: '1.0',
    occurredAt: '2026-07-20T12:00:00.000Z',
    observation,
  };
}

describe('Kennel observation admission', () => {
  it('delivers every browser-observer event to Kennel before exposing the matching projection', async () => {
    const delivered: ObservationEnvelope[] = [];
    const service = createObservationService({
      sessionId,
      allowedObservations: allObservations,
      kennelDelivery: { deliver: async (event) => void delivered.push(event) },
    });

    await expect(
      service.publish(
        envelope(
          {
            kind: 'session_started',
            provider: 'codex',
            sessionId,
            workingDirectoryName: 'waldo-backend',
            startSource: 'cli',
            initialState: 'working',
          },
          'event-start',
        ),
      ),
    ).resolves.toMatchObject({ accepted: true, projection: { state: 'working', observedEvents: 1 } });

    await expect(
      service.publish(
        envelope(
          {
            kind: 'permission_requested',
            provider: 'codex',
            sessionId,
            judgmentId: 'judgment-1',
            toolName: 'apply_patch',
            reason: 'A minimized decision summary.',
          },
          'event-permission',
        ),
      ),
    ).resolves.toMatchObject({ accepted: true, projection: { state: 'needs_user', attention: 'needs_you' } });

    await expect(
      service.publish(envelope({ kind: 'turn_started', provider: 'codex', sessionId }, 'event-turn-start')),
    ).resolves.toMatchObject({ accepted: true, projection: { state: 'working' } });

    await expect(
      service.publish(
        envelope(
          { kind: 'turn_completed', provider: 'codex', sessionId, result: 'completed', evidence: 'Synthetic evidence.' },
          'event-turn-complete',
        ),
      ),
    ).resolves.toMatchObject({ accepted: true, projection: { state: 'stopped', observedEvents: 4 } });

    expect(delivered.map((event) => event.observation.kind)).toEqual(allObservations);
    expect(service.status().kennelDelivery).toBe('delivered_to_configured_loopback_receiver');
  });

  it('does not admit an event when Kennel rejects it, so the same event can be retried', async () => {
    let attempts = 0;
    const service = createObservationService({
      sessionId,
      allowedObservations: ['turn_started'],
      kennelDelivery: {
        deliver: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('receiver unavailable');
        },
      },
    });
    const event = envelope({ kind: 'turn_started', provider: 'codex', sessionId }, 'event-retry');

    await expect(service.publish(event)).resolves.toMatchObject({
      accepted: false,
      code: 'KENNEL_DELIVERY_FAILED',
      projection: { observedEvents: 0 },
    });
    await expect(service.publish(event)).resolves.toMatchObject({
      accepted: true,
      deduplicated: false,
      projection: { observedEvents: 1 },
    });
  });
});