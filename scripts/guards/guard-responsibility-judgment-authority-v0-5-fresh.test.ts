import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildResponsibilityJudgmentAuthorityV05Bundle,
} from '../../packages/contracts/src/protocol/responsibility-judgment-authority-v0-5-fixtures';
import { findFixtureBundleDrift } from './fixture-bundle-freshness';

describe('guard-responsibility-judgment-authority-v0-5-fresh', () => {
  const sourceSha256 = createHash('sha256')
    .update(readFileSync(new URL(
      '../../packages/contracts/src/protocol/responsibility-judgment-authority-v0-5.ts',
      import.meta.url,
    )))
    .digest('hex');

  it('keeps committed fixtures byte-for-byte aligned with the source builder', () => {
    const directory = new URL(
      '../../packages/contracts/fixtures/responsibility-judgment-authority/v0.5/',
      import.meta.url,
    );
    const bundle = buildResponsibilityJudgmentAuthorityV05Bundle(
      (value) => createHash('sha256').update(value).digest('hex'),
      sourceSha256,
    );
    expect(findFixtureBundleDrift(fileURLToPath(directory), bundle)).toEqual([]);
  });

  it('detects CRLF mutation as byte drift', () => {
    const directory = mkdtempSync(join(tmpdir(), 'waldo-judgment-authority-v05-'));
    try {
      const bundle = buildResponsibilityJudgmentAuthorityV05Bundle(
        (value) => createHash('sha256').update(value).digest('hex'),
        sourceSha256,
      );
      for (const [path, contents] of Object.entries(bundle)) {
        writeFileSync(join(directory, path), contents);
      }
      writeFileSync(
        join(directory, 'judgment-answer.valid.json'),
        bundle['judgment-answer.valid.json']!.replace(/\n/g, '\r\n'),
      );
      expect(findFixtureBundleDrift(directory, bundle)).toEqual([
        'judgment-answer.valid.json:content',
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
