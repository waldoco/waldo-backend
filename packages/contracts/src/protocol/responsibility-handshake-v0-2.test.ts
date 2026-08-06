import { describe, expect, it } from 'vitest';
import {
  responsibilityCaptureRequestSchema,
} from './responsibility-handshake-v0-1';
import {
  responsibilityCaptureRequestV02Schema,
  responsibilityCaptureResultV02Schema,
  responsibilityProjectionPageV02Schema,
  responsibilityProtocolCapabilitiesV02Schema,
} from './responsibility-handshake-v0-2';

describe('responsibility handshake v0.2', () => {
  it('keeps released v0.1 strict while negotiating the additive v0.2 planning seam', () => {
    const planned = {
      protocolVersion: '0.2',
      requestId: 'request_01',
      commandType: 'responsibility.capture',
      presenceRegistrationId: 'presence_registration_01',
      clientIssuedAt: '2026-08-06T06:00:00.000Z',
      payload: {
        userStatement: 'Prepare and review the release.',
        mission: { brief: 'Prepare a reviewable release.' },
        workUnitProposals: [{ responsibility: 'Review the release artifact.' }],
      },
    };

    expect(responsibilityCaptureRequestSchema.safeParse({
      ...planned,
      protocolVersion: '0.1',
    }).success).toBe(false);
    expect(responsibilityCaptureRequestV02Schema.parse(planned)).toEqual(planned);
    expect(responsibilityProtocolCapabilitiesV02Schema.parse({
      protocolName: 'responsibility-handshake',
      supportedVersions: ['0.1', '0.2'],
      selectedVersion: '0.2',
      offlineCommands: 'none',
    })).toBeDefined();
  });

  it('names bounded planning inputs WorkUnitProposal and validates their relationships', () => {
    const result = {
      protocolVersion: '0.2',
      duplicate: false,
      ownerId: 'owner_01',
      requestId: 'request_01',
      outcome: {
        id: 'outcome_01', ownerId: 'owner_01', revision: 1,
        userStatement: 'Prepare and review the release.', state: 'captured',
        createdAt: '2026-08-06T06:00:01.000Z', updatedAt: '2026-08-06T06:00:01.000Z',
      },
      mission: null,
      workUnitProposals: [{
        id: 'work_unit_proposal_01', ownerId: 'owner_01', outcomeId: 'outcome_01',
        missionId: null, position: 0, revision: 1,
        responsibility: 'Review the release artifact.', state: 'proposed',
        createdAt: '2026-08-06T06:00:01.000Z', updatedAt: '2026-08-06T06:00:01.000Z',
      }],
      projectionCursor: 2,
    };
    expect(responsibilityCaptureResultV02Schema.parse(result)).toEqual(result);
    expect(responsibilityCaptureResultV02Schema.safeParse({
      ...result,
      workUnitProposals: [{ ...result.workUnitProposals[0], outcomeId: 'outcome_other' }],
    }).success).toBe(false);
  });

  it('allows a filtered projection page to advance across owner-global cursor gaps', () => {
    const page = {
      protocolVersion: '0.2',
      ownerId: 'owner_01',
      projectionName: 'responsibility.summary',
      snapshotId: 'snapshot_01',
      snapshotBaseCursor: 0,
      fromExclusiveCursor: 2,
      highWaterCursor: 7,
      nextCursor: 7,
      items: [{
        cursor: 5,
        itemType: 'outcome',
        aggregateId: 'outcome_02',
        outcomeId: 'outcome_02',
        revision: 1,
        state: 'captured',
        userStatement: 'A later responsibility event.',
        createdAt: '2026-08-06T06:00:01.000Z',
      }],
      hasMore: false,
      generatedAt: '2026-08-06T06:00:02.000Z',
    };
    expect(responsibilityProjectionPageV02Schema.parse(page)).toEqual(page);
    expect(responsibilityProjectionPageV02Schema.parse({
      ...page,
      fromExclusiveCursor: 7,
      highWaterCursor: 9,
      nextCursor: 9,
      items: [],
    })).toBeDefined();
  });
});
