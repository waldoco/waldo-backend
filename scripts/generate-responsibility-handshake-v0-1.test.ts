import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { buildResponsibilityHandshakeV01Bundle } from '../packages/contracts/src/protocol/responsibility-handshake-v0-1-fixtures';

const fixtureDirectory = new URL(
  '../packages/contracts/fixtures/responsibility-handshake/v0.1/',
  import.meta.url,
);

it('writes the deterministic responsibility-handshake v0.1 fixture bundle', () => {
  const bundle = buildResponsibilityHandshakeV01Bundle((value) =>
    createHash('sha256').update(value).digest('hex'),
  );
  mkdirSync(fixtureDirectory, { recursive: true });

  for (const [path, contents] of Object.entries(bundle)) {
    const target = new URL(path, fixtureDirectory);
    writeFileSync(target, contents);
    expect(readFileSync(target, 'utf8').replace(/\r\n/g, '\n')).toBe(contents);
  }
});
