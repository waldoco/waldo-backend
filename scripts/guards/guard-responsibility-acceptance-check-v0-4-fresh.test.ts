import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildResponsibilityAcceptanceCheckV04Bundle } from '../../packages/contracts/src/protocol/responsibility-acceptance-check-v0-4-fixtures';

describe('guard-responsibility-acceptance-check-v0-4-fresh', () => {
  it('keeps committed fixtures byte-for-byte aligned with the source builder', () => {
    const directory = new URL(
      '../../packages/contracts/fixtures/responsibility-acceptance-check/v0.4/',
      import.meta.url,
    );
    const bundle = buildResponsibilityAcceptanceCheckV04Bundle((value) =>
      createHash('sha256').update(value).digest('hex'));
    expect(readdirSync(directory).sort()).toEqual(Object.keys(bundle).sort());
    for (const [path, expected] of Object.entries(bundle)) {
      expect(readFileSync(new URL(path, directory), 'utf8').replace(/\r\n/g, '\n')).toBe(expected);
    }
  });
});
