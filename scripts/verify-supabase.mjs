import { spawnSync } from 'node:child_process';
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
run(['migration', 'up', '--local']);
