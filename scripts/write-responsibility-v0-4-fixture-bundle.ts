import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
export function writeResponsibilityV04FixtureBundle(directory: URL, build: (hash: (value: string) => string) => Record<string, string>): void {
  mkdirSync(directory, { recursive: true });
  for (const [path, contents] of Object.entries(build((value) => createHash('sha256').update(value).digest('hex')))) writeFileSync(new URL(path, directory), contents);
}
