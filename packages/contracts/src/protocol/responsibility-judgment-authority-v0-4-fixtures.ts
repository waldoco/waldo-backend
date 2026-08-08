import { z } from 'zod';
import {
  authorityGrantV04Schema,
  canonicalizeJudgmentRequestV04ForDigest,
  judgmentAnswerRequestV04Schema,
  judgmentAuthorityBindingV04Schema,
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

export const RESPONSIBILITY_JUDGMENT_AUTHORITY_REJECTION_NAMES_V04 = [
  'client-owned-owner',
  'client-owned-grant',
  'client-owned-grant-fields',
  'client-provider-selector',
  'client-model-selector',
  'client-executor-selector',
  'client-sensitive-context',
  'stale-answer-revision',
  'stale-displayed-request-digest',
  'unknown-selected-option',
  'inline-question-content',
  'lone-surrogate-reference',
  'reference-byte-ceiling',
  'recommendation-outside-options',
  'open-request-with-decision',
  'unauthenticated-decision',
  'grant-without-revocation-generation',
  'grant-credential-injection',
  'grant-counter-drift',
  'grant-max-safe-consumed',
  'grant-max-safe-next-index',
  'grant-invalid-validity',
  'grant-duplicate-scope',
  'binding-owner-mismatch',
  'binding-request-mismatch',
  'binding-subject-mismatch',
  'binding-option-mismatch',
  'binding-request-digest-mismatch',
  'binding-purpose-mismatch',
  'binding-effect-family-mismatch',
  'binding-resource-mismatch',
  'binding-scope-mismatch',
  'binding-audience-mismatch',
  'binding-argument-digest-mismatch',
  'binding-context-digest-mismatch',
  'binding-artifact-digest-mismatch',
  'binding-validity-mismatch',
] as const;

const rejectionCasesV04Schema = z.array(z.strictObject({
    name: z.enum(RESPONSIBILITY_JUDGMENT_AUTHORITY_REJECTION_NAMES_V04),
    schema: z.enum([
      'judgment-answer.schema.json',
      'judgment-request.schema.json',
      'judgment-decision.schema.json',
      'authority-grant.schema.json',
      'judgment-authority-binding.schema.json',
    ]),
    layer: z.enum(['schema', 'runtime']),
    zodOutcome: z.enum(['accept', 'reject']),
    value: z.unknown(),
  }))
  .length(RESPONSIBILITY_JUDGMENT_AUTHORITY_REJECTION_NAMES_V04.length)
  .superRefine((cases, context) => {
    const names = cases.map((entry) => entry.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({ code: 'custom', message: 'rejection case names must be unique' });
    }
    for (const [index, expected] of
      RESPONSIBILITY_JUDGMENT_AUTHORITY_REJECTION_NAMES_V04.entries()) {
      if (names[index] !== expected) {
        context.addIssue({
          code: 'custom',
          path: [index, 'name'],
          message: `rejection case ${index + 1} must be ${expected}`,
        });
      }
    }
  });

export const responsibilityJudgmentAuthorityRejectionCatalogueV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema,
  cases: rejectionCasesV04Schema,
});

export function buildResponsibilityJudgmentAuthorityV04Bundle(
  hashHex: HashHex,
): Record<string, string> {
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
      useLimit: 1,
      validUntil: '2026-08-08T18:30:00.000Z',
    },
    reEntryPointId: 'reentry_fixture_01',
    expiresAt: '2026-08-08T18:30:00.000Z',
    decisionId: null,
    state: 'open',
    createdAt: '2026-08-08T18:05:00.000Z',
    updatedAt: '2026-08-08T18:05:00.000Z',
  });

  const displayedRequestDigest = `sha256:${hashHex(
    canonicalizeJudgmentRequestV04ForDigest(judgmentRequest),
  )}`;

  const judgmentAnswer = judgmentAnswerRequestV04Schema.parse({
    protocolVersion: '0.4',
    requestId: 'answer_judgment_fixture_01',
    commandType: 'judgment.answer',
    presenceRegistrationId: 'presence_registration_fixture_01',
    aggregate: {
      kind: 'judgment_request',
      id: judgmentRequest.id,
      expectedRevision: judgmentRequest.revision,
    },
    correlationId: 'correlation_judgment_fixture_01',
    clientIssuedAt: '2026-08-08T18:10:00.000Z',
    payload: {
      selectedOptionId: 'option_approve',
      displayedRequestDigest,
    },
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
    displayedRequestDigest,
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

  const judgmentAuthorityBinding = judgmentAuthorityBindingV04Schema.parse({
    requestDigest: displayedRequestDigest,
    request: judgmentRequest,
    answer: judgmentAnswer,
    decision: judgmentDecision,
    grant: authorityGrant,
  });

  const { authenticatedSessionId: _session, ...unauthenticatedDecision } = judgmentDecision;
  const { revocationGeneration: _generation, ...grantWithoutRevocationGeneration } = authorityGrant;

  const schemas = {
    'judgment-answer.schema.json': schema(judgmentAnswerRequestV04Schema, 'judgment-answer'),
    'judgment-request.schema.json': schema(judgmentRequestV04Schema, 'judgment-request'),
    'judgment-decision.schema.json': schema(judgmentDecisionV04Schema, 'judgment-decision'),
    'authority-grant.schema.json': schema(authorityGrantV04Schema, 'authority-grant'),
    'judgment-authority-binding.schema.json': schema(
      judgmentAuthorityBindingV04Schema,
      'judgment-authority-binding',
    ),
  };
  const files: Record<string, string> = {
    ...Object.fromEntries(Object.entries(schemas).map(([path, value]) => [path, file(value)])),
    'judgment-answer.valid.json': file(judgmentAnswer),
    'judgment-request.valid.json': file(judgmentRequest),
    'judgment-decision.valid.json': file(judgmentDecision),
    'authority-grant.valid.json': file(authorityGrant),
    'judgment-authority-binding.valid.json': file(judgmentAuthorityBinding),
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
            name: 'client-model-selector',
            schema: 'judgment-answer.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: {
              ...judgmentAnswer,
              payload: { ...judgmentAnswer.payload, modelId: 'model_attacker' },
            },
          },
          {
            name: 'client-executor-selector',
            schema: 'judgment-answer.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: {
              ...judgmentAnswer,
              payload: { ...judgmentAnswer.payload, executorRef: 'executor_attacker' },
            },
          },
          {
            name: 'client-sensitive-context',
            schema: 'judgment-answer.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: {
              ...judgmentAnswer,
              payload: { ...judgmentAnswer.payload, sensitiveContextRef: 'context_attacker' },
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
            name: 'lone-surrogate-reference',
            schema: 'judgment-request.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: {
              ...judgmentRequest,
              question: { ...judgmentRequest.question, ref: '\ud800' },
            },
          },
          {
            name: 'reference-byte-ceiling',
            schema: 'judgment-request.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: {
              ...judgmentRequest,
              question: { ...judgmentRequest.question, ref: 'a'.repeat(129) },
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
            name: 'grant-max-safe-consumed',
            schema: 'authority-grant.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: { ...authorityGrant, usesConsumed: Number.MAX_SAFE_INTEGER },
          },
          {
            name: 'grant-max-safe-next-index',
            schema: 'authority-grant.schema.json',
            layer: 'schema',
            zodOutcome: 'reject',
            value: { ...authorityGrant, nextUseIndex: Number.MAX_SAFE_INTEGER },
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
          {
            name: 'binding-owner-mismatch',
            schema: 'judgment-authority-binding.schema.json',
            layer: 'runtime',
            zodOutcome: 'reject',
            value: {
              ...judgmentAuthorityBinding,
              request: { ...judgmentRequest, ownerId: 'owner_other' },
            },
          },
          {
            name: 'binding-request-mismatch',
            schema: 'judgment-authority-binding.schema.json',
            layer: 'runtime',
            zodOutcome: 'reject',
            value: {
              ...judgmentAuthorityBinding,
              answer: {
                ...judgmentAnswer,
                aggregate: { ...judgmentAnswer.aggregate, id: 'judgment_request_other' },
              },
            },
          },
          {
            name: 'binding-subject-mismatch',
            schema: 'judgment-authority-binding.schema.json',
            layer: 'runtime',
            zodOutcome: 'reject',
            value: {
              ...judgmentAuthorityBinding,
              decision: {
                ...judgmentDecision,
                subject: { kind: 'outcome', id: 'outcome_other', revision: 1 },
              },
            },
          },
          {
            name: 'binding-option-mismatch',
            schema: 'judgment-authority-binding.schema.json',
            layer: 'runtime',
            zodOutcome: 'reject',
            value: {
              ...judgmentAuthorityBinding,
              decision: { ...judgmentDecision, selectedOptionId: 'option_reject' },
            },
          },
          {
            name: 'binding-request-digest-mismatch',
            schema: 'judgment-authority-binding.schema.json',
            layer: 'runtime',
            zodOutcome: 'reject',
            value: {
              ...judgmentAuthorityBinding,
              answer: {
                ...judgmentAnswer,
                payload: {
                  ...judgmentAnswer.payload,
                  displayedRequestDigest: `sha256:${'b'.repeat(64)}`,
                },
              },
            },
          },
          {
            name: 'binding-purpose-mismatch',
            schema: 'judgment-authority-binding.schema.json',
            layer: 'runtime',
            zodOutcome: 'reject',
            value: {
              ...judgmentAuthorityBinding,
              grant: { ...authorityGrant, purpose: 'calendar.unrequested' },
            },
          },
          {
            name: 'binding-effect-family-mismatch',
            schema: 'judgment-authority-binding.schema.json',
            layer: 'runtime',
            zodOutcome: 'reject',
            value: {
              ...judgmentAuthorityBinding,
              grant: { ...authorityGrant, effectFamily: 'calendar.event.delete' },
            },
          },
          {
            name: 'binding-resource-mismatch',
            schema: 'judgment-authority-binding.schema.json',
            layer: 'runtime',
            zodOutcome: 'reject',
            value: {
              ...judgmentAuthorityBinding,
              grant: {
                ...authorityGrant,
                resources: [{ kind: 'calendar', ref: 'calendar_other' }],
              },
            },
          },
          {
            name: 'binding-scope-mismatch',
            schema: 'judgment-authority-binding.schema.json',
            layer: 'runtime',
            zodOutcome: 'reject',
            value: {
              ...judgmentAuthorityBinding,
              grant: { ...authorityGrant, scopes: ['calendar.admin'] },
            },
          },
          {
            name: 'binding-audience-mismatch',
            schema: 'judgment-authority-binding.schema.json',
            layer: 'runtime',
            zodOutcome: 'reject',
            value: {
              ...judgmentAuthorityBinding,
              grant: { ...authorityGrant, audiences: ['calendar.other_account'] },
            },
          },
          {
            name: 'binding-argument-digest-mismatch',
            schema: 'judgment-authority-binding.schema.json',
            layer: 'runtime',
            zodOutcome: 'reject',
            value: {
              ...judgmentAuthorityBinding,
              grant: { ...authorityGrant, argumentDigest: `sha256:${'b'.repeat(64)}` },
            },
          },
          {
            name: 'binding-context-digest-mismatch',
            schema: 'judgment-authority-binding.schema.json',
            layer: 'runtime',
            zodOutcome: 'reject',
            value: {
              ...judgmentAuthorityBinding,
              grant: { ...authorityGrant, contextDigest: `sha256:${'b'.repeat(64)}` },
            },
          },
          {
            name: 'binding-artifact-digest-mismatch',
            schema: 'judgment-authority-binding.schema.json',
            layer: 'runtime',
            zodOutcome: 'reject',
            value: {
              ...judgmentAuthorityBinding,
              grant: { ...authorityGrant, artifactDigest: `sha256:${'b'.repeat(64)}` },
            },
          },
          {
            name: 'binding-validity-mismatch',
            schema: 'judgment-authority-binding.schema.json',
            layer: 'runtime',
            zodOutcome: 'reject',
            value: {
              ...judgmentAuthorityBinding,
              grant: { ...authorityGrant, expiresAt: '2026-08-08T18:31:00.000Z' },
            },
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
