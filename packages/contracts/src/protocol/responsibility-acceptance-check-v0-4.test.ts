import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  acceptanceCheckV04Schema,
  buildResponsibilityAcceptanceCheckV04Bundle,
  canonicalizeAcceptanceCheckV04ForDigest,
  responsibilityAcceptanceCheckRejectionCatalogueV04Schema,
} from '../index';

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

  it('publishes a Draft 2020-12 schema that accepts its valid fixture', () => {
    const bundle = buildResponsibilityAcceptanceCheckV04Bundle(() => 'a'.repeat(64));
    const valid = JSON.parse(bundle['acceptance-check.valid.json']!);
    expect(acceptanceCheckV04Schema.parse(valid)).toEqual(valid);

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
    expect(validate(valid), JSON.stringify(validate.errors)).toBe(true);
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

    expect(catalogue.cases.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      'lone-surrogate-criterion',
      'criterion-byte-ceiling',
    ]));

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
