#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync('packages/runtime/wrangler.jsonc', 'utf8').replace(/\/\/[^\n]*/g, '').replace(/,(\s*[}\]])/g, '$1'));
const p = cfg.previews;
assert(p, 'PR previews require an explicit block');
assert.deepEqual(Object.keys(p).sort(), ['vars','observability','durable_objects','ratelimits'].sort(), 'preview keys are allowlisted, not just denied individually');
assert.deepEqual(p.observability, { enabled:true, logs:{enabled:true,invocation_logs:false}, traces:{enabled:false} });
assert.deepEqual(p.ratelimits, [{name:'RESPONSIBILITY_RATE_LIMITER',namespace_id:'1002',simple:{limit:120,period:60}}]);
assert.deepEqual(p.vars, { WALDO_ENVIRONMENT: 'preview', WALDO_RELEASE: 'unreleased', WALDO_OWNER_TELEGRAM_ID: '', LANGFUSE_CAPTURE_TEXT: 'false', WALDO_EGRESS_ALLOWLIST: '' });
assert.deepEqual(p.durable_objects, cfg.durable_objects, 'env DO bindings must be declared for isolated previews');
assert.equal(p.ratelimits[0].name, 'RESPONSIBILITY_RATE_LIMITER');
assert.notEqual(p.ratelimits[0].namespace_id, cfg.ratelimits[0].namespace_id);
assert.equal(p.observability.logs.invocation_logs, false);
assert.equal(p.observability.traces.enabled, false);
for (const key of ['r2_buckets', 'vectorize', 'ai', 'services', 'queues', 'triggers', 'routes', 'assets', 'migrations']) {
  assert.equal(p[key], undefined, `fail-closed preview must not copy ${key}`);
}
const command = readFileSync('scripts/deploy-runtime-preview.sh', 'utf8');
assert(command.includes('exec pnpm exec wrangler preview --worker-name waldo-runtime-staging --ignore-base-config --var'));
assert(command.includes('--ignore-base-config'), 'do not inherit dashboard base secrets');
assert(!/wrangler (?:deploy|versions)/.test(command));
assert(!/--env\s+staging/.test(command));
console.log('guard-runtime-preview-config: ok (fail-closed infrastructure scope)');
