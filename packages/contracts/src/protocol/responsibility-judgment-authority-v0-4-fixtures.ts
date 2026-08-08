import { z } from 'zod';
import {
  authorityGrantV04Schema,
  judgmentAnswerRequestV04Schema,
  judgmentDecisionV04Schema,
  judgmentRequestV04Schema,
} from './responsibility-judgment-authority-v0-4';
import { protocolVersionV04Schema } from './responsibility-acceptance-check-v0-4';

type HashHex = (input: string) => string;
const file = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const schema = (value: z.ZodType, name: string) => ({
  ...(z.toJSONSchema(value, { target: 'draft-2020-12', io: 'input', reused: 'ref' }) as object),
  $id: `urn:waldo:protocol:responsibility-judgment-authority:0.4:${name}`,
  'x-waldo-validation-level': 'structural-plus-runtime-invariants',
  'x-waldo-offline-commands': 'none',
});

export const responsibilityJudgmentAuthorityRejectionCatalogueV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema,
  cases: z.array(z.strictObject({
    name: z.enum([
      'client-owned-owner',
      'client-owned-grant',
      'client-owned-grant-fields',
      'stale-answer-revision',
      'stale-displayed-request-digest',
      'unknown-selected-option',
      'inline-question-content',
      'recommendation-outside-options',
      'open-request-with-decision',
      'unauthenticated-decision',
      'grant-without-revocation-generation',
      'grant-credential-injection',
      'grant-counter-drift',
      'grant-invalid-validity',
      'grant-duplicate-scope',
    ]),
    schema: z.enum([
      'judgment-answer.schema.json',
      'judgment-request.schema.json',
      'judgment-decision.schema.json',
      'authority-grant.schema.json',
    ]),
    layer: z.enum(['schema', 'runtime']),
    zodOutcome: z.enum(['accept', 'reject']),
    value: z.unknown(),
  })).length(15),
});

export function buildResponsibilityJudgmentAuthorityV04Bundle(
  hashHex: HashHex,
): Record<string, string> {
  const judgmentAnswer = judgmentAnswerRequestV04Schema.parse({
    protocolVersion: '0.4',
    requestId: 'answer_judgment_fixture_01',
    commandType: 'judgment.answer',
    presenceRegistrationId: 'presence_registration_fixture_01',
    aggregate: {
      kind: 'judgment_request',
      id: 'judgment_request_fixture_01',
      expectedRevision: 2,
    },
    correlationId: 'correlation_judgment_fixture_01',
    clientIssuedAt: '2026-08-08T18:10:00.000Z',
    payload: {
      selectedOptionId: 'option_approve',
      displayedRequestDigest: `sha256:${'a'.repeat(64)}`,
    },
  });

  const judgmentRequest = judgmentRequestV04Schema.parse({
    protocolVersion: '0.4',
    id: 'judgment_request_fixture_01',
    ownerId: 'owner_fixture_01',
    revision: 2,
    subject: { kind: 'work_unit', id: 'work_unit_fixture_01', revision: 4 },
    question: { ref: 'judgment_question_fixture_01', digest: `sha256:${'1'.repeat(64)}` },
    options: [
      {
        id: 'option_approve',
        content: { ref: 'option_content_approve', digest: `sha256:${'2'.repeat(64)}` },
      },
      {
        id: 'option_reject',
        content: { ref: 'option_content_reject', digest: `sha256:${'3'.repeat(64)}` },
      },
    ],
    recommendation: 'option_approve',
    evidence: [{ ref: 'evidence_summary_fixture_01', digest: `sha256:${'4'.repeat(64)}` }],
    risk: { ref: 'risk_summary_fixture_01', digest: `sha256:${'5'.repeat(64)}` },
    reversibility: {
      ref: 'reversibility_summary_fixture_01',
      digest: `sha256:${'6'.repeat(64)}`,
    },
    affectedDigest: `sha256:${'7'.repeat(64)}`,
    requestedAuthority: {
      purpose: 'calendar.follow_up.schedule',
      effectFamily: 'calendar.event.create',
      resources: [{ kind: 'calendar', ref: 'calendar_primary' }],
      scopes: ['calendar.event.create'],
      audiences: ['calendar.account'],
      argumentDigest: `sha256:${'8'.repeat(64)}`,
      contextDigest: `sha256:${'9'.repeat(64)}`,
      artifactDigest: null,
    },
    reEntryPointId: 'reentry_fixture_01',
    expiresAt: '2026-08-08T18:30:00.000Z',
    decisionId: null,
    state: 'open',
    createdAt: '2026-08-08T18:05:00.000Z',
    updatedAt: '2026-08-08T18:05:00.000Z',
  });

  const judgmentDecision = judgmentDecisionV04Schema.parse({
    protocolVersion: '0.4',
    id: 'judgment_decision_fixture_01',
    ownerId: 'owner_fixture_01',
    revision: 1,
    judgmentRequestId: 'judgment_request_fixture_01',
    judgmentRequestRevision: 2,
    subject: { kind: 'work_unit', id: 'work_unit_fixture_01', revision: 4 },
    selectedOptionId: 'option_approve',
    displayedRequestDigest: `sha256:${'a'.repeat(64)}`,
    actor: { kind: 'owner', id: 'owner_fixture_01' },
    presenceId: 'presence_fixture_01',
    authenticatedSessionId: 'authenticated_session_fixture_01',
    ownerPolicyRevision: 7,
    authAssurance: 'verified_session',
    state: 'recorded',
    decidedAt: '2026-08-08T18:11:00.000Z',
  });

  const authorityGrant = authorityGrantV04Schema.parse({
    protocolVersion: '0.4',
    id: 'authority_grant_fixture_01',
    ownerId: 'owner_fixture_01',
    revision: 1,
    judgmentRequestId: 'judgment_request_fixture_01',
    judgmentRequestRevision: 2,
    judgmentDecisionId: 'judgment_decision_fixture_01',
    grantor: { kind: 'owner', id: 'owner_fixture_01' },
    grantee: { kind: 'service', id: 'effect_engine' },
    subject: { kind: 'work_unit', id: 'work_unit_fixture_01', revision: 4 },
    purpose: 'calendar.follow_up.schedule',
    effectFamily: 'calendar.event.create',
    resources: [{ kind: 'calendar', ref: 'calendar_primary' }],
    scopes: ['calendar.event.create'],
    audiences: ['calendar.account'],
    argumentDigest: `sha256:${'8'.repeat(64)}`,
    contextDigest: `sha256:${'9'.repeat(64)}`,
    artifactDigest: null,
    useLimit: 1,
    usesConsumed: 0,
    nextUseIndex: 1,
    validFrom: '2026-08-08T18:11:00.000Z',
    expiresAt: '2026-08-08T18:30:00.000Z',
    revocationGeneration: 0,
    state: 'active',
    createdAt: '2026-08-08T18:11:00.000Z',
    updatedAt: '2026-08-08T18:11:00.000Z',
  });

  const { authenticatedSessionId: _session, ...unauthenticatedDecision } = judgmentDecision;
  const { revocationGeneration: _generation, ...grantWithoutRevocationGeneration } = authorityGrant;

  const schemas = {
    'judgment-answer.schema.json': schema(judgmentAnswerRequestV04Schema, 'judgment-answer'),
    'judgment-request.schema.json': schema(judgmentRequestV04Schema, 'judgment-request'),
    'judgment-decision.schema.json': schema(judgmentDecisionV04Schema, 'judgment-decision'),
    'authority-grant.schema.json': schema(authorityGrantV04Schema, 'authority-grant'),
  };
  const files: Record<string, string> = {
    ...Object.fromEntries(Object.entries(schemas).map(([path, value]) => [path, file(value)])),
    'judgment-answer.valid.json': file(judgmentAnswer),
    'judgment-request.valid.json': file(judgmentRequest),
    'judgment-decision.valid.json': file(judgmentDecision),
    'authority-grant.valid.json': file(authorityGrant),
    'judgment-authority.rejections.json': file(
      responsibilityJudgmentAuthorityRejectionCatalogueV04Schema.parse({
        protocolVersion: '0.4',
        cases: [
          {
            name: 'client-owned-owner',
            schema: 'judgment-answer.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: { ...judgmentAnswer, ownerId: 'owner_attacker' },
          },
          {
            name: 'client-owned-grant',
            schema: 'judgment-answer.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: { ...judgmentAnswer, authorityGrant: authorityGrant },
          },
          {
            name: 'client-owned-grant-fields',
            schema: 'judgment-answer.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: {
              ...judgmentAnswer,
              payload: {
                ...judgmentAnswer.payload,
                scopes: ['calendar.admin'],
                useLimit: 99,
                expiresAt: '2099-01-01T00:00:00.000Z',
                revocationGeneration: 0,
              },
            },
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
              payload: { ...judgmentAnswer.payload, displayedRequestDigest: `sha256:${'b'.repeat(64)}` },
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
            name: 'inline-question-content',
            schema: 'judgment-request.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: {
              ...judgmentRequest,
              question: { ...judgmentRequest.question, text: 'private inline question' },
            },
          },
          {
            name: 'recommendation-outside-options',
            schema: 'judgment-request.schema.json',
            layer: 'runtime',
            zodOutcome: 'reject',
            value: { ...judgmentRequest, recommendation: 'option_not_displayed' },
          },
          {
            name: 'open-request-with-decision',
            schema: 'judgment-request.schema.json',
            layer: 'runtime',
            zodOutcome: 'reject',
            value: { ...judgmentRequest, decisionId: 'judgment_decision_fixture_01' },
          },
          {
            name: 'unauthenticated-decision',
            schema: 'judgment-decision.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: unauthenticatedDecision,
          },
          {
            name: 'grant-without-revocation-generation',
            schema: 'authority-grant.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: grantWithoutRevocationGeneration,
          },
          {
            name: 'grant-credential-injection',
            schema: 'authority-grant.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: { ...authorityGrant, credential: 'secret-value' },
          },
          {
            name: 'grant-counter-drift',
            schema: 'authority-grant.schema.json',
            layer: 'runtime',
            zodOutcome: 'reject',
            value: { ...authorityGrant, usesConsumed: 1, nextUseIndex: 1 },
          },
          {
            name: 'grant-invalid-validity',
            schema: 'authority-grant.schema.json',
            layer: 'runtime',
            zodOutcome: 'reject',
            value: { ...authorityGrant, expiresAt: '2026-08-08T18:10:00.000Z' },
          },
          {
            name: 'grant-duplicate-scope',
            schema: 'authority-grant.schema.json',
            layer: 'runtime',
            zodOutcome: 'reject',
            value: { ...authorityGrant, scopes: ['calendar.event.create', 'calendar.event.create'] },
          },
        ],
      }),
    ),
  };

  return {
    ...files,
    'manifest.json': file({
      protocolName: 'responsibility-judgment-authority',
      protocolVersion: '0.4',
      mediaType: 'application/vnd.waldo.responsibility.v0.4+json',
      offlineCommands: 'none',
      proofLevel: 'adapter_conformance_fixture',
      files: Object.keys(files).sort().map((path) => ({
        path,
        sha256: `sha256:${hashHex(files[path]!)}`,
      })),
    }),
  };
}
