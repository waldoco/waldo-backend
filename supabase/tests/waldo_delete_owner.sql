begin;
create extension if not exists pgtap with schema extensions;
select plan(6);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.sig(msg text, at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;

insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000c', 'c@test.invalid');
insert into waldo.owners (id, auth_user_id, do_name) values ('10000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000c', 'do-c');

-- The owner carries one of every referencing row the delete must clear: a vault-backed
-- connection, a connect ticket, a console session and a health log (all no-cascade FKs),
-- plus the cascade-side rows (presences, owner_settings, link_codes).
select vault.create_secret('dead-token', 'conn_secret_c');
insert into waldo.connections (owner_id, provider, account, secret_id)
  select '10000000-0000-0000-0000-00000000000c', 'google', 'c@test.invalid', id from vault.secrets where name = 'conn_secret_c';
insert into waldo.connect_sessions (owner_id, provider, channel, ticket_hash, expires_at)
  values ('10000000-0000-0000-0000-00000000000c', 'google', 'console', 'ticket-c', now() + interval '30 minutes');
insert into waldo.console_sessions (owner_id, session_hash)
  values ('10000000-0000-0000-0000-00000000000c', 'sess-c');
insert into waldo.health_logs (owner_id, kind, logged_at, source, payload)
  values ('10000000-0000-0000-0000-00000000000c', 'meal', now(), 'console', '{}');
insert into waldo.presences (owner_id, provider, subject) values ('10000000-0000-0000-0000-00000000000c', 'telegram', '333');
insert into waldo.owner_settings (owner_id) values ('10000000-0000-0000-0000-00000000000c');
insert into waldo.link_codes (code_hash, owner_id, provider, expires_at) values ('h-c', '10000000-0000-0000-0000-00000000000c', 'telegram', now() + interval '10 minutes');

select throws_ok(
  $$ select waldo.delete_owner('do-c', extract(epoch from now())::bigint, 'forged') $$,
  '42501', 'unsigned router call', 'a forged signature is refused');

select is(waldo.delete_owner('do-c', extract(epoch from now())::bigint, pg_temp.sig('delown.do-c', extract(epoch from now())::bigint)),
  true, 'a signed delete succeeds with every referencing table populated');

select is((select count(*) from waldo.owners where id = '10000000-0000-0000-0000-00000000000c'), 0::bigint, 'the owner row is gone');
select is((select count(*) from waldo.connect_sessions where owner_id = '10000000-0000-0000-0000-00000000000c')
        + (select count(*) from waldo.console_sessions where owner_id = '10000000-0000-0000-0000-00000000000c')
        + (select count(*) from waldo.health_logs where owner_id = '10000000-0000-0000-0000-00000000000c')
        + (select count(*) from waldo.connections where owner_id = '10000000-0000-0000-0000-00000000000c'),
  0::bigint, 'no-cascade referencing rows are gone');
select is((select count(*) from waldo.presences where owner_id = '10000000-0000-0000-0000-00000000000c')
        + (select count(*) from waldo.owner_settings where owner_id = '10000000-0000-0000-0000-00000000000c')
        + (select count(*) from waldo.link_codes where owner_id = '10000000-0000-0000-0000-00000000000c'),
  0::bigint, 'cascade-side rows are gone');
select is((select count(*) from vault.secrets where name = 'conn_secret_c'), 0::bigint, 'the vault secret behind the connection is gone');

select * from finish();
rollback;
