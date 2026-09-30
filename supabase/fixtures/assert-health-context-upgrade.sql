select is_empty($q$(select * from public.health_context_daily except select * from health_upgrade_rows)
  union all (select * from health_upgrade_rows except select * from public.health_context_daily)$q$,
  'additive hardening preserves every existing historical row byte-for-byte');
select is_empty($q$with after_shape as (
  select attnum::text as key, to_jsonb(a) as value from pg_attribute a where attrelid='public.health_context_daily'::regclass and attnum>0
  union all select conname, to_jsonb(c) from pg_constraint c where conrelid='public.health_context_daily'::regclass
  union all select indexname, to_jsonb(i) from pg_indexes i where schemaname='public' and tablename='health_context_daily'
  union all select tgname, to_jsonb(t) from pg_trigger t where tgrelid='public.health_context_daily'::regclass
  union all select 'helper', jsonb_build_object('body',prosrc,'config',proconfig,'definer',prosecdef,'return',prorettype)
    from pg_proc where oid='public.set_updated_at()'::regprocedure)
  (select * from after_shape except select * from health_upgrade_shape)
  union all (select * from health_upgrade_shape except select * from after_shape)$q$,
  'additive hardening preserves columns, constraints, indexes, triggers and helper implementation');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='public.health_context_daily'::regclass),
  'upgrade explicitly enables forced owner RLS');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000ad01',true);
select is((select array_agg(user_id::text) from public.health_context_daily),
  array['00000000-0000-0000-0000-00000000ad01']::text[], 'existing A row remains readable only by A after upgrade');
select throws_ok($q$update public.health_context_daily set form='{}'$q$,
  '42501','permission denied for table health_context_daily', 'upgrade removes historical default authenticated writes');
set local role service_role;
select lives_ok($q$update public.health_context_daily set freshness='synthetic-upgrade'
  where user_id='00000000-0000-0000-0000-00000000ad01'$q$, 'trusted update still fires helper after upgrade');
select is((select updated_at from public.health_context_daily where user_id='00000000-0000-0000-0000-00000000ad01'),
  now(), 'upgrade preserves operational update trigger without direct helper EXECUTE');
reset role;
select * from finish();
rollback;
