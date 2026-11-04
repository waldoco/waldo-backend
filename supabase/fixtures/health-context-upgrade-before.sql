begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

insert into auth.users(id,email) values
  ('00000000-0000-0000-0000-00000000ad01','health-upgrade-a@test.invalid'),
  ('00000000-0000-0000-0000-00000000ad02','health-upgrade-b@test.invalid');
insert into public.health_context_daily(user_id,day,form,tier2,evidence,updated_at) values
  ('00000000-0000-0000-0000-00000000ad01','2026-09-30','{"zone":"low"}','{"fixture":true}','["synthetic-a"]','2000-01-01T00:00:00Z'),
  ('00000000-0000-0000-0000-00000000ad02','2026-09-30','{"zone":"good"}',null,'["synthetic-b"]','2000-01-01T00:00:00Z');
create temporary table health_upgrade_rows as select * from public.health_context_daily;
create temporary table health_upgrade_shape as
  select attnum::text as key, to_jsonb(a) as value from pg_attribute a
    where attrelid='public.health_context_daily'::regclass and attnum>0
  union all select conname, to_jsonb(c) from pg_constraint c where conrelid='public.health_context_daily'::regclass
  union all select indexname, to_jsonb(i) from pg_indexes i where schemaname='public' and tablename='health_context_daily'
  union all select tgname, to_jsonb(t) from pg_trigger t where tgrelid='public.health_context_daily'::regclass
  union all select 'helper', jsonb_build_object('body',prosrc,'config',proconfig,'definer',prosecdef,'return',prorettype)
    from pg_proc where oid='public.set_updated_at()'::regprocedure;

