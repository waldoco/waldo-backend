import { describe, expect, it } from 'vitest';
// @ts-expect-error TS2307 -- Node types are intentionally absent from the portable package
import { readFileSync, readdirSync } from 'node:fs';
// @ts-expect-error TS2307 -- Node types are intentionally absent from the portable package
import { createHash } from 'node:crypto';
// @ts-expect-error TS2307 -- Node types are intentionally absent from the portable package
import { URL, URLSearchParams } from 'node:url';
import {
  responsibilityCaptureRequestSchema,
} from './responsibility-handshake-v0-1';
import {
  responsibilityCaptureRequestV02Schema,
} from './responsibility-handshake-v0-2';
import {
  responsibilityHttpCapabilitiesV01Schema,
  responsibilityHttpFixtureManifestV01Schema,
  responsibilityHttpRouteManifestV01,
  responsibilityHttpMediaTypeV01,
  responsibilityHttpMediaTypeV02,
  responsibilityHttpMediaTypeV03,
  matchResponsibilityHttpRouteV01,
  responsibilityHttpProjectionFixturesV01Schema,
  responsibilityHttpProblemV01Schema,
  responsibilityHttpProblemV01,
  responsibilityHttpRejectionFixturesV01Schema,
} from './responsibility-http-adapter-v0-1';

describe('responsibility HTTP adapter v0.1', () => {
  it('pins the complete guarded route and protocol-version surface', () => {
    expect(responsibilityHttpRouteManifestV01).toEqual([
      {
        id: 'capture',
        method: 'POST',
        path: '/public/responsibilities',
        protocolVersions: ['0.1', '0.2'],
      },
      {
        id: 'projection',
        method: 'GET',
        path: '/public/responsibilities/projection',
        protocolVersions: ['0.1', '0.2'],
      },
      {
        id: 'planning_turn',
        method: 'POST',
        path: '/public/responsibilities/planning-turns',
        protocolVersions: ['0.3'],
      },
      {
        id: 'planning_cancel',
        method: 'POST',
        path: '/public/responsibilities/planning-turns/cancel',
        protocolVersions: ['0.3'],
      },
      {
        id: 'planning_projection',
        method: 'GET',
        path: '/public/responsibilities/planning-turns/projection',
        protocolVersions: ['0.3'],
      },
    ]);
    for (const route of responsibilityHttpRouteManifestV01) {
      expect(matchResponsibilityHttpRouteV01(route.method, route.path)).toBe(route);
    }
    expect(matchResponsibilityHttpRouteV01('DELETE', '/public/responsibilities')).toBeNull();
    expect(matchResponsibilityHttpRouteV01('POST', '/public/responsibilities/unknown')).toBeNull();
  });

  it('pins released representations and online-only negotiation', () => {
    expect(responsibilityHttpMediaTypeV01).toBe(
      'application/vnd.waldo.responsibility.v0.1+json',
    );
    expect(responsibilityHttpMediaTypeV02).toBe(
      'application/vnd.waldo.responsibility.v0.2+json',
    );
    expect(responsibilityHttpMediaTypeV03).toBe(
      'application/vnd.waldo.responsibility.v0.3+json',
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
    expect(responsibilityHttpProblemV01(401)).toEqual(problem);
    for (const status of [400, 401, 404, 406, 409, 429, 500, 503] as const) {
      expect(responsibilityHttpProblemV01Schema.parse(
        responsibilityHttpProblemV01(status),
      ).status).toBe(status);
    }
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
    const manifest = responsibilityHttpFixtureManifestV01Schema.parse(read('manifest.json'));
    expect(manifest).toEqual({
      adapterContractVersion: '0.1',
      responsibilityProtocolVersions: ['0.1', '0.2'],
      offlineCommands: 'none',
      proofLevel: 'adapter_conformance_fixture',
      files: [
        { path: 'capture-v0.1.valid.json', sha256: 'sha256:e52373cab7be93aebe8070d5bd55442eefe389bfef9e15420770f5d88b5d43b0' },
        { path: 'capture-v0.2.valid.json', sha256: 'sha256:1c3c822ff5b3fe8345a650f416b1272b190314c19e9176ea0cf9f7bb512d6965' },
        { path: 'projection-queries.valid.json', sha256: 'sha256:d01e4a5ac94fbc8fa7a2fcf9b0c53fd7c166de8a6b8a25de0a4cd5b46b41055a' },
        { path: 'rejections.json', sha256: 'sha256:030e500cd4ee58fe6024d5d9e18804134d18370cc46480a6e2b300770e6ec648' },
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
    const projectionQueries = responsibilityHttpProjectionFixturesV01Schema.parse(
      read('projection-queries.valid.json'),
    );
    expect(projectionQueries).toEqual({ cases: [
      { protocolVersion: '0.1', query: 'fromExclusiveCursor=0&limit=25' },
      {
        protocolVersion: '0.2',
        query: 'fromExclusiveCursor=14&limit=25&snapshotId=snapshot_01',
      },
    ] });
    for (const fixture of projectionQueries.cases) {
      const parameters = new URLSearchParams(fixture.query);
      expect([...parameters.keys()]).toEqual(
        fixture.protocolVersion === '0.1'
          ? ['fromExclusiveCursor', 'limit']
          : ['fromExclusiveCursor', 'limit', 'snapshotId'],
      );
      expect(Number(parameters.get('fromExclusiveCursor'))).toBeGreaterThanOrEqual(0);
      expect(Number(parameters.get('limit'))).toBeGreaterThan(0);
    }
    const rejections = responsibilityHttpRejectionFixturesV01Schema.parse(
      read('rejections.json'),
    );
    expect(rejections.cases.map((entry) => entry.name)).toEqual([
      'duplicate-key', 'malformed-unicode', 'server-owned-field', 'protocol-downgrade',
      'missing-or-revoked-auth', 'wrong-owner-root', 'digest-conflict',
      'stale-snapshot-or-cursor', 'rate-limited',
    ]);
    for (const fixture of rejections.cases) {
      expect(['GET', 'POST']).toContain(fixture.request.method);
      expect(fixture.request.path.startsWith('/public/responsibilities')).toBe(true);
      expect(Object.keys(fixture.request.headers).every((key) => key === key.toLowerCase()))
        .toBe(true);
      expect(!('bodyUtf8' in fixture.request) || !('bodyBase64' in fixture.request)).toBe(true);
      expect(responsibilityHttpProblemV01Schema.parse(fixture.expected.problem).status)
        .toBe(fixture.expected.status);
      expect(fixture.harnessState.length).toBeGreaterThan(0);
    }
    expect(responsibilityHttpFixtureManifestV01Schema.safeParse({
      ...manifest, unknown: true,
    }).success).toBe(false);
    expect(responsibilityHttpProjectionFixturesV01Schema.safeParse({
      cases: [{ ...projectionQueries.cases[0], unknown: true }, projectionQueries.cases[1]],
    }).success).toBe(false);
    expect(responsibilityHttpRejectionFixturesV01Schema.safeParse({
      cases: rejections.cases.map((fixture, index) => index === 0
        ? { ...fixture, harnessState: 'unknown' }
        : fixture),
    }).success).toBe(false);
    const firstRejection = rejections.cases[0]!;
    if (!('bodyUtf8' in firstRejection.request)) throw new Error('fixture drift');
    const { bodyUtf8: _body, ...bodylessRequest } = firstRejection.request;
    expect(responsibilityHttpRejectionFixturesV01Schema.safeParse({
      cases: rejections.cases.map((fixture, index) => index === 0
        ? { ...fixture, request: bodylessRequest }
        : fixture),
    }).success).toBe(false);
    expect(responsibilityHttpRejectionFixturesV01Schema.safeParse({
      cases: rejections.cases.map((fixture, index) => index === 0
        ? { ...fixture, request: { ...fixture.request, bodyBase64: '/w==' } }
        : fixture),
    }).success).toBe(false);
  });
});
