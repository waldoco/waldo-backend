import { z } from 'zod';
import {
  canonicalizeResponsibilityCaptureRequestV02ForDigest,
  responsibilityCaptureRequestV02Schema,
  responsibilityCaptureResultV01CompatibilitySchema,
  responsibilityCaptureResultV02Schema,
  responsibilityCaptureTrustedEnvelopeV02Schema,
  responsibilityProjectionPageV01CompatibilitySchema,
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
      workUnits: [{
        responsibility: 'Review the release artifact.',
        inputs: ['Prepared release artifact.'],
        dependencyPositions: [],
        expectedEvidence: ['A review report bound to the artifact digest.'],
        requiredCapabilities: ['artifact.read'],
        stopConditions: ['Stop before publication.'],
      }],
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
    workUnits: [{
      id: 'work_unit_01', ownerId: trusted.ownerId, outcomeId: 'outcome_01',
      missionId: 'mission_01', position: 0, revision: 1,
      responsibility: request.payload.workUnits![0]!.responsibility,
      inputs: request.payload.workUnits![0]!.inputs,
      dependencyIds: [],
      expectedEvidence: request.payload.workUnits![0]!.expectedEvidence,
      requiredCapabilities: request.payload.workUnits![0]!.requiredCapabilities,
      authorityCeiling: { externalEffects: 'none', acceptance: 'none', closure: 'none' },
      budget: { maxProviderTurns: 0, maxExternalEffects: 0, maxDurationMs: 0 },
      isolation: { mode: 'unassigned', egress: 'deny_all', credentials: 'none' },
      stopConditions: request.payload.workUnits![0]!.stopConditions,
      assignee: null,
      sessionIds: [],
      state: 'planned', createdAt: trusted.receivedAt, updatedAt: trusted.receivedAt,
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
        cursor: 3, itemType: 'work_unit', aggregateId: 'work_unit_01',
        outcomeId: 'outcome_01', missionId: 'mission_01', position: 0, revision: 1,
        state: 'planned', responsibility: request.payload.workUnits![0]!.responsibility,
        dependencyIds: [],
        requiredCapabilities: request.payload.workUnits![0]!.requiredCapabilities,
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
  const resultV01 = responsibilityCaptureResultV01CompatibilitySchema.parse({
    protocolVersion: '0.1',
    ownerId: trusted.ownerId,
    requestId: 'request_capture_v01_compat',
    outcome: {
      ...result.outcome,
      id: 'outcome_v01_compat',
      userStatement: 'Capture this responsibility through released v0.1.',
    },
    mission: null,
    workUnits: [],
    projectionCursor: 1,
  });
  const projectionV01 = responsibilityProjectionPageV01CompatibilitySchema.parse({
    protocolVersion: '0.1',
    ownerId: trusted.ownerId,
    projectionName: 'responsibility.summary',
    snapshotId: 'snapshot_v01_compat',
    snapshotBaseCursor: 0,
    fromExclusiveCursor: 0,
    highWaterCursor: 1,
    nextCursor: 1,
    items: [{
      cursor: 1, itemType: 'outcome', aggregateId: resultV01.outcome.id,
      outcomeId: resultV01.outcome.id, revision: 1, state: 'captured',
      userStatement: resultV01.outcome.userStatement, createdAt: trusted.receivedAt,
    }],
    hasMore: false,
    generatedAt: '2026-08-06T06:00:02.000Z',
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
        maxWorkUnits: 32,
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
        ownerBinding: 'Outcome, Mission, and WorkUnits equal result ownerId',
        relationships: 'Mission and WorkUnits belong to the admitted Outcome',
        workUnitOrder: 'position equals array index and dependencies point backward',
        idempotency: 'exact retries return the persisted original result',
      },
    )),
    'responsibility-capture-result.valid.json': jsonFile(result),
    'responsibility-capture-result-v0.1-compat.schema.json': jsonFile(schemaDocument(
      responsibilityCaptureResultV01CompatibilitySchema,
      'responsibility-capture-result-v0.1-compat',
      { compatibility: 'released v0.1 simple capture returns no Mission or WorkUnits' },
    )),
    'responsibility-capture-result-v0.1-compat.valid.json': jsonFile(resultV01),
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
    'responsibility-projection-page-v0.1-compat.schema.json': jsonFile(schemaDocument(
      responsibilityProjectionPageV01CompatibilitySchema,
      'responsibility-projection-page-v0.1-compat',
      {
        compatibility: 'released v0.1 generic page carrying responsibility summary items',
        itemCursorOrder: 'strictly ascending global owner cursors within the scanned range',
      },
    )),
    'responsibility-projection-page-v0.1-compat.valid.json': jsonFile(projectionV01),
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
          name: 'cross-mission-work-unit',
          schema: 'responsibility-capture-result',
          value: {
            ...result,
            workUnits: [{
              ...result.workUnits[0]!, missionId: 'mission_other_01',
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
