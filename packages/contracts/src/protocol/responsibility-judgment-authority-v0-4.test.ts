// @ts-expect-error TS2307 -- Node types are intentionally absent from the portable package
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  authorityGrantV04Schema,
  buildResponsibilityJudgmentAuthorityV04Bundle,
  canonicalizeAuthorityGrantV04ForDigest,
  canonicalizeJudgmentAnswerRequestV04ForDigest,
  canonicalizeJudgmentDecisionV04ForDigest,
  canonicalizeJudgmentRequestV04ForDigest,
  createJudgmentAuthorityBindingVerifierV04,
  judgmentAnswerRequestV04Schema,
  judgmentAuthorityBindingV04Schema,
  judgmentDecisionV04Schema,
  judgmentRequestV04Schema,
  responsibilityJudgmentAuthorityRejectionCatalogueV04Schema,
} from '../index';

const fixtureSchemas = {
  'judgment-answer.schema.json': judgmentAnswerRequestV04Schema,
  'judgment-request.schema.json': judgmentRequestV04Schema,
  'judgment-decision.schema.json': judgmentDecisionV04Schema,
  'authority-grant.schema.json': authorityGrantV04Schema,
  'judgment-authority-binding.schema.json': judgmentAuthorityBindingV04Schema,
} as const;

const validFixtureForSchema = {
  'judgment-answer.schema.json': 'judgment-answer.valid.json',
  'judgment-request.schema.json': 'judgment-request.valid.json',
  'judgment-decision.schema.json': 'judgment-decision.valid.json',
  'authority-grant.schema.json': 'authority-grant.valid.json',
  'judgment-authority-binding.schema.json': 'judgment-authority-binding.valid.json',
} as const;

// Test-owned and deliberately independent from the fixture builder/exported catalogue enum.
// Deleting a builder case together with its production name therefore still fails this test.
const REQUIRED_JUDGMENT_AUTHORITY_REJECTIONS_V04 = [
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
  'option-without-authority-disposition',
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
  'binding-refusal-option-cannot-grant',
  'binding-decision-before-request',
  'binding-decision-after-request-expiry',
  'binding-grant-created-before-decision',
  'binding-grant-valid-before-created',
  'binding-grant-empty-validity',
  'binding-coordinated-request-digest-mismatch',
] as const;

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
        useLimit: 1,
        validUntil: '2026-08-08T18:30:00.000Z',
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
    expect(judgmentRequestV04Schema.safeParse({
      ...request,
      requestedAuthority: { ...request.requestedAuthority, useLimit: 2 },
    }).success).toBe(false);
    expect(judgmentRequestV04Schema.safeParse({
      ...request,
      requestedAuthority: {
        ...request.requestedAuthority,
        validUntil: '2026-08-08T18:31:00.000Z',
      },
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
    for (const invalidCounters of [
      { useLimit: 2 },
      { usesConsumed: Number.MAX_SAFE_INTEGER },
      { nextUseIndex: Number.MAX_SAFE_INTEGER },
      { usesConsumed: 1, nextUseIndex: 2, state: 'active' },
      { usesConsumed: 0, nextUseIndex: 1, state: 'exhausted' },
      { usesConsumed: 0, nextUseIndex: 0, state: 'active' },
    ]) {
      expect(authorityGrantV04Schema.safeParse({
        ...grant,
        ...invalidCounters,
      }).success, JSON.stringify(invalidCounters)).toBe(false);
    }
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

  it('records a coordinated refusal without permitting the refusal option to yield authority', () => {
    const bundle = buildResponsibilityJudgmentAuthorityV04Bundle(() => 'a'.repeat(64));
    const granted = JSON.parse(bundle['judgment-authority-binding.valid.json']!);
    const { grant, ...bindingWithoutGrant } = granted;
    const refusal = {
      ...bindingWithoutGrant,
      authorityDisposition: 'refused',
      answer: {
        ...bindingWithoutGrant.answer,
        payload: {
          ...bindingWithoutGrant.answer.payload,
          selectedOptionId: 'option_reject',
        },
      },
      decision: {
        ...bindingWithoutGrant.decision,
        selectedOptionId: 'option_reject',
      },
    };

    expect(judgmentAuthorityBindingV04Schema.parse(refusal)).toEqual(refusal);
    expect(judgmentAuthorityBindingV04Schema.safeParse({
      ...refusal,
      authorityDisposition: 'granted',
      grant,
    }).success).toBe(false);
  });

  it('recomputes SHA-256 over the canonical embedded request at the trusted binding boundary', () => {
    const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');
    const bundle = buildResponsibilityJudgmentAuthorityV04Bundle(sha256Hex);
    const binding = JSON.parse(bundle['judgment-authority-binding.valid.json']!);
    const verifyBinding = createJudgmentAuthorityBindingVerifierV04(sha256Hex);

    expect(verifyBinding(binding)).toEqual(binding);

    const coordinatedFalseDigest = `sha256:${'b'.repeat(64)}`;
    expect(judgmentAuthorityBindingV04Schema.safeParse({
      ...binding,
      requestDigest: coordinatedFalseDigest,
      answer: {
        ...binding.answer,
        payload: {
          ...binding.answer.payload,
          displayedRequestDigest: coordinatedFalseDigest,
        },
      },
      decision: {
        ...binding.decision,
        displayedRequestDigest: coordinatedFalseDigest,
      },
    }).success).toBe(true);
    expect(() => verifyBinding({
      ...binding,
      requestDigest: coordinatedFalseDigest,
      answer: {
        ...binding.answer,
        payload: {
          ...binding.answer.payload,
          displayedRequestDigest: coordinatedFalseDigest,
        },
      },
      decision: {
        ...binding.decision,
        displayedRequestDigest: coordinatedFalseDigest,
      },
    })).toThrow('requestDigest must equal SHA-256 of the canonical embedded request');
  });

  it('uses only server timestamps for request-decision-grant authority ordering', () => {
    const bundle = buildResponsibilityJudgmentAuthorityV04Bundle(() => 'a'.repeat(64));
    const binding = JSON.parse(bundle['judgment-authority-binding.valid.json']!);

    for (const [name, mutation] of [
      ['decision before request', {
        decision: { ...binding.decision, decidedAt: '2026-08-08T18:04:59.999Z' },
      }],
      ['decision after request expiry', {
        decision: { ...binding.decision, decidedAt: '2026-08-08T18:30:00.001Z' },
      }],
      ['grant created before decision', {
        grant: { ...binding.grant, createdAt: '2026-08-08T18:10:59.999Z' },
      }],
      ['grant validity starts before creation', {
        grant: {
          ...binding.grant,
          createdAt: '2026-08-08T18:11:00.001Z',
          validFrom: '2026-08-08T18:11:00.000Z',
        },
      }],
      ['grant has an empty validity interval', {
        grant: {
          ...binding.grant,
          validFrom: binding.grant.expiresAt,
        },
      }],
    ] as const) {
      expect(
        judgmentAuthorityBindingV04Schema.safeParse({ ...binding, ...mutation }).success,
        name,
      ).toBe(false);
    }

    for (const clientIssuedAt of [
      '2000-01-01T00:00:00.000Z',
      '2099-01-01T00:00:00.000Z',
    ]) {
      expect(judgmentAuthorityBindingV04Schema.safeParse({
        ...binding,
        answer: { ...binding.answer, clientIssuedAt },
      }).success, clientIssuedAt).toBe(true);
    }
  });

  it('publishes Draft 2020-12 schemas that round-trip every valid fixture', () => {
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

  it('binds the valid family to the real canonical request digest and requested authority', () => {
    const hashedInputs: string[] = [];
    const bundle = buildResponsibilityJudgmentAuthorityV04Bundle((value) => {
      hashedInputs.push(value);
      return 'c'.repeat(64);
    });
    const request = judgmentRequestV04Schema.parse(
      JSON.parse(bundle['judgment-request.valid.json']!),
    );
    const answer = judgmentAnswerRequestV04Schema.parse(
      JSON.parse(bundle['judgment-answer.valid.json']!),
    );
    const decision = judgmentDecisionV04Schema.parse(
      JSON.parse(bundle['judgment-decision.valid.json']!),
    );
    const grant = authorityGrantV04Schema.parse(
      JSON.parse(bundle['authority-grant.valid.json']!),
    );
    const refusal = judgmentAuthorityBindingV04Schema.parse(
      JSON.parse(bundle['judgment-authority-refusal.valid.json']!),
    );
    const canonicalRequest = canonicalizeJudgmentRequestV04ForDigest(request);
    const requestDigest = `sha256:${'c'.repeat(64)}`;

    expect(hashedInputs[0]).toBe(canonicalRequest);
    expect(answer.aggregate).toEqual({
      kind: 'judgment_request',
      id: request.id,
      expectedRevision: request.revision,
    });
    expect(answer.payload.displayedRequestDigest).toBe(requestDigest);
    expect(request.options.map((option) => option.id)).toContain(answer.payload.selectedOptionId);
    expect(decision).toMatchObject({
      ownerId: request.ownerId,
      judgmentRequestId: request.id,
      judgmentRequestRevision: request.revision,
      subject: request.subject,
      selectedOptionId: answer.payload.selectedOptionId,
      displayedRequestDigest: requestDigest,
    });
    expect(grant).toMatchObject({
      ownerId: request.ownerId,
      judgmentRequestId: request.id,
      judgmentRequestRevision: request.revision,
      judgmentDecisionId: decision.id,
      grantor: { kind: 'owner', id: request.ownerId },
      subject: request.subject,
      purpose: request.requestedAuthority?.purpose,
      effectFamily: request.requestedAuthority?.effectFamily,
      resources: request.requestedAuthority?.resources,
      scopes: request.requestedAuthority?.scopes,
      audiences: request.requestedAuthority?.audiences,
      argumentDigest: request.requestedAuthority?.argumentDigest,
      contextDigest: request.requestedAuthority?.contextDigest,
      artifactDigest: request.requestedAuthority?.artifactDigest,
      useLimit: request.requestedAuthority?.useLimit,
    });
    expect(refusal).toMatchObject({
      authorityDisposition: 'refused',
      request,
      answer: { payload: { selectedOptionId: 'option_reject' } },
      decision: { selectedOptionId: 'option_reject' },
    });
    expect('grant' in refusal).toBe(false);
    for (const field of [
      'purpose',
      'effectFamily',
      'resources',
      'scopes',
      'audiences',
      'argumentDigest',
      'contextDigest',
      'artifactDigest',
      'useLimit',
    ] as const) {
      expect(grant[field], field).toEqual(request.requestedAuthority![field]);
    }
    expect(Date.parse(grant.expiresAt)).toBeLessThanOrEqual(Date.parse(request.expiresAt));
    expect(Date.parse(grant.expiresAt)).toBeLessThanOrEqual(
      Date.parse(request.requestedAuthority!.validUntil),
    );
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
    const verifyBinding = createJudgmentAuthorityBindingVerifierV04(
      () => 'a'.repeat(64),
    );

    const names = catalogue.cases.map((entry) => entry.name);
    expect(names).toEqual([...REQUIRED_JUDGMENT_AUTHORITY_REJECTIONS_V04]);
    expect(new Set(names).size).toBe(names.length);

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
      if (rejection.name === 'binding-coordinated-request-digest-mismatch') {
        expect(() => verifyBinding(rejection.value)).toThrow(
          'requestDigest must equal SHA-256 of the canonical embedded request',
        );
      }
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
