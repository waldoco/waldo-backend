// Local-only regression for the open sign-up cap under concurrency: two joins race for the last place of the day and
// exactly one is admitted. The named Docker container supplies schema only; all fixture rows live in a new disposable
// database, which also receives the open sign-up migration in case the container's own database predates it.
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const container = process.argv[2];
if (!container || !/^[a-zA-Z0-9_-]+$/.test(container)) throw new Error('Pass a local PostgreSQL Docker container name. No hosted connection is supported.');
const database = `waldo_open_signup_race_${Date.now()}`;
const command = (args, options = {}) => {
  try { return execFileSync('docker', ['exec', '-i', container, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options }); }
  catch (error) { throw new Error(`Local fixture command failed (${args[0]}, exit ${error.status ?? 'unavailable'}): ${String(error.stderr ?? '').slice(0, 300)}`); }
};
const sql = (text) => command(['psql', '-U', 'supabase_admin', '-d', database, '-XAt', '-v', 'ON_ERROR_STOP=1'], { input: text });
const migration = readFileSync(new URL('../../supabase/migrations/20261101060000_waldo_open_signup_capped.sql', import.meta.url), 'utf8');
command(['createdb', '-U', 'supabase_admin', database]);
try {
  sql(command(['pg_dump', '-U', 'supabase_admin', '-d', 'postgres', '--schema-only', '--no-owner']));
  if (sql("select to_regprocedure('waldo.signup_owner_open(uuid,text,text,text,text,integer,integer,bigint,text)') is null;").trim() === 't') sql(migration);
  sql(`delete from vault.secrets where name='waldo_router_hmac'; select vault.create_secret('synthetic-open-race-secret','waldo_router_hmac');
    insert into auth.users(id,email,email_confirmed_at) values
      ('00000000-0000-0000-0000-0000000000a1','first@test.invalid',now()),('00000000-0000-0000-0000-0000000000b1','second@test.invalid',now());
    insert into waldo.open_signup_days(day,admitted) values ((now() at time zone 'utc')::date, 1);`);
  // Daily cap 2 with one place taken: one place left for two joins.
  const join = (user, email, name, sleep) => `set application_name='${name}'; begin;
    select waldo.signup_owner_open('${user}','${email}','','','',2,80,extract(epoch from now())::bigint,
      encode(extensions.hmac(extract(epoch from now())::bigint::text||'.signup.open.${user}.${email}....2.80','synthetic-open-race-secret','sha256'),'hex'));
    select pg_sleep(${sleep}); commit;`;
  const run = promisify(execFile);
  const psql = (text) => run('docker', ['exec', '-i', container, 'psql', '-U', 'supabase_admin', '-d', database, '-XAt', '-v', 'ON_ERROR_STOP=1', '-c', text]);
  // The first join holds the server-wide lock, having taken the last place, until after the second starts.
  const first = psql(join('00000000-0000-0000-0000-0000000000a1', 'first@test.invalid', 'waldo_open_race_first', 5));
  const deadline = Date.now() + 4000;
  while (sql("select exists(select 1 from pg_stat_activity where datname=current_database() and application_name='waldo_open_race_first' and wait_event='PgSleep');").trim() !== 't') {
    assert.ok(Date.now() < deadline, 'first join must hold the lock before the second starts');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const second = psql(join('00000000-0000-0000-0000-0000000000b1', 'second@test.invalid', 'waldo_open_race_second', 0));
  let observedLock = false;
  while (Date.now() < deadline) {
    if (sql("select exists(select 1 from pg_stat_activity where datname=current_database() and application_name='waldo_open_race_second' and wait_event_type='Lock');").trim() === 't') { observedLock = true; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(observedLock, 'the second join must actually overlap and wait on the first');
  const [a, b] = await Promise.all([first, second]);
  assert.match(a.stdout, /"created": true/);
  assert.match(b.stdout, /"refused": "cap"/);
  assert.equal(sql("select count(*) from waldo.owners where admitted_via='open';").trim(), '1');
  assert.equal(sql("select admitted from waldo.open_signup_days;").trim(), '2');
  console.log('PASS: two overlapping open joins for the last place of the day admit exactly one owner; the other is refused at the cap.');
} finally {
  command(['dropdb', '-U', 'supabase_admin', database]);
}
