import { z } from 'zod';
import {
  agentSessionActivityObservedEventSchema,
  candidateEvidenceObservedEventSchema,
  canonicalizeSurfaceCommandRequestForDigest,
  domainEventSchema,
  judgmentNeededObservedEventSchema,
  presenceCapabilityV01Schema,
  projectionPageEnvelopeSchemaFor,
  responsibilityCaptureRequestSchema,
  responsibilityCaptureTrustedEnvelopeSchema,
  surfaceCommandRequestSchema,
  trustedCommandEnvelopeSchema,
} from './responsibility-handshake-v0-1';

type JsonRecord = Record<string, unknown>;
type HashHex = (input: string) => string;

function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function digestFor(hashHex: HashHex, value: string): string {
  return `sha256:${hashHex(value)}`;
}

function schemaDocument(
  schema: z.ZodType,
  id: string,
  title: string,
  runtimeInvariants: JsonRecord,
): JsonRecord {
  const generated = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    reused: 'ref',
  }) as JsonRecord;
  return {
    ...generated,
    $id: id,
    title,
    description:
      'Structural interoperability schema. Canonical admission also requires the listed Waldo runtime invariants.',
    'x-waldo-validation-level': 'structural',
    'x-waldo-runtime-validator-required': true,
    'x-waldo-runtime-invariants': runtimeInvariants,
  };
}

export function buildResponsibilityHandshakeV01Bundle(
  hashHex: HashHex,
): Record<string, string> {
  const surfaceRequest = {
    protocolVersion: '0.1',
    requestId: 'request_capture_01',
    commandType: 'responsibility.capture',
    presenceRegistrationId: 'presence_registration_01',
    clientIssuedAt: '2026-08-05T12:00:00Z',
    payload: {
      userStatement: 'Make sure the reviewed update is handled.',
    },
  };
  const canonicalRequest = canonicalizeSurfaceCommandRequestForDigest(surfaceRequest);
  const requestDigest = digestFor(hashHex, canonicalRequest);
  const trustedEnvelope = {
    protocolVersion: '0.1',
    commandId: 'command_capture_01',
    commandType: 'responsibility.capture',
    ownerId: 'owner_server_01',
    actor: { kind: 'presence', id: 'presence_server_01' },
    presenceId: 'presence_server_01',
    authenticatedSessionId: 'session_server_01',
    ownerPolicyRevision: 3,
    authAssurance: 'verified_session',
    ownerRootRoutingVersion: 2,
    requestDigest,
    correlationId: 'correlation_capture_01',
    receivedAt: '2026-08-05T12:00:01Z',
    payload: surfaceRequest.payload,
  };

  const projectionPage = {
    protocolVersion: '0.1',
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

  const reorderedDuplicate = {
    payload: { userStatement: surfaceRequest.payload.userStatement },
    clientIssuedAt: surfaceRequest.clientIssuedAt,
    presenceRegistrationId: surfaceRequest.presenceRegistrationId,
    commandType: surfaceRequest.commandType,
    requestId: surfaceRequest.requestId,
    protocolVersion: surfaceRequest.protocolVersion,
  };
  const changedDuplicate = {
    ...surfaceRequest,
    payload: { userStatement: 'Make sure a different update is handled.' },
  };
  const whitespaceRequest = {
    ...surfaceRequest,
    requestId: 'request_capture_whitespace_01',
    payload: { userStatement: '  Keep the exact user wording.  ' },
  };
  const escapedUnicodeRequest = {
    ...surfaceRequest,
    requestId: 'request_capture_escaping_01',
    payload: {
      userStatement: 'Handle "quoted" paths like C:\\work.\nKeep 🐕 intact.',
    },
  };
  const rejectedClientFields: Array<[string, JsonRecord]> = [
    ['owner', { ownerId: 'client_claim' }],
    ['actor', { actor: { kind: 'owner', id: 'client_claim' } }],
    ['actor role', { actorRole: 'owner' }],
    ['routing target', { targetDurableObjectId: 'client_claim' }],
    ['routing version', { ownerRootRoutingVersion: 1 }],
    ['authority grant', { authorityGrant: { id: 'client_claim' } }],
    ['credential', { credential: { ref: 'client_claim' } }],
    ['credential handle', { credentialHandle: 'client_claim' }],
    ['provider selector', { provider: 'client_claim' }],
    ['model selector', { model: 'client_claim' }],
    ['acceptance', { acceptance: { decision: 'accepted' } }],
    ['closure', { closure: { state: 'closed' } }],
    [
      'nested owner',
      { payload: { ...surfaceRequest.payload, ownerId: 'client_claim' } },
    ],
    [
      'nested authority grant',
      { payload: { ...surfaceRequest.payload, authorityGrant: { id: 'client_claim' } } },
    ],
    [
      'nested credential',
      { payload: { ...surfaceRequest.payload, credential: { ref: 'client_claim' } } },
    ],
    [
      'nested provider selector',
      { payload: { ...surfaceRequest.payload, provider: 'client_claim' } },
    ],
    [
      'nested model selector',
      { payload: { ...surfaceRequest.payload, model: 'client_claim' } },
    ],
    [
      'nested acceptance',
      { payload: { ...surfaceRequest.payload, acceptance: { decision: 'accepted' } } },
    ],
    [
      'nested closure',
      { payload: { ...surfaceRequest.payload, closure: { state: 'closed' } } },
    ],
  ];

  const files: Record<string, string> = {
    'domain-event.schema.json': jsonFile(
      schemaDocument(
        domainEventSchema,
        'urn:waldo:protocol:responsibility-handshake:0.1:domain-event',
        'Waldo DomainEvent protocol v0.1',
        {
          admission: 'eventType-discriminated concrete observation schemas',
          observationTrust: 'untrusted',
          aggregateKind: 'agent_session',
          aggregateId: 'equals payload.sessionId',
        },
      ),
    ),
    'observations.json': jsonFile({
      protocolVersion: '0.1',
      events: [
        {
          schemaVersion: '0.1',
          eventId: 'event_activity_01',
          eventType: 'agent_session.activity_observed',
          ownerId: 'owner_server_01',
          aggregate: { kind: 'agent_session', id: 'agent_session_01', revision: 2 },
          ownerCursor: 14,
          correlationId: 'correlation_capture_01',
          occurredAt: '2026-08-05T12:05:00Z',
          payload: {
            trust: 'untrusted',
            sessionId: 'agent_session_01',
            workUnitId: 'work_unit_01',
            activity: 'provider_done',
            observedAt: '2026-08-05T12:04:59Z',
          },
        },
        {
          schemaVersion: '0.1',
          eventId: 'event_judgment_01',
          eventType: 'agent_session.judgment_needed_observed',
          ownerId: 'owner_server_01',
          aggregate: { kind: 'agent_session', id: 'agent_session_01', revision: 3 },
          ownerCursor: 15,
          correlationId: 'correlation_capture_01',
          occurredAt: '2026-08-05T12:05:01Z',
          payload: {
            trust: 'untrusted',
            sessionId: 'agent_session_01',
            workUnitId: 'work_unit_01',
            reasonCode: 'choice_required',
            optionRefs: ['option_a', 'option_b'],
            observedAt: '2026-08-05T12:05:01Z',
          },
        },
        {
          schemaVersion: '0.1',
          eventId: 'event_evidence_01',
          eventType: 'agent_session.candidate_evidence_observed',
          ownerId: 'owner_server_01',
          aggregate: { kind: 'agent_session', id: 'agent_session_01', revision: 4 },
          ownerCursor: 16,
          correlationId: 'correlation_capture_01',
          occurredAt: '2026-08-05T12:05:02Z',
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
      ],
    }),
    'presence-capability.json': jsonFile({
      protocolVersion: '0.1',
      valid: { protocolVersion: '0.1', offlineCommands: 'none' },
      rejected: [
        {
          name: 'offline queue is not supported',
          capability: { protocolVersion: '0.1', offlineCommands: 'queue' },
        },
        {
          name: 'offline create is not supported',
          capability: { protocolVersion: '0.1', offlineCommands: 'create' },
        },
      ],
    }),
    'presence-capability-v0.1.schema.json': jsonFile(
      schemaDocument(
        presenceCapabilityV01Schema,
        'urn:waldo:protocol:responsibility-handshake:0.1:presence-capability',
        'Waldo PresenceCapabilityV01',
        { offlineCommands: 'none' },
      ),
    ),
    'projection-delivery.json': jsonFile({
      protocolVersion: '0.1',
      validPage: projectionPage,
      pairs: [
        {
          name: 'duplicate page',
          previous: projectionPage,
          next: projectionPage,
          expectedDisposition: 'ignore_duplicate',
        },
        {
          name: 'cursor gap',
          previous: projectionPage,
          next: {
            ...projectionPage,
            fromExclusiveCursor: 13,
            nextCursor: 14,
            items: [{ aggregateId: 'responsibility_03', revision: 1 }],
            hasMore: false,
            generatedAt: '2026-08-05T12:06:01Z',
          },
          expectedDisposition: 'recover_gap',
        },
        {
          name: 'snapshot replacement',
          previous: projectionPage,
          next: {
            ...projectionPage,
            snapshotId: 'snapshot_02',
            snapshotBaseCursor: 14,
            fromExclusiveCursor: 14,
            nextCursor: 14,
            items: [],
            hasMore: false,
            generatedAt: '2026-08-05T12:06:02Z',
          },
          expectedDisposition: 'replace_snapshot',
        },
        {
          name: 'owner account switch',
          previous: projectionPage,
          next: {
            ...projectionPage,
            ownerId: 'owner_server_02',
            snapshotId: 'snapshot_owner_02',
            snapshotBaseCursor: 0,
            fromExclusiveCursor: 0,
            highWaterCursor: 0,
            nextCursor: 0,
            items: [],
            hasMore: false,
            generatedAt: '2026-08-05T12:06:03Z',
          },
          expectedDisposition: 'reset_owner',
        },
      ],
    }),
    'projection-page.schema.json': jsonFile(
      schemaDocument(
        projectionPageEnvelopeSchemaFor(z.json()),
        'urn:waldo:protocol:responsibility-handshake:0.1:projection-page',
        'Waldo ProjectionPage protocol v0.1',
        {
          maxJsonDepth: 64,
          maxJsonNodes: 4_096,
          maxPageUtf8Bytes: 262_144,
          cursorOrder:
            'snapshotBaseCursor <= fromExclusiveCursor <= nextCursor <= highWaterCursor',
          hasMore: 'nextCursor < highWaterCursor',
        },
      ),
    ),
    'request-digests.json': jsonFile({
      protocolVersion: '0.1',
      digestAlgorithm: 'sha256',
      canonicalization: 'waldo-json-sorted-keys-v1',
      previousVersionCompatibility: 'not_run',
      cases: [
        {
          name: 'original request',
          request: surfaceRequest,
          canonicalRequest,
          expectedRequestDigest: requestDigest,
        },
        {
          name: 'same request id and same semantic request',
          request: reorderedDuplicate,
          canonicalRequest: canonicalizeSurfaceCommandRequestForDigest(reorderedDuplicate),
          expectedRequestDigest: digestFor(
            hashHex,
            canonicalizeSurfaceCommandRequestForDigest(reorderedDuplicate),
          ),
        },
        {
          name: 'same request id and changed payload',
          request: changedDuplicate,
          canonicalRequest: canonicalizeSurfaceCommandRequestForDigest(changedDuplicate),
          expectedRequestDigest: digestFor(
            hashHex,
            canonicalizeSurfaceCommandRequestForDigest(changedDuplicate),
          ),
        },
        {
          name: 'exact user whitespace is preserved',
          request: whitespaceRequest,
          canonicalRequest: canonicalizeSurfaceCommandRequestForDigest(whitespaceRequest),
          expectedRequestDigest: digestFor(
            hashHex,
            canonicalizeSurfaceCommandRequestForDigest(whitespaceRequest),
          ),
        },
        {
          name: 'unicode and JSON escaping',
          request: escapedUnicodeRequest,
          canonicalRequest:
            canonicalizeSurfaceCommandRequestForDigest(escapedUnicodeRequest),
          expectedRequestDigest: digestFor(
            hashHex,
            canonicalizeSurfaceCommandRequestForDigest(escapedUnicodeRequest),
          ),
        },
      ],
    }),
    'surface-command.rejections.json': jsonFile({
      protocolVersion: '0.1',
      cases: rejectedClientFields.map(([name, extra]) => ({
        name,
        request: { ...surfaceRequest, ...extra },
      })),
    }),
    'surface-command-request.schema.json': jsonFile(
      schemaDocument(
        surfaceCommandRequestSchema,
        'urn:waldo:protocol:responsibility-handshake:0.1:surface-command-request',
        'Waldo SurfaceCommandRequest protocol v0.1',
        {
          admission: 'commandType-discriminated concrete command schemas',
          maxPayloadUtf8Bytes: 16_384,
        },
      ),
    ),
    'surface-command.valid.json': jsonFile(surfaceRequest),
    'trusted-command-envelope.schema.json': jsonFile(
      schemaDocument(
        trustedCommandEnvelopeSchema,
        'urn:waldo:protocol:responsibility-handshake:0.1:trusted-command-envelope',
        'Waldo TrustedCommandEnvelope protocol v0.1',
        {
          admission: 'commandType-discriminated concrete trusted envelope schemas',
          maxPayloadUtf8Bytes: 16_384,
        },
      ),
    ),
    'trusted-command.valid.json': jsonFile(trustedEnvelope),
  };

  const entries = Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, content]) => ({ path, sha256: digestFor(hashHex, content) }));
  const manifest = jsonFile({
    formatVersion: 1,
    protocolVersion: '0.1',
    previousVersionCompatibility: 'not_run',
    files: entries,
  });

  return { 'manifest.json': manifest, ...files };
}
