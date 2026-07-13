import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { buildPublicOpenApiDocument } from '../packages/contracts/src/public/openapi';

it('writes the deterministic public OpenAPI artifact and SHA sentinel', () => {
  const artifactUrl = new URL('../packages/contracts/openapi/waldo-public-api.json', import.meta.url);
  const freshnessUrl = new URL(
    '../packages/contracts/openapi/waldo-public-api.sha256',
    import.meta.url,
  );
  const generated = `${JSON.stringify(buildPublicOpenApiDocument(), null, 2)}\n`;
  const freshness = `${createHash('sha256').update(generated).digest('hex')}\n`;

  writeFileSync(artifactUrl, generated);
  writeFileSync(freshnessUrl, freshness);

  expect(readFileSync(artifactUrl, 'utf8').replace(/\r\n/g, '\n')).toBe(generated);
  expect(readFileSync(freshnessUrl, 'utf8').replace(/\r\n/g, '\n')).toBe(freshness);
});
