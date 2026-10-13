#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Five guards block a merge, each for the harm it prevents. Every other guard still runs and reports, as a warning.
const BLOCKING = new Map([
  ['guard-health-leak.mjs', 'raw health values reaching code that logs, prompts, traces or stores them'],
  ['guard-setalarm.mjs', 'a second alarm writer silently overwriting the owner object\'s one alarm'],
  ['guard-do-only-runtime.mjs', 'runtime work leaving the owner Durable Object\'s execution path'],
  ['guard-wrangler-observability-regression.mjs', 'Worker logs persisting request URLs that carry OAuth codes and connect tickets'],
  ['guard-do-migration-lineage.mjs', 'a renumbered or reordered Durable Object migration corrupting deployed storage'],
]);

// The folder argument exists for the runner's own test; the verify loop runs the committed guards.
const here = process.argv[2] ? resolve(process.argv[2]) : dirname(fileURLToPath(import.meta.url));
const guardFiles = readdirSync(here)
  .filter((file) => file.endsWith('.mjs') && file !== 'run-all.mjs')
  .sort();

for (const guard of BLOCKING.keys()) {
  if (!guardFiles.includes(guard)) {
    process.stderr.write(`guard-runner: required guard is missing: ${guard}\n`);
    process.exit(1);
  }
}

const blocked = [];
for (const file of guardFiles) {
  const result = spawnSync(process.execPath, [join(here, file)], { stdio: 'inherit' });
  const reason = result.error ? `failed to run (${result.error.message})` : result.status !== 0 ? `exited ${result.status ?? 'by signal'}` : null;
  if (reason === null) continue;
  if (BLOCKING.has(file)) {
    blocked.push(file);
    process.stderr.write(`guard-runner: block: ${file} ${reason}; it guards against ${BLOCKING.get(file)}\n`);
  } else {
    process.stderr.write(`guard-runner: warn: ${file} ${reason}\n`);
  }
}
process.exit(blocked.length ? 1 : 0);
