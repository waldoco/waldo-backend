import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { buildResponsibilityHandshakeV02Bundle } from '../packages/contracts/src/protocol/responsibility-handshake-v0-2-fixtures';

const fixtureDirectory = new URL(
  '../packages/contracts/fixtures/responsibility-handshake/v0.2/',
  import.meta.url,
);

it('writes the deterministic responsibility-handshake v0.2 fixture bundle', () => {
  const bundle = buildResponsibilityHandshakeV02Bundle((value) =>
    createHash('sha256').update(value).digest('hex'));
  mkdirSync(fixtureDirectory, { recursive: true });
  for (const [path, content] of Object.entries(bundle)) {
    writeFileSync(new URL(path, fixtureDirectory), content);
  }
  expect(Object.keys(bundle).length).toBeGreaterThan(1);
});
