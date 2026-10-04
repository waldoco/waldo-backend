begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('trace-fixture-router', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$
  select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'trace-fixture-router', 'sha256'), 'hex')
$$;
insert into auth.users(id, email, email_confirmed_at) values
  ('70000000-0000-0000-0000-000000000001', 'trace-a@test.invalid', now()),
  ('70000000-0000-0000-0000-000000000002', 'trace-b@test.invalid', now());
insert into waldo.owners(id, auth_user_id, do_name, email) values
  ('71000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000001', 'trace-owner-a', 'trace-a@test.invalid'),
  ('71000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000002', 'trace-owner-b', 'trace-b@test.invalid');
insert into waldo.presences(owner_id, provider, subject) values
  ('71000000-0000-0000-0000-000000000001', 'telegram', 'trace-subject-a'),
  ('71000000-0000-0000-0000-000000000002', 'telegram', 'trace-subject-b');
create function pg_temp.route(which text) returns jsonb language sql as $$
  select to_jsonb(r) from waldo.route_presence('telegram', which, pg_temp.at(), pg_temp.sig('route.telegram.' || which)) r
$$;
select is(pg_temp.route('trace-subject-a')->>'owner_id', '71000000-0000-0000-0000-000000000001', 'canonical owner is not a channel or DO label');
select is(pg_temp.route('trace-subject-a')->>'owner_email', 'trace-a@test.invalid', 'verified account email is filterable');
select is(pg_temp.route('trace-subject-b')->>'owner_email', 'trace-b@test.invalid', 'other subject resolves its own verified email');
select is((select array_agg(k order by k) from jsonb_object_keys(pg_temp.route('trace-subject-a')) k),
  array['do_name','owner_email','owner_id','subject','timezone']::text[], 'routing projects only intended identity fields');
create temporary table trace_revision as select admission_revision from waldo.owners where do_name='trace-owner-a';
update auth.users set email='trace-new@test.invalid' where id='70000000-0000-0000-0000-000000000001';
select is(pg_temp.route('trace-subject-a')->>'owner_email', null::text, 'Auth mismatch removes stale email');
update waldo.owners set email='trace-new@test.invalid' where do_name='trace-owner-a';
select is(pg_temp.route('trace-subject-a')->>'owner_email', 'trace-new@test.invalid', 'next inbound lookup uses changed confirmed email');
select is((select admission_revision from waldo.owners where do_name='trace-owner-a'),
  (select admission_revision from trace_revision), 'email refresh does not depend on admission revision change');
update auth.users set email_confirmed_at=null where id='70000000-0000-0000-0000-000000000001';
select is(pg_temp.route('trace-subject-a')->>'owner_email', null::text, 'unconfirmed account email is unavailable');
select is(pg_temp.route('unknown-subject'), null::jsonb, 'unknown sender has no inferred identity');
select throws_ok($$select * from waldo.route_presence('telegram','trace-subject-a',pg_temp.at(),'forged')$$,
  '42501', 'unsigned router call', 'email projection does not weaken routing authentication');
select ok(has_function_privilege('anon', 'waldo.route_presence(text,text,bigint,text)', 'execute'), 'existing signed-only entry remains callable');
select ok(not exists(select 1 from pg_proc p, lateral aclexplode(p.proacl) a
  where p.oid='waldo.route_presence(text,text,bigint,text)'::regprocedure and a.grantee=0), 'no PUBLIC execution privilege introduced');
select * from finish();
rollback;
