// Production alpha readiness, dry run. It reads packages/runtime/wrangler.jsonc and the committed
// migrations, then prints what the top-level (production) Worker still lacks for the alpha in
// docs/ops/PRODUCTION_ALPHA_RUNBOOK_2026-10-22.md. It runs no command, reads no environment
// value, opens no connection and writes nothing.
//   node scripts/production-alpha-dryrun.mjs
// Exit 0 when nothing is missing, 1 while any gap or open decision remains.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from './jsonc.mjs';
import { localManifest } from './staging-migration-preflight.mjs';
import { pendingDigest } from './staging-migration-apply.mjs';

const ok = (id, detail) => ({ id, status: 'ok', detail });
const gap = (id, detail, step) => ({ id, status: 'gap', detail, step });
const decide = (id, detail, step) => ({ id, status: 'decide', detail, step });

export function configChecks(cfg) {
  const prod = cfg ?? {};
  const staging = prod.env?.staging ?? {};
  const vars = prod.vars ?? {};
  const out = [];
  out.push(prod.name === 'waldo-runtime' && vars.WALDO_ENVIRONMENT === 'production'
    ? ok('identity', 'waldo-runtime, WALDO_ENVIRONMENT=production')
    : gap('identity', 'top level must be waldo-runtime with WALDO_ENVIRONMENT=production', 'S5'));
  out.push(vars.LANGFUSE_CAPTURE_TEXT === 'false' && vars.WHATSAPP_DEBUG_LOG === 'false'
    ? ok('no-text-capture', 'LANGFUSE_CAPTURE_TEXT and WHATSAPP_DEBUG_LOG are "false"')
    : gap('no-text-capture', 'LANGFUSE_CAPTURE_TEXT and WHATSAPP_DEBUG_LOG must be "false"', 'S8'));
  out.push(vars.WALDO_COST_LEDGER_SYNC === 'on'
    ? ok('cost-ledger', 'WALDO_COST_LEDGER_SYNC=on')
    : gap('cost-ledger', 'WALDO_COST_LEDGER_SYNC is not "on", so the per-owner spend ceiling is inert', 'S9'));
  out.push(vars.WALDO_OWNER_DO_NAMESPACE
    ? ok('do-namespace', 'WALDO_OWNER_DO_NAMESPACE is set')
    : gap('do-namespace', 'WALDO_OWNER_DO_NAMESPACE is empty; files and the workspace answer "unavailable" until it names the production OWNER_DO namespace id', 'S5'));
  const bucket = (node) => (node.r2_buckets ?? []).find((b) => b?.binding === 'ARTIFACTS')?.bucket_name;
  out.push(bucket(prod) && bucket(prod) !== bucket(staging)
    ? ok('r2-separate', `ARTIFACTS is ${bucket(prod)}`)
    : gap('r2-separate', `ARTIFACTS bucket ${bucket(prod) ?? '(none)'} is shared with staging`, 'P2'));
  const limiter = (node) => (node.ratelimits ?? []).find((r) => r?.name === 'RESPONSIBILITY_RATE_LIMITER')?.namespace_id;
  out.push(limiter(prod) && limiter(prod) !== limiter(staging)
    ? ok('ratelimit-separate', `RESPONSIBILITY_RATE_LIMITER namespace ${limiter(prod)}`)
    : gap('ratelimit-separate', `RESPONSIBILITY_RATE_LIMITER namespace ${limiter(prod) ?? '(none)'} is shared with staging`, 'P2'));
  out.push((prod.triggers?.crons ?? []).length
    ? ok('retention-cron', `crons ${prod.triggers.crons.join(', ')}`)
    : gap('retention-cron', 'no cron trigger, so the daily health retention sweep never runs in production', 'P3'));
  out.push(prod.limits?.cpu_ms
    ? ok('cpu-limit', `limits.cpu_ms ${prod.limits.cpu_ms}`)
    : gap('cpu-limit', `no limits.cpu_ms; staging sets ${staging.limits?.cpu_ms ?? 'none'} because long owner turns pass the 30 s default`, 'P3'));
  out.push((prod.routes ?? []).length
    ? ok('domain', 'routes declared')
    : decide('domain', 'no route or custom domain; production would answer on workers.dev', 'S6'));
  const flags = ['CALENDAR_GROUNDED_PREP', 'DRIVE_READS', 'MAIL_SOURCE_FOLLOWUPS', 'MCP_READ_INTENTS'];
  const differ = flags.filter((name) => vars[name] !== (staging.vars ?? {})[name]);
  out.push(differ.length
    ? decide('feature-parity', `${differ.join(', ')} differ from staging, where the 22 Oct E2E ran`, 'D6')
    : ok('feature-parity', 'feature flags match staging'));
  out.push(vars.WALDO_EGRESS_ALLOWLIST
    ? ok('egress', 'WALDO_EGRESS_ALLOWLIST set')
    : decide('egress', 'WALDO_EGRESS_ALLOWLIST is empty, so browsing tools fail closed in production', 'D6'));
  return out;
}

// The digest the existing apply script would demand for an empty hosted history: every
// committed migration is pending, so the pending manifest is the whole local manifest.
export function fromZeroManifest(dir) {
  const rows = localManifest(dir);
  return { count: rows.length, first: rows[0].filename, last: rows.at(-1).filename, pendingManifestSha256: pendingDigest(rows) };
}

export function main({ root = new URL('../', import.meta.url), read = readFileSync, out = console.log } = {}) {
  const checks = configChecks(parseJsonc(read(new URL('packages/runtime/wrangler.jsonc', root), 'utf8')));
  for (const c of checks) out(`${c.status.toUpperCase().padEnd(6)} ${c.id.padEnd(18)} ${c.detail}${c.step ? ` (runbook ${c.step})` : ''}`);
  const manifest = fromZeroManifest(new URL('supabase/migrations/', root));
  out(`INFO   migrations         from zero: ${manifest.count} files, ${manifest.first} .. ${manifest.last}, pendingManifestSha256 ${manifest.pendingManifestSha256}`);
  out('INFO   secrets            names only, compare with: npx wrangler secret list --name waldo-runtime (runbook S4)');
  const open = checks.filter((c) => c.status !== 'ok').length;
  out(open ? `NOT READY: ${open} open (dry run, nothing was changed)` : 'READY (dry run, nothing was changed)');
  return open ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
