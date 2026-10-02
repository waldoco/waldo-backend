import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import '../../../../scripts/verify-supabase-migrations.mjs';

// Disposable fixture budget; this is not an operational bridge policy.
const startupBudget = { milliseconds: 60_000, source: 'authored local PostgreSQL fixture setup budget' };
const images = {
  db: 'public.ecr.aws/supabase/postgres@sha256:80d7b27c3e8d77cfa7226eee9508671796da214781ff15a35b3670d7ad5ee453',
  auth: 'public.ecr.aws/supabase/gotrue@sha256:b252efb680be37d4a8bf77c210cf0439c19b63a4b51929233a65dd101d25bdab',
};
if (process.argv.length !== 2) throw new Error('proof accepts no connection URL or other arguments');
if (process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT) throw new Error('proof refuses inherited Docker endpoint/context overrides');
const context = spawnSync('docker', ['context', 'inspect'], { encoding: 'utf8' });
if (context.error || context.status !== 0) throw new Error('local Docker endpoint not available');
const endpoint = JSON.parse(context.stdout)[0]?.Endpoints?.docker?.Host;
if (typeof endpoint !== 'string' || !endpoint.startsWith('unix:///') || new URL(endpoint).hostname) throw new Error('proof requires a local Unix Docker socket');
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const name = 'waldo-imessage-proof-' + randomUUID();
const network = name + '-network';
const label = 'waldo.imessage-proof=' + name;
const run = (args, input) => {
  const result = spawnSync('docker', ['--host', endpoint, ...args], { input, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || 'disposable database command failed');
  return result.stdout;
};
const sql = input => run(['exec', '-i', '--user', 'postgres', name, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-At'], input);
const containers = () => run(['ps', '--all', '--filter', 'label=' + label, '--format', '{{.ID}}']).trim().split('\n').filter(Boolean);
const networks = () => run(['network', 'ls', '--filter', 'label=' + label, '--format', '{{.ID}}']).trim().split('\n').filter(Boolean);
try {
  run(['network', 'create', '--internal', '--label', label, network]);
  run(['run', '-d', '--name', name, '--label', label, '--network', network, '--user', 'postgres',
    '-e', 'POSTGRES_PASSWORD=synthetic-disposable-only', images.db]);
  const until = Date.now() + startupBudget.milliseconds;
  while (spawnSync('docker', ['--host', endpoint, 'exec', '--user', 'postgres', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status !== 0) {
    if (Date.now() >= until) throw new Error('disposable PostgreSQL startup budget exceeded');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  run(['exec', '-i', '--user', 'postgres', name, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres'],
    "alter role supabase_auth_admin password 'synthetic-disposable-auth-only';");
  run(['run', '--rm', '--name', name + '-auth-migrate', '--label', label, '--network', network,
    '-e', 'GOTRUE_DB_DRIVER=postgres', '-e', 'GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:synthetic-disposable-auth-only@' + name + ':5432/postgres',
    '-e', 'GOTRUE_SITE_URL=http://fixture.invalid', '-e', 'API_EXTERNAL_URL=http://fixture.invalid',
    '-e', 'GOTRUE_JWT_SECRET=synthetic-disposable-jwt-secret-only', images.auth, 'auth', 'migrate']);
  const isolation = JSON.parse(run(['inspect', name]))[0];
  const net = JSON.parse(run(['network', 'inspect', network]))[0];
  if (!net.Internal || Object.keys(isolation.HostConfig.PortBindings ?? {}).length || isolation.Config.User !== 'postgres') throw new Error('database isolation not proved');
  console.log(JSON.stringify({ proof: 'disposable PostgreSQL', dockerEndpoint: 'frozen local Unix socket', networkInternal: net.Internal, publishedPorts: [], user: isolation.Config.User, images, startupBudget }));
  for (const filename of readdirSync(join(root, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort()) {
    const bytes = readFileSync(join(root, 'supabase/migrations', filename));
    sql(bytes); console.log('PASS baseline ' + filename + ' sha256=' + createHash('sha256').update(bytes).digest('hex'));
  }
  console.log(sql(readFileSync(new URL('./catalog-before.sql', import.meta.url))));
  const candidate = readFileSync(new URL('./presence-provider.sql', import.meta.url), 'utf8');
  console.log('candidate sha256=' + createHash('sha256').update(candidate).digest('hex'));
  // First execute the exact full script, including its own rollback.
  console.log(sql(candidate + readFileSync(new URL('./catalog-restored.sql', import.meta.url), 'utf8')));
  const end = candidate.lastIndexOf('rollback;');
  if (end < 0 || candidate.slice(end).trim() !== 'rollback;') throw new Error('candidate transaction boundary changed');
  // Observe identical candidate DDL in its transaction before its rollback.
  const output = sql(candidate.slice(0, end) + readFileSync(new URL('./inactive-tests.sql', import.meta.url), 'utf8') + candidate.slice(end) +
    readFileSync(new URL('./catalog-restored.sql', import.meta.url), 'utf8'));
  console.log(output);
  if (output.includes('not ok') || !output.includes('1..') || !output.includes('PASS catalog restored')) throw new Error('candidate SQL proof failed');
} finally {
  for (const id of containers()) run(['rm', '-f', '-v', id]);
  for (const id of networks()) run(['network', 'rm', id]);
  if (containers().length || networks().length) throw new Error('fixture disposal not proved');
  console.log('PASS disposal: zero owned labeled containers/networks; no hosted URL accepted.');
}
