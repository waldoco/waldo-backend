import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildResponsibilityObligationContextV04Bundle } from '../../packages/contracts/src/protocol/responsibility-obligation-context-v0-4-fixtures';
import { findFixtureBundleDrift } from './fixture-bundle-freshness';

const bundle = () =>
  buildResponsibilityObligationContextV04Bundle((value) =>
    createHash('sha256').update(value).digest('hex'),
  );

describe('guard-responsibility-obligation-context-v0-4-fresh', () => {
  it('keeps committed fixtures byte-for-byte aligned with the source builder', () => {
    const directory = new URL(
      '../../packages/contracts/fixtures/responsibility-obligation-context/v0.4/',
      import.meta.url,
    );
    expect(findFixtureBundleDrift(fileURLToPath(directory), bundle())).toEqual([]);
  });

  it('detects CRLF mutation as byte drift', () => {
    const directory = mkdtempSync(join(tmpdir(), 'waldo-obligation-context-v04-'));
    try {
      const expected = bundle();
      for (const [path, contents] of Object.entries(expected)) {
        writeFileSync(join(directory, path), contents);
      }
      writeFileSync(
        join(directory, 'obligation-context-confirmed.valid.json'),
        expected['obligation-context-confirmed.valid.json']!.replace(/\n/g, '\r\n'),
      );
      expect(findFixtureBundleDrift(directory, expected)).toEqual([
        'obligation-context-confirmed.valid.json:content',
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
