import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildResponsibilityAcceptanceCheckV04Bundle } from '../../packages/contracts/src/protocol/responsibility-acceptance-check-v0-4-fixtures';
import { findFixtureBundleDrift } from './fixture-bundle-freshness';

describe('guard-responsibility-acceptance-check-v0-4-fresh', () => {
  it('keeps committed fixtures byte-for-byte aligned with the source builder', () => {
    const directory = new URL(
      '../../packages/contracts/fixtures/responsibility-acceptance-check/v0.4/',
      import.meta.url,
    );
    const bundle = buildResponsibilityAcceptanceCheckV04Bundle((value) =>
      createHash('sha256').update(value).digest('hex'));
    expect(findFixtureBundleDrift(fileURLToPath(directory), bundle)).toEqual([]);
  });

  it('detects CRLF mutation as byte drift', () => {
    const directory = mkdtempSync(join(tmpdir(), 'waldo-acceptance-check-v04-'));
    try {
      const bundle = buildResponsibilityAcceptanceCheckV04Bundle((value) =>
        createHash('sha256').update(value).digest('hex'));
      for (const [path, contents] of Object.entries(bundle)) {
        writeFileSync(join(directory, path), contents);
      }
      writeFileSync(
        join(directory, 'acceptance-check.valid.json'),
        bundle['acceptance-check.valid.json']!.replace(/\n/g, '\r\n'),
      );

      expect(findFixtureBundleDrift(directory, bundle)).toEqual([
        'acceptance-check.valid.json:content',
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
