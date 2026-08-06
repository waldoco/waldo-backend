#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'guard-responsibility-handshake-v0-1-fresh';
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const vitestBin = join(
  repoRoot,
  'packages',
  'contracts',
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'vitest.cmd' : 'vitest',
);
const testPath = join(
  repoRoot,
  'scripts',
  'guards',
  'guard-responsibility-handshake-v0-1-fresh.test.ts',
);

const result = spawnSync(vitestBin, ['run', testPath], {
  cwd: repoRoot,
  encoding: 'utf8',
  shell: process.platform === 'win32',
});

if (result.error) {
  process.stderr.write(`${NAME}: failed to run fixture freshness test: ${result.error.message}\n`);
  process.exit(1);
}
if (result.status !== 0) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
process.stdout.write(`${NAME}: ok\n`);
