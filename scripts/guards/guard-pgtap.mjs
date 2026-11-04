#!/usr/bin/env node
// Executes the full pgTAP suite on a fresh local PostgreSQL 15 + Supabase shim
// (scripts/pgtap/run-local.sh). Written-but-unrun pgTAP shipped 'green' twice on
// 2026-09-25; this guard makes that impossible.
import { spawnSync } from 'node:child_process';

const result = spawnSync('bash', ['scripts/pgtap/run-local.sh'], { stdio: 'inherit' });
if (result.error) {
  process.stderr.write(`guard-pgtap: failed to run: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
