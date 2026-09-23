import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { findFixtureBundleDrift } from './fixture-bundle-freshness';
export function assertResponsibilityV04BundleFresh(
  directory: URL,
  build: (hash: (value: string) => string) => Record<string, string>,
): void {
  const bundle = build((value) => createHash('sha256').update(value).digest('hex'));
  expect(findFixtureBundleDrift(fileURLToPath(directory), bundle)).toEqual([]);
  const scratch = mkdtempSync(join(tmpdir(), 'waldo-v04-fresh-'));
  try {
    for (const [path, contents] of Object.entries(bundle)) {
      mkdirSync(scratch, { recursive: true });
      writeFileSync(join(scratch, path), contents);
    }
    const target = Object.keys(bundle).sort()[0]!;
    writeFileSync(join(scratch, target), bundle[target]!.replace(/\n/g, '\r\n'));
    expect(findFixtureBundleDrift(scratch, bundle)).toContain(`${target}:content`);
    writeFileSync(join(scratch, 'unexpected.json'), '{}\n');
    expect(findFixtureBundleDrift(scratch, bundle)).toContain('unexpected.json:unexpected');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
