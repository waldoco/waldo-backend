begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('synthetic-phone-router','waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$select floor(extract(epoch from clock_timestamp()))::bigint$$;
create function pg_temp.call(action text,payload jsonb) returns jsonb language sql as $$
 select waldo.signup_phone_transition(action,payload::text,pg_temp.at(),encode(extensions.hmac(pg_temp.at()::text||'.phoneproof.'||action||'.'||payload::text,'synthetic-phone-router','sha256'),'hex'))
$$;
create function pg_temp.binding(n integer,phone text default '+919876543210') returns jsonb language sql as $$select jsonb_build_object(
 'attempt',('10000000-0000-0000-0000-'||lpad(n::text,12,'0')),
 'authUser',('20000000-0000-0000-0000-'||lpad(n::text,12,'0')),
 'email','phone'||n||'@test.invalid','inviteHash',lpad(n::text,64,'a'),'phone',phone,
 'service','VA'||repeat('b',32),'expires',pg_temp.at()+899)
$$;
create function pg_temp.operation() returns jsonb language sql as $$select jsonb_build_object('operation','30000000-0000-0000-0000-000000000001')$$;
insert into auth.users(id,email,email_confirmed_at)
 select ('20000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'phone'||n||'@test.invalid',now() from generate_series(1,10) n;
insert into waldo.invites(code_hash,email,expires_at)
 select lpad(n::text,64,'a'),'phone'||n||'@test.invalid',now()+interval '1 day' from generate_series(1,10) n;
create temporary table phone_inputs(n integer primary key,p jsonb);
insert into phone_inputs select n,pg_temp.binding(n,case when n in (1,2) then '+919876543210' when n=10 then '+919876541010' else '+9198765432'||n end) from generate_series(1,10) n;
select is(has_table_privilege('anon','waldo.signup_phone_challenges','SELECT'),false,'anon cannot read proof rows');
select is(has_table_privilege('authenticated','waldo.signup_phone_challenges','INSERT'),false,'authenticated cannot write proofs');
select is(has_table_privilege('anon','waldo.signup_phone_budget','UPDATE'),false,'anon cannot reset budget');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='waldo.signup_phone_challenges'::regclass),'proof table forces RLS');
select throws_ok($$select waldo.signup_phone_transition('reserve_send','{}',pg_temp.at(),'bad')$$,'42501','unsigned router call','forged signature cannot reserve');
select throws_ok($$select waldo.signup_phone_transition('reserve_send','{}',null,null)$$,'42501','unsigned router call','null signature fails closed');
select is(pg_temp.call('reserve_send',(select p from phone_inputs where n=1)||pg_temp.operation())->>'kind','reserved','eligible confirmed email reserves before sending');
select is(pg_temp.call('reserve_send',(select p from phone_inputs where n=1)||pg_temp.operation())->>'kind','denied','parallel/replayed send reservation cannot send twice');
select is(pg_temp.call('reserve_send',(select p from phone_inputs where n=2)||pg_temp.operation())->>'kind','denied','same recipient is exclusive across identities');
select is(pg_temp.call('finish_send',(select p from phone_inputs where n=1)||pg_temp.operation()||jsonb_build_object('outcome','pending','sid','VE'||repeat('c',32)))->>'kind','pending','matching provider reference stored');
select is(pg_temp.call('reserve_send',(select p from phone_inputs where n=1)||pg_temp.operation())->>'kind','throttled','resend floor enforced durably');
select is(pg_temp.call('reserve_check',(select p from phone_inputs where n=1)||pg_temp.operation())#>>'{reference,phone}','+919876543210','check reserves only stored recipient');
select is(pg_temp.call('finish_check',(select p from phone_inputs where n=1)||pg_temp.operation()||jsonb_build_object('outcome','pending','sid','VE'||repeat('c',32)))->>'kind','pending','wrong code cannot approve');
select is((select proof_slots from waldo.signup_phone_budget where id),0,'definite wrong code releases success reservation');
select is(pg_temp.call('reserve_check',(select p from phone_inputs where n=1)||pg_temp.operation())->>'kind','reserved','retry after wrong code');
select is(pg_temp.call('finish_check',(select p from phone_inputs where n=1)||pg_temp.operation()||jsonb_build_object('outcome','approved','sid','VE'||repeat('c',32)))->>'kind','approved','matching approved result becomes durable evidence');
select is(pg_temp.call('finish_check',(select p from phone_inputs where n=1)||pg_temp.operation()||jsonb_build_object('outcome','approved','sid','VE'||repeat('c',32)))->>'kind','denied','approval finalization is one-use');
select is(pg_temp.call('reserve_check',(select p from phone_inputs where n=1)||pg_temp.operation())->>'kind','denied','approved challenge cannot be checked again');
select is((select used_at from waldo.invites where email='phone1@test.invalid'),null::timestamptz,'approval does not consume invite');
select is((select count(*) from waldo.owners where email='phone1@test.invalid'),0::bigint,'approval creates no owner');
select is(pg_temp.call('cancel',(select p from phone_inputs where n=1))->>'kind','canceled','cancel invalidates approved evidence');
select is(pg_temp.call('reserve_send',(select p from phone_inputs where n=2)||pg_temp.operation())->>'kind','denied','cancel preserves provider code quarantine');
select is(pg_temp.call('reserve_send',(select p from phone_inputs where n=3)||pg_temp.operation())->>'kind','reserved','second recipient can reserve');
select is(pg_temp.call('finish_send',(select p from phone_inputs where n=3)||pg_temp.operation()||jsonb_build_object('outcome','unknown','sid',''))->>'kind','unknown','uncertain send without SID is fenced');
select is(pg_temp.call('reserve_send',(select p from phone_inputs where n=3)||pg_temp.operation())->>'kind','denied','uncertain send is not automatically resent');
select is((select recipient_hold_until from waldo.signup_phone_challenges where email='phone3@test.invalid'),null::timestamptz,'unknown send holds recipient until reviewed reconciliation');
select is(pg_temp.call('reserve_send',(select p from phone_inputs where n=4)||pg_temp.operation())->>'kind','reserved','third recipient reserves');
update waldo.invites set revoked_at=now() where email='phone4@test.invalid';
select is(pg_temp.call('finish_send',(select p from phone_inputs where n=4)||pg_temp.operation()||jsonb_build_object('outcome','pending','sid','VE'||repeat('d',32)))->>'kind','denied','revocation during network request fences finalization');
select is(pg_temp.call('reserve_send',(select p from phone_inputs where n=5)||pg_temp.operation())->>'kind','reserved','expiry fixture reserves');
update waldo.signup_phone_challenges set phone_expires=clock_timestamp() where email='phone5@test.invalid';
select is(pg_temp.call('finish_send',(select p from phone_inputs where n=5)||pg_temp.operation()||jsonb_build_object('outcome','pending','sid','VE'||repeat('d',32)))->>'kind','expired','exact deadline fences late response');
select is(pg_temp.call('reserve_send',(select p from phone_inputs where n=6)||pg_temp.operation())->>'kind','reserved','binding fixture reserves');
select is(pg_temp.call('finish_send',(select p||jsonb_build_object('phone','+14155550100') from phone_inputs where n=6)||pg_temp.operation()||jsonb_build_object('outcome','pending','sid','VE'||repeat('d',32)))->>'kind','denied','phone edit cannot finalize old attempt');
select is(pg_temp.call('finish_send',(select p from phone_inputs where n=6)||pg_temp.operation()||jsonb_build_object('outcome','pending','sid','VE'||repeat('d',32)))->>'kind','pending','original binding can finalize');
select is(pg_temp.call('reserve_check',(select p from phone_inputs where n=6)||pg_temp.operation())->>'kind','reserved','SID fixture reserves check');
select is(pg_temp.call('finish_check',(select p from phone_inputs where n=6)||pg_temp.operation()||jsonb_build_object('outcome','approved','sid','VE'||repeat('e',32)))->>'kind','unknown','foreign provider reference cannot approve');
update waldo.signup_phone_budget set sends=20 where id;
select is(pg_temp.call('reserve_send',(select p from phone_inputs where n=7)||pg_temp.operation())->>'kind','throttled','global pilot send cap fails before provider');
select is(pg_temp.call('reserve_send',(select p||jsonb_build_object('inviteHash',repeat('f',64)) from phone_inputs where n=8)||pg_temp.operation())->>'kind','denied','wrong invite denied independently of cap');
update auth.users set email_confirmed_at=null where email='phone8@test.invalid';
select is(pg_temp.call('reserve_send',(select p from phone_inputs where n=8)||pg_temp.operation())->>'kind','denied','unconfirmed email cannot reserve');
insert into waldo.owners(do_name,email,auth_user_id) values('phone-existing-owner','phone9@test.invalid','20000000-0000-0000-0000-000000000009');
select is(pg_temp.call('reserve_send',(select p from phone_inputs where n=9)||pg_temp.operation())->>'kind','denied','existing member excluded from new signup proof');
select is(waldo.signin_allowed('phone9@test.invalid',pg_temp.at(),encode(extensions.hmac(pg_temp.at()::text||'.signin.phone9@test.invalid.','synthetic-phone-router','sha256'),'hex'),''),true,'existing member email login eligibility preserved');
update waldo.signup_phone_budget set sends=6,checks=3,proof_slots=2 where id;
select is(pg_temp.call('reserve_send',(select p from phone_inputs where n=10)||pg_temp.operation())->>'kind','reserved','attempt limit fixture reserves');
select is(pg_temp.call('finish_send',(select p from phone_inputs where n=10)||pg_temp.operation()||jsonb_build_object('outcome','pending','sid','VE'||repeat('f',32)))->>'kind','pending','attempt limit fixture pending');
do $$begin for i in 1..5 loop
 perform pg_temp.call('reserve_check',(select p from phone_inputs where n=10)||pg_temp.operation());
 perform pg_temp.call('finish_check',(select p from phone_inputs where n=10)||pg_temp.operation()||jsonb_build_object('outcome','pending','sid','VE'||repeat('f',32)));
end loop; end$$;
select is(pg_temp.call('reserve_check',(select p from phone_inputs where n=10)||pg_temp.operation())->>'kind','throttled','five wrong checks exhaust local attempt budget');
select is(pg_temp.call('reserve_send',(select p from phone_inputs where n=7)||pg_temp.operation())->>'kind','reserved','concurrency fixture reserves');
select is(pg_temp.call('finish_send',(select p from phone_inputs where n=7)||pg_temp.operation()||jsonb_build_object('outcome','pending','sid','VE'||repeat('f',32)))->>'kind','pending','concurrency fixture pending');
update waldo.signup_phone_budget set checks=50 where id;
select is(pg_temp.call('reserve_check',(select p from phone_inputs where n=7)||pg_temp.operation())->>'kind','throttled','global check budget blocks before transport');
update waldo.signup_phone_budget set checks=8,proof_slots=10 where id;
select is(pg_temp.call('reserve_check',(select p from phone_inputs where n=7)||pg_temp.operation())->>'kind','throttled','potential-success reservations enforce proof ceiling');
update waldo.signup_phone_budget set proof_slots=2 where id;
update waldo.signup_phone_challenges set next_send=now()-interval '1 second' where email='phone7@test.invalid';
select is(pg_temp.call('reserve_send',(select p from phone_inputs where n=7)||jsonb_build_object('operation','30000000-0000-0000-0000-000000000003'))->>'kind','reserved','cooldown expiry reserves resend');
select is(pg_temp.call('finish_send',(select p from phone_inputs where n=7)||pg_temp.operation()||jsonb_build_object('outcome','pending','sid','VE'||repeat('f',32)))->>'kind','denied','old send cannot finalize newer resend');
select is(pg_temp.call('finish_send',(select p from phone_inputs where n=7)||jsonb_build_object('operation','30000000-0000-0000-0000-000000000003','outcome','pending','sid','VE'||repeat('f',32)))->>'kind','pending','current resend accepts same provider reference');
select is(pg_temp.call('reserve_check',(select p from phone_inputs where n=7)||pg_temp.operation())->>'kind','reserved','check reserves before cancellation');
select is(pg_temp.call('cancel',(select p from phone_inputs where n=7))->>'kind','canceled','cancel in-flight check');
select is(pg_temp.call('finish_check',(select p from phone_inputs where n=7)||pg_temp.operation()||jsonb_build_object('outcome','approved','sid','VE'||repeat('f',32)))->>'kind','denied','late approval after cancel cannot recreate proof');
select is((select approved_at from waldo.signup_phone_challenges where email='phone7@test.invalid'),null::timestamptz,'canceled check has no approved timestamp');
delete from auth.users where email='phone3@test.invalid';
select is(pg_temp.call('reserve_send',(select p||jsonb_build_object('phone','+91987654323') from phone_inputs where n=2)||pg_temp.operation())->>'kind','denied','identity removal cannot release unknown recipient quarantine');
select * from finish();
rollback;
