// @ts-expect-error TS2307 -- Node types are intentionally absent from the portable package
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  authorityGrantV05Schema,
  canonicalizeJudgmentRequestV05ForDigest,
  createJudgmentAuthorityBindingVerifierV05,
  createJudgmentProjectionPageVerifierV05,
  judgmentAnswerRequestV05Schema,
  judgmentAnswerResultV05Schema,
  judgmentAuthorityBindingV05Schema,
  judgmentDecisionV05Schema,
  judgmentProjectionPageV05Schema,
  judgmentProjectionQueryV05Schema,
  judgmentRequestV05Schema,
} from './responsibility-judgment-authority-v0-5';
import {
  buildResponsibilityJudgmentAuthorityV05Bundle,
  responsibilityJudgmentAuthorityRejectionCatalogueV05Schema,
} from './responsibility-judgment-authority-v0-5-fixtures';

const validFixtureSchemas = {
  'judgment-request.valid.json': judgmentRequestV05Schema,
  'judgment-answer.valid.json': judgmentAnswerRequestV05Schema,
  'judgment-answer-result-granted.valid.json': judgmentAnswerResultV05Schema,
  'judgment-answer-result-refused.valid.json': judgmentAnswerResultV05Schema,
  'judgment-decision.valid.json': judgmentDecisionV05Schema,
  'authority-grant.valid.json': authorityGrantV05Schema,
  'judgment-authority-binding.valid.json': judgmentAuthorityBindingV05Schema,
  'judgment-authority-refusal.valid.json': judgmentAuthorityBindingV05Schema,
  'judgment-projection-query.valid.json': judgmentProjectionQueryV05Schema,
  'judgment-projection-page.valid.json': judgmentProjectionPageV05Schema,
} as const;

const schemaForValidFixture = {
  'judgment-request.valid.json': 'judgment-request.schema.json',
  'judgment-answer.valid.json': 'judgment-answer.schema.json',
  'judgment-answer-result-granted.valid.json': 'judgment-answer-result.schema.json',
  'judgment-answer-result-refused.valid.json': 'judgment-answer-result.schema.json',
  'judgment-decision.valid.json': 'judgment-decision.schema.json',
  'authority-grant.valid.json': 'authority-grant.schema.json',
  'judgment-authority-binding.valid.json': 'judgment-authority-binding.schema.json',
  'judgment-authority-refusal.valid.json': 'judgment-authority-binding.schema.json',
  'judgment-projection-query.valid.json': 'judgment-projection-query.schema.json',
  'judgment-projection-page.valid.json': 'judgment-projection-page.schema.json',
} as const;

const fixtureSchemas = {
  'judgment-request.schema.json': judgmentRequestV05Schema,
  'judgment-answer.schema.json': judgmentAnswerRequestV05Schema,
  'judgment-answer-result.schema.json': judgmentAnswerResultV05Schema,
  'judgment-decision.schema.json': judgmentDecisionV05Schema,
  'authority-grant.schema.json': authorityGrantV05Schema,
  'judgment-authority-binding.schema.json': judgmentAuthorityBindingV05Schema,
  'judgment-projection-query.schema.json': judgmentProjectionQueryV05Schema,
  'judgment-projection-page.schema.json': judgmentProjectionPageV05Schema,
} as const;

const REQUIRED_REJECTIONS_V05 = [
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
  'request-inline-sensitive-content',
  'request-missing-uncertainty',
  'request-missing-cost-of-waiting',
  'stale-answer-revision',
  'stale-displayed-request-digest',
  'unknown-selected-option',
  'refused-result-with-grant',
  'projection-missing-displayed-digest',
  'projection-owner-mismatch',
  'projection-coordinated-request-digest-mismatch',
  'binding-grantee-mismatch',
  'binding-policy-mismatch',
  'binding-decision-at-expiry',
  'binding-coordinated-request-digest-mismatch',
] as const;

function fixtureAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
  for (const keyword of ['x-waldo-validation-level', 'x-waldo-offline-commands']) {
    ajv.addKeyword(keyword);
  }
  return ajv;
}

describe('responsibility judgment and authority v0.5 fixtures', () => {
  const sourceSha256 = 'f'.repeat(64);

  it('publishes one digest-coherent valid fixture family and pins every byte', () => {
    const hashHex = (value: string) => createHash('sha256').update(value).digest('hex');
    const bundle = buildResponsibilityJudgmentAuthorityV05Bundle(hashHex, sourceSha256);

    for (const [path, schema] of Object.entries(validFixtureSchemas)) {
      const value = JSON.parse(bundle[path]!);
      expect(schema.parse(value), path).toEqual(value);
      const schemaPath = schemaForValidFixture[path as keyof typeof schemaForValidFixture];
      const validate = fixtureAjv().compile(JSON.parse(bundle[schemaPath]!));
      expect(validate(value), `${path}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }

    const request = judgmentRequestV05Schema.parse(
      JSON.parse(bundle['judgment-request.valid.json']!),
    );
    const requestDigest = `sha256:${hashHex(
      canonicalizeJudgmentRequestV05ForDigest(request),
    )}`;
    const answer = judgmentAnswerRequestV05Schema.parse(
      JSON.parse(bundle['judgment-answer.valid.json']!),
    );
    const decision = judgmentDecisionV05Schema.parse(
      JSON.parse(bundle['judgment-decision.valid.json']!),
    );
    const projection = judgmentProjectionPageV05Schema.parse(
      JSON.parse(bundle['judgment-projection-page.valid.json']!),
    );
    expect(answer.payload.displayedRequestDigest).toBe(requestDigest);
    expect(decision.displayedRequestDigest).toBe(requestDigest);
    expect(projection.items[0]?.displayedRequestDigest).toBe(requestDigest);

    const manifest = JSON.parse(bundle['manifest.json']!);
    expect(manifest).toMatchObject({
      protocolName: 'responsibility-judgment-authority',
      protocolVersion: '0.5',
      mediaType: 'application/vnd.waldo.responsibility.v0.5+json',
      offlineCommands: 'none',
      proofLevel: 'adapter_conformance_fixture',
      source: {
        path: 'packages/contracts/src/protocol/responsibility-judgment-authority-v0-5.ts',
        sha256: `sha256:${sourceSha256}`,
      },
      compatibilityWindow: {
        predecessor: '0.4',
        mode: 'parallel_additive',
        promise: 'v0.4 source, tests, and fixture bytes remain preserved',
        removal: 'none_authorized',
      },
      consumers: [
        { name: 'waldo-backend-runtime', status: 'required_next', issue: '#82' },
        { name: 'kennel', status: 'deferred', gate: 'B3' },
        { name: 'waldo-mobile', status: 'deferred', gate: 'B3' },
        { name: 'telegram', status: 'deferred', gate: 'B4' },
        { name: 'discord', status: 'deferred', gate: 'B4' },
      ],
      retrySemantics: {
        identity: 'requestId',
        exactDuplicate: 'return_persisted_result_byte_for_byte',
        changedDuplicate: 'reject_request_conflict',
      },
    });
    expect(manifest.files).toEqual(
      Object.keys(bundle)
        .filter((path) => path !== 'manifest.json')
        .sort()
        .map((path) => ({ path, sha256: `sha256:${hashHex(bundle[path]!)}` })),
    );
    expect(manifest.fixturePayloadRootSha256).toBe(
      `sha256:${hashHex(
        manifest.files.map(
          ({ path, sha256 }: { path: string; sha256: string }) => `${path}\u0000${sha256}\n`,
        ).join(''),
      )}`,
    );
  });

  it('catalogues structural, semantic, stale, and coordinated-digest attacks', () => {
    const hashHex = (value: string) => createHash('sha256').update(value).digest('hex');
    const bundle = buildResponsibilityJudgmentAuthorityV05Bundle(hashHex, sourceSha256);
    const catalogue = responsibilityJudgmentAuthorityRejectionCatalogueV05Schema.parse(
      JSON.parse(bundle['judgment-authority.rejections.json']!),
    );
    const validators = Object.fromEntries(
      Object.keys(fixtureSchemas).map((schemaPath) => [
        schemaPath,
        fixtureAjv().compile(JSON.parse(bundle[schemaPath]!)),
      ]),
    );

    expect(catalogue.cases.map((entry) => entry.name)).toEqual([...REQUIRED_REJECTIONS_V05]);
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
        expect(() => createJudgmentAuthorityBindingVerifierV05(hashHex)(rejection.value))
          .toThrow('requestDigest must equal SHA-256 of the canonical embedded request');
      }
      if (rejection.name === 'projection-coordinated-request-digest-mismatch') {
        expect(() => createJudgmentProjectionPageVerifierV05(hashHex)(rejection.value))
          .toThrow(
            'displayedRequestDigest must equal SHA-256 of the canonical embedded request',
          );
      }
    }
  });
});
