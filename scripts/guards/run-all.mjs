#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REQUIRED_GUARDS = ['guard-do-only-runtime.mjs'];
const guardFiles = readdirSync(here)
  .filter((file) => file.endsWith('.mjs') && file !== 'run-all.mjs')
  .sort();

for (const guard of REQUIRED_GUARDS) {
  if (!guardFiles.includes(guard)) {
    process.stderr.write(`guard-runner: required guard is missing: ${guard}\n`);
    process.exit(1);
  }
}

// Every guard runs, and every failure is listed at the end: a guard that cannot run where it is (pgTAP's download behind a
// proxy) must not hide a real violation in a guard after it.
const failed = [];
for (const file of guardFiles) {
  const result = spawnSync(process.execPath, [join(here, file)], {
    stdio: 'inherit',
  });

  if (result.error) failed.push(`${file} (could not run: ${result.error.message})`);
  else if (result.status !== 0) failed.push(`${file} (exit ${result.status ?? result.signal})`);
}

if (failed.length > 0) {
  process.stderr.write(`guard-runner: ${failed.length} of ${guardFiles.length} guards failed:\n${failed.map((line) => `  ${line}\n`).join('')}`);
  process.exit(1);
}
