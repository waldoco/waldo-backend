begin;
create extension if not exists pgtap with schema extensions;
select plan(19);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(extract(epoch from now())::bigint::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000c1', 'seeded@test.invalid'), ('00000000-0000-0000-0000-0000000000c2', 'invited@test.invalid'), ('00000000-0000-0000-0000-0000000000c3', 'stranger@test.invalid'), ('00000000-0000-0000-0000-0000000000c4', 'latephone@test.invalid'), ('00000000-0000-0000-0000-0000000000c6', 'unmarked@test.invalid');
insert into waldo.owners (do_name, email, bootstrap_claimable) values ('do-seeded', 'seeded@test.invalid', true);
insert into waldo.owners (do_name, email) values ('do-unmarked', 'unmarked@test.invalid');
insert into waldo.invites (code_hash, email, expires_at) values (repeat('a',64), 'invited@test.invalid', now()+interval '14 days'), (repeat('b',64), 'latephone@test.invalid', now()+interval '14 days');
-- regression fixture: an older invite for the same address, already used, never attributed
insert into waldo.invites (code_hash, email, used_at) values ('inv-old', 'invited@test.invalid', now() - interval '1 day');

select is(waldo.signin_allowed('seeded@test.invalid',pg_temp.at(),pg_temp.sig('signin.seeded@test.invalid.'),''),true,'a hand-marked bootstrap owner may sign in');
select is(waldo.signin_allowed('invited@test.invalid',pg_temp.at(),pg_temp.sig('signin.invited@test.invalid.'||repeat('a',64)),repeat('a',64)),true,'a current invite may request OTP');
select is(waldo.signin_allowed('stranger@test.invalid',pg_temp.at(),pg_temp.sig('signin.stranger@test.invalid.'),''),false,'uninvited stranger cannot request OTP');
select is(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000c1','seeded@test.invalid',pg_temp.at(),pg_temp.sig('owner.00000000-0000-0000-0000-0000000000c1.seeded@test.invalid..'),null,''),null::text,'bootstrap refuses empty phone');
select is((select bootstrap_claimable from waldo.owners where do_name='do-seeded'),true,'failed claim preserves bootstrap mark');
select is(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000c1','seeded@test.invalid',pg_temp.at(),pg_temp.sig('owner.00000000-0000-0000-0000-0000000000c1.seeded@test.invalid.+919000000010.'),'+919000000010',''),'do-seeded','marked owner binds once');
select is((select bootstrap_claimable from waldo.owners where do_name='do-seeded'),false,'successful claim consumes mark');
select is((select phone from waldo.owners where do_name='do-seeded'),'+919000000010','phone saved unverified');
select is(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000c2','invited@test.invalid',pg_temp.at(),pg_temp.sig('owner.00000000-0000-0000-0000-0000000000c2.invited@test.invalid..'||repeat('a',64)),null,repeat('a',64)),null::text,'missing phone cannot consume invite');
select is((select used_at from waldo.invites where code_hash=repeat('a',64)),null::timestamptz,'failed phone validation left invite unused');
select is(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000c2','invited@test.invalid',pg_temp.at(),pg_temp.sig('owner.00000000-0000-0000-0000-0000000000c2.invited@test.invalid.+919000000011.'||repeat('a',64)),'+919000000011',repeat('a',64)) like 'owner-%',true,'invited new member gets own DO');
select is((select used_by from waldo.invites where code_hash=repeat('a',64)),(select id from waldo.owners where email='invited@test.invalid'),'only matched code gets attribution');
select is((select used_by from waldo.invites where code_hash='inv-old'),null::uuid,'historical invite attribution untouched');
select is(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000c2','invited@test.invalid',pg_temp.at(),pg_temp.sig('owner.00000000-0000-0000-0000-0000000000c2.invited@test.invalid..'),null,'') like 'owner-%',true,'bound owner can sign in without a second code');
select is(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000c3','stranger@test.invalid',pg_temp.at(),pg_temp.sig('owner.00000000-0000-0000-0000-0000000000c3.stranger@test.invalid.+919000000012.'),'+919000000012',''),null::text,'stranger cannot provision');
select is((select count(*) from waldo.owners where email='stranger@test.invalid'),0::bigint,'no owner inserted for stranger');
select throws_ok($$select waldo.owner_for_auth('00000000-0000-0000-0000-0000000000c3','seeded@test.invalid',pg_temp.at(),'forged','+919000000012','')$$,'42501','unsigned router call','forged signature refused');
select is((select auth_user_id from waldo.owners where do_name='do-unmarked'),null::uuid,'unmarked row stays unbound');
select is(waldo.issue_link_code('do-seeded','hash-1',pg_temp.at(),pg_temp.sig('link.do-seeded.hash-1')),true,'bound owner can issue Telegram link code');
select * from finish();
rollback;
