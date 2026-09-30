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
  const config = JSON.parse(source.replace(/\/\/[^\n]*/g, '').replace(/,(\s*[}\]])/g, '$1'));
  // Inspect actual environments, not textual occurrence counts: adding an isolated
  // preview must not make the production/staging privacy regression stop running.
  for (const target of ['production', 'staging']) {
    for (const setting of ['invocation_logs', 'traces']) {
      const changed = structuredClone(config);
      const env = target === 'production' ? changed : changed.env.staging;
      if (setting === 'invocation_logs') env.observability.logs.invocation_logs = true;
      else env.observability.traces.enabled = true;
      const expected = setting === 'invocation_logs' ? 'full-URL invocation logs' : 'automatic traces';
      const result = check(JSON.stringify(changed));
      if (result.status !== 1 || !result.stderr.includes(expected)) {
        throw new Error(`guard accepted unsafe setting ${expected} in ${target}`);
      }
    }
  }
  console.log('guard-wrangler-observability-regression: ok');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
