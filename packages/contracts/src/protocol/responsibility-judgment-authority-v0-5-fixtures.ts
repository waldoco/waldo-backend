import { z } from 'zod';
import {
  authorityGrantV05Schema,
  canonicalizeJudgmentRequestV05ForDigest,
  judgmentAnswerRequestV05Schema,
  judgmentAnswerResultV05Schema,
  judgmentAnswerRetrySemanticsV05,
  judgmentAuthorityBindingV05Schema,
  judgmentDecisionV05Schema,
  judgmentProjectionPageV05Schema,
  judgmentProjectionQueryV05Schema,
  judgmentRequestV05Schema,
} from './responsibility-judgment-authority-v0-5';

type HashHex = (input: string) => string;

const file = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const schema = (value: z.ZodType, name: string) => ({
  ...(z.toJSONSchema(value, { target: 'draft-2020-12', io: 'input', reused: 'ref' }) as object),
  $id: `urn:waldo:protocol:responsibility-judgment-authority:0.5:${name}`,
  'x-waldo-validation-level': 'structural-plus-runtime-invariants',
  'x-waldo-offline-commands': 'none',
});

export const RESPONSIBILITY_JUDGMENT_AUTHORITY_REJECTION_NAMES_V05 = [
  'client-owned-owner',
  'client-owned-actor',
  'client-owned-session',
  'client-owned-policy',
  'client-owned-routing',
  'client-owned-grantee',
  'client-owned-admission',
  'client-owned-decision',
  'client-owned-grant',
  'client-owned-requested-authority',
  'client-provider-selector',
  'client-credential',
  'client-private-context',
  'client-prototype-key-top',
  'client-prototype-key-aggregate',
  'client-prototype-key-payload',
  'request-inline-sensitive-content',
  'request-missing-uncertainty',
  'request-missing-cost-of-waiting',
  'request-missing-refusal-option',
  'stale-answer-revision',
  'stale-displayed-request-digest',
  'unknown-selected-option',
  'refused-result-with-grant',
  'projection-missing-displayed-digest',
  'projection-owner-mismatch',
  'projection-non-advancing-cursor',
  'projection-coordinated-request-digest-mismatch',
  'binding-grantee-mismatch',
  'binding-policy-mismatch',
  'binding-decision-at-expiry',
  'binding-coordinated-request-digest-mismatch',
] as const;

const rejectionCasesV05Schema = z
  .array(z.strictObject({
    name: z.enum(RESPONSIBILITY_JUDGMENT_AUTHORITY_REJECTION_NAMES_V05),
    schema: z.enum([
      'judgment-request.schema.json',
      'judgment-answer.schema.json',
      'judgment-answer-result.schema.json',
      'judgment-decision.schema.json',
      'authority-grant.schema.json',
      'judgment-authority-binding.schema.json',
      'judgment-projection-query.schema.json',
      'judgment-projection-page.schema.json',
    ]),
    layer: z.enum(['schema', 'runtime']),
    zodOutcome: z.enum(['accept', 'reject']),
    value: z.unknown(),
  }))
  .length(RESPONSIBILITY_JUDGMENT_AUTHORITY_REJECTION_NAMES_V05.length)
  .superRefine((cases, context) => {
    const names = cases.map((entry) => entry.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({ code: 'custom', message: 'rejection case names must be unique' });
    }
    for (const [index, expected] of RESPONSIBILITY_JUDGMENT_AUTHORITY_REJECTION_NAMES_V05.entries()) {
      if (names[index] !== expected) {
        context.addIssue({
          code: 'custom',
          path: [index, 'name'],
          message: `rejection case ${index + 1} must be ${expected}`,
        });
      }
    }
  });

export const responsibilityJudgmentAuthorityRejectionCatalogueV05Schema = z.strictObject({
  protocolVersion: z.literal('0.5'),
  cases: rejectionCasesV05Schema,
});

export function buildResponsibilityJudgmentAuthorityV05Bundle(
  hashHex: HashHex,
  sourceSha256: string,
): Record<string, string> {
  const judgmentRequest = judgmentRequestV05Schema.parse({
    protocolVersion: '0.5',
    id: 'judgment_request_fixture_01',
    ownerId: 'owner_fixture_01',
    revision: 2,
    subject: { kind: 'work_unit', id: 'work_unit_fixture_01', revision: 4 },
    question: {
      ref: 'judgment_question_fixture_01',
      digest: `sha256:${'1'.repeat(64)}`,
    },
    options: [
      {
        id: 'option_approve',
        authorityDisposition: 'grant',
        content: { ref: 'option_content_approve', digest: `sha256:${'2'.repeat(64)}` },
      },
      {
        id: 'option_reject',
        authorityDisposition: 'refuse',
        content: { ref: 'option_content_reject', digest: `sha256:${'3'.repeat(64)}` },
      },
    ],
    recommendation: 'option_approve',
    uncertainty: {
      ref: 'uncertainty_summary_fixture_01',
      digest: `sha256:${'4'.repeat(64)}`,
    },
    evidence: [{
      ref: 'evidence_summary_fixture_01',
      digest: `sha256:${'5'.repeat(64)}`,
    }],
    costOfWaiting: {
      ref: 'cost_of_waiting_summary_fixture_01',
      digest: `sha256:${'6'.repeat(64)}`,
    },
    risk: { ref: 'risk_summary_fixture_01', digest: `sha256:${'7'.repeat(64)}` },
    reversibility: {
      ref: 'reversibility_summary_fixture_01',
      digest: `sha256:${'8'.repeat(64)}`,
    },
    affectedDigest: `sha256:${'9'.repeat(64)}`,
    requestedAuthority: {
      purpose: 'calendar.follow_up.schedule',
      effectFamily: 'calendar.event.create',
      resources: [{ kind: 'calendar', ref: 'calendar_primary' }],
      scopes: ['calendar.event.create'],
      audiences: ['calendar.account'],
      argumentDigest: `sha256:${'a'.repeat(64)}`,
      contextDigest: `sha256:${'b'.repeat(64)}`,
      artifactDigest: null,
      useLimit: 1,
      validUntil: '2026-08-15T18:30:00.000Z',
    },
    authorityAdmission: {
      grantee: { kind: 'service', id: 'effect_engine' },
      ownerPolicyRevision: 7,
      admissionContextDigest: `sha256:${'c'.repeat(64)}`,
    },
    reEntryPointId: 'reentry_fixture_01',
    expiresAt: '2026-08-15T18:30:00.000Z',
    decisionId: null,
    state: 'open',
    createdAt: '2026-08-15T18:05:00.000Z',
    updatedAt: '2026-08-15T18:05:00.000Z',
  });
  const displayedRequestDigest = `sha256:${hashHex(
    canonicalizeJudgmentRequestV05ForDigest(judgmentRequest),
  )}`;
  const judgmentAnswer = judgmentAnswerRequestV05Schema.parse({
    protocolVersion: '0.5',
    requestId: 'answer_judgment_fixture_01',
    commandType: 'judgment.answer',
    presenceRegistrationId: 'presence_registration_fixture_01',
    aggregate: {
      kind: 'judgment_request',
      id: judgmentRequest.id,
      expectedRevision: judgmentRequest.revision,
    },
    correlationId: 'correlation_judgment_fixture_01',
    clientIssuedAt: '2026-08-15T18:10:00.000Z',
    payload: {
      selectedOptionId: 'option_approve',
      displayedRequestDigest,
    },
  });
  const judgmentDecision = judgmentDecisionV05Schema.parse({
    protocolVersion: '0.5',
    id: 'judgment_decision_fixture_01',
    ownerId: judgmentRequest.ownerId,
    revision: 1,
    judgmentRequestId: judgmentRequest.id,
    judgmentRequestRevision: judgmentRequest.revision,
    subject: judgmentRequest.subject,
    selectedOptionId: judgmentAnswer.payload.selectedOptionId,
    displayedRequestDigest,
    actor: { kind: 'owner', id: judgmentRequest.ownerId },
    presenceId: 'presence_fixture_01',
    authenticatedSessionId: 'authenticated_session_fixture_01',
    ownerPolicyRevision: judgmentRequest.authorityAdmission!.ownerPolicyRevision,
    authAssurance: 'verified_session',
    state: 'recorded',
    decidedAt: '2026-08-15T18:11:00.000Z',
  });
  const authorityGrant = authorityGrantV05Schema.parse({
    protocolVersion: '0.5',
    id: 'authority_grant_fixture_01',
    ownerId: judgmentRequest.ownerId,
    revision: 1,
    judgmentRequestId: judgmentRequest.id,
    judgmentRequestRevision: judgmentRequest.revision,
    judgmentDecisionId: judgmentDecision.id,
    grantor: { kind: 'owner', id: judgmentRequest.ownerId },
    grantee: judgmentRequest.authorityAdmission!.grantee,
    subject: judgmentRequest.subject,
    purpose: judgmentRequest.requestedAuthority!.purpose,
    effectFamily: judgmentRequest.requestedAuthority!.effectFamily,
    resources: judgmentRequest.requestedAuthority!.resources,
    scopes: judgmentRequest.requestedAuthority!.scopes,
    audiences: judgmentRequest.requestedAuthority!.audiences,
    argumentDigest: judgmentRequest.requestedAuthority!.argumentDigest,
    contextDigest: judgmentRequest.requestedAuthority!.contextDigest,
    artifactDigest: judgmentRequest.requestedAuthority!.artifactDigest,
    useLimit: 1,
    usesConsumed: 0,
    nextUseIndex: 1,
    validFrom: judgmentDecision.decidedAt,
    expiresAt: judgmentRequest.requestedAuthority!.validUntil,
    revocationGeneration: 0,
    state: 'active',
    createdAt: judgmentDecision.decidedAt,
    updatedAt: judgmentDecision.decidedAt,
  });
  const judgmentAuthorityBinding = judgmentAuthorityBindingV05Schema.parse({
    requestDigest: displayedRequestDigest,
    request: judgmentRequest,
    answer: judgmentAnswer,
    decision: judgmentDecision,
    authorityDisposition: 'granted',
    grant: authorityGrant,
  });
  const refusalAnswer = judgmentAnswerRequestV05Schema.parse({
    ...judgmentAnswer,
    requestId: 'answer_judgment_refusal_fixture_01',
    payload: { ...judgmentAnswer.payload, selectedOptionId: 'option_reject' },
  });
  const refusalDecision = judgmentDecisionV05Schema.parse({
    ...judgmentDecision,
    id: 'judgment_decision_refusal_fixture_01',
    selectedOptionId: 'option_reject',
  });
  const judgmentAuthorityRefusal = judgmentAuthorityBindingV05Schema.parse({
    requestDigest: displayedRequestDigest,
    request: judgmentRequest,
    answer: refusalAnswer,
    decision: refusalDecision,
    authorityDisposition: 'refused',
  });
  const authorityGrantSummary = {
    id: authorityGrant.id,
    revision: authorityGrant.revision,
    grantee: authorityGrant.grantee,
    state: 'active',
    expiresAt: authorityGrant.expiresAt,
    revocationGeneration: authorityGrant.revocationGeneration,
  } as const;
  const judgmentAnswerResultGranted = judgmentAnswerResultV05Schema.parse({
    protocolVersion: '0.5',
    requestId: judgmentAnswer.requestId,
    judgmentRequest: { id: judgmentRequest.id, revision: 3 },
    judgmentDecision: { id: judgmentDecision.id, revision: judgmentDecision.revision },
    selectedOptionId: judgmentAnswer.payload.selectedOptionId,
    projectionCursor: 27,
    authorityDisposition: 'granted',
    grant: authorityGrantSummary,
  });
  const judgmentAnswerResultRefused = judgmentAnswerResultV05Schema.parse({
    protocolVersion: '0.5',
    requestId: refusalAnswer.requestId,
    judgmentRequest: { id: judgmentRequest.id, revision: 3 },
    judgmentDecision: { id: refusalDecision.id, revision: refusalDecision.revision },
    selectedOptionId: refusalAnswer.payload.selectedOptionId,
    projectionCursor: 27,
    authorityDisposition: 'refused',
  });
  const projectionQuery = judgmentProjectionQueryV05Schema.parse({
    protocolVersion: '0.5',
    fromExclusiveCursor: 26,
    limit: 25,
    snapshotId: 'judgment_snapshot_fixture_01',
  });
  const projectionPage = judgmentProjectionPageV05Schema.parse({
    protocolVersion: '0.5',
    ownerId: judgmentRequest.ownerId,
    projectionName: 'judgment.needs_you',
    snapshotId: 'judgment_snapshot_fixture_01',
    snapshotBaseCursor: 20,
    fromExclusiveCursor: 26,
    highWaterCursor: 28,
    nextCursor: 27,
    items: [{
      cursor: 27,
      itemType: 'judgment_request',
      request: judgmentRequest,
      displayedRequestDigest,
    }],
    hasMore: true,
    generatedAt: '2026-08-15T18:10:00.000Z',
  });

  const { uncertainty: _uncertainty, ...requestWithoutUncertainty } = judgmentRequest;
  const { costOfWaiting: _costOfWaiting, ...requestWithoutCostOfWaiting } = judgmentRequest;
  const requestWithoutRefusalOption = {
    ...judgmentRequest,
    options: judgmentRequest.options.map((option) => ({
      ...option,
      authorityDisposition: 'grant' as const,
    })),
  };
  const projectionItem = projectionPage.items[0]!;
  const {
    displayedRequestDigest: _projectionDigest,
    ...projectionItemWithoutDisplayedDigest
  } = projectionItem;
  const coordinatedFalseDigest = `sha256:${'d'.repeat(64)}`;
  const withOwnPrototypeKey = <Value extends Record<string, unknown>>(value: Value): Value => {
    const result = { ...value };
    Object.defineProperty(result, '__proto__', {
      value: 'forbidden_prototype_value',
      enumerable: true,
    });
    return result;
  };

  const rejectionCatalogue = responsibilityJudgmentAuthorityRejectionCatalogueV05Schema.parse({
    protocolVersion: '0.5',
    cases: [
      {
        name: 'client-owned-owner',
        schema: 'judgment-answer.schema.json',
        layer: 'schema',
        zodOutcome: 'reject',
        value: { ...judgmentAnswer, ownerId: 'owner_attacker' },
      },
      {
        name: 'client-owned-actor',
        schema: 'judgment-answer.schema.json',
        layer: 'schema',
        zodOutcome: 'reject',
        value: { ...judgmentAnswer, actor: { kind: 'owner', id: 'owner_attacker' } },
      },
      {
        name: 'client-owned-session',
        schema: 'judgment-answer.schema.json',
        layer: 'schema',
        zodOutcome: 'reject',
        value: { ...judgmentAnswer, authenticatedSessionId: 'session_attacker' },
      },
      {
        name: 'client-owned-policy',
        schema: 'judgment-answer.schema.json',
        layer: 'schema',
        zodOutcome: 'reject',
        value: { ...judgmentAnswer, ownerPolicyRevision: 99 },
      },
      {
        name: 'client-owned-routing',
        schema: 'judgment-answer.schema.json',
        layer: 'schema',
        zodOutcome: 'reject',
        value: { ...judgmentAnswer, ownerRootRoutingVersion: 99 },
      },
      {
        name: 'client-owned-grantee',
        schema: 'judgment-answer.schema.json',
        layer: 'schema',
        zodOutcome: 'reject',
        value: { ...judgmentAnswer, grantee: { kind: 'service', id: 'service_attacker' } },
      },
      {
        name: 'client-owned-admission',
        schema: 'judgment-answer.schema.json',
        layer: 'schema',
        zodOutcome: 'reject',
        value: { ...judgmentAnswer, authorityAdmission: judgmentRequest.authorityAdmission },
      },
      {
        name: 'client-owned-decision',
        schema: 'judgment-answer.schema.json',
        layer: 'schema',
        zodOutcome: 'reject',
        value: { ...judgmentAnswer, judgmentDecision },
      },
      {
        name: 'client-owned-grant',
        schema: 'judgment-answer.schema.json',
        layer: 'schema',
        zodOutcome: 'reject',
        value: { ...judgmentAnswer, authorityGrant },
      },
      {
        name: 'client-owned-requested-authority',
        schema: 'judgment-answer.schema.json',
        layer: 'schema',
        zodOutcome: 'reject',
        value: { ...judgmentAnswer, requestedAuthority: judgmentRequest.requestedAuthority },
      },
      {
        name: 'client-provider-selector',
        schema: 'judgment-answer.schema.json',
        layer: 'schema',
        zodOutcome: 'reject',
        value: {
          ...judgmentAnswer,
          payload: { ...judgmentAnswer.payload, providerId: 'provider_attacker' },
        },
      },
      {
        name: 'client-credential',
        schema: 'judgment-answer.schema.json',
        layer: 'schema',
        zodOutcome: 'reject',
        value: {
          ...judgmentAnswer,
          payload: { ...judgmentAnswer.payload, credential: 'credential_injection_attempt' },
        },
      },
      {
        name: 'client-private-context',
        schema: 'judgment-answer.schema.json',
        layer: 'schema',
        zodOutcome: 'reject',
        value: {
          ...judgmentAnswer,
          payload: {
            ...judgmentAnswer.payload,
            context: { ref: 'forbidden_context_ref' },
          },
        },
      },
      {
        name: 'client-prototype-key-top',
        schema: 'judgment-answer.schema.json',
        layer: 'schema',
        zodOutcome: 'reject',
        value: withOwnPrototypeKey(judgmentAnswer),
      },
      {
        name: 'client-prototype-key-aggregate',
        schema: 'judgment-answer.schema.json',
        layer: 'schema',
        zodOutcome: 'reject',
        value: {
          ...judgmentAnswer,
          aggregate: withOwnPrototypeKey(judgmentAnswer.aggregate),
        },
      },
      {
        name: 'client-prototype-key-payload',
        schema: 'judgment-answer.schema.json',
        layer: 'schema',
        zodOutcome: 'reject',
        value: {
          ...judgmentAnswer,
          payload: withOwnPrototypeKey(judgmentAnswer.payload),
        },
      },
      {
        name: 'request-inline-sensitive-content',
        schema: 'judgment-request.schema.json',
        layer: 'schema',
        zodOutcome: 'reject',
        value: {
          ...judgmentRequest,
          transcript: { ref: 'forbidden_inline_content' },
        },
      },
      {
        name: 'request-missing-uncertainty',
        schema: 'judgment-request.schema.json',
        layer: 'schema',
        zodOutcome: 'reject',
        value: requestWithoutUncertainty,
      },
      {
        name: 'request-missing-cost-of-waiting',
        schema: 'judgment-request.schema.json',
        layer: 'schema',
        zodOutcome: 'reject',
        value: requestWithoutCostOfWaiting,
      },
      {
        name: 'request-missing-refusal-option',
        schema: 'judgment-request.schema.json',
        layer: 'runtime',
        zodOutcome: 'reject',
        value: requestWithoutRefusalOption,
      },
      {
        name: 'stale-answer-revision',
        schema: 'judgment-answer.schema.json',
        layer: 'runtime',
        zodOutcome: 'accept',
        value: {
          ...judgmentAnswer,
          aggregate: { ...judgmentAnswer.aggregate, expectedRevision: 1 },
        },
      },
      {
        name: 'stale-displayed-request-digest',
        schema: 'judgment-answer.schema.json',
        layer: 'runtime',
        zodOutcome: 'accept',
        value: {
          ...judgmentAnswer,
          payload: { ...judgmentAnswer.payload, displayedRequestDigest: coordinatedFalseDigest },
        },
      },
      {
        name: 'unknown-selected-option',
        schema: 'judgment-answer.schema.json',
        layer: 'runtime',
        zodOutcome: 'accept',
        value: {
          ...judgmentAnswer,
          payload: { ...judgmentAnswer.payload, selectedOptionId: 'option_not_displayed' },
        },
      },
      {
        name: 'refused-result-with-grant',
        schema: 'judgment-answer-result.schema.json',
        layer: 'schema',
        zodOutcome: 'reject',
        value: {
          ...judgmentAnswerResultRefused,
          grant: authorityGrantSummary,
        },
      },
      {
        name: 'projection-missing-displayed-digest',
        schema: 'judgment-projection-page.schema.json',
        layer: 'schema',
        zodOutcome: 'reject',
        value: { ...projectionPage, items: [projectionItemWithoutDisplayedDigest] },
      },
      {
        name: 'projection-owner-mismatch',
        schema: 'judgment-projection-page.schema.json',
        layer: 'runtime',
        zodOutcome: 'reject',
        value: { ...projectionPage, ownerId: 'owner_other' },
      },
      {
        name: 'projection-non-advancing-cursor',
        schema: 'judgment-projection-page.schema.json',
        layer: 'runtime',
        zodOutcome: 'reject',
        value: {
          ...projectionPage,
          nextCursor: projectionPage.fromExclusiveCursor,
          items: [],
          hasMore: true,
        },
      },
      {
        name: 'projection-coordinated-request-digest-mismatch',
        schema: 'judgment-projection-page.schema.json',
        layer: 'runtime',
        zodOutcome: 'accept',
        value: {
          ...projectionPage,
          items: [{ ...projectionItem, displayedRequestDigest: coordinatedFalseDigest }],
        },
      },
      {
        name: 'binding-grantee-mismatch',
        schema: 'judgment-authority-binding.schema.json',
        layer: 'runtime',
        zodOutcome: 'reject',
        value: {
          ...judgmentAuthorityBinding,
          grant: {
            ...authorityGrant,
            grantee: { kind: 'service', id: 'service_other' },
          },
        },
      },
      {
        name: 'binding-policy-mismatch',
        schema: 'judgment-authority-binding.schema.json',
        layer: 'runtime',
        zodOutcome: 'reject',
        value: {
          ...judgmentAuthorityBinding,
          decision: { ...judgmentDecision, ownerPolicyRevision: 8 },
        },
      },
      {
        name: 'binding-decision-at-expiry',
        schema: 'judgment-authority-binding.schema.json',
        layer: 'runtime',
        zodOutcome: 'reject',
        value: {
          ...judgmentAuthorityRefusal,
          decision: { ...refusalDecision, decidedAt: judgmentRequest.expiresAt },
        },
      },
      {
        name: 'binding-coordinated-request-digest-mismatch',
        schema: 'judgment-authority-binding.schema.json',
        layer: 'runtime',
        zodOutcome: 'accept',
        value: {
          ...judgmentAuthorityBinding,
          requestDigest: coordinatedFalseDigest,
          answer: {
            ...judgmentAnswer,
            payload: {
              ...judgmentAnswer.payload,
              displayedRequestDigest: coordinatedFalseDigest,
            },
          },
          decision: {
            ...judgmentDecision,
            displayedRequestDigest: coordinatedFalseDigest,
          },
        },
      },
    ],
  });

  const files: Record<string, string> = {
    'judgment-request.schema.json': file(schema(judgmentRequestV05Schema, 'judgment-request')),
    'judgment-answer.schema.json': file(schema(judgmentAnswerRequestV05Schema, 'judgment-answer')),
    'judgment-answer-result.schema.json': file(schema(
      judgmentAnswerResultV05Schema,
      'judgment-answer-result',
    )),
    'judgment-decision.schema.json': file(schema(judgmentDecisionV05Schema, 'judgment-decision')),
    'authority-grant.schema.json': file(schema(authorityGrantV05Schema, 'authority-grant')),
    'judgment-authority-binding.schema.json': file(schema(
      judgmentAuthorityBindingV05Schema,
      'judgment-authority-binding',
    )),
    'judgment-projection-query.schema.json': file(schema(
      judgmentProjectionQueryV05Schema,
      'judgment-projection-query',
    )),
    'judgment-projection-page.schema.json': file(schema(
      judgmentProjectionPageV05Schema,
      'judgment-projection-page',
    )),
    'judgment-request.valid.json': file(judgmentRequest),
    'judgment-answer.valid.json': file(judgmentAnswer),
    'judgment-answer-result-granted.valid.json': file(judgmentAnswerResultGranted),
    'judgment-answer-result-refused.valid.json': file(judgmentAnswerResultRefused),
    'judgment-decision.valid.json': file(judgmentDecision),
    'authority-grant.valid.json': file(authorityGrant),
    'judgment-authority-binding.valid.json': file(judgmentAuthorityBinding),
    'judgment-authority-refusal.valid.json': file(judgmentAuthorityRefusal),
    'judgment-projection-query.valid.json': file(projectionQuery),
    'judgment-projection-page.valid.json': file(projectionPage),
    'judgment-authority.rejections.json': file(rejectionCatalogue),
  };

  const filePins = Object.keys(files)
    .sort()
    .map((path) => ({
      path,
      sha256: `sha256:${hashHex(files[path]!)}`,
    }));
  const fixturePayloadRootSha256 = `sha256:${hashHex(
    filePins.map(({ path, sha256 }) => `${path}\u0000${sha256}\n`).join(''),
  )}`;

  return {
    ...files,
    'manifest.json': file({
      protocolName: 'responsibility-judgment-authority',
      protocolVersion: '0.5',
      mediaType: 'application/vnd.waldo.responsibility.v0.5+json',
      offlineCommands: 'none',
      proofLevel: 'adapter_conformance_fixture',
      source: {
        path: 'packages/contracts/src/protocol/responsibility-judgment-authority-v0-5.ts',
        sha256: `sha256:${sourceSha256}`,
      },
      fixturePayloadRootSha256,
      compatibilityWindow: {
        predecessor: '0.4',
        mode: 'parallel_additive',
        promise: 'v0.4 source, tests, and fixture bytes remain preserved',
        removal: 'none_authorized',
      },
      consumers: [
        { name: 'waldo-backend-runtime', contractRole: 'canonical_runtime' },
        { name: 'kennel', contractRole: 'owner_surface' },
        { name: 'waldo-mobile', contractRole: 'owner_surface' },
        { name: 'telegram', contractRole: 'messaging_presence' },
        { name: 'discord', contractRole: 'messaging_presence' },
      ],
      bytePreservation: {
        throughVersion: '0.4',
        guard: 'scripts/guards/guard-responsibility-released-v0-1-v0-4-bytes.mjs',
        compositeSha256: 'sha256:e2674177d5852b15b83ae59d6f9faef62f13ff03b99b89ebb33cee14e491a0ca',
      },
      retrySemantics: judgmentAnswerRetrySemanticsV05,
      files: filePins,
    }),
  };
}
