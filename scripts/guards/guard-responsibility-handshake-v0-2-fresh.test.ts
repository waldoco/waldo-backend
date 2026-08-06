import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildResponsibilityHandshakeV02Bundle } from '../../packages/contracts/src/protocol/responsibility-handshake-v0-2-fixtures';

const fixtureDirectory = new URL(
  '../../packages/contracts/fixtures/responsibility-handshake/v0.2/',
  import.meta.url,
);
const previousManifest = new URL(
  '../../packages/contracts/fixtures/responsibility-handshake/v0.1/manifest.json',
  import.meta.url,
);

describe('guard-responsibility-handshake-v0-2-fresh', () => {
  it('keeps committed fixtures byte-for-byte aligned with their source builder', () => {
    const bundle = buildResponsibilityHandshakeV02Bundle((value) =>
      createHash('sha256').update(value).digest('hex'));
    expect(readdirSync(fixtureDirectory).sort()).toEqual(Object.keys(bundle).sort());
    for (const [path, expected] of Object.entries(bundle)) {
      expect(readFileSync(new URL(path, fixtureDirectory), 'utf8').replace(/\r\n/g, '\n'))
        .toBe(expected);
    }
    const manifest = JSON.parse(bundle['manifest.json']!) as {
      previousVersionManifestSha256: string;
    };
    expect(manifest.previousVersionManifestSha256).toBe(
      `sha256:${createHash('sha256').update(readFileSync(previousManifest, 'utf8')).digest('hex')}`,
    );
  });
});
