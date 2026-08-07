import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  buildResponsibilityPlanningTurnV03Bundle,
  responsibilityPlanningTurnRejectionCatalogueV03Schema,
} from './responsibility-planning-turn-v0-3-fixtures';
import {
  emptyPlanningCapabilityManifestV03Schema,
  workUnitPlanningAuthorityCeilingV03Schema,
  workUnitCandidatePlanV03Schema,
  workUnitPlanningTurnRequestV03Schema,
  workUnitPlanningCancelRequestV03Schema,
  workUnitPlanningProjectionPageV03Schema,
} from './responsibility-planning-turn-v0-3';

describe('responsibility planning turn v0.3', () => {
  const request = {
    protocolVersion: '0.3',
    requestId: 'request_plan_01',
    commandType: 'work_unit.request_planning_turn',
    presenceRegistrationId: 'presence_registration_01',
    aggregate: {
      kind: 'work_unit',
      id: 'work_unit_01',
      expectedRevision: 1,
    },
    correlationId: 'correlation_plan_01',
    clientIssuedAt: '2026-08-07T10:00:00.000Z',
    payload: {
      governedInputs: [
        {
          ref: 'fixture_investor_context_01',
          digest: `sha256:${'a'.repeat(64)}`,
          content: 'The investor cares about distribution and evidence of follow-through.',
        },
      ],
    },
  } as const;

  it('admits only a bounded WorkUnit planning request and no client-owned execution authority', () => {
    expect(workUnitPlanningTurnRequestV03Schema.parse(request)).toEqual(request);
    expect(workUnitPlanningTurnRequestV03Schema.safeParse({
      ...request,
      provider: 'client-selected-provider',
    }).success).toBe(false);
    expect(workUnitPlanningTurnRequestV03Schema.safeParse({
      ...request,
      payload: { ...request.payload, tools: ['web_search'] },
    }).success).toBe(false);
    expect(workUnitPlanningTurnRequestV03Schema.safeParse({
      ...request,
      aggregate: { ...request.aggregate, expectedRevision: 0 },
    }).success).toBe(false);
  });

  it('accepts a useful strict candidate plan and rejects schema expansion or oversized lists', () => {
    const plan = {
      summary: 'Prepare a concise meeting brief and a reviewable follow-up checklist.',
      proposedSteps: [
        'Review the supplied investor context.',
        'Draft the meeting brief.',
        'List follow-ups for the user to handle.',
      ],
      openQuestions: ['Which metric should lead the update?'],
      constraints: ['Do not contact anyone or modify external systems.'],
    };

    expect(workUnitCandidatePlanV03Schema.parse(plan)).toEqual(plan);
    expect(workUnitCandidatePlanV03Schema.safeParse({ ...plan, outcomeComplete: true }).success)
      .toBe(false);
    expect(workUnitCandidatePlanV03Schema.safeParse({
      ...plan,
      proposedSteps: Array.from({ length: 13 }, (_, index) => `Step ${index}`),
    }).success).toBe(false);
  });

  it('pins a literal empty capability manifest and a planning-only authority ceiling', () => {
    expect(emptyPlanningCapabilityManifestV03Schema.parse({
      schemaVersion: '0.3',
      tools: [],
      connectors: [],
      filesystem: 'none',
      shell: 'none',
      network: 'none',
      externalEffects: 'none',
    })).toEqual({
      schemaVersion: '0.3',
      tools: [],
      connectors: [],
      filesystem: 'none',
      shell: 'none',
      network: 'none',
      externalEffects: 'none',
    });
    expect(emptyPlanningCapabilityManifestV03Schema.safeParse({
      schemaVersion: '0.3',
      tools: ['web_search'],
      connectors: [],
      filesystem: 'none',
      shell: 'none',
      network: 'none',
      externalEffects: 'none',
    }).success).toBe(false);

    expect(workUnitPlanningAuthorityCeilingV03Schema.parse({
      providerPlanningTurns: 1,
      tools: 'none',
      connectors: 'none',
      externalEffects: 'none',
      outcomeMutation: 'none',
      evidence: 'none',
      verification: 'none',
      acceptance: 'none',
      closure: 'none',
    })).toBeTruthy();
  });

  it('keeps cancellation strict and free of client-owned owner/provider authority', () => {
    const cancellation = {
      protocolVersion: '0.3', requestId: 'planning_cancel_01',
      commandType: 'work_unit.cancel_planning_turn',
      presenceRegistrationId: 'presence_registration_01',
      executionRequestId: 'execution_request_01', expectedCancellationGeneration: 0,
      clientIssuedAt: '2026-08-07T10:00:00.000Z',
    } as const;
    expect(workUnitPlanningCancelRequestV03Schema.parse(cancellation)).toEqual(cancellation);
    expect(workUnitPlanningCancelRequestV03Schema.safeParse({
      ...cancellation, ownerId: 'owner_attacker', provider: 'attacker',
    }).success).toBe(false);
  });

  it('rejects a structurally valid planning projection above the page byte ceiling', () => {
    const candidatePlan = {
      summary: '界'.repeat(1_024),
      proposedSteps: Array.from({ length: 12 }, () => 'x'.repeat(250)),
      openQuestions: Array.from({ length: 8 }, () => 'x'.repeat(200)),
      constraints: Array.from({ length: 12 }, () => 'x'.repeat(200)),
    };
    const items = Array.from({ length: 32 }, (_, index) => ({
      cursor: index + 1, itemType: 'work_unit_candidate_plan' as const,
      outcomeId: 'outcome_01', workUnitId: 'work_unit_01',
      executionRequestId: `execution_request_${index}`,
      agentSessionId: `agent_session_${index}`,
      resultDigest: `sha256:${index.toString(16).padStart(64, '0')}`,
      candidatePlan, createdAt: '2026-08-07T10:00:00.000Z',
    }));
    expect(workUnitPlanningProjectionPageV03Schema.safeParse({
      protocolVersion: '0.3', ownerId: 'owner_01',
      projectionName: 'work_unit.planning_activity', snapshotId: 'snapshot_01',
      snapshotBaseCursor: 0, fromExclusiveCursor: 0, highWaterCursor: 32,
      nextCursor: 32, items, hasMore: false, generatedAt: '2026-08-07T10:00:00.000Z',
    }).success).toBe(false);
  });

  it('makes every v0.3 rejection fixture executable at its declared validation layer', () => {
    const bundle = buildResponsibilityPlanningTurnV03Bundle(() => 'a'.repeat(64));
    const catalogue = responsibilityPlanningTurnRejectionCatalogueV03Schema.parse(
      JSON.parse(bundle['planning-turn.rejections.json']!),
    );
    const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
    for (const keyword of [
      'x-waldo-validation-level',
      'x-waldo-offline-commands',
    ]) ajv.addKeyword(keyword);
    const validators = new Map(
      [...new Set(catalogue.cases.map((entry) => entry.schema))].map((path) => [
        path,
        ajv.compile(JSON.parse(bundle[path]!)),
      ]),
    );
    const validFixtureBySchema = {
      'planning-turn-request.schema.json': 'planning-turn-request.valid.json',
      'planning-turn-trusted-envelope.schema.json':
        'planning-turn-trusted-envelope.valid.json',
      'work-unit-candidate-plan.schema.json': 'work-unit-candidate-plan.valid.json',
    } as const;

    for (const [schemaPath, validate] of validators) {
      const validPath = validFixtureBySchema[schemaPath];
      expect(
        validate(JSON.parse(bundle[validPath]!)),
        `${validPath}: ${JSON.stringify(validate.errors)}`,
      ).toBe(true);
    }

    for (const rejection of catalogue.cases) {
      const validate = validators.get(rejection.schema);
      if (validate === undefined) throw new Error(`missing validator for ${rejection.schema}`);
      const accepted = validate(rejection.value);
      expect(accepted, `${rejection.name}: ${JSON.stringify(validate.errors)}`)
        .toBe(rejection.layer === 'runtime');
    }
  });
});
