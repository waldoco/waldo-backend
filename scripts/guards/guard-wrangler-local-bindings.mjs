#!/usr/bin/env node
// Guard: remote-only bindings (Workers AI, Vectorize) must live under an env
// section, never top-level. vitest-pool-workers reads wrangler.jsonc and starts
// a remote proxy session for top-level ai/vectorize bindings, which demands
// wrangler auth and kills the ENTIRE runtime test pool with a misleading
// "no tests" result (found 2026-09-25 after c76f7cd).
import { readFileSync } from 'node:fs';

const path = process.env.WRANGLER_CONFIG_PATH ?? 'packages/runtime/wrangler.jsonc';
const text = readFileSync(path, 'utf8');
const bad = [];
for (const key of ['"ai"', '"vectorize"']) {
  // Top-level keys sit at 2-space indent in our wrangler.jsonc; anything
  // deeper (env.staging etc.) is fine.
  if (new RegExp(`^  ${key}\\s*:`, 'm').test(text)) bad.push(key);
}
if (bad.length) {
  process.stderr.write(
    `guard-wrangler-local-bindings: ${bad.join(', ')} at top level of ${path}; ` +
      `remote-only bindings belong under "env" so local test pools stay offline\n`,
  );
  process.exit(1);
}
console.log('guard-wrangler-local-bindings: ok');
