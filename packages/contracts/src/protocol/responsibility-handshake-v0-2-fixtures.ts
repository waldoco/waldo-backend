import { z } from 'zod';
import {
  canonicalizeResponsibilityCaptureRequestV02ForDigest,
  responsibilityCaptureRequestV02Schema,
  responsibilityCaptureResultV02Schema,
  responsibilityCaptureTrustedEnvelopeV02Schema,
  responsibilityProjectionPageV02Schema,
  responsibilityProtocolCapabilitiesV02Schema,
} from './responsibility-handshake-v0-2';

type HashHex = (input: string) => string;

function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function schemaDocument(
  schema: z.ZodType,
  name: string,
  runtimeInvariants: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(z.toJSONSchema(schema, {
      target: 'draft-2020-12',
      io: 'input',
      reused: 'ref',
    }) as Record<string, unknown>),
    $id: `urn:waldo:protocol:responsibility-handshake:0.2:${name}`,
    title: `Waldo responsibility-handshake v0.2 ${name}`,
    description:
      'Structural interoperability schema. Canonical admission also requires the listed Waldo runtime invariants.',
    'x-waldo-validation-level': 'structural',
    'x-waldo-runtime-validator-required': true,
    'x-waldo-runtime-invariants': runtimeInvariants,
    'x-waldo-offline-commands': 'none',
  };
}

export function buildResponsibilityHandshakeV02Bundle(
  hashHex: HashHex,
): Record<string, string> {
  const request = responsibilityCaptureRequestV02Schema.parse({
    protocolVersion: '0.2',
    requestId: 'request_capture_02',
    commandType: 'responsibility.capture',
    presenceRegistrationId: 'presence_registration_01',
    clientIssuedAt: '2026-08-06T06:00:00.000Z',
    payload: {
      userStatement: 'Prepare and review the release.',
      mission: { brief: 'Prepare a reviewable release.' },
      workUnitProposals: [{ responsibility: 'Review the release artifact.' }],
    },
  });
  const requestDigest = `sha256:${hashHex(
    canonicalizeResponsibilityCaptureRequestV02ForDigest(request),
  )}`;
  const trusted = responsibilityCaptureTrustedEnvelopeV02Schema.parse({
    protocolVersion: '0.2',
    commandId: 'command_capture_02',
    commandType: 'responsibility.capture',
    ownerId: 'owner_server_01',
    actor: { kind: 'presence', id: 'presence_server_01' },
    presenceId: 'presence_server_01',
    authenticatedSessionId: 'authenticated_session_01',
    ownerPolicyRevision: 1,
    authAssurance: 'verified_session',
    ownerRootRoutingVersion: 1,
    requestDigest,
    correlationId: 'correlation_02',
    receivedAt: '2026-08-06T06:00:01.000Z',
    payload: request.payload,
  });
  const result = responsibilityCaptureResultV02Schema.parse({
    protocolVersion: '0.2',
    duplicate: false,
    ownerId: trusted.ownerId,
    requestId: request.requestId,
    outcome: {
      id: 'outcome_01', ownerId: trusted.ownerId, revision: 1,
      userStatement: request.payload.userStatement, state: 'captured',
      createdAt: trusted.receivedAt, updatedAt: trusted.receivedAt,
    },
    mission: {
      id: 'mission_01', ownerId: trusted.ownerId, outcomeId: 'outcome_01', revision: 1,
      brief: request.payload.mission!.brief, state: 'proposed',
      createdAt: trusted.receivedAt, updatedAt: trusted.receivedAt,
    },
    workUnitProposals: [{
      id: 'work_unit_proposal_01', ownerId: trusted.ownerId, outcomeId: 'outcome_01',
      missionId: 'mission_01', position: 0, revision: 1,
      responsibility: request.payload.workUnitProposals![0]!.responsibility,
      state: 'proposed', createdAt: trusted.receivedAt, updatedAt: trusted.receivedAt,
    }],
    projectionCursor: 3,
  });
  const projection = responsibilityProjectionPageV02Schema.parse({
    protocolVersion: '0.2',
    ownerId: trusted.ownerId,
    projectionName: 'responsibility.summary',
    snapshotId: 'snapshot_01',
    snapshotBaseCursor: 0,
    fromExclusiveCursor: 0,
    highWaterCursor: 4,
    nextCursor: 4,
    items: [
      {
        cursor: 1, itemType: 'outcome', aggregateId: 'outcome_01', outcomeId: 'outcome_01',
        revision: 1, state: 'captured', userStatement: request.payload.userStatement,
        createdAt: trusted.receivedAt,
      },
      {
        cursor: 3, itemType: 'work_unit_proposal', aggregateId: 'work_unit_proposal_01',
        outcomeId: 'outcome_01', missionId: 'mission_01', position: 0, revision: 1,
        state: 'proposed', responsibility: request.payload.workUnitProposals![0]!.responsibility,
        createdAt: trusted.receivedAt,
      },
    ],
    hasMore: false,
    generatedAt: '2026-08-06T06:00:02.000Z',
  });
  const capabilities = responsibilityProtocolCapabilitiesV02Schema.parse({
    protocolName: 'responsibility-handshake',
    supportedVersions: ['0.1', '0.2'],
    selectedVersion: '0.2',
    offlineCommands: 'none',
  });

  const files: Record<string, string> = {
    'capabilities.schema.json': jsonFile(schemaDocument(
      responsibilityProtocolCapabilitiesV02Schema,
      'capabilities',
      {
        negotiation: 'selectedVersion must be included in supportedVersions',
        offlineCommands: 'none',
      },
    )),
    'capabilities.valid.json': jsonFile(capabilities),
    'responsibility-capture-request.schema.json': jsonFile(schemaDocument(
      responsibilityCaptureRequestV02Schema,
      'responsibility-capture-request',
      {
        admission: 'strict command-specific schema before canonicalization',
        userText: 'well-formed UTF-16 with non-whitespace content',
        maxPayloadUtf8Bytes: 16_384,
        maxWorkUnitProposals: 32,
        serverOwnedFields: 'rejected',
      },
    )),
    'responsibility-capture-request.valid.json': jsonFile(request),
    'responsibility-capture-trusted-envelope.schema.json': jsonFile(schemaDocument(
      responsibilityCaptureTrustedEnvelopeV02Schema,
      'responsibility-capture-trusted-envelope',
      {
        ownerBinding: 'ownerId is supplied only by trusted server context',
        digest: 'recomputed from the admitted surface request',
        payload: 'must equal the admitted request payload',
        aggregateAndRevision: 'server-owned and absent for direct capture',
      },
    )),
    'responsibility-capture-trusted-envelope.valid.json': jsonFile(trusted),
    'responsibility-capture-result.schema.json': jsonFile(schemaDocument(
      responsibilityCaptureResultV02Schema,
      'responsibility-capture-result',
      {
        ownerBinding: 'Outcome, Mission, and proposals equal result ownerId',
        relationships: 'Mission and proposals belong to the admitted Outcome',
        proposalOrder: 'position equals array index',
        idempotency: 'exact retries return the persisted original result',
      },
    )),
    'responsibility-capture-result.valid.json': jsonFile(result),
    'responsibility-projection-page.schema.json': jsonFile(schemaDocument(
      responsibilityProjectionPageV02Schema,
      'responsibility-projection-page',
      {
        maxItemsPerPage: 256,
        maxPageUtf8Bytes: 262_144,
        itemCursorOrder: 'strictly ascending global owner cursors within the scanned range',
        filteredGaps: 'allowed, including empty pages that advance nextCursor',
        cursorRange: 'snapshotBaseCursor <= fromExclusiveCursor <= nextCursor <= highWaterCursor',
        hasMore: 'nextCursor < highWaterCursor',
      },
    )),
    'responsibility-projection-page.valid.json': jsonFile(projection),
    'responsibility-v0.2.rejections.json': jsonFile({
      protocolVersion: '0.2',
      cases: [
        {
          name: 'cross-owner-result',
          schema: 'responsibility-capture-result',
          value: {
            ...result,
            mission: { ...result.mission!, ownerId: 'owner_other_01' },
          },
        },
        {
          name: 'cross-mission-proposal',
          schema: 'responsibility-capture-result',
          value: {
            ...result,
            workUnitProposals: [{
              ...result.workUnitProposals[0]!, missionId: 'mission_other_01',
            }],
          },
        },
        {
          name: 'out-of-order-projection-cursors',
          schema: 'responsibility-projection-page',
          value: {
            ...projection,
            items: [projection.items[1]!, projection.items[0]!],
          },
        },
        {
          name: 'inconsistent-projection-page-cursors',
          schema: 'responsibility-projection-page',
          value: { ...projection, nextCursor: 3, hasMore: false },
        },
      ],
    }),
  };
  files['manifest.json'] = jsonFile({
    formatVersion: 1,
    protocolVersion: '0.2',
    previousVersionCompatibility: 'passed',
    previousVersionManifestSha256:
      'sha256:9553fceb9797cbc6e3fe6441c099dfccaed2e4d3b199dcb4c1e5c9b754db2cca',
    files: Object.keys(files).sort().map((path) => ({
      path,
      sha256: `sha256:${hashHex(files[path]!)}`,
    })),
  });
  return files;
}
