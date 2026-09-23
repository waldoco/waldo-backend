#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const vitest = join(
  root,
  'packages',
  'contracts',
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'vitest.cmd' : 'vitest',
);
const result = spawnSync(
  vitest,
  ['run', join(root, 'scripts/guards/guard-responsibility-v0-1-v0-3-preserved.test.ts')],
  { cwd: root, shell: process.platform === 'win32', stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
