import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const family = process.argv[2];
if (!/^(presence-channel|execution|closure|continuity)$/.test(family ?? '')) throw new Error('unknown v0.4 fixture family');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vitest = join(root, 'packages', 'contracts', 'node_modules', '.bin', process.platform === 'win32' ? 'vitest.cmd' : 'vitest');
const result = spawnSync(vitest, ['run', join(root, 'scripts', `generate-responsibility-${family}-v0-4.test.ts`)], { cwd: root, shell: process.platform === 'win32', stdio: 'inherit' });
if (result.error) throw result.error; process.exit(result.status ?? 1);
