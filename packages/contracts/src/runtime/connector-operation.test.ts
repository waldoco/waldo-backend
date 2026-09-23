import { describe, expect, it, vi } from 'vitest';
import { ConnectionModule, type Connection } from './connection';
import {
  GoogleConnectorProxy, canonicalizeConnectorEnvelope, connectorOperationEnvelopeSchema,
  type ConnectorOperationEnvelope, type UnsignedConnectorOperationEnvelope,
} from './connector-operation';

const active = (overrides: Partial<Connection> = {}): Connection => ({
  id: 'google-work', ownerId: 'owner-a', provider: 'google', providerAccountId: 'subject-1',
  accountLabel: 'work@example.com', purpose: 'calendar',
  dataClasses: ['calendar_availability', 'calendar_metadata'],
  scopes: ['calendar.freebusy', 'calendar.events.owned.readonly', 'calendar.events.owned'],
  scopeRevision: 1, credentialHandle: 'vault:opaque', credentialGeneration: 2,
  adapterVersion: 'google-v1', consentEpoch: 3, revocationGeneration: 0,
  status: 'active', updatedAt: 1, ...overrides,
});

const unsigned = (overrides: Partial<UnsignedConnectorOperationEnvelope> = {}): UnsignedConnectorOperationEnvelope => ({
  version: 1, ownerId: 'owner-a', connectionId: 'google-work', provider: 'google',
  capabilityManifestDigest: `sha256:${'1'.repeat(64)}`, credentialGeneration: 2,
  revocationGeneration: 0, consentEpoch: 3, idempotencyKey: 'a'.repeat(64), expiresAt: 200,
  request: {
    operation: 'google.calendar.freebusy.read', effectClass: 'read',
    responseClass: 'calendar_freebusy', resource: 'primary',
    parameters: { from: '2026-09-23T00:00:00Z', to: '2026-09-24T00:00:00Z' },
  }, ...overrides,
} as unknown as UnsignedConnectorOperationEnvelope);

function harness() {
  const connections = new ConnectionModule();
  connections.put('owner-a', active());
  const executor = { execute: vi.fn(async () => ({ ok: true })) };
  const proxy = new GoogleConnectorProxy({
    connections, executor, now: () => 100,
    verifySignature: (digest, signature) => signature === digest,
    authorizeManifest: (digest, operation) => digest === `sha256:${'1'.repeat(64)}` && operation.startsWith('google.calendar.'),
  });
  const sign = (value: UnsignedConnectorOperationEnvelope): ConnectorOperationEnvelope => ({
    ...value, signature: canonicalizeConnectorEnvelope(value),
  });
  return { connections, executor, proxy, sign };
}

describe('GoogleConnectorProxy', () => {
  it('dispatches only a signed owner-bound typed Google operation using an opaque credential handle', async () => {
    const { executor, proxy, sign } = harness();
    await expect(proxy.dispatch('owner-a', sign(unsigned()))).resolves.toEqual({ ok: true });
    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: 'owner-a', providerAccountId: 'subject-1', credentialHandle: 'vault:opaque',
      request: expect.objectContaining({ operation: 'google.calendar.freebusy.read', resource: 'primary' }),
    }));
    expect(connectorOperationEnvelopeSchema.safeParse({ ...sign(unsigned()), url: 'https://evil.test' }).success).toBe(false);
  });

  it('rejects owner substitution, signature changes, expiry and unauthorized operations before I/O', async () => {
    const { executor, proxy, sign } = harness();
    const valid = sign(unsigned());
    await expect(proxy.dispatch('owner-b', valid)).rejects.toThrow('owner mismatch');
    await expect(proxy.dispatch('owner-a', { ...valid, credentialGeneration: 9 })).rejects.toThrow('signature invalid');
    await expect(proxy.dispatch('owner-a', sign(unsigned({ expiresAt: 100 })))).rejects.toThrow('expired');
    await expect(proxy.dispatch('owner-a', sign(unsigned({ capabilityManifestDigest: `sha256:${'2'.repeat(64)}` })))).rejects.toThrow('not authorized');
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('rechecks live connection generations, scope and status at dispatch', async () => {
    const { connections, executor, proxy, sign } = harness();
    await expect(proxy.dispatch('owner-a', sign(unsigned({ credentialGeneration: 1 })))).rejects.toThrow('generation mismatch');
    connections.put('owner-a', active({ status: 'reauthorization_required', updatedAt: 2 }));
    await expect(proxy.dispatch('owner-a', sign(unsigned()))).rejects.toThrow('unavailable');
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('deduplicates identical completed requests and rejects idempotency-key substitution', async () => {
    const { executor, proxy, sign } = harness();
    const first = sign(unsigned());
    await proxy.dispatch('owner-a', first);
    await proxy.dispatch('owner-a', first);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    const changed = unsigned({ request: {
      operation: 'google.calendar.events.owned.read', effectClass: 'read',
      responseClass: 'calendar_events', resource: 'primary',
      parameters: { from: '2026-09-23T00:00:00Z', to: '2026-09-24T00:00:00Z' },
    } as unknown as UnsignedConnectorOperationEnvelope['request'] });
    await expect(proxy.dispatch('owner-a', sign(changed))).rejects.toThrow('idempotency conflict');
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('makes create-event approval and no-notification constraints structurally mandatory', () => {
    const request = {
      operation: 'google.calendar.event.create', effectClass: 'approved_effect',
      responseClass: 'calendar_event_receipt', resource: 'primary', parameters: {
        eventId: 'abcde1', title: 'Focus', start: '2026-09-23T09:00:00+05:30',
        end: '2026-09-23T10:00:00+05:30', timeZone: 'Asia/Calcutta', sendUpdates: 'none',
        approvalRef: 'approval-1', approvedDigest: `sha256:${'b'.repeat(64)}`,
      },
    } as unknown as UnsignedConnectorOperationEnvelope['request'];
    expect(connectorOperationEnvelopeSchema.safeParse({ ...unsigned({ request }), signature: 'signed' }).success).toBe(true);
    expect(connectorOperationEnvelopeSchema.safeParse({ ...unsigned({ request: { ...request, parameters: { ...request.parameters, sendUpdates: 'all' } } as never }), signature: 'signed' }).success).toBe(false);
  });
});
