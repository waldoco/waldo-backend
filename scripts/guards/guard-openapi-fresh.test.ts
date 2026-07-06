import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPublicOpenApiDocument } from '../../packages/contracts/src/public/openapi';

describe('guard-openapi-fresh', () => {
  it('keeps the committed artifact and freshness sentinel in sync with the source builder', () => {
    const generated = `${JSON.stringify(buildPublicOpenApiDocument(), null, 2)}\n`;
    const artifact = readFileSync(
      new URL('../../packages/contracts/openapi/waldo-public-api.json', import.meta.url),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const freshness = readFileSync(
      new URL('../../packages/contracts/openapi/waldo-public-api.sha256', import.meta.url),
      'utf8',
    ).replace(/\r\n/g, '\n');

    expect(artifact).toBe(generated);
    expect(freshness).toBe(`${createHash('sha256').update(artifact).digest('hex')}\n`);
  });
});
