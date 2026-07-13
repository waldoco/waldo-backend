import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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
});
