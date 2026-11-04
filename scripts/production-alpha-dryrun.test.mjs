import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { configChecks, fromZeroManifest, main } from './production-alpha-dryrun.mjs';
import { compareHistory, localManifest } from './staging-migration-preflight.mjs';
import { pendingDigest } from './staging-migration-apply.mjs';

const ready = () => ({
  name: 'waldo-runtime',
  vars: { WALDO_ENVIRONMENT: 'production', LANGFUSE_CAPTURE_TEXT: 'false', WHATSAPP_DEBUG_LOG: 'false', WALDO_COST_LEDGER_SYNC: 'on', WALDO_OWNER_DO_NAMESPACE: 'abc', WALDO_EGRESS_ALLOWLIST: '*', CALENDAR_GROUNDED_PREP: '1' },
  r2_buckets: [{ binding: 'ARTIFACTS', bucket_name: 'waldo-artifacts-production' }],
  ratelimits: [{ name: 'RESPONSIBILITY_RATE_LIMITER', namespace_id: '1003' }],
  triggers: { crons: ['17 3 * * *'] },
  limits: { cpu_ms: 300000 },
  routes: [{ pattern: 'api.example.test', custom_domain: true }],
  env: { staging: {
    vars: { CALENDAR_GROUNDED_PREP: '1' },
    r2_buckets: [{ binding: 'ARTIFACTS', bucket_name: 'waldo-artifacts' }],
    ratelimits: [{ name: 'RESPONSIBILITY_RATE_LIMITER', namespace_id: '1001' }],
    limits: { cpu_ms: 300000 },
  } },
});
const status = (cfg) => Object.fromEntries(configChecks(cfg).map((c) => [c.id, c.status]));

test('a fully separated production config has nothing open', () => {
  assert.ok(configChecks(ready()).every((c) => c.status === 'ok'));
});

test('a bucket or rate-limit namespace shared with staging is a gap', () => {
  const cfg = ready();
  cfg.r2_buckets[0].bucket_name = 'waldo-artifacts';
  cfg.ratelimits[0].namespace_id = '1001';
  assert.equal(status(cfg)['r2-separate'], 'gap');
  assert.equal(status(cfg)['ratelimit-separate'], 'gap');
});

test('text capture, the cost ledger and the retention cron are gaps when unset', () => {
  const cfg = ready();
  cfg.vars.LANGFUSE_CAPTURE_TEXT = 'true';
  delete cfg.vars.WALDO_COST_LEDGER_SYNC;
  delete cfg.triggers;
  const s = status(cfg);
  assert.equal(s['no-text-capture'], 'gap');
  assert.equal(s['cost-ledger'], 'gap');
  assert.equal(s['retention-cron'], 'gap');
});

test('the from-zero digest is the digest the apply script demands for an empty hosted history', () => {
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const { pending } = compareHistory(localManifest(dir), []);
  assert.equal(fromZeroManifest(dir).pendingManifestSha256, pendingDigest(pending));
  assert.equal(fromZeroManifest(dir).count, pending.length);
});

test('the committed config yields one line per check and an exit code that matches its verdict', () => {
  const lines = [];
  const code = main({ out: (line) => lines.push(line) });
  const verdict = lines.at(-1);
  assert.ok(lines.slice(0, configChecks({}).length).every((line) => /^(OK|GAP|DECIDE) /.test(line)));
  assert.equal(code, verdict.startsWith('READY') ? 0 : 1);
  assert.match(verdict, /^(READY|NOT READY: \d+ open) \(dry run, nothing was changed\)$/);
});

test('the script stays offline: no process spawning, network or environment reads', () => {
  const source = readFileSync(new URL('./production-alpha-dryrun.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['child_process', 'fetch(', 'process.env', 'writeFile']) assert.ok(!source.includes(forbidden), forbidden);
});
