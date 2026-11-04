begin;
create extension if not exists pgtap with schema extensions;
select plan(13);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
insert into auth.users (id,email) values
 ('00000000-0000-0000-0000-0000000000d1','uninvited@test.invalid'),
 ('00000000-0000-0000-0000-0000000000d2','invited@test.invalid'),
 ('00000000-0000-0000-0000-0000000000d3','other@test.invalid');
insert into waldo.owners(do_name,email,bootstrap_claimable) values ('seeded-do','seeded@test.invalid',true);
insert into waldo.invites(code_hash,email,expires_at) values (repeat('a',64),'invited@test.invalid',now()+interval '14 days');
select is(waldo.signin_allowed('uninvited@test.invalid',pg_temp.at(),pg_temp.sig('signin.uninvited@test.invalid.'),''),false,'uninvited address cannot request an OTP');
select is(waldo.signin_allowed('invited@test.invalid',pg_temp.at(),pg_temp.sig('signin.invited@test.invalid.'||repeat('a',64)),repeat('a',64)),true,'invite code and matching email admit an OTP');
select is(waldo.signin_allowed('other@test.invalid',pg_temp.at(),pg_temp.sig('signin.other@test.invalid.'||repeat('a',64)),repeat('a',64)),false,'code cannot admit another email');
select is(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000d1','uninvited@test.invalid',pg_temp.at(),pg_temp.sig('owner.00000000-0000-0000-0000-0000000000d1.uninvited@test.invalid.+14155550100.'),'+14155550100',''),null::text,'uninvited verified Auth user cannot provision');
select is((select count(*) from waldo.owners where email='uninvited@test.invalid'),0::bigint,'uninvited call leaves no owner');
select is(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000d2','invited@test.invalid',pg_temp.at(),pg_temp.sig('owner.00000000-0000-0000-0000-0000000000d2.invited@test.invalid.+14155550101.'||repeat('a',64)),'+14155550101',repeat('a',64)) like 'owner-%',true,'code provisions owner');
select is((select used_by is not null from waldo.invites where code_hash=repeat('a',64)),true,'only spent code gets attribution');
select is(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000d3','other@test.invalid',pg_temp.at(),pg_temp.sig('owner.00000000-0000-0000-0000-0000000000d3.other@test.invalid.+14155550102.'||repeat('a',64)),'+14155550102',repeat('a',64)),null::text,'spent code cannot be replayed for another owner');
select is(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000d2','invited@test.invalid',pg_temp.at(),pg_temp.sig('owner.00000000-0000-0000-0000-0000000000d2.invited@test.invalid..'),null,'') like 'owner-%',true,'existing bound owner can return without code or phone');
select is(waldo.signin_allowed('seeded@test.invalid',pg_temp.at(),pg_temp.sig('signin.seeded@test.invalid.'),''),true,'marked bootstrap owner can request OTP');
select is(waldo.signin_allowed('unmarked@test.invalid',pg_temp.at(),pg_temp.sig('signin.unmarked@test.invalid.'),''),false,'unmarked email cannot request OTP');
select throws_ok($$select waldo.signin_allowed('uninvited@test.invalid',pg_temp.at(),'forged','')$$,'42501','unsigned router call','forged gate signature refused');
select is((select phone_verified_at from waldo.owners where email='invited@test.invalid'),null,'phone remains unverified');
select * from finish();
rollback;
