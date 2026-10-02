import { readFileSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import '../../../scripts/verify-supabase-migrations.mjs';

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
const root = fileURLToPath(new URL('../../../', import.meta.url));
const name = 'waldo-admission-proof-' + randomUUID();
const network = name + '-network';
const label = 'waldo.admission-proof=' + name;
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
  run(['run', '--pull=never', '-d', '--name', name, '--label', label, '--network', network, '--user', 'postgres',
    '-e', 'POSTGRES_PASSWORD=synthetic-disposable-only', images.db]);
  const until = Date.now() + startupBudget.milliseconds;
  while (spawnSync('docker', ['--host', endpoint, 'exec', '--user', 'postgres', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status !== 0) {
    if (Date.now() >= until) throw new Error('disposable PostgreSQL startup budget exceeded');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  run(['exec', '-i', '--user', 'postgres', name, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres'],
    "alter role supabase_auth_admin password 'synthetic-disposable-auth-only';");
  run(['run', '--pull=never', '--rm', '--name', name + '-auth-migrate', '--label', label, '--network', network,
    '-e', 'GOTRUE_DB_DRIVER=postgres', '-e', 'GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:synthetic-disposable-auth-only@' + name + ':5432/postgres',
    '-e', 'GOTRUE_SITE_URL=http://fixture.invalid', '-e', 'API_EXTERNAL_URL=http://fixture.invalid',
    '-e', 'GOTRUE_JWT_SECRET=synthetic-disposable-jwt-secret-only', images.auth, 'auth', 'migrate']);
  const isolation = JSON.parse(run(['inspect', name]))[0];
  const net = JSON.parse(run(['network', 'inspect', network]))[0];
  if (!net.Internal || Object.keys(isolation.HostConfig.PortBindings ?? {}).length || isolation.Config.User !== 'postgres') throw new Error('database isolation not proved');
  console.log(JSON.stringify({ proof: 'disposable PostgreSQL', dockerEndpoint: 'frozen local Unix socket', networkInternal: net.Internal, publishedPorts: [], user: isolation.Config.User, images, startupBudget }));
  for (const filename of readdirSync(join(root, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort()) {
    if (filename === '20261002120000_waldo_owner_admission_revision.sql') sql("insert into waldo.owners(do_name) values('pre-revision-owner');");
    const bytes = readFileSync(join(root, 'supabase/migrations', filename));
    sql(bytes); console.log('PASS baseline ' + filename + ' sha256=' + createHash('sha256').update(bytes).digest('hex'));
  }
  const output=sql(readFileSync(join(root, 'supabase/tests/waldo_owner_admission_revision.sql'),'utf8'));
  console.log(output);
  if (/^not ok/m.test(output) || !/^1\.\.[0-9]+$/m.test(output)) throw new Error('admission revision assertions failed');

  // Separate committed sessions exercise opposite transfers plus owner state edits.
  sql(`create table public.revision_concurrency_audit(old_revision bigint, new_revision bigint);
    create function public.revision_concurrency_audit() returns trigger language plpgsql as $$
    begin insert into public.revision_concurrency_audit values(old.admission_revision,new.admission_revision); return new; end $$;
    insert into waldo.owners(id,do_name) values
      ('10000000-0000-0000-0000-000000000011','concurrent-a'),
      ('10000000-0000-0000-0000-000000000012','concurrent-b');
    insert into waldo.presences(id,owner_id,provider,subject) values
      ('20000000-0000-0000-0000-000000000011','10000000-0000-0000-0000-000000000011','console','concurrent-a'),
      ('20000000-0000-0000-0000-000000000012','10000000-0000-0000-0000-000000000012','console','concurrent-b');
    create trigger revision_concurrency_audit after update on waldo.owners for each row
      when (old.admission_revision is distinct from new.admission_revision)
      execute function public.revision_concurrency_audit();`);
  const session = input => new Promise((resolve, reject) => {
    const child = spawn('docker', ['--host', endpoint, 'exec', '-i', '--user', 'postgres', name,
      'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-At']);
    let stderr = '';
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.stdout.resume();
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
    child.stdin.end(input);
  });
  const transferSession = (presence, first, second) => Array.from({length: 10}, () => `begin;
    set local statement_timeout='10s'; set local role service_role;
    update waldo.presences set owner_id='10000000-0000-0000-0000-0000000000${first}' where subject='concurrent-${presence}';
    select pg_sleep(0.02);
    update waldo.presences set owner_id='10000000-0000-0000-0000-0000000000${second}' where subject='concurrent-${presence}';
    commit;`).join('\n');
  const lifecycleSession = Array.from({length: 10}, () => `begin;
    set local statement_timeout='10s'; set local role service_role;
    update waldo.owners set state='suspended' where do_name='concurrent-a';
    select pg_sleep(0.02);
    update waldo.owners set state='active' where do_name='concurrent-a'; commit;`).join('\n');
  const outcomes = await Promise.allSettled([
    session(transferSession('a','12','11')), session(transferSession('b','11','12')), session(lifecycleSession),
  ]);
  for (const result of outcomes) if (result.status === 'rejected') throw result.reason;
  const concurrency = sql(`select count(*)=100 and count(distinct new_revision)=100
    and bool_and(new_revision > old_revision) from public.revision_concurrency_audit;`).trim();
  if (concurrency !== 't') throw new Error('concurrent custody mutations lost, duplicated or nonmonotonic');
  console.log('PASS concurrency: 40 opposite presence transfers and 20 owner lifecycle changes; 100 unique monotonic owner revisions, no deadlocks.');
  const beforeRollback = sql("select admission_revision from waldo.owners where do_name='concurrent-a';").trim();
  const atomic = sql(`begin;
    update waldo.presences set subject='rollback-subject' where subject='concurrent-a'; rollback;
    select p.subject='concurrent-a' and o.admission_revision=${beforeRollback}
      from waldo.presences p join waldo.owners o on o.id=p.owner_id where p.subject='concurrent-a';`).trim().split('\n').at(-1);
  if (atomic !== 't') throw new Error('rolled-back presence mutation leaked custody revision');
  console.log('PASS atomic rollback: presence and owner epoch roll back together; allocation gaps are harmless.');

} finally {
  for (const id of containers()) run(['rm', '-f', '-v', id]);
  for (const id of networks()) run(['network', 'rm', id]);
  if (containers().length || networks().length) throw new Error('fixture disposal not proved');
  console.log('PASS disposal: zero owned labeled containers/networks; no hosted URL accepted.');
}
