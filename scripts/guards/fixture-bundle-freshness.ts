import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function findFixtureBundleDrift(
  directory: string,
  expectedBundle: Readonly<Record<string, string>>,
): string[] {
  const actualPaths = new Set(readdirSync(directory));
  const expectedPaths = Object.keys(expectedBundle).sort();
  const drift: string[] = [];

  for (const path of expectedPaths) {
    if (!actualPaths.delete(path)) {
      drift.push(`${path}:missing`);
      continue;
    }
    if (!readFileSync(join(directory, path)).equals(Buffer.from(expectedBundle[path]!))) {
      drift.push(`${path}:content`);
    }
  }
  for (const path of [...actualPaths].sort()) drift.push(`${path}:unexpected`);
  return drift;
}
