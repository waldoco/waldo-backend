// @ts-expect-error TS2307 -- Node types are intentionally absent from the portable package
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
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

describe('responsibility handshake v0.1 golden fixtures', () => {
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
      pairs: Array<{
        previous: ProjectionFixturePage;
        next: ProjectionFixturePage;
        expectedDisposition: string;
      }>;
    }>('projection-delivery.json');
    expect(projectionPageSchema.safeParse(catalog.validPage).success).toBe(true);
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
      previousVersionCompatibility: string;
      cases: Array<{
        request: { requestId: string };
        canonicalRequest: string;
        expectedRequestDigest: string;
      }>;
    }>('request-digests.json');
    const [original, duplicate, changed] = catalog.cases;
    expect(original).toBeDefined();
    expect(duplicate).toBeDefined();
    expect(changed).toBeDefined();
    expect(catalog.previousVersionCompatibility).toBe('not_run');
    expect(original!.request.requestId).toBe(duplicate!.request.requestId);
    expect(original!.request.requestId).toBe(changed!.request.requestId);
    expect(original!.expectedRequestDigest).toBe(duplicate!.expectedRequestDigest);
    expect(original!.expectedRequestDigest).not.toBe(changed!.expectedRequestDigest);
    for (const entry of catalog.cases) {
      expect(protocolDigestSchema.safeParse(entry.expectedRequestDigest).success).toBe(true);
      expect(entry.expectedRequestDigest).toBe(`sha256:${hashHex(entry.canonicalRequest)}`);
    }
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
