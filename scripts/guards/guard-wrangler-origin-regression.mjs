#!/usr/bin/env node
// Adversarial config regression for the public origin: a deploy environment must not issue links on a malformed
// origin, drop workers.dev by adding a route, or serve a route while its links fall back to the request's host.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from '../jsonc.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(join(root, 'packages/runtime/wrangler.jsonc'), 'utf8');
const guard = join(root, 'scripts/guards/guard-wrangler-local-bindings.mjs');
const directory = mkdtempSync(join(tmpdir(), 'waldo-origin-'));

const check = (config) => {
  const file = join(directory, 'wrangler.jsonc');
  writeFileSync(file, JSON.stringify(config));
  return spawnSync(process.execPath, [guard], {
    cwd: root,
    env: { ...process.env, WRANGLER_CONFIG_PATH: file },
    encoding: 'utf8',
  });
};

const ROUTE = [{ pattern: 'app.fixture.invalid', custom_domain: true }];
const cases = [
  ['a trailing slash', 'WALDO_PUBLIC_ORIGIN must be empty or a bare https origin', (env) => { env.vars.WALDO_PUBLIC_ORIGIN = 'https://app.fixture.invalid/'; }],
  ['plain http', 'WALDO_PUBLIC_ORIGIN must be empty or a bare https origin', (env) => { env.vars.WALDO_PUBLIC_ORIGIN = 'http://app.fixture.invalid'; }],
  ['routes without workers_dev', 'must set workers_dev explicitly', (env) => { env.routes = ROUTE; delete env.workers_dev; env.vars.WALDO_PUBLIC_ORIGIN = 'https://app.fixture.invalid'; }],
  ['routes with an empty origin', 'declares routes, so WALDO_PUBLIC_ORIGIN must be set', (env) => { env.routes = ROUTE; env.workers_dev = true; env.vars.WALDO_PUBLIC_ORIGIN = ''; }],
];

try {
  if (check(parseJsonc(source)).status !== 0) throw new Error('current config rejected');
  for (const target of ['production', 'staging']) {
    for (const [label, expected, change] of cases) {
      const changed = parseJsonc(source);
      change(target === 'production' ? changed : changed.env.staging);
      const result = check(changed);
      if (result.status !== 1 || !result.stderr.includes(expected)) throw new Error(`guard accepted ${label} in ${target}`);
    }
  }
  console.log('guard-wrangler-origin-regression: ok');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
