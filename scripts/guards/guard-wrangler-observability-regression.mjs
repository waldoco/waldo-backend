#!/usr/bin/env node
// Adversarial config regression: neither deploy environment may silently resume
// persisting request URLs while OAuth codes and connect tickets use URL surfaces.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(join(root, 'packages/runtime/wrangler.jsonc'), 'utf8');
const guard = join(root, 'scripts/guards/guard-wrangler-local-bindings.mjs');
const directory = mkdtempSync(join(tmpdir(), 'waldo-observability-'));

const check = (config) => {
  const file = join(directory, 'wrangler.jsonc');
  writeFileSync(file, config);
  return spawnSync(process.execPath, [guard], {
    cwd: root,
    env: { ...process.env, WRANGLER_CONFIG_PATH: file },
    encoding: 'utf8',
  });
};

try {
  if (check(source).status !== 0) throw new Error('current observability config rejected');
  for (const [before, after, expected] of [
    ['"invocation_logs": false', '"invocation_logs": true', 'full-URL invocation logs'],
    ['"traces": { "enabled": false }', '"traces": { "enabled": true }', 'automatic traces'],
  ]) {
    const parts = source.split(before);
    if (parts.length !== 3) throw new Error(`expected two ${before} settings`);
    for (const occurrence of [1, 2]) {
      const changed = parts.slice(0, occurrence).join(before) + after + parts.slice(occurrence).join(before);
      const result = check(changed);
      if (result.status !== 1 || !result.stderr.includes(expected)) {
        throw new Error(`guard accepted unsafe setting ${expected} in occurrence ${occurrence}`);
      }
    }
  }
  console.log('guard-wrangler-observability-regression: ok');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
