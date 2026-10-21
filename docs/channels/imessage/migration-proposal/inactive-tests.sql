set local search_path = public, extensions;
select no_plan();
insert into auth.users (id, email) values
('00000000-0000-4000-8000-000000000001', 'fixture-one@example.invalid'),
('00000000-0000-4000-8000-000000000002', 'fixture-two@example.invalid');
insert into waldo.owners (id, auth_user_id, do_name, phone_verified_at) values
('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'fixture-owner-one', now()),
('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', 'fixture-owner-two', now());
select lives_ok($sql$insert into waldo.presences (owner_id, provider, subject)
select '10000000-0000-4000-8000-000000000001', provider, 'fixture-' || provider
from unnest(array['telegram', 'console', 'ios', 'whatsapp']) provider$sql$, 'existing providers remain active');
select lives_ok($sql$insert into waldo.presences (owner_id, provider, subject, state)
values ('10000000-0000-4000-8000-000000000001','imessage','fixture-apple-handle','unlinked')$sql$, 'only unlinked iMessage scaffold is allowed');
select throws_ok($sql$insert into waldo.presences (owner_id, provider, subject)
values ('10000000-0000-4000-8000-000000000001','imessage','fixture-active')$sql$, '23514', null, 'unverified iMessage activation rejects even privileged direct SQL');
select throws_ok($sql$update waldo.presences set state='active' where provider='imessage'$sql$, '23514', null, 'scaffold cannot activate by update');
select throws_ok($sql$insert into waldo.presences (owner_id,provider,subject,state)
values ('10000000-0000-4000-8000-000000000001','imessage','fixture-pending','pending')$sql$, '23514', null, 'no invented pending state');
select throws_ok($sql$insert into waldo.presences (owner_id,provider,subject,state)
values ('10000000-0000-4000-8000-000000000099','imessage','fixture-orphan','unlinked')$sql$, '23503', null, 'owner FK preserved');
select throws_ok($sql$insert into waldo.presences (owner_id,provider,subject)
values ('10000000-0000-4000-8000-000000000002','telegram','fixture-telegram')$sql$, '23505', null, 'live subject cannot cross owners');
select throws_ok($sql$insert into waldo.link_codes (code_hash,owner_id,provider,expires_at)
values ('synthetic-code','10000000-0000-4000-8000-000000000001','imessage',now())$sql$, '23514', null, 'redemption providers unchanged');
select is((select count(*)::integer from (
  (select * from public.imessage_proof_catalog where kind <> 'constraint' except select * from public.imessage_proof_current where kind <> 'constraint')
  union all (select * from public.imessage_proof_current where kind <> 'constraint' except select * from public.imessage_proof_catalog where kind <> 'constraint')
) differences), 0, 'RLS/grants/functions/policies/index have no drift');
insert into waldo.presences (owner_id,provider,subject) values ('10000000-0000-4000-8000-000000000002','telegram','fixture-owner-two-channel');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
select is((select count(*)::integer from waldo.presences), 5, 'owner reads own rows only');
select is((select count(*)::integer from waldo.presences where owner_id='10000000-0000-4000-8000-000000000002'), 0, 'foreign owner rows remain invisible');
select throws_ok($sql$insert into waldo.presences(owner_id,provider,subject)
values ('10000000-0000-4000-8000-000000000001','imessage','forged-authenticated')$sql$, '42501', null, 'authenticated role cannot link by direct insert');
select throws_ok($sql$update waldo.presences set state='active' where provider='imessage'$sql$, '42501', null, 'authenticated role cannot activate');
reset role;
set local role anon;
select throws_ok($sql$select * from waldo.presences$sql$, '42501', null, 'anon cannot read private presences');
select throws_ok($sql$select * from waldo.route_presence('imessage','fixture-apple-handle',0,'forged')$sql$, '42501', null, 'unsigned routing rejects before context');
reset role;
select is((select count(*)::integer from waldo.presences where provider='imessage' and state='active'), 0, 'no live iMessage authority created');
select * from finish();
