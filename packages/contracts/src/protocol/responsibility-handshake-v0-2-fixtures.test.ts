// @ts-expect-error TS2307 -- Node types are intentionally absent from the portable package
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { responsibilityCaptureRequestSchema } from './responsibility-handshake-v0-1';
import { buildResponsibilityHandshakeV01Bundle } from './responsibility-handshake-v0-1-fixtures';
import { buildResponsibilityHandshakeV02Bundle } from './responsibility-handshake-v0-2-fixtures';
import {
  responsibilityCaptureRequestV02Schema,
  responsibilityCaptureResultV02Schema,
  responsibilityCaptureTrustedEnvelopeV02Schema,
  responsibilityProjectionPageV02Schema,
  responsibilityProtocolCapabilitiesV02Schema,
} from './responsibility-handshake-v0-2';

const hashHex = (value: string) => createHash('sha256').update(value).digest('hex');

describe('responsibility handshake v0.2 golden fixtures', () => {
  it('builds deterministic dual-version compatibility evidence', () => {
    const bundle = buildResponsibilityHandshakeV02Bundle(hashHex);
    const v01Bundle = buildResponsibilityHandshakeV01Bundle(hashHex);
    const v01Manifest = v01Bundle['manifest.json']!;
    expect(bundle).toEqual(buildResponsibilityHandshakeV02Bundle(hashHex));
    expect(JSON.parse(bundle['manifest.json']!)).toMatchObject({
      protocolVersion: '0.2',
      previousVersionCompatibility: 'passed',
      previousVersionManifestSha256:
        'sha256:9553fceb9797cbc6e3fe6441c099dfccaed2e4d3b199dcb4c1e5c9b754db2cca',
    });
    expect(bundle['responsibility-projection-page.valid.json']).toContain(
      'work_unit_proposal',
    );
    expect(JSON.parse(bundle['manifest.json']!).previousVersionManifestSha256).toBe(
      `sha256:${hashHex(v01Manifest)}`,
    );
    expect(responsibilityCaptureRequestSchema.parse(
      JSON.parse(v01Bundle['surface-command.valid.json']!),
    )).toBeDefined();
  });

  it('round-trips structural schemas while the runtime validator rejects cross-field attacks', () => {
    const bundle = buildResponsibilityHandshakeV02Bundle(hashHex);
    const schemaNames = Object.keys(bundle).filter((name) => name.endsWith('.schema.json'));
    const identifiers = new Set<string>();
    for (const name of schemaNames) {
      const document = JSON.parse(bundle[name]!) as Record<string, unknown>;
      expect(document.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(typeof document.$id).toBe('string');
      identifiers.add(document.$id as string);
      expect(document['x-waldo-validation-level']).toBe('structural');
      expect(document['x-waldo-runtime-validator-required']).toBe(true);
      expect(document['x-waldo-runtime-invariants']).toEqual(expect.any(Object));
      const definitions = document.$defs as Record<string, unknown> | undefined;
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
          value.forEach(visit);
          return;
        }
        if (value === null || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
          if (key === '$ref') {
            expect(child).toEqual(expect.stringMatching(/^#\/\$defs\//));
            expect(definitions).toHaveProperty((child as string).slice('#/$defs/'.length));
          } else {
            visit(child);
          }
        }
      };
      visit(document);
    }
    expect(identifiers.size).toBe(schemaNames.length);

    const schemaCases = [
      ['capabilities', responsibilityProtocolCapabilitiesV02Schema],
      ['responsibility-capture-request', responsibilityCaptureRequestV02Schema],
      ['responsibility-capture-trusted-envelope', responsibilityCaptureTrustedEnvelopeV02Schema],
      ['responsibility-capture-result', responsibilityCaptureResultV02Schema],
      ['responsibility-projection-page', responsibilityProjectionPageV02Schema],
    ] as const;
    for (const [name, runtimeSchema] of schemaCases) {
      const structuralDocument = JSON.parse(bundle[`${name}.schema.json`]!) as Record<string, unknown>;
      const structuralSchema = z.fromJSONSchema(structuralDocument);
      const valid = JSON.parse(bundle[`${name}.valid.json`]!);
      expect(structuralSchema.parse(valid)).toEqual(valid);
      expect(structuralDocument).toMatchObject({
        'x-waldo-validation-level': 'structural',
        'x-waldo-runtime-validator-required': true,
      });
      expect(runtimeSchema.parse(valid)).toEqual(valid);
    }

    const catalog = JSON.parse(bundle['responsibility-v0.2.rejections.json']!) as {
      cases: Array<{ schema: string; value: unknown }>;
    };
    expect(catalog.cases).toHaveLength(4);
    for (const rejection of catalog.cases) {
      const runtimeSchema = rejection.schema === 'responsibility-capture-result'
        ? responsibilityCaptureResultV02Schema
        : responsibilityProjectionPageV02Schema;
      expect(runtimeSchema.safeParse(rejection.value).success).toBe(false);
    }
  });
});
