import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { responsibilityHttpRouteManifestV01 } from '../../packages/contracts/src/protocol/responsibility-http-adapter-v0-1';
import { buildPublicOpenApiDocument } from '../../packages/contracts/src/public/openapi';

describe('guard-openapi-fresh', () => {
  it('keeps the committed artifact and freshness sentinel in sync with the source builder', () => {
    const generated = `${JSON.stringify(buildPublicOpenApiDocument(), null, 2)}\n`;
    const artifactUrl = new URL(
      '../../packages/contracts/openapi/waldo-public-api.json',
      import.meta.url,
    );
    const freshnessUrl = new URL(
      '../../packages/contracts/openapi/waldo-public-api.sha256',
      import.meta.url,
    );

    const artifact = readFileSync(artifactUrl, 'utf8').replace(/\r\n/g, '\n');
    const freshness = readFileSync(freshnessUrl, 'utf8').replace(/\r\n/g, '\n');

    expect(artifact).toBe(generated);
    expect(freshness).toBe(`${createHash('sha256').update(artifact).digest('hex')}\n`);
  });

  it('detects a deliberate guarded-route manifest mutation', () => {
    const artifactUrl = new URL(
      '../../packages/contracts/openapi/waldo-public-api.json',
      import.meta.url,
    );
    const artifact = readFileSync(artifactUrl, 'utf8').replace(/\r\n/g, '\n');
    const mutatedManifest = responsibilityHttpRouteManifestV01.map((route) =>
      route.id === 'capture'
        ? Object.freeze({ ...route, path: '/public/responsibilities-mutated' })
        : route,
    );

    const mutated = `${JSON.stringify(buildPublicOpenApiDocument(mutatedManifest), null, 2)}\n`;

    expect(mutated).not.toBe(artifact);
  });
});
