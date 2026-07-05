#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const guardFiles = readdirSync(here)
  .filter((file) => file.endsWith('.mjs') && file !== 'run-all.mjs')
  .sort();

for (const file of guardFiles) {
  const result = spawnSync(process.execPath, [join(here, file)], {
    stdio: 'inherit',
  });

  if (result.error) {
    process.stderr.write(`guard-runner: failed to run ${file}: ${result.error.message}\n`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
