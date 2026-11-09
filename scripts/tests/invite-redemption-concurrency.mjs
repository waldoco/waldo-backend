// Local-only regression against the migrated Sept28 atomic redemption contract. The named
// Docker container supplies schema only; all fixture rows live in a new disposable database.
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const container = process.argv[2];
if (!container || !/^[a-zA-Z0-9_-]+$/.test(container)) throw new Error('Pass a local PostgreSQL Docker container name. No hosted connection is supported.');
const database = `waldo_invite_race_${Date.now()}`;
const command = (args, options = {}) => {
  try { return execFileSync('docker', ['exec', '-i', container, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options }); }
  catch (error) { throw new Error(`Local fixture command failed (${args[0]}, exit ${error.status ?? 'unavailable'}): ${String(error.stderr ?? '').slice(0, 300)}`); }
};
const sql = (text) => command(['psql', '-U', 'supabase_admin', '-d', database, '-XAt', '-v', 'ON_ERROR_STOP=1'], { input: text });
command(['createdb', '-U', 'supabase_admin', database]);
try {
  const schema = command(['pg_dump', '-U', 'supabase_admin', '-d', 'postgres', '--schema-only', '--no-owner']);
  sql(schema);
  const eligibility = sql(readFileSync(new URL('../../supabase/tests/waldo_invite_chain.sql', import.meta.url), 'utf8'));
  assert.ok(eligibility.includes('1..43'), 'all canonical invite assertions must execute');
  assert.ok(!/^not ok/m.test(eligibility), eligibility);
  assert.equal((eligibility.match(/^ok /gm) ?? []).length, 43, 'canonical eligibility assertion count');
  console.log('PASS: 43 canonical invite/active-member eligibility assertions in an isolated local database.');
  sql(`delete from vault.secrets where name='waldo_router_hmac'; select vault.create_secret('synthetic-invite-race-secret','waldo_router_hmac');
    insert into auth.users(id,email) values ('00000000-0000-0000-0000-0000000000a1','race@test.invalid');
    insert into waldo.owners(do_name,email,is_admin) values ('race-root','root@test.invalid',true);
    insert into waldo.invites(code_hash,email,issued_by,expires_at) values (repeat('a',64),'race@test.invalid',(select id from waldo.owners where do_name='race-root'),now()+interval '1 day');`);
  const redeem = `set application_name='waldo_invite_race_first'; begin;
    select waldo.owner_for_auth('00000000-0000-0000-0000-0000000000a1','race@test.invalid',extract(epoch from now())::bigint,
      encode(extensions.hmac(extract(epoch from now())::bigint::text||'.owner.00000000-0000-0000-0000-0000000000a1.race@test.invalid.+14155550100.'||repeat('a',64),'synthetic-invite-race-secret','sha256'),'hex'),'+14155550100',repeat('a',64));
    select pg_sleep(5); commit;`;
  const run = promisify(execFile);
  const redeemCommand = ['exec', '-i', container, 'psql', '-U', 'supabase_admin', '-d', database, '-XAt', '-v', 'ON_ERROR_STOP=1', '-c', redeem];
  // The first transaction holds the invite row lock until after the sibling starts.
  const first = run('docker', redeemCommand);
  const deadline = Date.now() + 4000;
  while (sql("select exists(select 1 from pg_stat_activity where datname=current_database() and application_name='waldo_invite_race_first' and wait_event='PgSleep');").trim() !== 't') {
    assert.ok(Date.now() < deadline, 'first transaction must hold its redeemed invite before starting sibling');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const secondCommand = [...redeemCommand];
  secondCommand[secondCommand.length - 1] = redeem.replace('waldo_invite_race_first', 'waldo_invite_race_second').replace('pg_sleep(5)', 'pg_sleep(0)');
  const second = run('docker', secondCommand);
  let observedLock = false;
  while (Date.now() < deadline) {
    if (sql("select exists(select 1 from pg_stat_activity where datname=current_database() and application_name='waldo_invite_race_second' and wait_event_type='Lock');").trim() === 't') { observedLock = true; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(observedLock, 'sibling redemption must actually overlap and wait on the first transaction');
  await Promise.all([first, second]);
  assert.equal(sql("select count(*) from waldo.owners where email='race@test.invalid';").trim(), '1');
  assert.equal(sql("select count(*) from waldo.invites where email='race@test.invalid' and used_at is not null and used_by is not null;").trim(), '1');
  assert.equal(sql("select phone_verified_at is null from waldo.owners where email='race@test.invalid';").trim(), 't');
  console.log('PASS: overlapping canonical redemptions leave one owner and one used invite; collected phone remains unverified. Schema-only isolated local fixture, not new signup readiness.');
} finally {
  command(['dropdb', '-U', 'supabase_admin', database]);
}
