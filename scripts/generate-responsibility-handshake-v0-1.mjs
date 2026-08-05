#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
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
  'generate-responsibility-handshake-v0-1.test.ts',
);

const result = spawnSync(vitestBin, ['run', testPath], {
  cwd: repoRoot,
  encoding: 'utf8',
  shell: process.platform === 'win32',
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
