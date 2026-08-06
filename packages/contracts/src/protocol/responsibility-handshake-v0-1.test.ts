import { describe, expect, it } from 'vitest';
import {
  agentSessionActivityObservedEventSchema,
  candidateEvidenceObservedEventSchema,
  canonicalizeProtocolJson,
  canonicalizeSurfaceCommandRequestForDigest,
  domainEventSchema,
  judgmentNeededObservedEventSchema,
  presenceCapabilityV01Schema,
  projectionPageSchema,
  protocolJsonObjectSchema,
  protocolJsonValueSchema,
  responsibilityCaptureRequestSchema,
  responsibilityCaptureResultV01Schema,
  responsibilityProjectionPageSchema,
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

function nestedArrays(depth: number): unknown {
  let value: unknown = null;
  for (let index = 0; index < depth; index += 1) value = [value];
  return value;
}

function testUtf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

describe('responsibility handshake v0.1', () => {
  it('fails bounded JSON validation instead of throwing on hostile nesting', () => {
    let result: { success: boolean } | undefined;

    expect(() => {
      result = protocolJsonObjectSchema.safeParse({ nested: nestedArrays(8_100) });
    }).not.toThrow();
    expect(result?.success).toBe(false);
  });

  it('enforces the iterative JSON node bound', () => {
    expect(protocolJsonValueSchema.safeParse(Array(4_095).fill(null)).success).toBe(
      true,
    );
    expect(protocolJsonValueSchema.safeParse(Array(4_096).fill(null)).success).toBe(
      false,
    );
  });

  it('rejects a wide object before reading properties beyond the node bound', () => {
    const wideObject: Record<string, unknown> = {};
    for (let index = 0; index < 4_095; index += 1) {
      wideObject[`key_${index}`] = null;
    }
    Object.defineProperty(wideObject, 'key_beyond_limit', {
      enumerable: true,
      get: () => {
        throw new Error('property beyond the node bound was read');
      },
    });
    let result: { success: boolean } | undefined;

    expect(() => {
      result = protocolJsonObjectSchema.safeParse(wideObject);
    }).not.toThrow();
    expect(result?.success).toBe(false);
  });

  it('enforces the iterative JSON depth bound', () => {
    expect(protocolJsonValueSchema.safeParse(nestedArrays(64)).success).toBe(true);
    expect(protocolJsonValueSchema.safeParse(nestedArrays(65)).success).toBe(false);
  });

  it('rejects hostile command nesting without throwing from safeParse', () => {
    const parse = () =>
      surfaceCommandRequestSchema.safeParse({
        ...surfaceRequest,
        payload: { nested: nestedArrays(8_100) },
      });

    expect(parse).not.toThrow();
    expect(parse().success).toBe(false);
  });

  it('rejects hostile projection nesting without throwing from safeParse', () => {
    const parse = () =>
      projectionPageSchema.safeParse({
        ...projectionPage,
        items: [nestedArrays(8_100)],
      });

    expect(parse).not.toThrow();
    expect(parse().success).toBe(false);
  });

  it('scopes the JSON node bound to each projection item', () => {
    expect(
      projectionPageSchema.safeParse({
        ...projectionPage,
        items: [Array(3_000).fill(null), Array(3_000).fill(null)],
      }).success,
    ).toBe(true);
    expect(
      projectionPageSchema.safeParse({
        ...projectionPage,
        items: [Array(4_096).fill(null)],
      }).success,
    ).toBe(false);
    expect(
      projectionPageSchema.safeParse({
        ...projectionPage,
        items: [Array(4_095).fill(null)],
      }).success,
    ).toBe(true);
  });

  it('accepts a full projection page of plausible flat items', () => {
    const item = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`field_${index}`, `value_${index}`]),
    );

    expect(
      projectionPageSchema.safeParse({
        ...projectionPage,
        items: Array.from({ length: 256 }, () => item),
      }).success,
    ).toBe(true);
  });

  it('enforces the serialized projection-page byte limit exactly', () => {
    const emptyStringPage = { ...projectionPage, items: [''] };
    const emptyPageBytes = testUtf8ByteLength(JSON.stringify(emptyStringPage));
    const exactLimitPage = {
      ...projectionPage,
      items: ['x'.repeat(262_144 - emptyPageBytes)],
    };
    const overLimitPage = {
      ...projectionPage,
      items: ['x'.repeat(262_145 - emptyPageBytes)],
    };

    expect(testUtf8ByteLength(JSON.stringify(exactLimitPage))).toBe(262_144);
    expect(projectionPageSchema.safeParse(exactLimitPage).success).toBe(true);
    const overLimitResult = projectionPageSchema.safeParse(overLimitPage);
    expect(overLimitResult.success).toBe(false);
    if (!overLimitResult.success) {
      expect(overLimitResult.error.issues.map((issue) => issue.message)).toContain(
        'projection page must not exceed 262144 UTF-8 bytes',
      );
    }

    const escapingSeed = '🐕"\\\n\t\u0000';
    const escapingSeedPage = { ...projectionPage, items: [escapingSeed] };
    const escapingSeedBytes = testUtf8ByteLength(JSON.stringify(escapingSeedPage));
    const exactEscapingPage = {
      ...projectionPage,
      items: [escapingSeed + 'x'.repeat(262_144 - escapingSeedBytes)],
    };
    expect(testUtf8ByteLength(JSON.stringify(exactEscapingPage))).toBe(262_144);
    expect(projectionPageSchema.safeParse(exactEscapingPage).success).toBe(true);
    expect(
      projectionPageSchema.safeParse({
        ...exactEscapingPage,
        items: [`${exactEscapingPage.items[0]}x`],
      }).success,
    ).toBe(false);
  });

  it('accepts the minimal untrusted responsibility-capture request', () => {
    expect(
      responsibilityCaptureRequestSchema.safeParse(surfaceRequest).success,
    ).toBe(true);
  });

  it('accepts optional Mission and bounded WorkUnit proposals without client-owned IDs', () => {
    expect(
      responsibilityCaptureRequestSchema.safeParse({
        ...surfaceRequest,
        payload: {
          ...surfaceRequest.payload,
          mission: { brief: 'Prepare and review the release.' },
          workUnits: [
            { responsibility: 'Prepare the release artifact.' },
            { responsibility: 'Review the release artifact.' },
          ],
        },
      }).success,
    ).toBe(true);
  });

  it('rejects owner and relationship corruption in persisted capture results', () => {
    const result = {
      duplicate: false,
      ownerId: 'owner_server_01',
      requestId: 'request_capture_01',
      outcome: {
        id: 'outcome_01', ownerId: 'owner_server_01', revision: 1,
        userStatement: 'Handle this.', state: 'captured',
        createdAt: '2026-08-06T06:00:00.000Z', updatedAt: '2026-08-06T06:00:00.000Z',
      },
      mission: null,
      workUnits: [],
      projectionCursor: 1,
    };
    expect(responsibilityCaptureResultV01Schema.safeParse(result).success).toBe(true);
    expect(responsibilityCaptureResultV01Schema.safeParse({
      ...result,
      outcome: { ...result.outcome, ownerId: 'owner_other_01' },
    }).success).toBe(false);
  });

  it('defines typed ordered Outcome, Mission, and WorkUnit projection items', () => {
    const page = {
        protocolVersion: '0.1',
        ownerId: 'owner_server_01',
        projectionName: 'responsibility.summary',
        snapshotId: 'snapshot_01',
        snapshotBaseCursor: 0,
        fromExclusiveCursor: 0,
        highWaterCursor: 3,
        nextCursor: 3,
        items: [
          {
            cursor: 1,
            itemType: 'outcome',
            aggregateId: 'outcome_01',
            outcomeId: 'outcome_01',
            revision: 1,
            state: 'captured',
            userStatement: 'Handle this.',
            createdAt: '2026-08-06T06:00:00.000Z',
          },
          {
            cursor: 2,
            itemType: 'mission',
            aggregateId: 'mission_01',
            outcomeId: 'outcome_01',
            revision: 1,
            state: 'proposed',
            brief: 'Plan the work.',
            createdAt: '2026-08-06T06:00:00.000Z',
          },
          {
            cursor: 3,
            itemType: 'work_unit',
            aggregateId: 'work_unit_01',
            outcomeId: 'outcome_01',
            missionId: 'mission_01',
            position: 0,
            revision: 1,
            state: 'proposed',
            responsibility: 'Do the bounded work.',
            createdAt: '2026-08-06T06:00:00.000Z',
          },
        ],
        hasMore: false,
        generatedAt: '2026-08-06T06:00:01.000Z',
      };
    expect(responsibilityProjectionPageSchema.safeParse(page).success).toBe(true);
    expect(
      responsibilityProjectionPageSchema.safeParse({
        ...page,
        nextCursor: 1,
        hasMore: true,
        items: [{ ...page.items[0], revision: 0 }],
      }).success,
    ).toBe(false);
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
    { ...surfaceRequest, commandType: 'outcome.create' },
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

  it('keeps public surface admission untrusted and strict', () => {
    expect(surfaceCommandRequestSchema.safeParse(surfaceRequest).success).toBe(true);
    expect(surfaceCommandRequestSchema.safeParse(trustedEnvelope).success).toBe(false);
  });

  it('uses command-specific admission before accepting or digesting a request', () => {
    const smuggledRequest = {
      ...surfaceRequest,
      payload: { ...surfaceRequest.payload, ownerId: 'owner_client_smuggled' },
    };

    expect(surfaceCommandRequestSchema.safeParse(smuggledRequest).success).toBe(false);
    expect(() => canonicalizeSurfaceCommandRequestForDigest(smuggledRequest)).toThrow();
  });

  it('accepts only a fully server-enriched trusted envelope', () => {
    expect(trustedCommandEnvelopeSchema.safeParse(trustedEnvelope).success).toBe(true);
    expect(trustedCommandEnvelopeSchema.safeParse(surfaceRequest).success).toBe(false);
  });

  it('uses command-specific admission for trusted envelope payloads', () => {
    expect(
      trustedCommandEnvelopeSchema.safeParse({
        ...trustedEnvelope,
        payload: { ...trustedEnvelope.payload, authorityGrant: { id: 'client_claim' } },
      }).success,
    ).toBe(false);
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
    { ...trustedEnvelope, commandType: 'outcome.create' },
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

  it('uses event-specific admission for observation trust boundaries', () => {
    const promotedObservation = {
      ...domainEventBase,
      payload: {
        trust: 'untrusted',
        sessionId: 'agent_session_01',
        workUnitId: 'work_unit_01',
        activity: 'provider_done',
        observedAt: '2026-08-05T12:04:59Z',
        verification: { state: 'passed' },
      },
    };

    expect(domainEventSchema.safeParse(promotedObservation).success).toBe(false);
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

  it('binds every agent-session observation to its payload session aggregate', () => {
    const cases = [
      {
        schema: agentSessionActivityObservedEventSchema,
        event: {
          ...domainEventBase,
          payload: {
            trust: 'untrusted',
            sessionId: 'agent_session_01',
            workUnitId: 'work_unit_01',
            activity: 'provider_done',
            observedAt: '2026-08-05T12:04:59Z',
          },
        },
      },
      {
        schema: judgmentNeededObservedEventSchema,
        event: {
          ...domainEventBase,
          eventType: 'agent_session.judgment_needed_observed',
          payload: {
            trust: 'untrusted',
            sessionId: 'agent_session_01',
            workUnitId: 'work_unit_01',
            reasonCode: 'choice_required',
            optionRefs: ['option_a', 'option_b'],
            observedAt: '2026-08-05T12:05:01Z',
          },
        },
      },
      {
        schema: candidateEvidenceObservedEventSchema,
        event: {
          ...domainEventBase,
          eventType: 'agent_session.candidate_evidence_observed',
          payload: {
            trust: 'untrusted',
            sessionId: 'agent_session_01',
            workUnitId: 'work_unit_01',
            subjectRef: 'artifact_reviewed_01',
            evidenceRef: 'candidate_evidence_01',
            contentDigest: `sha256:${'b'.repeat(64)}`,
            observedAt: '2026-08-05T12:05:02Z',
          },
        },
      },
    ];

    for (const { schema, event } of cases) {
      expect(
        schema.safeParse({
          ...event,
          aggregate: { kind: 'outcome', id: 'outcome_01', revision: 2 },
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          ...event,
          aggregate: {
            kind: 'agent_session',
            id: 'agent_session_different',
            revision: 2,
          },
        }).success,
      ).toBe(false);
    }
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
    { ...domainEventBase, eventType: 'outcome.verified', payload: {} },
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

  it('rejects an unknown event schema version through the v0.1 admission union', () => {
    expect(
      domainEventSchema.safeParse({
        ...domainEventBase,
        schemaVersion: '0.2',
        payload: {
          trust: 'untrusted',
          sessionId: 'agent_session_01',
          workUnitId: 'work_unit_01',
          activity: 'progress',
          observedAt: '2026-08-05T12:04:59Z',
        },
      }).success,
    ).toBe(false);
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

  it('sorts canonical JSON object keys by UTF-16 code units', () => {
    expect(
      canonicalizeProtocolJson({
        '\uE000': 'basic multilingual plane',
        '😀': 'astral plane',
      }),
    ).toBe('{"😀":"astral plane","":"basic multilingual plane"}');
  });

  it('does not let JavaScript reorder integer-like canonical object keys', () => {
    expect(canonicalizeProtocolJson({ 2: 'two', 10: 'ten', a: 'aye' })).toBe(
      '{"10":"ten","2":"two","a":"aye"}',
    );
  });

  it('rejects malformed UTF-16 before admission or canonicalization', () => {
    const malformed = '\uD800';

    expect(
      responsibilityCaptureRequestSchema.safeParse({
        ...surfaceRequest,
        payload: { userStatement: malformed },
      }).success,
    ).toBe(false);
    expect(() => canonicalizeProtocolJson({ value: malformed })).toThrow();
    expect(() => canonicalizeProtocolJson({ [malformed]: 'value' })).toThrow();
  });

  it.each([
    NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    undefined,
    1n,
    new Date('2026-08-05T00:00:00Z'),
    new Map([['key', 'value']]),
    Array(2),
  ])('rejects non-I-JSON canonicalization input %#', (value) => {
    expect(() => canonicalizeProtocolJson(value)).toThrow();
  });

  it('rejects cyclic canonicalization input without overflowing the stack', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => canonicalizeProtocolJson(cyclic)).toThrow();
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
