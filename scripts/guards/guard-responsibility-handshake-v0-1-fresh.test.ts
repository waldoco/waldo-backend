import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildResponsibilityHandshakeV01Bundle } from '../../packages/contracts/src/protocol/responsibility-handshake-v0-1-fixtures';

const fixtureDirectory = new URL(
  '../../packages/contracts/fixtures/responsibility-handshake/v0.1/',
  import.meta.url,
);

describe('guard-responsibility-handshake-v0-1-fresh', () => {
  it('keeps every committed fixture byte-for-byte aligned with its source builder', () => {
    const bundle = buildResponsibilityHandshakeV01Bundle((value) =>
      createHash('sha256').update(value).digest('hex'),
    );
    expect(readdirSync(fixtureDirectory).sort()).toEqual(Object.keys(bundle).sort());

    for (const [path, expected] of Object.entries(bundle)) {
      expect(readFileSync(new URL(path, fixtureDirectory), 'utf8').replace(/\r\n/g, '\n')).toBe(
        expected,
      );
    }
  });
});
