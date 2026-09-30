begin;
create extension if not exists pgtap with schema extensions;
select plan(32);

select is(
  (select array_agg(column_name::text || ':' || udt_name || ':' || is_nullable || ':' || coalesce(column_default, '<null>') order by ordinal_position)
   from information_schema.columns where table_schema='public' and table_name='health_context_daily'),
  array['id:uuid:NO:gen_random_uuid()', 'user_id:uuid:NO:<null>', 'day:date:NO:<null>',
    'form:jsonb:YES:<null>', 'recovery:jsonb:YES:<null>', 'weight:jsonb:YES:<null>',
    'tier2:jsonb:YES:<null>', 'drivers:jsonb:NO:''[]''::jsonb', 'confidence:numeric:YES:<null>',
    'freshness:text:YES:<null>', 'tags:_text:NO:''{}''::text[]', 'evidence:jsonb:NO:''[]''::jsonb',
    'created_at:timestamptz:NO:now()', 'updated_at:timestamptz:NO:now()']::text[],
  'all fourteen historical columns, types, nullability and defaults are exact');
select is(
  (select array_agg(conname::text || ':' || pg_get_constraintdef(oid) order by conname)
   from pg_constraint where conrelid='public.health_context_daily'::regclass),
  array['health_context_daily_pkey:PRIMARY KEY (id)',
    'health_context_daily_user_id_day_key:UNIQUE (user_id, day)',
    'health_context_daily_user_id_fkey:FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE']::text[],
  'primary key, day uniqueness and cascading auth-user custody remain exact');
select is(
  (select array_agg(indexdef order by indexname) from pg_indexes where schemaname='public' and tablename='health_context_daily'),
  array['CREATE UNIQUE INDEX health_context_daily_pkey ON public.health_context_daily USING btree (id)',
    'CREATE UNIQUE INDEX health_context_daily_user_id_day_key ON public.health_context_daily USING btree (user_id, day)',
    'CREATE INDEX health_context_user_day_idx ON public.health_context_daily USING btree (user_id, day DESC)']::text[],
  'the exact historical indexes are retained');
select is((select count(*) from pg_trigger where tgrelid='public.health_context_daily'::regclass and not tgisinternal),
  1::bigint, 'only the historical update trigger exists');
select ok((select tgfoid='public.set_updated_at()'::regprocedure and tgenabled='O' and tgtype=19
  from pg_trigger where tgrelid='public.health_context_daily'::regclass and tgname='health_context_set_updated_at'),
  'the enabled row BEFORE UPDATE trigger uses the original helper');
select ok((select not prosecdef and prorettype='trigger'::regtype and proconfig=array['search_path=""']::text[]
  from pg_proc where oid='public.set_updated_at()'::regprocedure),
  'helper remains a trigger invoker with empty search_path');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='public.health_context_daily'::regclass),
  'RLS is enabled and explicitly forced, including non-bypass table owners');
select is((select array_agg(policyname::text || ':' || cmd || ':' || roles::text || ':' || qual order by policyname)
  from pg_policies where schemaname='public' and tablename='health_context_daily'),
  array['own rows:SELECT:{public}:(auth.uid() = user_id)']::text[], 'the sole historical owner SELECT policy is unchanged');
select is_empty($q$with expected(grantee, privilege_type) as (values
  ('authenticated','SELECT'), ('service_role','SELECT'), ('service_role','INSERT'), ('service_role','UPDATE')),
  actual as (select grantee::text, privilege_type::text from information_schema.table_privileges
    where table_schema='public' and table_name='health_context_daily' and grantee in ('PUBLIC','anon','authenticated','service_role'))
  (select * from actual except select * from expected) union all (select * from expected except select * from actual)$q$,
  'exact table ACL is authenticated SELECT and trusted SELECT/INSERT/UPDATE only');
select is_empty($q$select privilege_type from information_schema.column_privileges
  where table_schema='public' and table_name='health_context_daily' and grantee in ('PUBLIC','anon','authenticated')
  and privilege_type <> 'SELECT'$q$, 'no client column write privilege survives');
select is_empty($q$select privilege_type from information_schema.routine_privileges
  where routine_schema='public' and routine_name='set_updated_at' and grantee in ('PUBLIC','anon','authenticated','service_role')$q$,
  'neither clients nor trusted writer have direct helper execution');
select ok(not has_function_privilege('anon','public.set_updated_at()','EXECUTE')
  and not has_function_privilege('authenticated','public.set_updated_at()','EXECUTE')
  and not has_function_privilege('service_role','public.set_updated_at()','EXECUTE'),
  'helper execution cannot leak through inherited PUBLIC privilege');
select ok((select rolbypassrls from pg_roles where rolname='service_role'),
  'trusted Supabase ingestion role bypasses RLS without adding client write policies');

insert into auth.users(id,email) values
  ('00000000-0000-0000-0000-00000000ac01','health-access-a@test.invalid'),
  ('00000000-0000-0000-0000-00000000ac02','health-access-b@test.invalid');
insert into waldo.owners(do_name,email,auth_user_id) values
  ('health-access-a','health-access-a@test.invalid','00000000-0000-0000-0000-00000000ac01'),
  ('health-access-b','health-access-b@test.invalid','00000000-0000-0000-0000-00000000ac02');
insert into public.health_context_daily(user_id,day,form,updated_at) values
  ('00000000-0000-0000-0000-00000000ac01','2026-09-30','{"zone":"low"}','2000-01-01T00:00:00Z'),
  ('00000000-0000-0000-0000-00000000ac02','2026-09-30','{"zone":"good"}','2000-01-01T00:00:00Z');
create temporary table health_before as select * from public.health_context_daily;

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000ac01',true);
select is((select array_agg(user_id::text) from public.health_context_daily),
  array['00000000-0000-0000-0000-00000000ac01']::text[], 'authenticated A reads only A on the shared day');
select is((select count(*) from public.health_context_daily where user_id='00000000-0000-0000-0000-00000000ac02'),
  0::bigint, 'explicit foreign-owner read returns no row');
select throws_ok($q$insert into public.health_context_daily(user_id,day) values
  ('00000000-0000-0000-0000-00000000ac01','2026-10-01')$q$,
  '42501','permission denied for table health_context_daily','authenticated cannot insert an own row');
select throws_ok($q$update public.health_context_daily set form='{"zone":"good"}'$q$,
  '42501','permission denied for table health_context_daily','authenticated cannot update any row');
select throws_ok($q$delete from public.health_context_daily$q$,
  '42501','permission denied for table health_context_daily','authenticated cannot delete any row');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000ac02',true);
select is((select array_agg(user_id::text) from public.health_context_daily),
  array['00000000-0000-0000-0000-00000000ac02']::text[], 'authenticated B independently reads only B');
set local role anon;
select throws_ok($q$select * from public.health_context_daily$q$,
  '42501','permission denied for table health_context_daily','anon cannot read despite the historical PUBLIC policy target');
select throws_ok($q$insert into public.health_context_daily(user_id,day) values
  ('00000000-0000-0000-0000-00000000ac01','2026-10-01')$q$,
  '42501','permission denied for table health_context_daily','anon cannot write');
reset role;
select is_empty($q$(select * from public.health_context_daily except select * from health_before)
  union all (select * from health_before except select * from public.health_context_daily)$q$,
  'all rejected client writes left every historical row unchanged');

set local role service_role;
select lives_ok($q$insert into public.health_context_daily(user_id,day,form,updated_at) values
  ('00000000-0000-0000-0000-00000000ac01','2026-09-30','{"zone":"moderate"}','2000-01-01T00:00:00Z')
  on conflict(user_id,day) do update set form=excluded.form, updated_at=excluded.updated_at$q$,
  'trusted upsert works with revoked direct helper execution');
select is((select updated_at from public.health_context_daily where user_id='00000000-0000-0000-0000-00000000ac01'),
  now(), 'trusted update fires the historical timestamp helper');
select throws_ok($q$delete from public.health_context_daily$q$,
  '42501','permission denied for table health_context_daily','trusted writer has no DELETE grant');
select throws_ok($q$truncate public.health_context_daily$q$,
  '42501','permission denied for table health_context_daily','trusted writer has no TRUNCATE grant');
reset role;
select is((select form from public.health_context_daily where user_id='00000000-0000-0000-0000-00000000ac02'),
  '{"zone":"good"}'::jsonb,'trusted A update preserves B');

delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('health-access-fixture','waldo_router_hmac');
select is(waldo.health_context_read('health-access-a',extract(epoch from now())::bigint,
  encode(extensions.hmac(extract(epoch from now())::bigint::text || '.healthctx.read.health-access-a','health-access-fixture','sha256'),'hex'))
  ->'context'->'form', '{"zone":"moderate"}'::jsonb, 'signed health read returns only A derived context');
select is(waldo.health_context_read('health-access-b',extract(epoch from now())::bigint,
  encode(extensions.hmac(extract(epoch from now())::bigint::text || '.healthctx.read.health-access-b','health-access-fixture','sha256'),'hex'))
  ->'context'->'form', '{"zone":"good"}'::jsonb, 'signed B read remains separate from A');
select is((select array_agg(key order by key) from jsonb_object_keys(waldo.health_context_read(
  'health-access-a',extract(epoch from now())::bigint,
  encode(extensions.hmac(extract(epoch from now())::bigint::text || '.healthctx.read.health-access-a','health-access-fixture','sha256'),'hex'))
  ->'context') as keys(key)),
  array['compiled_at','confidence','day','drivers','form','freshness','id','recovery','tags','weight']::text[],
  'signed read exposes the exact derived context fields, excluding tier2 and evidence');
select is((select array_agg(key order by key) from jsonb_object_keys(waldo.health_context_read(
  'health-access-a',extract(epoch from now())::bigint,
  encode(extensions.hmac(extract(epoch from now())::bigint::text || '.healthctx.read.health-access-a','health-access-fixture','sha256'),'hex')))
  as keys(key)), array['context','previous']::text[], 'signed read keeps the exact scoped context/trend envelope');
select throws_ok($q$select waldo.health_context_read('health-access-a',extract(epoch from now())::bigint,'bad')$q$,
  '42501','unsigned router call','ACL repair does not weaken signed health-read authentication');
select * from finish();
rollback;
