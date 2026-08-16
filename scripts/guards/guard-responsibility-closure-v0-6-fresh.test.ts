import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildResponsibilityClosureV06Bundle } from '../../packages/contracts/src/protocol/responsibility-closure-v0-6-fixtures';
import { findFixtureBundleDrift } from './fixture-bundle-freshness';

describe('guard-responsibility-closure-v0-6-fresh', () => {
  const sourceSha256 = createHash('sha256').update(readFileSync(new URL(
    '../../packages/contracts/src/protocol/responsibility-closure-v0-6.ts',
    import.meta.url,
  ))).digest('hex');

  it('keeps committed fixtures byte-for-byte aligned with the source builder', () => {
    const directory = new URL(
      '../../packages/contracts/fixtures/responsibility-closure/v0.6/',
      import.meta.url,
    );
    const bundle = buildResponsibilityClosureV06Bundle(
      (value) => createHash('sha256').update(value).digest('hex'),
      sourceSha256,
    );
    expect(findFixtureBundleDrift(fileURLToPath(directory), bundle)).toEqual([]);
  });

  it('detects one-byte fixture mutation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'waldo-closure-v06-'));
    try {
      const bundle = buildResponsibilityClosureV06Bundle(
        (value) => createHash('sha256').update(value).digest('hex'),
        sourceSha256,
      );
      for (const [path, contents] of Object.entries(bundle)) {
        writeFileSync(join(directory, path), contents);
      }
      writeFileSync(
        join(directory, 'acceptance-record-request.valid.json'),
        `${bundle['acceptance-record-request.valid.json']!} `,
      );
      expect(findFixtureBundleDrift(directory, bundle)).toEqual([
        'acceptance-record-request.valid.json:content',
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
