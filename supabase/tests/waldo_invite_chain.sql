begin;
create extension if not exists pgtap with schema extensions;
select plan(43);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
insert into auth.users (id,email) values
 ('00000000-0000-0000-0000-0000000000a1','one@test.invalid'),
 ('00000000-0000-0000-0000-0000000000a2','other@test.invalid'),
 ('00000000-0000-0000-0000-0000000000a3','expired@test.invalid');
insert into waldo.owners(do_name,email,is_admin) values ('root-do','root@test.invalid',true),('ordinary-do','ordinary@test.invalid',false);
select is(waldo.signin_allowed('one@test.invalid',pg_temp.at(),pg_temp.sig('signin.one@test.invalid.'),''),false,'unknown address denied without code');
select is(waldo.admin_invite('root-do','one@test.invalid',pg_temp.at(),pg_temp.sig('invite.root-do.one@test.invalid.'||repeat('a',64)),repeat('a',64)),true,'admin can issue root code');
select is(waldo.admin_invite('ordinary-do','other@test.invalid',pg_temp.at(),pg_temp.sig('invite.ordinary-do.other@test.invalid.'||repeat('b',64)),repeat('b',64)),false,'ordinary owner cannot issue root code');
select is(waldo.signin_allowed('one@test.invalid',pg_temp.at(),pg_temp.sig('signin.one@test.invalid.'||repeat('a',64)),repeat('a',64)),true,'correct code and email admit OTP');
select is(waldo.signin_allowed('other@test.invalid',pg_temp.at(),pg_temp.sig('signin.other@test.invalid.'||repeat('a',64)),repeat('a',64)),false,'code cannot move to another email');
select is(waldo.signin_allowed('one@test.invalid',pg_temp.at(),pg_temp.sig('signin.one@test.invalid.'||repeat('b',64)),repeat('b',64)),false,'wrong code denied');
select is(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000a1','one@test.invalid',pg_temp.at(),pg_temp.sig('owner.00000000-0000-0000-0000-0000000000a1.one@test.invalid..'||repeat('a',64)),'',repeat('a',64)),null::text,'email proof with empty phone cannot provision');
select is((select used_at from waldo.invites where code_hash=repeat('a',64)),null::timestamptz,'pending signup leaves invite unconsumed');
select is((select count(*) from waldo.owners where email='one@test.invalid'),0::bigint,'pending signup leaves no owner');
insert into waldo.invites(code_hash,email,issued_by,expires_at,revoked_at) values (repeat('f',64),'expired@test.invalid',(select id from waldo.owners where do_name='root-do'),now()+interval '1 day',now());
select is(waldo.signin_allowed('expired@test.invalid',pg_temp.at(),pg_temp.sig('signin.expired@test.invalid.'||repeat('f',64)),repeat('f',64)),false,'revoked code cannot request OTP');
select is(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000a3','expired@test.invalid',pg_temp.at(),pg_temp.sig('owner.00000000-0000-0000-0000-0000000000a3.expired@test.invalid.+14155550103.'||repeat('f',64)),'+14155550103',repeat('f',64)),null::text,'revoked code cannot provision');
select is(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000a1','one@test.invalid',pg_temp.at(),pg_temp.sig('owner.00000000-0000-0000-0000-0000000000a1.one@test.invalid.+14155550101.'||repeat('a',64)),'+14155550101',repeat('a',64)) like 'owner-%',true,'correct code provisions owner');
select is((select count(*) from waldo.invites where code_hash=repeat('a',64) and used_at is not null and used_by is not null),1::bigint,'redemption stamped only one invite');
select is(waldo.signin_allowed('one@test.invalid',pg_temp.at(),pg_temp.sig('signin.one@test.invalid.'),''),true,'bound owner can sign in again without code');
select is(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000a1','one@test.invalid',pg_temp.at(),pg_temp.sig('owner.00000000-0000-0000-0000-0000000000a1.one@test.invalid..'),null,'') like 'owner-%',true,'bound identity remains idempotent');
select is(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000a2','other@test.invalid',pg_temp.at(),pg_temp.sig('owner.00000000-0000-0000-0000-0000000000a2.other@test.invalid.+14155550102.'||repeat('a',64)),'+14155550102',repeat('a',64)),null::text,'spent code cannot provision another');
select is(waldo.issue_member_invite('root-do','other@test.invalid',repeat('b',64),pg_temp.at(),pg_temp.sig('memberinvite.root-do.other@test.invalid.'||repeat('b',64))),true,'member can invite an email');
select is(waldo.issue_member_invite('root-do','other@test.invalid',repeat('c',64),pg_temp.at(),pg_temp.sig('memberinvite.root-do.other@test.invalid.'||repeat('c',64))),false,'duplicate live invitation refused');
select is(waldo.issue_member_invite('root-do','root@test.invalid',repeat('d',64),pg_temp.at(),pg_temp.sig('memberinvite.root-do.root@test.invalid.'||repeat('d',64))),false,'existing owner cannot be re-invited');
select is(waldo.issue_member_invite('root-do','bad@test.invalid','not-a-hash',pg_temp.at(),pg_temp.sig('memberinvite.root-do.bad@test.invalid.not-a-hash')),false,'non-hash code rejected');
select is(waldo.signin_allowed('other@test.invalid',pg_temp.at(),pg_temp.sig('signin.other@test.invalid.'||repeat('b',64)),repeat('b',64)),true,'member-issued code admits scoped email');
select is(jsonb_array_length(waldo.member_invites('root-do',pg_temp.at(),pg_temp.sig('memberinvites.root-do'))),3,'issuer sees own admin and member invites');
select is(jsonb_array_length(waldo.member_invites('ordinary-do',pg_temp.at(),pg_temp.sig('memberinvites.ordinary-do'))),0,'other member sees no root invites');
select is((waldo.member_invites('root-do',pg_temp.at(),pg_temp.sig('memberinvites.root-do'))::text like '%'||repeat('b',64)||'%'),false,'list never exposes code hash');
update waldo.invites set expires_at=now()-interval '1 second' where code_hash=repeat('b',64);
select is(waldo.signin_allowed('other@test.invalid',pg_temp.at(),pg_temp.sig('signin.other@test.invalid.'||repeat('b',64)),repeat('b',64)),false,'expired code cannot request OTP');
select is(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000a2','other@test.invalid',pg_temp.at(),pg_temp.sig('owner.00000000-0000-0000-0000-0000000000a2.other@test.invalid.+14155550102.'||repeat('b',64)),'+14155550102',repeat('b',64)),null::text,'expired code cannot provision');
-- Five per member is a lifetime issuance cap, enforced on the issuer row lock.
select is(waldo.issue_member_invite('ordinary-do','p1@test.invalid',repeat('1',64),pg_temp.at(),pg_temp.sig('memberinvite.ordinary-do.p1@test.invalid.'||repeat('1',64))),true,'member invite 1');
select is(waldo.issue_member_invite('ordinary-do','p2@test.invalid',repeat('2',64),pg_temp.at(),pg_temp.sig('memberinvite.ordinary-do.p2@test.invalid.'||repeat('2',64))),true,'member invite 2');
select is(waldo.issue_member_invite('ordinary-do','p3@test.invalid',repeat('3',64),pg_temp.at(),pg_temp.sig('memberinvite.ordinary-do.p3@test.invalid.'||repeat('3',64))),true,'member invite 3');
select is(waldo.issue_member_invite('ordinary-do','p4@test.invalid',repeat('4',64),pg_temp.at(),pg_temp.sig('memberinvite.ordinary-do.p4@test.invalid.'||repeat('4',64))),true,'member invite 4');
select is(waldo.issue_member_invite('ordinary-do','p5@test.invalid',repeat('5',64),pg_temp.at(),pg_temp.sig('memberinvite.ordinary-do.p5@test.invalid.'||repeat('5',64))),true,'member invite 5');
select is(waldo.issue_member_invite('ordinary-do','p6@test.invalid',repeat('6',64),pg_temp.at(),pg_temp.sig('memberinvite.ordinary-do.p6@test.invalid.'||repeat('6',64))),false,'sixth invite refused even when earlier invites expire');
select throws_ok($$select waldo.issue_member_invite('root-do','x@test.invalid',repeat('e',64),pg_temp.at(),'forged')$$,'42501','unsigned router call','forged issuer call denied');
select is(has_function_privilege('service_role','waldo.issue_member_invite(text,text,text,bigint,text)','execute'),false,'service role not granted member issue');
select is(has_function_privilege('anon','waldo.issue_member_invite(text,text,text,bigint,text)','execute'),true,'signed runtime can issue');
select is((select count(*) from waldo.owners where email='other@test.invalid'),0::bigint,'expired code left no owner');
-- Existing member access is not invite validity; these calls execute canonical SQL.
insert into waldo.invites(code_hash,email,issued_by,expires_at,revoked_at) values
 (repeat('7',64),'one@test.invalid',(select id from waldo.owners where do_name='root-do'),now()-interval '1 day',null),
 (repeat('8',64),'one@test.invalid',(select id from waldo.owners where do_name='root-do'),now()+interval '1 day',now());
select is(waldo.signin_allowed('one@test.invalid',pg_temp.at(),pg_temp.sig('signin.one@test.invalid.'||repeat('9',64)),repeat('9',64)),true,'active member access ignores arbitrary invite hash');
select is(waldo.signin_allowed('one@test.invalid',pg_temp.at(),pg_temp.sig('signin.one@test.invalid.'||repeat('7',64)),repeat('7',64)),true,'active member access ignores expired invite hash');
select is(waldo.signin_allowed('one@test.invalid',pg_temp.at(),pg_temp.sig('signin.one@test.invalid.'||repeat('8',64)),repeat('8',64)),true,'active member access ignores revoked invite hash');
select is(waldo.signin_allowed('one@test.invalid',pg_temp.at(),pg_temp.sig('signin.one@test.invalid.'||repeat('a',64)),repeat('a',64)),true,'active member access ignores used invite hash');
select is(waldo.owner_for_auth('00000000-0000-0000-0000-0000000000a1','one@test.invalid',pg_temp.at(),pg_temp.sig('owner.00000000-0000-0000-0000-0000000000a1.one@test.invalid..'||repeat('9',64)),'',repeat('9',64)),(select do_name from waldo.owners where auth_user_id='00000000-0000-0000-0000-0000000000a1'),'existing identity resolves with empty phone and arbitrary invite, without a new owner');
select is((select used_at from waldo.invites where code_hash=repeat('7',64)),null::timestamptz,'member access leaves expired invite unused');
select is((select used_at from waldo.invites where code_hash=repeat('8',64)),null::timestamptz,'member access leaves revoked invite unused');
select * from finish();
rollback;
