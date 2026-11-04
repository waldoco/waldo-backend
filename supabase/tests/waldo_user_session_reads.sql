begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-0000-0000-0000000005a1', 'session@test.invalid', now());
insert into waldo.owners (auth_user_id, do_name, email, phone) values ('00000000-0000-0000-0000-0000000005a1', 'do-session', 'session@test.invalid', '+15550005555');
insert into waldo.owner_settings (owner_id) select id from waldo.owners where do_name = 'do-session';
insert into waldo.presences (owner_id, provider, subject) select id, 'telegram', '5550005555' from waldo.owners where do_name = 'do-session';

select is_empty($$select schemaname, tablename from pg_policies where schemaname in ('waldo', 'public')$$, 'no waldo or public table has a policy for a user session');
select is_empty($$select table_schema, table_name, grantee, privilege_type from information_schema.role_table_grants
  where table_schema in ('waldo', 'public') and grantee in ('anon', 'authenticated')$$, 'neither anon nor a user session holds any waldo or public table privilege');
select is_empty($$select table_schema, table_name, column_name, grantee from information_schema.column_privileges
  where table_schema in ('waldo', 'public') and grantee in ('anon', 'authenticated')$$, 'nor any column privilege');
select is_empty($$select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('waldo', 'public') and c.relkind in ('r', 'p') and not c.relrowsecurity$$, 'every waldo and public table has RLS enabled');
select is_empty($$select n.nspname, d.defaclobjtype, d.defaclacl::text from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
  where d.defaclrole = 'postgres'::regrole and n.nspname in ('waldo', 'public') and d.defaclobjtype in ('r', 'S')
    and d.defaclacl::text ~ '(^|[{,])(anon|authenticated)='$$, 'no default privilege hands a new waldo or public table or sequence to anon or a user session');
-- A table created after these migrations arrives with no grant for a user session.
set local role postgres;
create table waldo.session_reads_probe (id bigint generated always as identity primary key);
create table public.session_reads_probe (id bigint generated always as identity primary key);
reset role;
select is_empty($$select t, r from (values ('waldo.session_reads_probe'), ('public.session_reads_probe')) tables(t)
  cross join (values ('anon'), ('authenticated')) roles(r)
  where has_table_privilege(r, t, 'select,insert,update,delete')$$, 'a new table is not readable or writable by anon or a user session');
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
select throws_ok($$select * from public.health_daily$$, '42501', null, 'nor the July raw health days');
select throws_ok($$select * from public.crs_scores$$, '42501', null, 'nor scores');
select throws_ok($$select * from public.chat_messages$$, '42501', null, 'nor chat messages');
select throws_ok($$select * from public.users$$, '42501', null, 'nor the July user rows');
reset role;

set local role anon;
select throws_ok($$select * from waldo.owners$$, '42501', null, 'anon cannot read owners');
select throws_ok($$update waldo.owner_settings set volume = 'high'$$, '42501', null, 'anon cannot change settings');
select throws_ok($$select * from public.health_daily$$, '42501', null, 'anon cannot read raw health days');
reset role;

select is((select volume from waldo.owner_settings s join waldo.owners o on o.id = s.owner_id where o.do_name = 'do-session'), 'normal', 'the settings are unchanged');

select * from finish();
rollback;
