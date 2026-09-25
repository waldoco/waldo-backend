begin;
create extension if not exists pgtap with schema extensions;
select plan(7);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
insert into waldo.owners (id, do_name) values ('30000000-0000-0000-0000-00000000000a', 'do-a'), ('30000000-0000-0000-0000-00000000000b', 'do-b');
insert into waldo.presences (owner_id, provider, subject, state) values
  ('30000000-0000-0000-0000-00000000000a', 'telegram', 'tg-1', 'unlinked'),
  ('30000000-0000-0000-0000-00000000000b', 'telegram', 'tg-1', 'active');

select is(waldo.assert_channel_presence('do-b', 'telegram', 'tg-1', pg_temp.at(), pg_temp.sig('presence.do-b.telegram.tg-1')), true, 'the current owner passes the send-time check');
select is(waldo.assert_channel_presence('do-a', 'telegram', 'tg-1', pg_temp.at(), pg_temp.sig('presence.do-a.telegram.tg-1')), false, 'the rebound old owner fails closed');
select is(waldo.assert_channel_presence('do-a', 'telegram', 'tg-2', pg_temp.at(), pg_temp.sig('presence.do-a.telegram.tg-2')), false, 'a never-linked subject fails closed');
select is(waldo.assert_channel_presence('do-b', 'whatsapp', 'tg-1', pg_temp.at(), pg_temp.sig('presence.do-b.whatsapp.tg-1')), false, 'the wrong provider fails closed');
select throws_ok($$ select waldo.assert_channel_presence('do-b', 'telegram', 'tg-1', pg_temp.at(), 'forged') $$, '42501', 'unsigned router call', 'a forged check is refused');

update waldo.owners set state = 'suspended' where id = '30000000-0000-0000-0000-00000000000b';
select is(waldo.assert_channel_presence('do-b', 'telegram', 'tg-1', pg_temp.at(), pg_temp.sig('presence.do-b.telegram.tg-1')), false, 'a suspended owner fails closed even with an active row');
update waldo.owners set state = 'active' where id = '30000000-0000-0000-0000-00000000000b';
update waldo.presences set state = 'unlinked', unlinked_at = now() where owner_id = '30000000-0000-0000-0000-00000000000b';
select is(waldo.assert_channel_presence('do-b', 'telegram', 'tg-1', pg_temp.at(), pg_temp.sig('presence.do-b.telegram.tg-1')), false, 'after unlink the last owner fails closed too');
select * from finish();
rollback;
