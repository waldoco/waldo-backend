begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('agent-mail-fixture-router', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$
  select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'agent-mail-fixture-router', 'sha256'), 'hex')
$$;
insert into auth.users(id, email, email_confirmed_at) values
  ('74000000-0000-0000-0000-000000000001', 'Mail-A@test.invalid', now()),
  ('74000000-0000-0000-0000-000000000002', 'mail-b@test.invalid', null),
  ('74000000-0000-0000-0000-000000000003', 'mail-c@test.invalid', now());
insert into waldo.owners(id, auth_user_id, do_name, email) values
  ('75000000-0000-0000-0000-000000000001', '74000000-0000-0000-0000-000000000001', 'mail-owner-a', 'mail-a@test.invalid'),
  ('75000000-0000-0000-0000-000000000002', '74000000-0000-0000-0000-000000000002', 'mail-owner-b', 'mail-b@test.invalid'),
  ('75000000-0000-0000-0000-000000000003', '74000000-0000-0000-0000-000000000003', 'mail-owner-c', 'mail-c@test.invalid');
insert into waldo.owner_settings(owner_id, timezone) values ('75000000-0000-0000-0000-000000000001', 'Asia/Kolkata');
create function pg_temp.route(which text) returns setof record language sql as $$
  select do_name, timezone, owner_id, owner_email from waldo.route_agent_mail(which, pg_temp.at(), pg_temp.sig('mailroute.' || which))
$$;
create function pg_temp.claim(owner_id uuid, handle text) returns void language sql as $$
  insert into waldo.agent_mail_handles(handle, owner_id) values (handle, owner_id)
$$;

select pg_temp.claim('75000000-0000-0000-0000-000000000001', 'priya');
select pg_temp.claim('75000000-0000-0000-0000-000000000002', 'b.owner-2');
select results_eq($$select * from pg_temp.route('priya') as r(do_name text, timezone text, owner_id uuid, owner_email text)$$,
  $$values ('mail-owner-a'::text, 'Asia/Kolkata'::text, '75000000-0000-0000-0000-000000000001'::uuid, 'mail-a@test.invalid'::text)$$,
  'a handle routes to its owner with the confirmed sign-in address, lower-cased');
select results_eq($$select do_name, owner_email from pg_temp.route('b.owner-2') as r(do_name text, timezone text, owner_id uuid, owner_email text)$$,
  $$values ('mail-owner-b'::text, null::text)$$, 'an unconfirmed address routes with no owner address, so no mail counts as from the owner');
select is_empty($$select * from pg_temp.route('nobody') as r(do_name text, timezone text, owner_id uuid, owner_email text)$$, 'an unknown handle has no route');

select throws_ok($$select pg_temp.claim('75000000-0000-0000-0000-000000000003', 'priya')$$, '23505', null, 'a handle has one owner');
select throws_ok($$select pg_temp.claim('75000000-0000-0000-0000-000000000001', 'second')$$, '23505', null, 'an owner has one handle');
select throws_ok(format($$select pg_temp.claim('75000000-0000-0000-0000-000000000003', %L)$$, reserved), '23514', null, format('%s is reserved', reserved))
  from unnest(array['postmaster', 'abuse', 'hostmaster', 'webmaster', 'admin', 'support', 'info', 'security', 'noreply', 'waldo']) reserved;
select throws_ok(format($$select pg_temp.claim('75000000-0000-0000-0000-000000000003', %L)$$, bad), '23514', null, format('%L is not a handle', bad))
  from unnest(array['Priya', 'a', '-ab', 'ab-', 'a..b', 'a+b', 'a b', 'a@b', repeat('a', 33)]) bad;

update waldo.owners set state = 'suspended' where id = '75000000-0000-0000-0000-000000000002';
select is_empty($$select * from pg_temp.route('b.owner-2') as r(do_name text, timezone text, owner_id uuid, owner_email text)$$, 'a suspended owner receives no mail');

-- Release: the owner gives the handle up. Nobody, the owner included, gets it back for 180 days.
delete from waldo.agent_mail_handles where handle = 'priya';
select is_empty($$select * from pg_temp.route('priya') as r(do_name text, timezone text, owner_id uuid, owner_email text)$$, 'a released handle has no route');
select throws_ok($$select pg_temp.claim('75000000-0000-0000-0000-000000000003', 'priya')$$, '23514', 'agent mail handle released within 180 days', 'a released handle is not reissued to another owner');
select throws_ok($$select pg_temp.claim('75000000-0000-0000-0000-000000000001', 'priya')$$, '23514', 'agent mail handle released within 180 days', 'nor to its old owner');
select is((select count(*) from waldo.agent_mail_released_handles where position(convert_to('priya', 'UTF8') in handle_digest) > 0), 0::bigint, 'the release record does not hold the handle');
update waldo.agent_mail_released_handles set released_at = now() - interval '181 days' where handle_digest = extensions.digest('priya', 'sha256');
select lives_ok($$select pg_temp.claim('75000000-0000-0000-0000-000000000003', 'priya')$$, 'after 180 days the handle can be claimed again');
select is((select count(*) from waldo.agent_mail_released_handles where handle_digest = extensions.digest('priya', 'sha256')), 0::bigint, 'and its release record goes');

-- Renaming releases the old handle.
update waldo.agent_mail_handles set handle = 'priya.k' where handle = 'priya';
select throws_ok($$select pg_temp.claim('75000000-0000-0000-0000-000000000001', 'priya')$$, '23514', 'agent mail handle released within 180 days', 'a renamed-away handle is released');

-- Account deletion removes the handle with the owner and keeps only the release record.
select ok(waldo.delete_owner('mail-owner-c', pg_temp.at(), pg_temp.sig('delown.mail-owner-c')), 'the owner is deleted');
select is((select count(*) from waldo.agent_mail_handles where owner_id = '75000000-0000-0000-0000-000000000003'), 0::bigint, 'the handle is deleted with the account');
select throws_ok($$select pg_temp.claim('75000000-0000-0000-0000-000000000001', 'priya.k')$$, '23514', 'agent mail handle released within 180 days', 'a deleted account''s handle is not reissued');

select throws_ok($$select * from waldo.route_agent_mail('b.owner-2', extract(epoch from now())::bigint, 'forged')$$,
  '42501', 'unsigned router call', 'a forged signature is refused');
select throws_ok(format($$select * from waldo.route_agent_mail('b.owner-2', %s, %L)$$, pg_temp.at(), pg_temp.sig('mailroute.priya')),
  '42501', 'unsigned router call', 'a signature for another handle does not route this one');
select ok(has_function_privilege('anon', 'waldo.route_agent_mail(text,bigint,text)', 'execute'), 'the signed entry is callable');
select ok(not has_function_privilege('authenticated', 'waldo.route_agent_mail(text,bigint,text)', 'execute'), 'a signed-in end user cannot call it');
select ok(not exists(select 1 from pg_proc p, lateral aclexplode(p.proacl) a
  where p.oid = 'waldo.route_agent_mail(text,bigint,text)'::regprocedure and a.grantee = 0), 'no PUBLIC execution privilege');
select ok(not has_table_privilege('anon', 'waldo.agent_mail_handles'::regclass, 'select'), 'the handle table is not readable through the API');
select ok(not has_table_privilege('authenticated', 'waldo.agent_mail_released_handles'::regclass, 'select'), 'nor the release records');
select * from finish();
rollback;
