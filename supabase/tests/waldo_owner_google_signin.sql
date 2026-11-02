begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('google-signin-fixture-router', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$
  select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'google-signin-fixture-router', 'sha256'), 'hex')
$$;
insert into auth.users(id, email, email_confirmed_at) values
  ('74000000-0000-0000-0000-000000000001', 'Google-A@test.invalid', now()),
  ('74000000-0000-0000-0000-000000000002', 'apple-b@test.invalid', now()),
  ('74000000-0000-0000-0000-000000000003', 'code-c@test.invalid', now());
insert into auth.identities (user_id, provider, provider_id, identity_data) values
  ('74000000-0000-0000-0000-000000000001', 'google', 'google-a-old', '{"sub": "google-a-old"}'),
  ('74000000-0000-0000-0000-000000000001', 'google', 'google-a-new', '{"sub": "google-a-new"}'),
  ('74000000-0000-0000-0000-000000000002', 'apple', 'apple-b', '{"sub": "apple-b"}');
insert into waldo.owners(id, auth_user_id, do_name, email) values
  ('75000000-0000-0000-0000-000000000001', '74000000-0000-0000-0000-000000000001', 'gsi-owner-a', 'google-a@test.invalid'),
  ('75000000-0000-0000-0000-000000000002', '74000000-0000-0000-0000-000000000002', 'gsi-owner-b', 'apple-b@test.invalid'),
  ('75000000-0000-0000-0000-000000000003', '74000000-0000-0000-0000-000000000003', 'gsi-owner-c', 'code-c@test.invalid');
insert into waldo.owner_signin_identities (owner_id, provider, subject, trusted_at) values
  ('75000000-0000-0000-0000-000000000001', 'google', 'google-a-old', now() - interval '2 days'),
  ('75000000-0000-0000-0000-000000000001', 'google', 'google-a-new', now() - interval '1 day'),
  ('75000000-0000-0000-0000-000000000002', 'apple', 'apple-b', now());
create function pg_temp.signin(which text) returns jsonb language sql as $$
  select waldo.owner_google_signin(which, pg_temp.at(), pg_temp.sig('googlesignin.' || which))
$$;
select is(pg_temp.signin('gsi-owner-a'), '{"subject": "google-a-new", "email": "google-a@test.invalid"}'::jsonb,
  'the most recently trusted Google identity, with the owner''s own address lower-cased');
select is(pg_temp.signin('gsi-owner-b'), null::jsonb, 'an Apple sign-in is not a Google one');
select is(pg_temp.signin('gsi-owner-c'), null::jsonb, 'an owner who signs in with an email code has none');
select is(pg_temp.signin('unknown-owner'), null::jsonb, 'an unknown owner has none');
delete from auth.identities where provider_id = 'google-a-new';
select is(pg_temp.signin('gsi-owner-a')->>'subject', 'google-a-old', 'an identity Supabase no longer links is skipped');
update auth.users set email_confirmed_at = null where id = '74000000-0000-0000-0000-000000000001';
select is(pg_temp.signin('gsi-owner-a'), null::jsonb, 'an unconfirmed address serves nothing');
update auth.users set email_confirmed_at = now() where id = '74000000-0000-0000-0000-000000000001';
update waldo.owners set state = 'suspended' where do_name = 'gsi-owner-a';
select is(pg_temp.signin('gsi-owner-a'), null::jsonb, 'a suspended owner has none');
select throws_ok($$select waldo.owner_google_signin('gsi-owner-b', extract(epoch from now())::bigint, 'forged')$$,
  '42501', 'unsigned router call', 'a forged signature is refused');
select throws_ok(format($$select waldo.owner_google_signin('gsi-owner-b', %s, %L)$$, pg_temp.at(), pg_temp.sig('googlesignin.gsi-owner-a')),
  '42501', 'unsigned router call', 'a signature for another owner does not read this one');
select ok(has_function_privilege('anon', 'waldo.owner_google_signin(text,bigint,text)', 'execute'), 'the signed entry is callable');
select ok(not has_function_privilege('authenticated', 'waldo.owner_google_signin(text,bigint,text)', 'execute'), 'a signed-in end user cannot call it');
select ok(not exists(select 1 from pg_proc p, lateral aclexplode(p.proacl) a
  where p.oid = 'waldo.owner_google_signin(text,bigint,text)'::regprocedure and a.grantee = 0), 'no PUBLIC execution privilege');
select * from finish();
rollback;
