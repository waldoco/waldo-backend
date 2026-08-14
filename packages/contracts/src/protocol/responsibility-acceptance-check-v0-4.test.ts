import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  acceptanceCheckV04Schema,
  buildResponsibilityAcceptanceCheckV04Bundle,
  canonicalizeAcceptanceCheckV04ForDigest,
  responsibilityAcceptanceCheckRejectionCatalogueV04Schema,
} from '../index';

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

// Test-owned so deleting a fixture-builder case together with its production enum still fails.
const REQUIRED_ACCEPTANCE_CHECK_REJECTIONS_V04 = [
  'client-owned-authority',
  'inline-read-back-payload',
  'unbound-subject-revision',
  'malformed-expected-digest',
  'lone-surrogate-criterion',
  'criterion-byte-ceiling',
  'artifact-check-readback-field',
  'semantic-check-missing-model-version',
  'semantic-check-missing-harness-version',
  'semantic-check-missing-grader-version',
  'semantic-check-missing-evidence-version',
  'semantic-check-missing-independence-disclosure',
  'nullable-negotiation-field',
] as const;

describe('responsibility acceptance check v0.4', () => {
  it('declares a deterministic read-back check against an exact responsibility revision', () => {
    const check = {
      protocolVersion: '0.4',
      id: 'acceptance_check_01',
      ownerId: 'owner_01',
      revision: 1,
      subject: {
        kind: 'outcome',
        id: 'outcome_01',
        revision: 3,
      },
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
      createdAt: '2026-08-08T18:00:00.000Z',
    } as const;

    expect(acceptanceCheckV04Schema.parse(check)).toEqual(check);
    expect(canonicalizeAcceptanceCheckV04ForDigest({
      ...check,
      subject: {
        revision: check.subject.revision,
        id: check.subject.id,
        kind: check.subject.kind,
      },
    })).toBe(canonicalizeAcceptanceCheckV04ForDigest(check));
  });

  it('supports strict executable artifact and declared semantic verification methods', () => {
    const base = {
      protocolVersion: '0.4',
      id: 'acceptance_check_01',
      ownerId: 'owner_01',
      revision: 1,
      subject: { kind: 'outcome', id: 'outcome_01', revision: 3 },
      criterion: 'The approved artifact communicates the agreed launch decision.',
      createdAt: '2026-08-08T18:00:00.000Z',
    } as const;
    const artifactCheck = {
      ...base,
      verificationMethod: {
        kind: 'deterministic_artifact_check',
        capability: 'artifact.digest.read',
        artifactRef: 'artifact_launch_01',
        assertion: {
          operator: 'digest_equals',
          expectedDigest: `sha256:${'b'.repeat(64)}`,
        },
      },
    } as const;
    const semanticCheck = {
      ...base,
      verificationMethod: {
        kind: 'declared_semantic_check',
        capability: 'artifact.semantic.verify',
        targetRef: 'artifact_launch_01',
        model: { id: 'semantic_model_01', version: '2026-08-08' },
        harness: { id: 'semantic_harness_01', version: '0.4.0' },
        grader: { id: 'launch_grader_01', version: '1.0.0' },
        evidence: {
          ref: 'evidence_bundle_01',
          version: '1.0.0',
          digest: `sha256:${'c'.repeat(64)}`,
        },
        independenceDisclosure: {
          independentFromProducer: true,
          disclosure: {
            ref: 'independence_disclosure_01',
            digest: `sha256:${'d'.repeat(64)}`,
          },
        },
      },
    } as const;

    expect(acceptanceCheckV04Schema.parse(artifactCheck)).toEqual(artifactCheck);
    expect(acceptanceCheckV04Schema.parse(semanticCheck)).toEqual(semanticCheck);
    expect(acceptanceCheckV04Schema.safeParse({
      ...artifactCheck,
      verificationMethod: {
        ...artifactCheck.verificationMethod,
        targetRef: 'read_back_target_not_allowed',
      },
    }).success).toBe(false);
    const { independenceDisclosure: _missing, ...semanticWithoutDisclosure } =
      semanticCheck.verificationMethod;
    expect(acceptanceCheckV04Schema.safeParse({
      ...semanticCheck,
      verificationMethod: semanticWithoutDisclosure,
    }).success).toBe(false);
  });

  it('rejects a structurally bounded criterion above the contract byte ceiling', () => {
    const oversized = {
      protocolVersion: '0.4',
      id: 'acceptance_check_01',
      ownerId: 'owner_01',
      revision: 1,
      subject: { kind: 'outcome', id: 'outcome_01', revision: 3 },
      criterion: '界'.repeat(2_048),
      verificationMethod: {
        kind: 'deterministic_read_back',
        capability: 'calendar.event.read',
        targetRef: 'calendar_event_target_01',
        assertion: {
          operator: 'digest_equals',
          expectedDigest: `sha256:${'a'.repeat(64)}`,
        },
      },
      createdAt: '2026-08-08T18:00:00.000Z',
    };

    expect(acceptanceCheckV04Schema.safeParse(oversized).success).toBe(false);
  });

  it('accepts exactly 4,096 UTF-8 bytes and rejects 4,097', () => {
    const checkWithCriterion = (criterion: string) => ({
      protocolVersion: '0.4',
      id: 'acceptance_check_01',
      ownerId: 'owner_01',
      revision: 1,
      subject: { kind: 'outcome', id: 'outcome_01', revision: 3 },
      criterion,
      verificationMethod: {
        kind: 'deterministic_read_back',
        capability: 'calendar.event.read',
        targetRef: 'calendar_event_target_01',
        assertion: {
          operator: 'digest_equals',
          expectedDigest: `sha256:${'a'.repeat(64)}`,
        },
      },
      createdAt: '2026-08-08T18:00:00.000Z',
    });
    const exact = checkWithCriterion(`${'界'.repeat(1_200)}${'a'.repeat(34)}`);
    const over = checkWithCriterion(`${'界'.repeat(1_200)}${'a'.repeat(35)}`);

    expect(utf8ByteLength(JSON.stringify(exact))).toBe(4_096);
    expect(utf8ByteLength(JSON.stringify(over))).toBe(4_097);
    expect(acceptanceCheckV04Schema.safeParse(exact).success).toBe(true);
    expect(acceptanceCheckV04Schema.safeParse(over).success).toBe(false);
  });

  it('publishes a Draft 2020-12 schema that accepts its valid fixture', () => {
    const bundle = buildResponsibilityAcceptanceCheckV04Bundle(() => 'a'.repeat(64));
    const jsonSchema = JSON.parse(bundle['acceptance-check.schema.json']!);
    expect(jsonSchema).toMatchObject({
      'x-waldo-validation-level': 'structural-plus-runtime-invariants',
      'x-waldo-offline-commands': 'none',
    });
    const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
    for (const keyword of [
      'x-waldo-validation-level',
      'x-waldo-offline-commands',
    ]) ajv.addKeyword(keyword);
    const validate = ajv.compile(jsonSchema);
    for (const fixturePath of [
      'acceptance-check.valid.json',
      'acceptance-check-artifact.valid.json',
      'acceptance-check-semantic.valid.json',
    ]) {
      const valid = JSON.parse(bundle[fixturePath]!);
      expect(acceptanceCheckV04Schema.parse(valid), fixturePath).toEqual(valid);
      expect(validate(valid), `${fixturePath}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it('rejects every catalogued hostile or unbound check at its declared layer', () => {
    const bundle = buildResponsibilityAcceptanceCheckV04Bundle(() => 'a'.repeat(64));
    const catalogue = responsibilityAcceptanceCheckRejectionCatalogueV04Schema.parse(
      JSON.parse(bundle['acceptance-check.rejections.json']!),
    );
    const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
    for (const keyword of [
      'x-waldo-validation-level',
      'x-waldo-offline-commands',
    ]) ajv.addKeyword(keyword);
    const validate = ajv.compile(JSON.parse(bundle['acceptance-check.schema.json']!));

    expect(catalogue.cases.map((entry) => entry.name)).toEqual(
      [...REQUIRED_ACCEPTANCE_CHECK_REJECTIONS_V04],
    );

    for (const rejection of catalogue.cases) {
      expect(
        validate(rejection.value),
        `${rejection.name}: ${JSON.stringify(validate.errors)}`,
      ).toBe(rejection.layer === 'runtime');
      expect(acceptanceCheckV04Schema.safeParse(rejection.value).success).toBe(false);
    }
  });

  it('pins every fixture byte in an adapter-conformance manifest', () => {
    const bundle = buildResponsibilityAcceptanceCheckV04Bundle((value) =>
      `${value.length.toString(16).padStart(64, '0')}`,
    );
    const manifest = JSON.parse(bundle['manifest.json']!);

    expect(manifest).toMatchObject({
      protocolName: 'responsibility-acceptance-check',
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
