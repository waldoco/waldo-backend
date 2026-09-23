import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const EXPECTED_RELEASED_FILE_COUNT = 211;
const EXPECTED_RELEASED_ROOT_SHA256 =
  'f5bf7db0d5cef40f5acd8f9b04467e605a38cb6ab1d4e8ed15c0e6dd3db15a64';

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function isReleasedResponsibilityPath(path: string): boolean {
  return (
    /^packages\/contracts\/src\/protocol\/responsibility-.*-v0-[1-5](?:-fixtures)?(?:\.test)?\.ts$/.test(path) ||
    /^packages\/contracts\/fixtures\/responsibility-[^/]+\/v0\.[1-5]\//.test(path)
  );
}

function releasedRoot(repoRoot: string): { count: number; sha256: string } {
  const paths = [
    ...walk(join(repoRoot, 'packages', 'contracts', 'src', 'protocol')),
    ...walk(join(repoRoot, 'packages', 'contracts', 'fixtures')),
  ].map((path) => relative(repoRoot, path).split(sep).join('/'))
    .filter(isReleasedResponsibilityPath)
    .sort();
  const root = createHash('sha256');
  for (const path of paths) {
    const digest = createHash('sha256').update(readFileSync(join(repoRoot, path))).digest('hex');
    root.update(`${path}\0${digest}\n`);
  }
  return { count: paths.length, sha256: root.digest('hex') };
}

describe('released responsibility v0.1-v0.5 byte preservation', () => {
  it('pins every released protocol source, test, and fixture byte', () => {
    const repoRoot = resolve(import.meta.dirname, '../..');
    expect(releasedRoot(repoRoot)).toEqual({
      count: EXPECTED_RELEASED_FILE_COUNT,
      sha256: EXPECTED_RELEASED_ROOT_SHA256,
    });
  });
});
