import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './verify-supabase-migrations.mjs';

const SUPABASE_CLI_VERSION = '2.109.1';

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const run = (args) => {
  const result = spawnSync(npx, ['-y', `supabase@${SUPABASE_CLI_VERSION}`, ...args], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run(['db', 'reset', '--local', '--no-seed']);
run(['test', 'db']);
run(['migration', 'list', '--local']);
run([
  'db',
  'query',
  '--local',
  '--file',
  'supabase/fixtures/assert-canonical-migration-history.sql',
]);
run([
  'db',
  'query',
  '--local',
  '--file',
  'supabase/fixtures/assert-responsibility-session-authority-rollback.sql',
]);
run(['migration', 'up', '--local']);

// Prove additive hardening with rows already in the historical table. Assemble
// the actual migration between transactional fixtures rather than copying SQL.
run(['db', 'reset', '--local', '--no-seed', '--version', '20260930100000']);
const upgradeDir = mkdtempSync(join(tmpdir(), 'waldo-health-context-upgrade-'));
process.on('exit', () => rmSync(upgradeDir, { recursive: true, force: true }));
const upgradeTest = join(upgradeDir, 'health-context-upgrade.sql');
writeFileSync(upgradeTest, [
  '../supabase/fixtures/health-context-upgrade-before.sql',
  '../supabase/migrations/20260930134308_waldo_health_context_access_hardening.sql',
  '../supabase/fixtures/assert-health-context-upgrade.sql',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n'));
run(['test', 'db', '--local', upgradeTest]);
run(['migration', 'up', '--local']);
run(['db', 'query', '--local', '--file', 'supabase/fixtures/assert-canonical-migration-history.sql']);
