begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-0000-0000-0000000005a1', 'session@test.invalid', now());
insert into waldo.owners (auth_user_id, do_name, email, phone) values ('00000000-0000-0000-0000-0000000005a1', 'do-session', 'session@test.invalid', '+15550005555');
insert into waldo.owner_settings (owner_id) select id from waldo.owners where do_name = 'do-session';
insert into waldo.presences (owner_id, provider, subject) select id, 'telegram', '5550005555' from waldo.owners where do_name = 'do-session';

select is_empty($$select tablename from pg_policies where schemaname = 'waldo'$$, 'no waldo table has a policy for a user session');
select is_empty($$select table_name, grantee, privilege_type from information_schema.role_table_grants
  where table_schema = 'waldo' and grantee in ('anon', 'authenticated')$$, 'neither anon nor a user session holds any waldo table privilege');
select is_empty($$select table_name, column_name, grantee from information_schema.column_privileges
  where table_schema = 'waldo' and grantee in ('anon', 'authenticated')$$, 'nor any column privilege');
select ok(not has_schema_privilege('authenticated', 'waldo', 'usage'), 'a user session cannot use the waldo schema');
select ok(has_schema_privilege('anon', 'waldo', 'usage'), 'anon keeps the schema, for the signed RPCs');
select ok(not has_function_privilege('authenticated', 'waldo.current_owner()', 'execute'), 'a user session cannot resolve its owner');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000005a1', true);
select throws_ok($$select * from waldo.owners$$, '42501', null, 'the owner''s own Supabase session cannot read the owner row');
select throws_ok($$select * from waldo.presences$$, '42501', null, 'nor the linked handles');
select throws_ok($$select * from waldo.owner_settings$$, '42501', null, 'nor the settings');
select throws_ok($$update waldo.owner_settings set volume = 'high'$$, '42501', null, 'nor change them');
select throws_ok($$select * from public.health_context_daily$$, '42501', null, 'nor read derived health context');
reset role;

set local role anon;
select throws_ok($$select * from waldo.owners$$, '42501', null, 'anon cannot read owners');
select throws_ok($$update waldo.owner_settings set volume = 'high'$$, '42501', null, 'anon cannot change settings');
reset role;

select is((select volume from waldo.owner_settings s join waldo.owners o on o.id = s.owner_id where o.do_name = 'do-session'), 'normal', 'the settings are unchanged');

select * from finish();
rollback;
