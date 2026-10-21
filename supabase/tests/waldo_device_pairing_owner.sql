begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
create function pg_temp.owned(o text, h text) returns uuid language sql as $$ select waldo.issue_device_pairing_code_owned(o,h,pg_temp.at(),pg_temp.sig('devpairowner.'||o||'.'||h)) $$;
create function pg_temp.redeem(h text, k text) returns table(device_id text, owner_id text) language sql as $$ select * from waldo.redeem_device_pairing(h,k,'Test Mac','machine_state_query',pg_temp.at(),pg_temp.sig('devredeem.'||h||'.'||k||'.'||encode(convert_to('Test Mac','UTF8'),'hex')||'.machine_state_query')) $$;
insert into waldo.owners(do_name,email) values ('owned-a','owned-a@test.invalid'),('owned-cap','owned-cap@test.invalid');

select is(has_function_privilege('anon','waldo.issue_device_pairing_code_owned(text,text,bigint,text)','execute'),true,'the signed runtime can mint (signature still required)');
select is(has_function_privilege('authenticated','waldo.issue_device_pairing_code_owned(text,text,bigint,text)','execute'),false,'signed-in users cannot mint directly');
select throws_ok($$select waldo.issue_device_pairing_code_owned('owned-a',repeat('a',64),pg_temp.at(),'forged')$$,'42501','unsigned router call','forged mint refused');
select throws_ok($$select waldo.issue_device_pairing_code_owned('owned-a',repeat('a',64),pg_temp.at(),pg_temp.sig('devpair.owned-a.'||repeat('a',64)))$$,'42501','unsigned router call','a boolean-mint signature cannot be replayed here');

select is(pg_temp.owned('owned-a',repeat('a',64)),(select id from waldo.owners where do_name='owned-a'),'mint returns the owner UUID');
select is(pg_temp.owned('owned-a','not-a-hash'),null,'malformed hash refused');
select is(pg_temp.owned('missing-owner',repeat('b',64)),null,'unknown owner refused');
select is(pg_temp.owned('owned-a',repeat('a',64)),null,'hash collision never overwrites');
select is((select owner_id from pg_temp.redeem(repeat('a',64),repeat('A',43))),(select id::text from waldo.owners where do_name='owned-a'),'redeem returns the same owner the code named');

update waldo.owners set state='suspended' where do_name='owned-a';
select is(pg_temp.owned('owned-a',repeat('c',64)),null,'suspended owner cannot mint');

select pg_temp.owned('owned-cap',repeat(n::text,64)) from generate_series(1,5) n;
select is((select count(*)::int from waldo.device_pairing_codes c join waldo.owners o on o.id=c.owner_id where o.do_name='owned-cap'),5,'five outstanding codes');
select is(pg_temp.owned('owned-cap',repeat('d',64)),null,'sixth outstanding code refused');

select * from finish();
rollback;
