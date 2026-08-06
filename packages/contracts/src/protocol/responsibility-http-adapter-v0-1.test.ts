import { describe, expect, it } from 'vitest';
// @ts-expect-error TS2307 -- Node types are intentionally absent from the portable package
import { readFileSync, readdirSync } from 'node:fs';
// @ts-expect-error TS2307 -- Node types are intentionally absent from the portable package
import { createHash } from 'node:crypto';
// @ts-expect-error TS2307 -- Node types are intentionally absent from the portable package
import { URL } from 'node:url';
import {
  responsibilityCaptureRequestSchema,
} from './responsibility-handshake-v0-1';
import {
  responsibilityCaptureRequestV02Schema,
} from './responsibility-handshake-v0-2';
import {
  responsibilityHttpCapabilitiesV01Schema,
  responsibilityHttpMediaTypeV01,
  responsibilityHttpMediaTypeV02,
  responsibilityHttpProblemV01Schema,
} from './responsibility-http-adapter-v0-1';

describe('responsibility HTTP adapter v0.1', () => {
  it('pins released representations and online-only negotiation', () => {
    expect(responsibilityHttpMediaTypeV01).toBe(
      'application/vnd.waldo.responsibility.v0.1+json',
    );
    expect(responsibilityHttpMediaTypeV02).toBe(
      'application/vnd.waldo.responsibility.v0.2+json',
    );
    expect(responsibilityHttpCapabilitiesV01Schema.parse({
      protocolName: 'responsibility-handshake',
      supportedVersions: ['0.1', '0.2'],
      selectedVersion: '0.2',
      offlineCommands: 'none',
    })).toBeDefined();
  });

  it('keeps every adapter error content-free and strict', () => {
    const problem = {
      type: 'https://api.heywaldo.com/problems/unauthorized',
      title: 'Authentication required', status: 401, code: 'unauthorized',
    };
    expect(responsibilityHttpProblemV01Schema.parse(problem)).toEqual(problem);
    expect(responsibilityHttpProblemV01Schema.safeParse({
      ...problem, ownerId: 'owner_leak', detail: 'expired presence',
    }).success).toBe(false);
  });

  it('keeps the version-pinned conformance fixture manifest fresh and parseable', () => {
    const directory = new URL(
      '../../fixtures/responsibility-http-adapter/v0.1/',
      // @ts-expect-error TS2339 -- Vitest runs this test in Node with import.meta.url
      import.meta.url,
    );
    const read = (name: string): unknown => JSON.parse(
      readFileSync(new URL(name, directory), 'utf8'),
    );
    const manifest = read('manifest.json') as {
      adapterContractVersion: string;
      responsibilityProtocolVersions: string[];
      offlineCommands: string;
      proofLevel: string;
      files: Array<{ path: string; sha256: string }>;
    };
    expect(manifest).toEqual({
      adapterContractVersion: '0.1',
      responsibilityProtocolVersions: ['0.1', '0.2'],
      offlineCommands: 'none',
      proofLevel: 'adapter_conformance_fixture',
      files: [
        { path: 'capture-v0.1.valid.json', sha256: 'sha256:e52373cab7be93aebe8070d5bd55442eefe389bfef9e15420770f5d88b5d43b0' },
        { path: 'capture-v0.2.valid.json', sha256: 'sha256:1c3c822ff5b3fe8345a650f416b1272b190314c19e9176ea0cf9f7bb512d6965' },
        { path: 'projection-queries.valid.json', sha256: 'sha256:d01e4a5ac94fbc8fa7a2fcf9b0c53fd7c166de8a6b8a25de0a4cd5b46b41055a' },
        { path: 'rejections.json', sha256: 'sha256:880a3a4f7b3ecaa522bd406584aead38a505a12516a5b1a072f580eb9997b2f3' },
      ],
    });
    expect(readdirSync(directory).sort()).toEqual([
      ...manifest.files.map((entry) => entry.path), 'manifest.json',
    ].sort());
    for (const entry of manifest.files) {
      const bytes = readFileSync(new URL(entry.path, directory));
      expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(entry.sha256);
    }
    expect(responsibilityCaptureRequestSchema.parse(read(manifest.files[0]!.path))).toBeDefined();
    expect(responsibilityCaptureRequestV02Schema.parse(read(manifest.files[1]!.path))).toBeDefined();
    const rejections = read('rejections.json') as { cases: Array<{ name: string }> };
    expect(rejections.cases.map((entry) => entry.name)).toEqual([
      'duplicate-key', 'malformed-unicode', 'server-owned-field', 'protocol-downgrade',
      'missing-or-revoked-auth', 'wrong-owner-root', 'digest-conflict',
      'stale-snapshot-or-cursor', 'rate-limited',
    ]);
  });
});
