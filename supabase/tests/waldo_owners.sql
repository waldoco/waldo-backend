begin;
create extension if not exists pgtap with schema extensions;
select plan(13);
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.sig(msg text, at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@test.invalid'),
  ('00000000-0000-0000-0000-00000000000b', 'b@test.invalid');
insert into waldo.owners (id, auth_user_id, do_name) values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'do-a'),
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'do-b');
insert into waldo.owner_settings (owner_id) values ('10000000-0000-0000-0000-00000000000a'), ('10000000-0000-0000-0000-00000000000b');
insert into waldo.presences (owner_id, provider, subject) values ('10000000-0000-0000-0000-00000000000b', 'telegram', '222');
insert into waldo.link_codes (code_hash, owner_id, provider, expires_at) values
  ('h-a', '10000000-0000-0000-0000-00000000000a', 'telegram', now() + interval '10 minutes'),
  ('h-old', '10000000-0000-0000-0000-00000000000a', 'telegram', now() - interval '1 minute'),
  ('h-steal', '10000000-0000-0000-0000-00000000000a', 'telegram', now() + interval '10 minutes');

select is((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'waldo' and c.relkind = 'r' and c.relrowsecurity and c.relforcerowsecurity), (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'waldo' and c.relkind = 'r'), 'RLS is forced on every waldo table');

select is(waldo.redeem_link_code('h-old', 'telegram', '111'), null, 'an expired code binds nothing');
select is(waldo.redeem_link_code('h-a', 'telegram', '111'), '10000000-0000-0000-0000-00000000000a'::uuid, 'a fresh code binds the presence');
select is(waldo.redeem_link_code('h-a', 'telegram', '111'), null, 'a code works once');
select throws_ok($$ select waldo.redeem_link_code('h-steal', 'telegram', '222') $$, 'P0001', 'presence already linked to another owner', 'a code cannot take a subject another owner holds');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
select is((select array_agg(do_name) from waldo.owners), array['do-a'], 'owner A sees only their own owner row');
select is((select count(*) from waldo.presences where owner_id = '10000000-0000-0000-0000-00000000000b'), 0::bigint, 'owner A cannot see owner B presences');
update waldo.owner_settings set timezone = 'Asia/Kolkata' where owner_id = '10000000-0000-0000-0000-00000000000b';
select throws_ok($$ select count(*) from waldo.link_codes $$, '42501', null, 'link codes are service-only');
reset role;
select is((select timezone from waldo.owner_settings where owner_id = '10000000-0000-0000-0000-00000000000b'), 'UTC', 'owner A cannot change owner B settings');

select is((select do_name from waldo.route_presence('telegram', '222', extract(epoch from now())::bigint, pg_temp.sig('route.telegram.222', extract(epoch from now())::bigint))), 'do-b', 'a signed route call resolves the owner');
select throws_ok($$ select * from waldo.route_presence('telegram', '222', extract(epoch from now())::bigint, 'forged') $$, '42501', 'unsigned router call', 'a forged signature is refused');
select throws_ok($$ select * from waldo.route_presence('telegram', '222', extract(epoch from now())::bigint - 900, pg_temp.sig('route.telegram.222', extract(epoch from now())::bigint - 900)) $$, '42501', 'unsigned router call', 'a stale signature is refused');
set local role anon;
select throws_ok($$ select * from waldo.owners $$, '42501', null, 'the publishable key reads no waldo table');
reset role;
select * from finish();
rollback;
