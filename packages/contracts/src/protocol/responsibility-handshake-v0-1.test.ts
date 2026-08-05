import { describe, expect, it } from 'vitest';
import {
  agentSessionActivityObservedEventSchema,
  candidateEvidenceObservedEventSchema,
  canonicalizeSurfaceCommandRequestForDigest,
  domainEventSchema,
  judgmentNeededObservedEventSchema,
  presenceCapabilityV01Schema,
  projectionPageSchema,
  responsibilityCaptureRequestSchema,
  surfaceCommandRequestSchema,
  trustedCommandEnvelopeSchema,
} from './responsibility-handshake-v0-1';

const surfaceRequest = {
  protocolVersion: '0.1' as const,
  requestId: 'request_capture_01',
  commandType: 'responsibility.capture' as const,
  presenceRegistrationId: 'presence_registration_01',
  clientIssuedAt: '2026-08-05T12:00:00Z',
  payload: {
    userStatement: 'Make sure the reviewed update is handled.',
  },
};

const trustedEnvelope = {
  protocolVersion: '0.1' as const,
  commandId: 'command_capture_01',
  commandType: 'responsibility.capture',
  ownerId: 'owner_server_01',
  actor: { kind: 'presence' as const, id: 'presence_server_01' },
  presenceId: 'presence_server_01',
  authenticatedSessionId: 'session_server_01',
  ownerPolicyRevision: 3,
  authAssurance: 'verified_session',
  ownerRootRoutingVersion: 2,
  requestDigest: `sha256:${'a'.repeat(64)}`,
  correlationId: 'correlation_capture_01',
  receivedAt: '2026-08-05T12:00:01Z',
  payload: surfaceRequest.payload,
};

const domainEventBase = {
  schemaVersion: '0.1',
  eventId: 'event_session_01',
  eventType: 'agent_session.activity_observed',
  ownerId: 'owner_server_01',
  aggregate: { kind: 'agent_session', id: 'agent_session_01', revision: 2 },
  ownerCursor: 14,
  correlationId: 'correlation_capture_01',
  occurredAt: '2026-08-05T12:05:00Z',
};

const projectionPage = {
  protocolVersion: '0.1' as const,
  ownerId: 'owner_server_01',
  projectionName: 'responsibility.summary',
  snapshotId: 'snapshot_01',
  snapshotBaseCursor: 10,
  fromExclusiveCursor: 10,
  highWaterCursor: 14,
  nextCursor: 12,
  items: [
    { aggregateId: 'responsibility_01', revision: 1 },
    { aggregateId: 'responsibility_02', revision: 1 },
  ],
  hasMore: true,
  generatedAt: '2026-08-05T12:06:00Z',
};

describe('responsibility handshake v0.1', () => {
  it('accepts the minimal untrusted responsibility-capture request', () => {
    expect(
      responsibilityCaptureRequestSchema.safeParse(surfaceRequest).success,
    ).toBe(true);
  });

  it.each([
    ['ownerId', 'owner_server_only'],
    ['actor', { kind: 'owner', id: 'owner_server_only' }],
    ['actorRole', 'owner'],
    ['targetDurableObjectId', 'do_server_only'],
    ['ownerRootRoutingVersion', 1],
    ['authorityGrant', { id: 'grant_server_only' }],
    ['credential', 'credential_server_only'],
    ['credentialHandle', 'credential_server_only'],
    ['provider', 'provider_server_only'],
    ['model', 'model_server_only'],
    ['acceptance', { decision: 'accepted' }],
    ['closure', { state: 'closed' }],
  ])('rejects the client-owned %s field', (field, value) => {
    expect(
      responsibilityCaptureRequestSchema.safeParse({
        ...surfaceRequest,
        [field]: value,
      }).success,
    ).toBe(false);
  });

  it.each([
    ['ownerId', 'owner_server_only'],
    ['authorityGrant', { id: 'grant_server_only' }],
    ['credential', 'credential_server_only'],
    ['provider', 'provider_server_only'],
    ['model', 'model_server_only'],
    ['acceptance', { decision: 'accepted' }],
    ['closure', { state: 'closed' }],
  ])('rejects nested capture-payload smuggling through %s', (field, value) => {
    expect(
      responsibilityCaptureRequestSchema.safeParse({
        ...surfaceRequest,
        payload: { ...surfaceRequest.payload, [field]: value },
      }).success,
    ).toBe(false);
  });

  it.each([
    { ...surfaceRequest, protocolVersion: '0.2' },
    { ...surfaceRequest, clientIssuedAt: 'not-a-timestamp' },
    { ...surfaceRequest, unexpected: true },
    { ...surfaceRequest, payload: { userStatement: '   ' } },
    {
      ...surfaceRequest,
      aggregate: { kind: 'outcome', id: 'outcome_01', unexpected: true },
    },
    {
      ...surfaceRequest,
      payload: { userStatement: 'x'.repeat(8_193) },
    },
    {
      ...surfaceRequest,
      payload: { userStatement: '🐕'.repeat(4_096) },
    },
  ])('rejects an invalid or oversized surface request', (request) => {
    expect(responsibilityCaptureRequestSchema.safeParse(request).success).toBe(false);
  });

  it('keeps the generic surface schema untrusted and strict', () => {
    expect(surfaceCommandRequestSchema.safeParse(surfaceRequest).success).toBe(true);
    expect(surfaceCommandRequestSchema.safeParse(trustedEnvelope).success).toBe(false);
  });

  it('accepts only a fully server-enriched trusted envelope', () => {
    expect(trustedCommandEnvelopeSchema.safeParse(trustedEnvelope).success).toBe(true);
    expect(trustedCommandEnvelopeSchema.safeParse(surfaceRequest).success).toBe(false);
  });

  it.each([
    'commandId',
    'ownerId',
    'actor',
    'presenceId',
    'authenticatedSessionId',
    'ownerPolicyRevision',
    'authAssurance',
    'ownerRootRoutingVersion',
    'requestDigest',
    'correlationId',
    'receivedAt',
  ])('requires the server-owned %s field', (field) => {
    const candidate = { ...trustedEnvelope } as Record<string, unknown>;
    delete candidate[field];
    expect(trustedCommandEnvelopeSchema.safeParse(candidate).success).toBe(false);
  });

  it.each([
    { ...trustedEnvelope, actor: { kind: 'admin', id: 'actor_01' } },
    { ...trustedEnvelope, requestDigest: `sha256:${'A'.repeat(64)}` },
    { ...trustedEnvelope, requestDigest: `sha256:${'a'.repeat(63)}` },
    { ...trustedEnvelope, requestDigest: `sha512:${'a'.repeat(64)}` },
    { ...trustedEnvelope, receivedAt: 'yesterday' },
    { ...trustedEnvelope, unexpected: true },
  ])('rejects a malformed trusted envelope', (candidate) => {
    expect(trustedCommandEnvelopeSchema.safeParse(candidate).success).toBe(false);
  });

  it('declares protocol v0.1 as online-only', () => {
    expect(
      presenceCapabilityV01Schema.safeParse({
        protocolVersion: '0.1',
        offlineCommands: 'none',
      }).success,
    ).toBe(true);
  });

  it.each([
    { protocolVersion: '0.0', offlineCommands: 'none' },
    { protocolVersion: '0.1', offlineCommands: 'queue' },
    { protocolVersion: '0.1', offlineCommands: 'create' },
    { protocolVersion: '0.1', offlineCommands: 'none', offlineQueue: true },
    { protocolVersion: '0.1', offlineCommands: 'none', createOffline: true },
  ])('rejects offline queue/create capability', (candidate) => {
    expect(presenceCapabilityV01Schema.safeParse(candidate).success).toBe(false);
  });

  it('accepts only an explicitly untrusted provider/session activity observation', () => {
    const event = {
      ...domainEventBase,
      payload: {
        trust: 'untrusted',
        sessionId: 'agent_session_01',
        workUnitId: 'work_unit_01',
        activity: 'provider_done',
        observedAt: '2026-08-05T12:04:59Z',
      },
    };

    expect(agentSessionActivityObservedEventSchema.safeParse(event).success).toBe(true);
    expect(domainEventSchema.safeParse(event).success).toBe(true);
  });

  it('accepts judgment-needed and candidate-evidence observations without promoting truth', () => {
    const judgmentNeeded = {
      ...domainEventBase,
      eventId: 'event_judgment_01',
      eventType: 'agent_session.judgment_needed_observed',
      ownerCursor: 15,
      payload: {
        trust: 'untrusted',
        sessionId: 'agent_session_01',
        workUnitId: 'work_unit_01',
        reasonCode: 'choice_required',
        optionRefs: ['option_a', 'option_b'],
        observedAt: '2026-08-05T12:05:01Z',
      },
    };
    const candidateEvidence = {
      ...domainEventBase,
      eventId: 'event_evidence_01',
      eventType: 'agent_session.candidate_evidence_observed',
      ownerCursor: 16,
      payload: {
        trust: 'untrusted',
        sessionId: 'agent_session_01',
        workUnitId: 'work_unit_01',
        subjectRef: 'artifact_reviewed_01',
        evidenceRef: 'candidate_evidence_01',
        contentDigest: `sha256:${'b'.repeat(64)}`,
        observedAt: '2026-08-05T12:05:02Z',
      },
    };

    expect(judgmentNeededObservedEventSchema.safeParse(judgmentNeeded).success).toBe(true);
    expect(candidateEvidenceObservedEventSchema.safeParse(candidateEvidence).success).toBe(true);
  });

  it.each([
    ['rawTranscript', 'provider transcript content'],
    ['credential', 'credential_value'],
    ['personalContext', { homeAddress: 'private' }],
    ['rawHealth', { metric: 1 }],
    ['verification', { state: 'passed' }],
    ['acceptance', { decision: 'accepted' }],
    ['closure', { state: 'closed' }],
  ])('rejects truth or sensitive-content smuggling through %s', (field, value) => {
    expect(
      agentSessionActivityObservedEventSchema.safeParse({
        ...domainEventBase,
        payload: {
          trust: 'untrusted',
          sessionId: 'agent_session_01',
          workUnitId: 'work_unit_01',
          activity: 'provider_done',
          observedAt: '2026-08-05T12:04:59Z',
          [field]: value,
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    { ...domainEventBase, ownerCursor: -1, payload: {} },
    { ...domainEventBase, ownerCursor: 1.5, payload: {} },
    { ...domainEventBase, schemaVersion: '', payload: {} },
    { ...domainEventBase, occurredAt: 'not-a-timestamp', payload: {} },
    {
      ...domainEventBase,
      aggregate: { kind: 'agent_session', id: 'agent_session_01', revision: -1 },
      payload: {},
    },
    { ...domainEventBase, payload: {}, unexpected: true },
  ])('rejects a malformed domain event', (event) => {
    expect(domainEventSchema.safeParse(event).success).toBe(false);
  });

  it('accepts an ordered projection page with snapshot and cursor metadata', () => {
    expect(projectionPageSchema.safeParse(projectionPage).success).toBe(true);
    expect(
      projectionPageSchema.safeParse({
        ...projectionPage,
        nextCursor: 14,
        hasMore: false,
      }).success,
    ).toBe(true);
  });

  it.each([
    { ...projectionPage, snapshotBaseCursor: -1 },
    { ...projectionPage, fromExclusiveCursor: 10.5 },
    { ...projectionPage, snapshotBaseCursor: 11 },
    { ...projectionPage, fromExclusiveCursor: 13, nextCursor: 12 },
    { ...projectionPage, nextCursor: 15 },
    { ...projectionPage, hasMore: false },
    { ...projectionPage, nextCursor: 14, hasMore: true },
    { ...projectionPage, generatedAt: 'not-a-timestamp' },
    { ...projectionPage, items: Array.from({ length: 257 }, () => ({})) },
    { ...projectionPage, unexpected: true },
  ])('rejects malformed or inconsistent projection metadata', (candidate) => {
    expect(projectionPageSchema.safeParse(candidate).success).toBe(false);
  });

  it('canonicalizes equivalent requests identically for request-digest input', () => {
    const reorderedRequest = {
      payload: { userStatement: surfaceRequest.payload.userStatement },
      clientIssuedAt: surfaceRequest.clientIssuedAt,
      presenceRegistrationId: surfaceRequest.presenceRegistrationId,
      commandType: surfaceRequest.commandType,
      requestId: surfaceRequest.requestId,
      protocolVersion: surfaceRequest.protocolVersion,
    };

    expect(canonicalizeSurfaceCommandRequestForDigest(reorderedRequest)).toBe(
      canonicalizeSurfaceCommandRequestForDigest(surfaceRequest),
    );
  });

  it('changes canonical digest input when the request payload changes', () => {
    expect(
      canonicalizeSurfaceCommandRequestForDigest({
        ...surfaceRequest,
        payload: { userStatement: 'Handle a different responsibility.' },
      }),
    ).not.toBe(canonicalizeSurfaceCommandRequestForDigest(surfaceRequest));
  });

  it('preserves the exact user statement across validation and digest canonicalization', () => {
    const wireRequest = {
      ...surfaceRequest,
      requestId: 'request_capture_whitespace_01',
      payload: { userStatement: '  Keep the exact user wording.  ' },
    };
    const parsedRequest = responsibilityCaptureRequestSchema.parse(wireRequest);

    expect(parsedRequest.payload.userStatement).toBe(wireRequest.payload.userStatement);
    expect(canonicalizeSurfaceCommandRequestForDigest(parsedRequest)).toBe(
      canonicalizeSurfaceCommandRequestForDigest(wireRequest),
    );
  });

  it('rejects malformed requests before canonicalization', () => {
    expect(() =>
      canonicalizeSurfaceCommandRequestForDigest({
        ...surfaceRequest,
        ownerId: 'owner_client_smuggled',
      }),
    ).toThrow();
  });
});
