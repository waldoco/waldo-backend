// @ts-expect-error TS2307 -- Node types are intentionally absent from the portable package
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  buildResponsibilityObligationContextV04Bundle,
  canonicalizeDeclaredOutcomeAcceptanceCriteriaV04ForDigest,
  createOutcomeObligationContextBindingVerifierV04,
  outcomeObligationContextV04Schema,
  responsibilityObligationContextRejectionCatalogueV04Schema,
} from '../index';

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

const REQUIRED_OBLIGATION_CONTEXT_REJECTIONS_V04 = [
  'owner-mismatch',
  'outcome-revision-relabeled',
  'criteria-digest-mismatch',
  'criteria-revision-zero',
  'declared-empty-checks',
  'declared-missing-verification-method',
  'declared-semantic-verification-method',
  'declared-too-many-checks',
  'criterion-provider-done-field',
  'read-back-method-provider-done-field',
  'artifact-method-provider-done-field',
  'criterion-length-2049',
  'absent-hidden-criteria',
  'declined-hidden-criteria',
  'inferred-criteria-field',
  'provider-done-field',
  'effect-receipt-field',
  'artifact-field',
  'evidence-field',
  'verification-field',
  'acceptance-field',
  'closure-field',
  'lone-surrogate-criterion',
] as const;

function declaredContext() {
  const candidate = {
    protocolVersion: '0.4',
    id: 'obligation_context_01',
    ownerId: 'owner_01',
    revision: 1,
    outcome: { id: 'outcome_01', revision: 3 },
    acceptanceCriteria: {
      state: 'declared',
      revision: 2,
      digest: `sha256:${'0'.repeat(64)}`,
      checks: [{
        id: 'acceptance_check_01',
        revision: 1,
        criterion: 'The calendar contains the approved investor meeting.',
        verificationMethod: {
          kind: 'deterministic_read_back',
          capability: 'calendar.event.read',
          targetRef: 'calendar_event_target_01',
          assertion: {
            operator: 'digest_equals',
            expectedDigest: `sha256:${'a'.repeat(64)}`,
          },
        },
      }],
    },
    recordedAt: '2026-08-08T18:00:00.000Z',
  } as const;
  return outcomeObligationContextV04Schema.parse({
    ...candidate,
    acceptanceCriteria: {
      ...candidate.acceptanceCriteria,
      digest: `sha256:${sha256Hex(
        canonicalizeDeclaredOutcomeAcceptanceCriteriaV04ForDigest(candidate),
      )}`,
    },
  });
}

describe('responsibility obligation context v0.4', () => {
  it('binds owner-stated criteria to the exact canonical Outcome revision and digest', () => {
    const verifier = createOutcomeObligationContextBindingVerifierV04(sha256Hex);
    const context = declaredContext();
    const binding = { ownerId: 'owner_01', outcome: { id: 'outcome_01', revision: 3 } };

    expect(verifier.verifyContext(context, binding)).toEqual(context);
    expect(() => verifier.verifyContext({
      ...context,
      outcome: { ...context.outcome, revision: 4 },
    }, binding)).toThrow(
      'obligation context must bind canonical owner and exact Outcome id/revision',
    );
    expect(() => verifier.verifyContext({
      ...context,
      acceptanceCriteria: {
        ...context.acceptanceCriteria,
        digest: `sha256:${'f'.repeat(64)}`,
      },
    }, binding)).toThrow(
      'declared acceptance criteria digest must match canonical criteria bytes',
    );
  });

  it('records explicit absence or owner decline without hidden criteria', () => {
    const base = {
      protocolVersion: '0.4',
      id: 'obligation_context_01',
      ownerId: 'owner_01',
      revision: 1,
      outcome: { id: 'outcome_01', revision: 3 },
      recordedAt: '2026-08-08T18:00:00.000Z',
    } as const;
    const declared = declaredContext();
    if (declared.acceptanceCriteria.state !== 'declared') {
      throw new Error('declared fixture must retain declared criteria');
    }
    const verifier = createOutcomeObligationContextBindingVerifierV04(sha256Hex);
    const binding = { ownerId: 'owner_01', outcome: { id: 'outcome_01', revision: 3 } };
    for (const state of ['absent', 'declined'] as const) {
      const context = { ...base, acceptanceCriteria: { state } };
      expect(outcomeObligationContextV04Schema.parse(context)).toEqual(context);
      expect(verifier.verifyContext(context, binding)).toEqual(context);
      expect(outcomeObligationContextV04Schema.safeParse({
        ...context,
        acceptanceCriteria: {
          state,
          checks: declared.acceptanceCriteria.checks,
        },
      }).success).toBe(false);
    }
  });

  it('requires an explicit deterministic read-back or artifact method for every criterion', () => {
    const context = declaredContext();
    if (context.acceptanceCriteria.state !== 'declared') {
      throw new Error('declared fixture must retain declared criteria');
    }
    const [check] = context.acceptanceCriteria.checks;
    if (check === undefined) throw new Error('declared fixture must retain one criterion');
    const { verificationMethod: _method, ...checkWithoutMethod } = check;
    const missingMethod = outcomeObligationContextV04Schema.safeParse({
      ...context,
      acceptanceCriteria: {
        ...context.acceptanceCriteria,
        checks: [checkWithoutMethod],
      },
    });
    expect(missingMethod.success).toBe(false);
    if (missingMethod.success) throw new Error('criterion method must be required');
    expect(missingMethod.error.issues).toContainEqual({
      expected: 'object',
      code: 'invalid_type',
      path: ['acceptanceCriteria', 'checks', 0, 'verificationMethod'],
      message: 'Invalid input: expected object, received undefined',
    });

    expect(outcomeObligationContextV04Schema.safeParse({
      ...context,
      acceptanceCriteria: {
        ...context.acceptanceCriteria,
        checks: [{
          ...context.acceptanceCriteria.checks[0],
          verificationMethod: {
            kind: 'declared_semantic_check',
            capability: 'artifact.semantic.verify',
          },
        }],
      },
    }).success).toBe(false);

    const artifactCandidate = {
      ...context,
      acceptanceCriteria: {
        ...context.acceptanceCriteria,
        digest: `sha256:${'0'.repeat(64)}`,
        checks: [{
          id: 'acceptance_check_artifact_01',
          revision: 1,
          criterion: 'The owner-reviewed release bytes match exactly.',
          verificationMethod: {
            kind: 'deterministic_artifact_check',
            capability: 'artifact.digest.read',
            artifactRef: 'artifact_release_01',
            assertion: {
              operator: 'digest_equals',
              expectedDigest: `sha256:${'b'.repeat(64)}`,
            },
          },
        }],
      },
    } as const;
    const artifactContext = outcomeObligationContextV04Schema.parse({
      ...artifactCandidate,
      acceptanceCriteria: {
        ...artifactCandidate.acceptanceCriteria,
        digest: `sha256:${sha256Hex(
          canonicalizeDeclaredOutcomeAcceptanceCriteriaV04ForDigest(artifactCandidate),
        )}`,
      },
    });
    expect(createOutcomeObligationContextBindingVerifierV04(sha256Hex).verifyContext(
      artifactContext,
      { ownerId: 'owner_01', outcome: { id: 'outcome_01', revision: 3 } },
    )).toEqual(artifactContext);
  });

  it('rejects prohibited nested fields at criterion and deterministic method boundaries', () => {
    const context = declaredContext();
    if (context.acceptanceCriteria.state !== 'declared') {
      throw new Error('declared fixture must retain declared criteria');
    }
    const [check] = context.acceptanceCriteria.checks;
    if (check === undefined || check.verificationMethod.kind !== 'deterministic_read_back') {
      throw new Error('declared fixture must retain a deterministic read-back criterion');
    }
    const candidates = [
      {
        name: 'criterion',
        value: {
          ...context,
          acceptanceCriteria: {
            ...context.acceptanceCriteria,
            checks: [{ ...check, providerDone: true }],
          },
        },
        path: ['acceptanceCriteria', 'checks', 0],
      },
      {
        name: 'read-back method',
        value: {
          ...context,
          acceptanceCriteria: {
            ...context.acceptanceCriteria,
            checks: [{
              ...check,
              verificationMethod: { ...check.verificationMethod, providerDone: true },
            }],
          },
        },
        path: ['acceptanceCriteria', 'checks', 0, 'verificationMethod'],
      },
      {
        name: 'artifact method',
        value: {
          ...context,
          acceptanceCriteria: {
            ...context.acceptanceCriteria,
            checks: [{
              ...check,
              verificationMethod: {
                kind: 'deterministic_artifact_check',
                capability: 'artifact.digest.read',
                artifactRef: 'artifact_release_01',
                assertion: {
                  operator: 'digest_equals',
                  expectedDigest: `sha256:${'b'.repeat(64)}`,
                },
                providerDone: true,
              },
            }],
          },
        },
        path: ['acceptanceCriteria', 'checks', 0, 'verificationMethod'],
      },
    ] as const;
    for (const candidate of candidates) {
      const result = outcomeObligationContextV04Schema.safeParse(candidate.value);
      expect(result.success, candidate.name).toBe(false);
      if (result.success) throw new Error('nested provider field must be rejected');
      expect(result.error.issues).toEqual([{
        code: 'unrecognized_keys',
        keys: ['providerDone'],
        path: candidate.path,
        message: 'Unrecognized key: "providerDone"',
      }]);
    }
  });

  it('accepts a 2,048-character criterion and rejects 2,049 at the exact field', () => {
    const context = declaredContext();
    if (context.acceptanceCriteria.state !== 'declared') {
      throw new Error('declared fixture must retain declared criteria');
    }
    const [check] = context.acceptanceCriteria.checks;
    if (check === undefined) throw new Error('declared fixture must retain one criterion');
    const withCriterion = (criterion: string) => ({
      ...context,
      acceptanceCriteria: {
        ...context.acceptanceCriteria,
        checks: [{ ...check, criterion }],
      },
    });
    expect(outcomeObligationContextV04Schema.safeParse(
      withCriterion('a'.repeat(2_048)),
    ).success).toBe(true);
    const over = outcomeObligationContextV04Schema.safeParse(
      withCriterion('a'.repeat(2_049)),
    );
    expect(over.success).toBe(false);
    if (over.success) throw new Error('criterion above 2,048 characters must be rejected');
    expect(over.error.issues).toEqual([{
      origin: 'string',
      code: 'too_big',
      maximum: 2_048,
      inclusive: true,
      path: ['acceptanceCriteria', 'checks', 0, 'criterion'],
      message: 'Too big: expected string to have <=2048 characters',
    }]);
  });

  it('canonicalizes field order but never omits exact Outcome revision', () => {
    const context = declaredContext();
    const reordered = {
      recordedAt: context.recordedAt,
      acceptanceCriteria: context.acceptanceCriteria,
      outcome: {
        revision: context.outcome.revision,
        id: context.outcome.id,
      },
      revision: context.revision,
      ownerId: context.ownerId,
      id: context.id,
      protocolVersion: context.protocolVersion,
    };
    expect(canonicalizeDeclaredOutcomeAcceptanceCriteriaV04ForDigest(reordered)).toBe(
      canonicalizeDeclaredOutcomeAcceptanceCriteriaV04ForDigest(context),
    );
    expect(canonicalizeDeclaredOutcomeAcceptanceCriteriaV04ForDigest({
      ...context,
      outcome: { ...context.outcome, revision: 4 },
    })).not.toBe(canonicalizeDeclaredOutcomeAcceptanceCriteriaV04ForDigest(context));
    if (context.acceptanceCriteria.state !== 'declared') {
      throw new Error('declared fixture must retain declared criteria');
    }
    expect(canonicalizeDeclaredOutcomeAcceptanceCriteriaV04ForDigest({
      ...context,
      acceptanceCriteria: { ...context.acceptanceCriteria, revision: 3 },
    })).not.toBe(canonicalizeDeclaredOutcomeAcceptanceCriteriaV04ForDigest(context));
  });

  it('pins independent canonical digests for canonical owner and Outcome binding fields', () => {
    const context = declaredContext();
    const cases = [
      ['base', context],
      ['ownerId', { ...context, ownerId: 'owner_02' }],
      ['outcome.id', { ...context, outcome: { ...context.outcome, id: 'outcome_02' } }],
      ['outcome.revision', {
        ...context,
        outcome: { ...context.outcome, revision: 4 },
      }],
    ] as const;
    expect(cases.map(([field, value]) => [
      field,
      `sha256:${sha256Hex(
        canonicalizeDeclaredOutcomeAcceptanceCriteriaV04ForDigest(value),
      )}`,
    ])).toEqual([
      ['base', 'sha256:20102bafc1b06829d5c335235c83ad148dec699b89b904dc1d90577c74b51729'],
      ['ownerId', 'sha256:b4049c2ee999ad8f901f9be060b5606d534b85d40d7288b21a4a034ff66e1db0'],
      ['outcome.id', 'sha256:ab0c866fe58a9325d10093341388b2b93e2b7bc79b8b47f232a727d05565b642'],
      ['outcome.revision', 'sha256:8cd30d751791ebb56d0e2aca173e5ec201302e89afdffe06fc570f49fe5827e7'],
    ]);
  });

  it('publishes strict declared, absent, and declined fixtures plus hostile oracles', () => {
    const bundle = buildResponsibilityObligationContextV04Bundle(sha256Hex);
    const schema = JSON.parse(bundle['obligation-context.schema.json']!);
    const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
    for (const keyword of [
      'x-waldo-validation-level',
      'x-waldo-offline-commands',
    ]) ajv.addKeyword(keyword);
    const validate = ajv.compile(schema);
    for (const path of [
      'obligation-context-declared.valid.json',
      'obligation-context-absent.valid.json',
      'obligation-context-declined.valid.json',
    ]) {
      const value = JSON.parse(bundle[path]!);
      expect(outcomeObligationContextV04Schema.parse(value), path).toEqual(value);
      expect(validate(value), `${path}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }

    const catalogue = responsibilityObligationContextRejectionCatalogueV04Schema.parse(
      JSON.parse(bundle['obligation-context.rejections.json']!),
    );
    expect(catalogue.cases.map((entry) => entry.name)).toEqual([
      ...REQUIRED_OBLIGATION_CONTEXT_REJECTIONS_V04,
    ]);
    const verifier = createOutcomeObligationContextBindingVerifierV04(sha256Hex);
    const binding = { ownerId: 'owner_fixture_01', outcome: {
      id: 'outcome_fixture_01', revision: 3,
    } };
    for (const rejection of catalogue.cases) {
      expect(
        validate(rejection.value),
        `${rejection.name}: ${JSON.stringify(validate.errors)}`,
      ).toBe(rejection.layer !== 'schema');
      expect(
        outcomeObligationContextV04Schema.safeParse(rejection.value).success,
        rejection.name,
      ).toBe(rejection.zodOutcome === 'accept');
      if (rejection.layer === 'binding') {
        expect(
          () => verifier.verifyContext(rejection.value, binding),
          rejection.name,
        ).toThrow(rejection.expectedError);
      }
    }
  });
});
