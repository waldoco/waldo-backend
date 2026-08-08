import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  authorityGrantV04Schema,
  buildResponsibilityJudgmentAuthorityV04Bundle,
  canonicalizeAuthorityGrantV04ForDigest,
  canonicalizeJudgmentAnswerRequestV04ForDigest,
  canonicalizeJudgmentDecisionV04ForDigest,
  canonicalizeJudgmentRequestV04ForDigest,
  judgmentAnswerRequestV04Schema,
  judgmentDecisionV04Schema,
  judgmentRequestV04Schema,
  responsibilityJudgmentAuthorityRejectionCatalogueV04Schema,
} from '../index';

const fixtureSchemas = {
  'judgment-answer.schema.json': judgmentAnswerRequestV04Schema,
  'judgment-request.schema.json': judgmentRequestV04Schema,
  'judgment-decision.schema.json': judgmentDecisionV04Schema,
  'authority-grant.schema.json': authorityGrantV04Schema,
} as const;

const validFixtureForSchema = {
  'judgment-answer.schema.json': 'judgment-answer.valid.json',
  'judgment-request.schema.json': 'judgment-request.valid.json',
  'judgment-decision.schema.json': 'judgment-decision.valid.json',
  'authority-grant.schema.json': 'authority-grant.valid.json',
} as const;

function fixtureAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
  for (const keyword of [
    'x-waldo-validation-level',
    'x-waldo-offline-commands',
  ]) ajv.addKeyword(keyword);
  return ajv;
}

describe('responsibility judgment and authority v0.4', () => {
  it('lets a surface answer only an exact JudgmentRequest revision', () => {
    const answer = {
      protocolVersion: '0.4',
      requestId: 'answer_judgment_01',
      commandType: 'judgment.answer',
      presenceRegistrationId: 'presence_registration_01',
      aggregate: {
        kind: 'judgment_request',
        id: 'judgment_request_01',
        expectedRevision: 2,
      },
      correlationId: 'correlation_judgment_01',
      clientIssuedAt: '2026-08-08T18:10:00.000Z',
      payload: {
        selectedOptionId: 'option_approve',
        displayedRequestDigest: `sha256:${'a'.repeat(64)}`,
      },
    } as const;

    expect(judgmentAnswerRequestV04Schema.parse(answer)).toEqual(answer);
    expect(canonicalizeJudgmentAnswerRequestV04ForDigest({
      payload: answer.payload,
      clientIssuedAt: answer.clientIssuedAt,
      correlationId: answer.correlationId,
      aggregate: answer.aggregate,
      presenceRegistrationId: answer.presenceRegistrationId,
      commandType: answer.commandType,
      requestId: answer.requestId,
      protocolVersion: answer.protocolVersion,
    })).toBe(canonicalizeJudgmentAnswerRequestV04ForDigest(answer));
    expect(judgmentAnswerRequestV04Schema.safeParse({
      ...answer,
      ownerId: 'owner_attacker',
      authorityGrant: { id: 'grant_attacker' },
      payload: { ...answer.payload, useLimit: 99, scopes: ['calendar.admin'] },
    }).success).toBe(false);
  });

  it('publishes an open JudgmentRequest with content-minimized framing and exact requested authority', () => {
    const request = {
      protocolVersion: '0.4',
      id: 'judgment_request_01',
      ownerId: 'owner_01',
      revision: 2,
      subject: { kind: 'work_unit', id: 'work_unit_01', revision: 4 },
      question: { ref: 'judgment_question_01', digest: `sha256:${'1'.repeat(64)}` },
      options: [
        { id: 'option_approve', content: { ref: 'option_content_approve', digest: `sha256:${'2'.repeat(64)}` } },
        { id: 'option_reject', content: { ref: 'option_content_reject', digest: `sha256:${'3'.repeat(64)}` } },
      ],
      recommendation: 'option_approve',
      evidence: [{ ref: 'evidence_summary_01', digest: `sha256:${'4'.repeat(64)}` }],
      risk: { ref: 'risk_summary_01', digest: `sha256:${'5'.repeat(64)}` },
      reversibility: { ref: 'reversibility_summary_01', digest: `sha256:${'6'.repeat(64)}` },
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
      reEntryPointId: 'reentry_01',
      expiresAt: '2026-08-08T18:30:00.000Z',
      decisionId: null,
      state: 'open',
      createdAt: '2026-08-08T18:05:00.000Z',
      updatedAt: '2026-08-08T18:05:00.000Z',
    } as const;

    expect(judgmentRequestV04Schema.parse(request)).toEqual(request);
    expect(canonicalizeJudgmentRequestV04ForDigest({
      ...request,
      subject: {
        revision: request.subject.revision,
        id: request.subject.id,
        kind: request.subject.kind,
      },
    })).toBe(canonicalizeJudgmentRequestV04ForDigest(request));
    expect(judgmentRequestV04Schema.safeParse({
      ...request,
      recommendation: 'option_not_displayed',
    }).success).toBe(false);
  });

  it('records the authenticated JudgmentDecision separately from any resulting grant', () => {
    const decision = {
      protocolVersion: '0.4',
      id: 'judgment_decision_01',
      ownerId: 'owner_01',
      revision: 1,
      judgmentRequestId: 'judgment_request_01',
      judgmentRequestRevision: 2,
      subject: { kind: 'work_unit', id: 'work_unit_01', revision: 4 },
      selectedOptionId: 'option_approve',
      displayedRequestDigest: `sha256:${'a'.repeat(64)}`,
      actor: { kind: 'owner', id: 'owner_01' },
      presenceId: 'presence_01',
      authenticatedSessionId: 'authenticated_session_01',
      ownerPolicyRevision: 7,
      authAssurance: 'verified_session',
      state: 'recorded',
      decidedAt: '2026-08-08T18:11:00.000Z',
    } as const;

    expect(judgmentDecisionV04Schema.parse(decision)).toEqual(decision);
    expect(canonicalizeJudgmentDecisionV04ForDigest({
      ...decision,
      actor: { id: decision.actor.id, kind: decision.actor.kind },
    })).toBe(canonicalizeJudgmentDecisionV04ForDigest(decision));
    expect(judgmentDecisionV04Schema.safeParse({
      ...decision,
      authenticatedSessionId: undefined,
      authorityGrant: { useLimit: 5 },
    }).success).toBe(false);
    expect(judgmentDecisionV04Schema.safeParse({
      ...decision,
      actor: { kind: 'provider', id: 'provider_attacker' },
    }).success).toBe(false);
    expect(judgmentDecisionV04Schema.safeParse({
      ...decision,
      actor: { kind: 'owner', id: 'owner_other' },
    }).success).toBe(false);
  });

  it('binds a server-constructed AuthorityGrant to exact revisions, digests, scope, use, and revocation', () => {
    const grant = {
      protocolVersion: '0.4',
      id: 'authority_grant_01',
      ownerId: 'owner_01',
      revision: 1,
      judgmentRequestId: 'judgment_request_01',
      judgmentRequestRevision: 2,
      judgmentDecisionId: 'judgment_decision_01',
      grantor: { kind: 'owner', id: 'owner_01' },
      grantee: { kind: 'service', id: 'effect_engine' },
      subject: { kind: 'work_unit', id: 'work_unit_01', revision: 4 },
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
    } as const;

    expect(authorityGrantV04Schema.parse(grant)).toEqual(grant);
    expect(canonicalizeAuthorityGrantV04ForDigest({
      ...grant,
      subject: {
        revision: grant.subject.revision,
        id: grant.subject.id,
        kind: grant.subject.kind,
      },
    })).toBe(canonicalizeAuthorityGrantV04ForDigest(grant));
    expect(authorityGrantV04Schema.parse({ ...grant, state: 'revoked' }).state).toBe('revoked');
    expect(authorityGrantV04Schema.parse({ ...grant, state: 'expired' }).state).toBe('expired');
    expect(authorityGrantV04Schema.parse({
      ...grant,
      usesConsumed: 1,
      nextUseIndex: 2,
      state: 'exhausted',
    }).nextUseIndex).toBe(2);
    const { revocationGeneration: _missing, ...withoutRevocationGeneration } = grant;
    expect(authorityGrantV04Schema.safeParse(withoutRevocationGeneration).success).toBe(false);
    expect(authorityGrantV04Schema.safeParse({
      ...grant,
      grantee: { kind: 'provider', id: 'provider_attacker' },
    }).success).toBe(false);
    expect(authorityGrantV04Schema.safeParse({
      ...grant,
      grantor: { kind: 'owner', id: 'owner_other' },
    }).success).toBe(false);
  });

  it('publishes four Draft 2020-12 schemas that round-trip every valid fixture', () => {
    const bundle = buildResponsibilityJudgmentAuthorityV04Bundle(() => 'a'.repeat(64));

    for (const [schemaPath, zodSchema] of Object.entries(fixtureSchemas)) {
      const fixturePath = validFixtureForSchema[schemaPath as keyof typeof validFixtureForSchema];
      const valid = JSON.parse(bundle[fixturePath]!);
      expect(zodSchema.parse(valid)).toEqual(valid);

      const jsonSchema = JSON.parse(bundle[schemaPath]!);
      expect(jsonSchema).toMatchObject({
        'x-waldo-validation-level': 'structural-plus-runtime-invariants',
        'x-waldo-offline-commands': 'none',
      });
      const validate = fixtureAjv().compile(jsonSchema);
      expect(validate(valid), `${schemaPath}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it('asserts every rejection at its declared schema or runtime layer', () => {
    const bundle = buildResponsibilityJudgmentAuthorityV04Bundle(() => 'a'.repeat(64));
    const catalogue = responsibilityJudgmentAuthorityRejectionCatalogueV04Schema.parse(
      JSON.parse(bundle['judgment-authority.rejections.json']!),
    );
    const validators = Object.fromEntries(
      Object.keys(fixtureSchemas).map((schemaPath) => [
        schemaPath,
        fixtureAjv().compile(JSON.parse(bundle[schemaPath]!)),
      ]),
    );

    expect(catalogue.cases.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      'client-owned-owner',
      'client-owned-grant',
      'client-owned-grant-fields',
      'stale-answer-revision',
      'stale-displayed-request-digest',
      'unknown-selected-option',
      'grant-without-revocation-generation',
      'grant-credential-injection',
    ]));

    for (const rejection of catalogue.cases) {
      const validate = validators[rejection.schema]!;
      expect(
        validate(rejection.value),
        `${rejection.name}: ${JSON.stringify(validate.errors)}`,
      ).toBe(rejection.layer === 'runtime');
      expect(
        fixtureSchemas[rejection.schema].safeParse(rejection.value).success,
        rejection.name,
      ).toBe(rejection.zodOutcome === 'accept');
    }
  });

  it('pins every fixture byte in an adapter-conformance manifest', () => {
    const bundle = buildResponsibilityJudgmentAuthorityV04Bundle((value) =>
      value.length.toString(16).padStart(64, '0'));
    const manifest = JSON.parse(bundle['manifest.json']!);

    expect(manifest).toMatchObject({
      protocolName: 'responsibility-judgment-authority',
      protocolVersion: '0.4',
      offlineCommands: 'none',
      proofLevel: 'adapter_conformance_fixture',
    });
    expect(manifest.files).toEqual(
      Object.keys(bundle)
        .filter((path) => path !== 'manifest.json')
        .sort()
        .map((path) => ({
          path,
          sha256: `sha256:${bundle[path]!.length.toString(16).padStart(64, '0')}`,
        })),
    );
  });
});
