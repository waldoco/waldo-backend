begin;
create extension if not exists pgtap with schema extensions;
select plan(52);

delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('signup-fixture-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$
  select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'signup-fixture-secret', 'sha256'), 'hex')
$$;
create function pg_temp.signup(subject uuid, email text, phone text, code_hash text) returns text language sql as $$
  select waldo.signup_owner_for_auth(subject, email, pg_temp.at(),
    pg_temp.sig('signup.owner.' || subject::text || '.' || lower(email) || '.' || coalesce(nullif(phone, ''), '') || '.' || code_hash),
    phone, code_hash)
$$;

insert into auth.users(id, email, email_confirmed_at) values
  ('10000000-0000-0000-0000-000000000001', 'no-phone@test.invalid', now()),
  ('10000000-0000-0000-0000-000000000002', 'contact@test.invalid', now()),
  ('10000000-0000-0000-0000-000000000003', 'unverified@test.invalid', null),
  ('10000000-0000-0000-0000-000000000004', 'different@test.invalid', now()),
  ('10000000-0000-0000-0000-000000000005', 'expired@test.invalid', now()),
  ('10000000-0000-0000-0000-000000000006', 'revoked@test.invalid', now()),
  ('10000000-0000-0000-0000-000000000007', 'bootstrap@test.invalid', now()),
  ('10000000-0000-0000-0000-000000000008', 'blank-phone@test.invalid', now()),
  ('10000000-0000-0000-0000-000000000009', 'suspended@test.invalid', now()),
  ('10000000-0000-0000-0000-000000000010', 'no-invite@test.invalid', now()),
  ('10000000-0000-0000-0000-000000000011', 'malformed@test.invalid', now()),
  ('10000000-0000-0000-0000-000000000012', 'rollback@test.invalid', now());
insert into waldo.owners(do_name, email, bootstrap_claimable) values
  ('signup-issuer', 'issuer@test.invalid', false),
  ('signup-seeded', 'bootstrap@test.invalid', true);
insert into waldo.owners(do_name, email, auth_user_id, state) values
  ('signup-suspended', 'suspended@test.invalid', '10000000-0000-0000-0000-000000000009', 'suspended');
insert into waldo.invites(code_hash, email, issued_by, expires_at)
select repeat(code, 64), email, (select id from waldo.owners where do_name = 'signup-issuer'), now() + interval '1 day'
from (values
  ('1', 'no-phone@test.invalid'), ('2', 'contact@test.invalid'), ('3', 'unverified@test.invalid'),
  ('4', 'different@test.invalid'), ('5', 'expired@test.invalid'), ('6', 'revoked@test.invalid'),
  ('7', 'bootstrap@test.invalid'), ('8', 'blank-phone@test.invalid'), ('9', 'suspended@test.invalid'),
  ('a', 'malformed@test.invalid'), ('b', 'rollback@test.invalid')
) as fixture(code, email);
update waldo.invites set expires_at = now() - interval '1 second' where code_hash = repeat('5', 64);
update waldo.invites set revoked_at = now() where code_hash = repeat('6', 64);

select isnt(to_regprocedure('waldo.signup_owner_for_auth(uuid,text,bigint,text,text,text)'), null::regprocedure, 'dedicated signup RPC exists');
select is(has_function_privilege('anon', 'waldo.signup_owner_for_auth(uuid,text,bigint,text,text,text)', 'execute'), true, 'signed runtime role can call signup');
select is(has_function_privilege('authenticated', 'waldo.signup_owner_for_auth(uuid,text,bigint,text,text,text)', 'execute'), false, 'authenticated clients have no direct signup execute grant');
select is(has_function_privilege('service_role', 'waldo.signup_owner_for_auth(uuid,text,bigint,text,text,text)', 'execute'), false, 'service role has no direct signup execute grant');
select throws_ok($$select waldo.signup_owner_for_auth('10000000-0000-0000-0000-000000000001', 'no-phone@test.invalid', pg_temp.at(), 'forged', null, repeat('1',64))$$,
  '42501', 'unsigned router call', 'forged signature fails closed');
select throws_ok($$select waldo.signup_owner_for_auth('10000000-0000-0000-0000-000000000001', 'no-phone@test.invalid', pg_temp.at(), null, null, repeat('1',64))$$,
  '42501', 'unsigned router call', 'null signature fails closed');
select throws_ok($$select waldo.signup_owner_for_auth('10000000-0000-0000-0000-000000000001', 'no-phone@test.invalid', pg_temp.at() - 600, pg_temp.sig('signup.owner.10000000-0000-0000-0000-000000000001.no-phone@test.invalid..' || repeat('1',64)), null, repeat('1',64))$$,
  '42501', 'unsigned router call', 'expired signed request fails closed');
select throws_ok($$select waldo.signup_owner_for_auth('10000000-0000-0000-0000-000000000001', 'no-phone@test.invalid', pg_temp.at(), pg_temp.sig('signup.owner.10000000-0000-0000-0000-000000000001.no-phone@test.invalid..' || repeat('1',64)), '+14155550101', repeat('1',64))$$,
  '42501', 'unsigned router call', 'optional contact phone is covered by the signature');

select is(pg_temp.signup('10000000-0000-0000-0000-000000000003', 'unverified@test.invalid', null, repeat('3',64)), null::text, 'unconfirmed Auth email cannot provision');
select is((select used_at from waldo.invites where code_hash = repeat('3',64)), null::timestamptz, 'unconfirmed email leaves invite untouched');
select is(pg_temp.signup('10000000-0000-0000-0000-000000000004', 'no-phone@test.invalid', null, repeat('1',64)), null::text, 'verified subject cannot substitute another email');
select is(pg_temp.signup('10000000-0000-0000-0000-000000000099', 'no-phone@test.invalid', null, repeat('1',64)), null::text, 'missing Auth identity cannot provision');
select is(pg_temp.signup('10000000-0000-0000-0000-000000000001', 'no-phone@test.invalid', null, repeat('4',64)), null::text, 'invite cannot move between recipients');
select is(pg_temp.signup('10000000-0000-0000-0000-000000000010', 'no-invite@test.invalid', null, ''), null::text, 'verified email alone does not open signup');
select is(pg_temp.signup('10000000-0000-0000-0000-000000000005', 'expired@test.invalid', null, repeat('5',64)), null::text, 'expired invite cannot provision');
select is(pg_temp.signup('10000000-0000-0000-0000-000000000006', 'revoked@test.invalid', null, repeat('6',64)), null::text, 'revoked invite cannot provision');
select is(pg_temp.signup('10000000-0000-0000-0000-000000000011', 'malformed@test.invalid', 'not-a-phone', repeat('a',64)), null::text, 'supplied phone must have the contact format');
select is((select used_at from waldo.invites where code_hash = repeat('a',64)), null::timestamptz, 'invalid contact phone cannot burn an invite');
select is((select count(*) from waldo.owners where auth_user_id = '10000000-0000-0000-0000-000000000001'), 0::bigint, 'denied calls left no owner');

select is(pg_temp.signup('10000000-0000-0000-0000-000000000001', 'no-phone@test.invalid', null, repeat('1',64)) like 'owner-%', true, 'verified invited member can join without a phone');
select is((select phone from waldo.owners where email = 'no-phone@test.invalid'), null::text, 'omitted phone is stored as NULL');
select is((select phone_verified_at from waldo.owners where email = 'no-phone@test.invalid'), null::timestamptz, 'signup creates no phone verification');
select is((select count(*) from waldo.owner_settings s join waldo.owners o on o.id = s.owner_id where o.email = 'no-phone@test.invalid'), 1::bigint, 'owner and settings are provisioned together');
select is((select used_by from waldo.invites where code_hash = repeat('1',64)), (select id from waldo.owners where email = 'no-phone@test.invalid'), 'invite consumption records exactly this new owner');
select isnt((select used_at from waldo.invites where code_hash = repeat('1',64)), null::timestamptz, 'successful invite has a consumption timestamp');
select is((select count(*) from waldo.presences p join waldo.owners o on o.id = p.owner_id where o.email = 'no-phone@test.invalid'), 0::bigint, 'signup grants no channel presence');
select is(pg_temp.signup('10000000-0000-0000-0000-000000000002', 'contact@test.invalid', null, repeat('1',64)), null::text, 'consumed invite cannot create another owner');
select is(pg_temp.signup('10000000-0000-0000-0000-000000000001', 'no-phone@test.invalid', '+14155550999', repeat('1',64)),
  (select do_name from waldo.owners where email = 'no-phone@test.invalid'), 'completion retry resolves the same canonical owner after consumption');
select is((select phone from waldo.owners where email = 'no-phone@test.invalid'), null::text, 'completion retry cannot overwrite owner contact data');
select is((select count(*) from waldo.owners where auth_user_id = '10000000-0000-0000-0000-000000000001'), 1::bigint, 'repeated completion creates no second owner');
insert into waldo.invites(code_hash, email, issued_by, expires_at)
values (repeat('c',64), 'no-phone@test.invalid', (select id from waldo.owners where do_name = 'signup-issuer'), now() + interval '1 day');
select is(pg_temp.signup('10000000-0000-0000-0000-000000000001', 'no-phone@test.invalid', null, repeat('c',64)),
  (select do_name from waldo.owners where email = 'no-phone@test.invalid'), 'existing bound owner resolves without consuming a later invite');
select is((select used_at from waldo.invites where code_hash = repeat('c',64)), null::timestamptz, 'bound retry leaves unrelated invite unused');

select is(pg_temp.signup('10000000-0000-0000-0000-000000000002', 'CONTACT@test.invalid', '+14155550102', repeat('2',64)) like 'owner-%', true, 'matching confirmed email accepts an optional contact phone');
select isnt((select do_name from waldo.owners where email = 'contact@test.invalid'), (select do_name from waldo.owners where email = 'no-phone@test.invalid'), 'second member has a different owner DO');
select is((select phone from waldo.owners where email = 'contact@test.invalid'), '+14155550102', 'optional contact is stored on its own owner');
select is((select phone_verified_at from waldo.owners where email = 'contact@test.invalid'), null::timestamptz, 'optional contact remains unverified');
select throws_ok($$insert into waldo.presences(owner_id, provider, subject) values ((select id from waldo.owners where email = 'contact@test.invalid'), 'whatsapp', '14155550102')$$,
  'P0001', 'whatsapp presence requires a verified phone (phone_verified_at is null)', 'optional phone cannot authorize WhatsApp linking');
select is(pg_temp.signup('10000000-0000-0000-0000-000000000008', 'blank-phone@test.invalid', '', repeat('8',64)) like 'owner-%', true, 'blank optional phone also permits signup');
select is((select phone from waldo.owners where email = 'blank-phone@test.invalid'), null::text, 'blank contact is normalized to NULL');

select throws_ok($$select pg_temp.signup('10000000-0000-0000-0000-000000000007', 'bootstrap@test.invalid', null, repeat('7',64))$$,
  '23505', 'owner already exists', 'signup does not claim a seeded owner by email');
select is((select auth_user_id from waldo.owners where do_name = 'signup-seeded'), null::uuid, 'seeded identity remains unbound');
select is((select bootstrap_claimable from waldo.owners where do_name = 'signup-seeded'), true, 'signup does not consume the bootstrap mark');
select is((select used_at from waldo.invites where code_hash = repeat('7',64)), null::timestamptz, 'owner uniqueness conflict rolls back invite consumption');
select throws_ok($$select pg_temp.signup('10000000-0000-0000-0000-000000000009', 'suspended@test.invalid', null, repeat('9',64))$$,
  '23505', 'owner already exists', 'suspended owner cannot acquire a new active identity');
select is((select used_at from waldo.invites where code_hash = repeat('9',64)), null::timestamptz, 'suspended collision also leaves invite unused');

create function pg_temp.reject_fixture_settings() returns trigger language plpgsql as $$
begin
  if exists (select 1 from waldo.owners where id = new.owner_id and email = 'rollback@test.invalid') then
    raise exception 'fixture settings failure';
  end if;
  return new;
end $$;
create trigger signup_fixture_settings_failure before insert on waldo.owner_settings
  for each row execute function pg_temp.reject_fixture_settings();
select throws_ok($$select pg_temp.signup('10000000-0000-0000-0000-000000000012', 'rollback@test.invalid', null, repeat('b',64))$$,
  'P0001', 'fixture settings failure', 'settings failure rejects the complete signup transaction');
select is((select count(*) from waldo.owners where email = 'rollback@test.invalid'), 0::bigint, 'settings failure rolls back owner creation');
select is((select used_at from waldo.invites where code_hash = repeat('b',64)), null::timestamptz, 'settings failure rolls back invite consumption');
drop trigger signup_fixture_settings_failure on waldo.owner_settings;

select is(waldo.owner_for_auth('10000000-0000-0000-0000-000000000011', 'malformed@test.invalid', pg_temp.at(),
  pg_temp.sig('owner.10000000-0000-0000-0000-000000000011.malformed@test.invalid..' || repeat('a',64)), '', repeat('a',64)), null::text,
  'existing sign-in RPC does not gain no-phone provisioning authority');
select is((select used_at from waldo.invites where code_hash = repeat('a',64)), null::timestamptz, 'existing sign-in still cannot consume this invite');
update auth.users set email_confirmed_at = null where id = '10000000-0000-0000-0000-000000000001';
select is(pg_temp.signup('10000000-0000-0000-0000-000000000001', 'no-phone@test.invalid', null, repeat('1',64)), null::text, 'even bound completion retry rechecks confirmed Auth email');
select is((select count(*) from waldo.owner_settings s join waldo.owners o on o.id = s.owner_id where o.email = 'contact@test.invalid'), 1::bigint, 'second member receives only its own settings row');

select * from finish();
rollback;
