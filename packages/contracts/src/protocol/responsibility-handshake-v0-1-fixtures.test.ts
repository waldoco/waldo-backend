// @ts-expect-error TS2307 -- Node types are intentionally absent from the portable package
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as publicContracts from '../index';
import {
  agentSessionActivityObservedEventSchema,
  candidateEvidenceObservedEventSchema,
  judgmentNeededObservedEventSchema,
  presenceCapabilityV01Schema,
  projectionPageSchema,
  protocolDigestSchema,
  responsibilityCaptureRequestSchema,
  responsibilityCaptureTrustedEnvelopeSchema,
} from '../index';
import { canonicalizeProtocolJson } from './responsibility-handshake-v0-1';
import {
  buildResponsibilityHandshakeV01Bundle,
} from './responsibility-handshake-v0-1-fixtures';

function hashHex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const bundle = buildResponsibilityHandshakeV01Bundle(hashHex);

function fixture<T>(name: string): T {
  const source = bundle[name];
  if (source === undefined) throw new Error(`missing fixture ${name}`);
  return JSON.parse(source) as T;
}

function nestedArrays(depth: number): unknown {
  let value: unknown = null;
  for (let index = 0; index < depth; index += 1) value = [value];
  return value;
}

const sensitiveFixtureValuePatterns = [
  /(?:sk|pk)[_-](?:live|test)[_-]/i,
  /api[_-]?key|authorization|bearer|password|secret|credential|token/i,
  /raw[_-]?(?:transcript|health|audio|messages?)/i,
  /home[_-]?address|personal[_-]?context/i,
];

function sensitiveFixtureValues(value: unknown): string[] {
  const findings: string[] = [];
  const visit = (current: unknown): void => {
    if (typeof current === 'string') {
      if (sensitiveFixtureValuePatterns.some((pattern) => pattern.test(current))) {
        findings.push(current);
      }
      return;
    }
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!current || typeof current !== 'object') return;
    Object.values(current).forEach(visit);
  };
  visit(value);
  return findings;
}

describe('responsibility handshake v0.1 golden fixtures', () => {
  it('exports only canonical protocol admission schemas from the package root', () => {
    expect(publicContracts.surfaceCommandRequestSchema).toBeDefined();
    expect(publicContracts.trustedCommandEnvelopeSchema).toBeDefined();
    expect(publicContracts.domainEventSchema).toBeDefined();
    expect(publicContracts.projectionPageSchema).toBeDefined();
    expect(publicContracts.presenceCapabilityV01Schema).toBeDefined();
    expect(publicContracts.canonicalizeSurfaceCommandRequestForDigest).toBeDefined();
    expect(publicContracts).not.toHaveProperty('canonicalizeProtocolJson');
    expect(publicContracts).not.toHaveProperty('surfaceCommandRequestEnvelopeSchemaFor');
    expect(publicContracts).not.toHaveProperty('trustedCommandEnvelopeSchemaFor');
    expect(publicContracts).not.toHaveProperty('domainEventEnvelopeSchemaFor');
    expect(publicContracts).not.toHaveProperty('projectionPageEnvelopeSchemaFor');
    expect(publicContracts).not.toHaveProperty('protocolJsonObjectSchema');
    expect(publicContracts).not.toHaveProperty('protocolJsonValueSchema');
  });

  it.each([
    'surface-command-request.schema.json',
    'trusted-command-envelope.schema.json',
    'presence-capability-v0.1.schema.json',
    'domain-event.schema.json',
    'projection-page.schema.json',
  ])('publishes the machine-readable %s contract', (name) => {
    expect(bundle[name]).toBeDefined();
  });

  it('publishes the versioned canonicalization specification and vectors', () => {
    const specification = bundle['waldo-json-sorted-keys-v1.md'];
    const catalog = fixture<{
      algorithm: string;
      specification: string;
      cases: Array<{
        name: string;
        inputJson: string;
        canonicalJson: string;
        expectedDigest: string;
      }>;
      rejectedCases: Array<{
        name: string;
        inputJson: string;
        rejectionStage: string;
      }>;
    }>('canonicalization-vectors.json');

    expect(specification).toContain('RFC 8785');
    expect(specification).toContain('UTF-16 code units');
    expect(specification).toContain('ECMAScript `JSON.stringify`');
    expect(catalog.algorithm).toBe('waldo-json-sorted-keys-v1');
    expect(catalog.specification).toBe('waldo-json-sorted-keys-v1.md');
    expect(catalog.cases.some((entry) => entry.name === 'UTF-16 key ordering')).toBe(
      true,
    );
    expect(
      catalog.cases.some((entry) => entry.name === 'integer-like key ordering'),
    ).toBe(true);
    for (const entry of catalog.cases) {
      expect(canonicalizeProtocolJson(JSON.parse(entry.inputJson)), entry.name).toBe(
        entry.canonicalJson,
      );
      expect(entry.expectedDigest).toBe(`sha256:${hashHex(entry.canonicalJson)}`);
    }
    for (const entry of catalog.rejectedCases.filter(
      (candidate) => candidate.rejectionStage === 'canonicalization',
    )) {
      expect(() => canonicalizeProtocolJson(JSON.parse(entry.inputJson))).toThrow();
    }
    expect(catalog.rejectedCases).toContainEqual({
      name: 'duplicate object key',
      inputJson: '{"a":1,"a":2}',
      rejectionStage: 'raw-json-admission',
    });
  });

  it('round-trips every schema document through a machine validator', () => {
    const surfaceRequest = fixture<Record<string, unknown>>(
      'surface-command.valid.json',
    );
    const trustedEnvelope = fixture<Record<string, unknown>>(
      'trusted-command.valid.json',
    );
    const capabilityCatalog = fixture<{ valid: Record<string, unknown> }>(
      'presence-capability.json',
    );
    const observationCatalog = fixture<{ events: Array<Record<string, unknown>> }>(
      'observations.json',
    );
    const projectionCatalog = fixture<{ validPage: Record<string, unknown> }>(
      'projection-delivery.json',
    );
    const cases: Array<{
      name: string;
      valid: Record<string, unknown>;
      invalid: Record<string, unknown>;
    }> = [
      {
        name: 'surface-command-request.schema.json',
        valid: surfaceRequest,
        invalid: {
          ...surfaceRequest,
          payload: {
            ...(surfaceRequest.payload as Record<string, unknown>),
            ownerId: 'owner_client_smuggled',
          },
        },
      },
      {
        name: 'trusted-command-envelope.schema.json',
        valid: trustedEnvelope,
        invalid: {
          ...trustedEnvelope,
          payload: {
            ...(trustedEnvelope.payload as Record<string, unknown>),
            authorityGrant: { id: 'client_claim' },
          },
        },
      },
      {
        name: 'presence-capability-v0.1.schema.json',
        valid: capabilityCatalog.valid,
        invalid: { protocolVersion: '0.1', offlineCommands: 'queue' },
      },
      {
        name: 'domain-event.schema.json',
        valid: observationCatalog.events[0]!,
        invalid: {
          ...observationCatalog.events[0]!,
          payload: {
            ...(observationCatalog.events[0]!.payload as Record<string, unknown>),
            verification: { state: 'passed' },
          },
        },
      },
      {
        name: 'projection-page.schema.json',
        valid: projectionCatalog.validPage,
        invalid: { ...projectionCatalog.validPage, unexpected: true },
      },
    ];

    for (const entry of cases) {
      const document = fixture<Parameters<typeof z.fromJSONSchema>[0]>(entry.name);
      const compiled = z.fromJSONSchema(document);
      expect(compiled.safeParse(entry.valid).success, entry.name).toBe(true);
      expect(compiled.safeParse(entry.invalid).success, entry.name).toBe(false);
    }
  });

  it('keeps schema identifiers unique and every JSON pointer local', () => {
    const names = [
      'surface-command-request.schema.json',
      'trusted-command-envelope.schema.json',
      'presence-capability-v0.1.schema.json',
      'domain-event.schema.json',
      'projection-page.schema.json',
    ];
    const expectedInvariants: Record<string, Record<string, unknown>> = {
      'surface-command-request.schema.json': {
        admission: 'commandType-discriminated concrete command schemas',
        maxPayloadUtf8Bytes: 16_384,
        wellFormedUserStatementUnicode: true,
      },
      'trusted-command-envelope.schema.json': {
        admission: 'commandType-discriminated concrete trusted envelope schemas',
        maxPayloadUtf8Bytes: 16_384,
        wellFormedUserStatementUnicode: true,
      },
      'presence-capability-v0.1.schema.json': { offlineCommands: 'none' },
      'domain-event.schema.json': {
        schemaVersion: '0.1',
        admission: 'eventType-discriminated concrete observation schemas',
        observationTrust: 'untrusted',
        aggregateKind: 'agent_session',
        aggregateId: 'equals payload.sessionId',
      },
      'projection-page.schema.json': {
        maxJsonDepthPerItem: 64,
        maxJsonNodesPerItem: 4_096,
        maxItemsPerPage: 256,
        maxPageUtf8Bytes: 262_144,
        wellFormedItemUnicode: true,
        cursorOrder:
          'snapshotBaseCursor <= fromExclusiveCursor <= nextCursor <= highWaterCursor',
        hasMore: 'nextCursor < highWaterCursor',
      },
    };
    const identifiers = new Set<string>();

    for (const name of names) {
      const document = fixture<Record<string, unknown>>(name);
      expect(document.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(document['x-waldo-validation-level']).toBe('structural');
      expect(document['x-waldo-runtime-validator-required']).toBe(true);
      expect(document['x-waldo-runtime-invariants']).toEqual(expectedInvariants[name]);
      expect(typeof document.$id).toBe('string');
      identifiers.add(document.$id as string);

      const definitions = document.$defs as Record<string, unknown> | undefined;
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
          value.forEach(visit);
          return;
        }
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
          if (key === '$ref') {
            if (typeof child !== 'string') throw new Error(`${name} has non-string $ref`);
            expect(child).toMatch(/^#\/\$defs\//);
            expect(definitions).toHaveProperty(child.slice('#/$defs/'.length));
          } else {
            visit(child);
          }
        }
      };
      visit(document);
    }

    expect(identifiers.size).toBe(names.length);
  });

  it('covers the structural negative catalogue in the schema artifacts', () => {
    const compile = (name: string) =>
      z.fromJSONSchema(fixture<Parameters<typeof z.fromJSONSchema>[0]>(name));
    const surfaceSchema = compile('surface-command-request.schema.json');
    const trustedSchema = compile('trusted-command-envelope.schema.json');
    const capabilitySchema = compile('presence-capability-v0.1.schema.json');
    const eventSchema = compile('domain-event.schema.json');
    const projectionSchema = compile('projection-page.schema.json');
    const surfaceRejections = fixture<{ cases: Array<{ request: unknown }> }>(
      'surface-command.rejections.json',
    );
    const trustedEnvelope = fixture<Record<string, unknown>>(
      'trusted-command.valid.json',
    );
    const observations = fixture<{ events: Array<Record<string, unknown>> }>(
      'observations.json',
    );
    const projection = fixture<{ validPage: Record<string, unknown> }>(
      'projection-delivery.json',
    ).validPage;

    for (const entry of surfaceRejections.cases) {
      expect(surfaceSchema.safeParse(entry.request).success).toBe(false);
    }
    const { ownerId: _ownerId, ...trustedWithoutOwner } = trustedEnvelope;
    expect(trustedSchema.safeParse(trustedWithoutOwner).success).toBe(false);
    expect(
      trustedSchema.safeParse({ ...trustedEnvelope, requestDigest: 'sha256:not-a-digest' })
        .success,
    ).toBe(false);
    expect(
      capabilitySchema.safeParse({ protocolVersion: '0.1', offlineCommands: 'create' })
        .success,
    ).toBe(false);
    expect(
      capabilitySchema.safeParse({
        protocolVersion: '0.1',
        offlineCommands: 'none',
        offlineQueue: true,
      }).success,
    ).toBe(false);
    for (const event of observations.events) {
      expect(eventSchema.safeParse(event).success).toBe(true);
    }
    expect(
      eventSchema.safeParse({
        ...observations.events[0]!,
        eventType: 'outcome.verified',
      }).success,
    ).toBe(false);
    expect(
      eventSchema.safeParse({
        ...observations.events[0]!,
        schemaVersion: '0.2',
      }).success,
    ).toBe(false);
    expect(
      projectionSchema.safeParse({ ...projection, protocolVersion: '0.2' }).success,
    ).toBe(false);
    expect(
      projectionSchema.safeParse({ ...projection, generatedAt: 'not-a-timestamp' })
        .success,
    ).toBe(false);
    expect(
      projectionSchema.safeParse({
        ...projection,
        items: Array.from({ length: 257 }, () => null),
      }).success,
    ).toBe(false);
  });

  it('labels machine schemas as structural and pins runtime-only invariants', () => {
    const surfaceDocument = fixture<Parameters<typeof z.fromJSONSchema>[0]>(
      'surface-command-request.schema.json',
    );
    const projectionDocument = fixture<Parameters<typeof z.fromJSONSchema>[0]>(
      'projection-page.schema.json',
    );
    const surfaceSchema = z.fromJSONSchema(surfaceDocument);
    const trustedDocument = fixture<Parameters<typeof z.fromJSONSchema>[0]>(
      'trusted-command-envelope.schema.json',
    );
    const domainDocument = fixture<Parameters<typeof z.fromJSONSchema>[0]>(
      'domain-event.schema.json',
    );
    const trustedSchema = z.fromJSONSchema(trustedDocument);
    const domainSchema = z.fromJSONSchema(domainDocument);
    const projectionSchema = z.fromJSONSchema(projectionDocument);
    const surfaceRequest = fixture<Record<string, unknown>>(
      'surface-command.valid.json',
    );
    const projection = fixture<{ validPage: Record<string, unknown> }>(
      'projection-delivery.json',
    ).validPage;
    const trustedEnvelope = fixture<Record<string, unknown>>(
      'trusted-command.valid.json',
    );
    const activityEvent = fixture<{ events: Array<Record<string, unknown>> }>(
      'observations.json',
    ).events[0]!;
    const unicodeOversize = {
      ...surfaceRequest,
      payload: { userStatement: '🐕'.repeat(4_096) },
    };
    const runtimeOnlyProjectionCases = [
      { ...projection, snapshotBaseCursor: 11 },
      { ...projection, hasMore: false },
      {
        ...projection,
        items: [Array(4_096).fill(null)],
      },
      { ...projection, items: [nestedArrays(65)] },
      { ...projection, items: ['x'.repeat(262_145)] },
      { ...projection, items: ['\uD800'] },
      { ...projection, items: [{ ['\uD800']: 'value' }] },
    ];

    expect(surfaceSchema.safeParse(unicodeOversize).success).toBe(true);
    expect(publicContracts.surfaceCommandRequestSchema.safeParse(unicodeOversize).success).toBe(
      false,
    );
    const trustedUnicodeOversize = {
      ...trustedEnvelope,
      payload: { userStatement: '🐕'.repeat(4_096) },
    };
    expect(trustedSchema.safeParse(trustedUnicodeOversize).success).toBe(true);
    expect(
      publicContracts.trustedCommandEnvelopeSchema.safeParse(trustedUnicodeOversize)
        .success,
    ).toBe(false);
    const malformedUnicodeRequest = {
      ...surfaceRequest,
      payload: { userStatement: '\uD800' },
    };
    expect(surfaceSchema.safeParse(malformedUnicodeRequest).success).toBe(true);
    expect(
      publicContracts.surfaceCommandRequestSchema.safeParse(malformedUnicodeRequest)
        .success,
    ).toBe(false);
    const malformedUnicodeTrustedEnvelope = {
      ...trustedEnvelope,
      payload: { userStatement: '\uD800' },
    };
    expect(trustedSchema.safeParse(malformedUnicodeTrustedEnvelope).success).toBe(true);
    expect(
      publicContracts.trustedCommandEnvelopeSchema.safeParse(
        malformedUnicodeTrustedEnvelope,
      ).success,
    ).toBe(false);
    const mismatchedSessionAggregate = {
      ...activityEvent,
      aggregate: {
        ...(activityEvent.aggregate as Record<string, unknown>),
        id: 'agent_session_different',
      },
    };
    expect(domainSchema.safeParse(mismatchedSessionAggregate).success).toBe(true);
    expect(publicContracts.domainEventSchema.safeParse(mismatchedSessionAggregate).success).toBe(
      false,
    );
    for (const candidate of runtimeOnlyProjectionCases) {
      expect(projectionSchema.safeParse(candidate).success).toBe(true);
      expect(publicContracts.projectionPageSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it('builds the same byte-for-byte bundle on every run', () => {
    expect(buildResponsibilityHandshakeV01Bundle(hashHex)).toEqual(bundle);
  });

  it('parses the valid responsibility capture and enriched envelope', () => {
    expect(
      responsibilityCaptureRequestSchema.safeParse(
        fixture('surface-command.valid.json'),
      ).success,
    ).toBe(true);
    expect(
      responsibilityCaptureTrustedEnvelopeSchema.safeParse(
        fixture('trusted-command.valid.json'),
      ).success,
    ).toBe(true);
  });

  it('rejects every client authority-smuggling fixture', () => {
    const catalog = fixture<{ cases: Array<{ request: unknown }> }>(
      'surface-command.rejections.json',
    );
    expect(catalog.cases).not.toHaveLength(0);
    for (const entry of catalog.cases) {
      expect(responsibilityCaptureRequestSchema.safeParse(entry.request).success).toBe(
        false,
      );
    }
  });

  it('declares online-only capability and rejects queue/create alternatives', () => {
    const catalog = fixture<{
      valid: unknown;
      rejected: Array<{ capability: unknown }>;
    }>('presence-capability.json');
    expect(presenceCapabilityV01Schema.safeParse(catalog.valid).success).toBe(true);
    for (const entry of catalog.rejected) {
      expect(presenceCapabilityV01Schema.safeParse(entry.capability).success).toBe(false);
    }
  });

  it('keeps every duplicate, gap, replacement, and account-switch page locally valid', () => {
    const catalog = fixture<{
      validPage: unknown;
      maxItemPage: { items: unknown[] };
      pairs: Array<{
        previous: ProjectionFixturePage;
        next: ProjectionFixturePage;
        expectedDisposition: string;
      }>;
    }>('projection-delivery.json');
    expect(projectionPageSchema.safeParse(catalog.validPage).success).toBe(true);
    expect(catalog.maxItemPage.items).toHaveLength(256);
    expect(projectionPageSchema.safeParse(catalog.maxItemPage).success).toBe(true);
    expect(catalog.pairs.map((pair) => pair.expectedDisposition)).toEqual([
      'ignore_duplicate',
      'recover_gap',
      'replace_snapshot',
      'reset_owner',
    ]);
    for (const pair of catalog.pairs) {
      expect(projectionPageSchema.safeParse(pair.previous).success).toBe(true);
      expect(projectionPageSchema.safeParse(pair.next).success).toBe(true);
    }

    const [duplicate, gap, replacement, accountSwitch] = catalog.pairs;
    expect(duplicate!.next).toEqual(duplicate!.previous);
    expect(gap!.next.ownerId).toBe(gap!.previous.ownerId);
    expect(gap!.next.snapshotId).toBe(gap!.previous.snapshotId);
    expect(gap!.next.fromExclusiveCursor).toBeGreaterThan(gap!.previous.nextCursor);
    expect(replacement!.next.ownerId).toBe(replacement!.previous.ownerId);
    expect(replacement!.next.snapshotId).not.toBe(replacement!.previous.snapshotId);
    expect(replacement!.next.snapshotBaseCursor).toBe(
      replacement!.next.fromExclusiveCursor,
    );
    expect(accountSwitch!.next.ownerId).not.toBe(accountSwitch!.previous.ownerId);
    expect(accountSwitch!.next.snapshotBaseCursor).toBe(0);
    expect(accountSwitch!.next.fromExclusiveCursor).toBe(0);
    expect(accountSwitch!.next.nextCursor).toBe(0);
  });

  it('pins same-id duplicate and changed-digest semantics', () => {
    const catalog = fixture<{
      canonicalizationSpecification: string;
      canonicalizationVectors: string;
      previousVersionCompatibility: string;
      cases: Array<{
        name: string;
        request: Record<string, unknown> & { requestId: string };
        canonicalRequest: string;
        expectedRequestDigest: string;
      }>;
    }>('request-digests.json');
    const [original, duplicate, changed] = catalog.cases;
    expect(original).toBeDefined();
    expect(duplicate).toBeDefined();
    expect(changed).toBeDefined();
    expect(catalog.previousVersionCompatibility).toBe('not_run');
    expect(catalog.canonicalizationSpecification).toBe(
      'waldo-json-sorted-keys-v1.md',
    );
    expect(catalog.canonicalizationVectors).toBe('canonicalization-vectors.json');
    expect(original!.request.requestId).toBe(duplicate!.request.requestId);
    expect(original!.request.requestId).toBe(changed!.request.requestId);
    expect(original!.expectedRequestDigest).toBe(duplicate!.expectedRequestDigest);
    expect(original!.expectedRequestDigest).not.toBe(changed!.expectedRequestDigest);
    expect(
      catalog.cases.some((entry) => entry.name === 'unicode and JSON escaping'),
    ).toBe(true);
    for (const entry of catalog.cases) {
      expect(entry.canonicalRequest).toBe(
        publicContracts.canonicalizeSurfaceCommandRequestForDigest(entry.request),
      );
      expect(protocolDigestSchema.safeParse(entry.expectedRequestDigest).success).toBe(true);
      expect(entry.expectedRequestDigest).toBe(`sha256:${hashHex(entry.canonicalRequest)}`);
    }
    const trustedEnvelope = fixture<{ requestDigest: string }>(
      'trusted-command.valid.json',
    );
    expect(trustedEnvelope.requestDigest).toBe(original!.expectedRequestDigest);
  });

  it('keeps observation fixtures untrusted, narrow, and parseable', () => {
    const catalog = fixture<{ events: Array<Record<string, unknown>> }>(
      'observations.json',
    );
    const schemas = [
      agentSessionActivityObservedEventSchema,
      judgmentNeededObservedEventSchema,
      candidateEvidenceObservedEventSchema,
    ];
    expect(catalog.events).toHaveLength(schemas.length);
    catalog.events.forEach((event, index) => {
      expect(schemas[index]!.safeParse(event).success).toBe(true);
    });

    const forbiddenKeys = new Set([
      'acceptance',
      'apikey',
      'authorization',
      'closure',
      'credential',
      'fulltranscript',
      'heartrate',
      'homeaddress',
      'personalcontext',
      'rawhealth',
      'rawtranscript',
      'secret',
      'token',
      'verification',
    ]);
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        expect(forbiddenKeys.has(key.replaceAll(/[^A-Za-z]/g, '').toLowerCase())).toBe(
          false,
        );
        visit(child);
      }
    };
    visit(catalog.events);
    expect(sensitiveFixtureValues(catalog.events)).toEqual([]);
  });

  it('detects sensitive values even when observation keys are allowed', () => {
    expect(
      sensitiveFixtureValues({
        evidenceRef: 'sk_live_SUPERSECRET',
        subjectRef: 'raw_health_export',
        sessionId: 'raw_transcript_full',
      }),
    ).toEqual(['sk_live_SUPERSECRET', 'raw_health_export', 'raw_transcript_full']);
  });

  it('checks every generated file against the manifest digest', () => {
    const manifest = fixture<{
      previousVersionCompatibility: string;
      files: Array<{ path: string; sha256: string }>;
    }>('manifest.json');
    expect(manifest.previousVersionCompatibility).toBe('not_run');
    for (const entry of manifest.files) {
      expect(entry.sha256).toBe(`sha256:${hashHex(bundle[entry.path]!)}`);
    }
  });
});

type ProjectionFixturePage = {
  ownerId: string;
  snapshotId: string;
  snapshotBaseCursor: number;
  fromExclusiveCursor: number;
  nextCursor: number;
};
