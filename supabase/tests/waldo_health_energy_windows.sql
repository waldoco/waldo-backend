begin;
create extension if not exists pgtap with schema extensions;
select plan(24);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- Today's energy windows and the sleep debt trend on the derived row: written through the current writer, read back by the
-- scores read (windows only) and the model's read (windows and the whole sleep debt). Synthetic owner and values.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.grant_body(rid text,purpose text) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','apple','purpose',purpose,'version',2,'expected_epoch',0,'age_attested_18_plus',true) $$;
create function pg_temp.model_read(owner text) returns jsonb language plpgsql as $$
declare a bigint:=extract(epoch from now())::bigint;
begin return waldo.health_context_read(owner,a,pg_temp.sig('healthctx.read.'||owner,a)); end $$;
create function pg_temp.debt(state text default 'available',extra jsonb default '{}') returns jsonb language sql as $$
  select case state
    when 'available' then jsonb_build_object('state','available','debt_minutes',95,'need_basis','blended_average','algorithm_version','sleep-debt.v2','activation','accepted')
    when 'partial' then jsonb_build_object('state','partial','confidence',0.4,'algorithm_version','sleep-debt.v2','activation','accepted')
    else jsonb_build_object('state','unavailable','reason','missing_sleep') end || extra $$;
create function pg_temp.ctx(extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('day',to_char((now() at time zone 'UTC')::date,'YYYY-MM-DD'),'timezone','UTC',
    'basis',jsonb_build_array(jsonb_build_object('source','apple','consent_epoch',1)),
    'form',jsonb_build_object('reason','intraday_inputs_unavailable'),
    'recovery',jsonb_build_object('score',72,'zone','good','algorithm_version','recovery.v5','activation','accepted','hrv_method','rmssd','confidence',0.8),
    'weight',jsonb_build_object('reason','calendar_demand_unavailable'),'freshness','fresh') || extra $$;
create function pg_temp.write(extra jsonb default '{}') returns jsonb language sql as $$ select pg_temp.h('context_write','win-owner',pg_temp.ctx(extra)) $$;
create function pg_temp.scores() returns jsonb language sql as $$ select pg_temp.h('scores_read','win-owner')->'scores' $$;
create function pg_temp.refused(extra jsonb) returns boolean language sql as $$ select pg_temp.write(extra)->>'error' = 'invalid_request' $$;

insert into auth.users(id,email) values ('e1000000-0000-0000-0000-0000000000e1','win@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('e3000000-0000-0000-0000-0000000000e3','e1000000-0000-0000-0000-0000000000e1','win-owner','win@example.invalid');
select is(pg_temp.h('consent_grant','win-owner',pg_temp.grant_body('grant-w-storage1','storage_compute'))->'consent'->>'status','granted','the owner grants storage');
select is(pg_temp.h('consent_grant','win-owner',pg_temp.grant_body('grant-w-model0001','model_processing'))->'consent'->>'status','granted','and model use');

select col_type_is('public','health_context_daily','windows','jsonb','the derived row has a windows column');
select col_type_is('public','health_context_daily','windows_version','text','and the version it was computed by');
select ok((select bool_and(is_nullable = 'YES') from information_schema.columns where table_schema='public' and table_name='health_context_daily' and column_name in ('windows','windows_version')),'both nullable, so a row written without them holds nothing');

-- Written together, read back as stored.
create function pg_temp.w3() returns jsonb language sql as $$
  select '[{"start":"09:30","end":"11:30","kind":"peak"},{"start":"14:00","end":"15:30","kind":"dip"},{"start":"19:00","end":"21:00","kind":"peak"}]'::jsonb $$;
select is(pg_temp.write(jsonb_build_object('windows',pg_temp.w3(),'windows_version','energy-windows.v1'))->>'written','true','a row with windows and their version is written');
select is(pg_temp.scores()->'windows',pg_temp.w3(),'the scores read returns the windows as written');
select ok(not (pg_temp.scores() ? 'windows_version'),'and never the version, which is not part of the app''s answer');
select is(pg_temp.model_read('win-owner')->'context'->'windows',pg_temp.w3(),'the model''s read returns them too');
select is((select windows_version from public.health_context_daily where user_id='e1000000-0000-0000-0000-0000000000e1'),'energy-windows.v1','the version is on the row');

-- A write without windows replaces the row, so yesterday's windows do not outlive the recompute that found none.
select is(pg_temp.write()->>'written','true','a row written without windows lands');
select ok(not (pg_temp.scores() ? 'windows'),'and the scores read leaves the key out, never an empty list');
select ok(not (pg_temp.model_read('win-owner')->'context' ? 'windows'),'as the model''s read does');
select ok((select windows is null and windows_version is null from public.health_context_daily where user_id='e1000000-0000-0000-0000-0000000000e1'),'and the columns are cleared');

-- Up to four windows.
select is(pg_temp.write(jsonb_build_object('windows','[{"start":"00:00","end":"23:30","kind":"dip"},{"start":"06:00","end":"07:00","kind":"peak"},{"start":"08:00","end":"09:00","kind":"peak"},{"start":"10:00","end":"11:00","kind":"dip"}]'::jsonb,'windows_version','energy-windows.v1'))->>'written','true','four windows are written');

-- Everything outside the shape is refused whole.
select is((select count(*)::int from unnest(array[
  '[]','null','{}','"09:00"','7',
  '[{"start":"09:00","end":"10:00","kind":"peak"},{"start":"09:00","end":"10:00","kind":"peak"},{"start":"09:00","end":"10:00","kind":"peak"},{"start":"09:00","end":"10:00","kind":"peak"},{"start":"09:00","end":"10:00","kind":"peak"}]',
  '[null]','["09:00"]','[[]]',
  '[{"start":"9:00","end":"10:00","kind":"peak"}]','[{"start":"09:00","end":"24:00","kind":"peak"}]','[{"start":"09:00","end":"10:60","kind":"peak"}]',
  '[{"start":"09:00:00","end":"10:00","kind":"peak"}]','[{"start":"09h","end":"10:00","kind":"peak"}]','[{"start":"09:00","end":"10:00","kind":"low"}]',
  '[{"start":"09:00","end":"10:00","kind":"PEAK"}]','[{"start":"09:00","end":"10:00"}]','[{"start":"09:00","kind":"peak"}]','[{"end":"10:00","kind":"peak"}]',
  '[{"start":"09:00","end":"10:00","kind":"peak","note":"focus"}]','[{"start":900,"end":"10:00","kind":"peak"}]','[{"start":"09:00","end":null,"kind":"peak"}]',
  '[{"start":"10:00","end":"09:00","kind":"peak"}]','[{"start":"09:00","end":"09:00","kind":"dip"}]',
  '[{"start":"2026-03-20T09:00","end":"10:00","kind":"peak"}]'
]::jsonb[]) bad where pg_temp.refused(jsonb_build_object('windows',bad,'windows_version','energy-windows.v1'))),25,'every windows value outside its shape is refused');
select is((select count(*)::int from unnest(array[
  '{"windows":[{"start":"09:00","end":"10:00","kind":"peak"}]}',
  '{"windows_version":"energy-windows.v1"}',
  '{"windows":[{"start":"09:00","end":"10:00","kind":"peak"}],"windows_version":"energy-windows"}',
  '{"windows":[{"start":"09:00","end":"10:00","kind":"peak"}],"windows_version":"windows.v1"}',
  '{"windows":[{"start":"09:00","end":"10:00","kind":"peak"}],"windows_version":"energy-windows.v1.1"}',
  '{"windows":[{"start":"09:00","end":"10:00","kind":"peak"}],"windows_version":"Energy-Windows.v1"}',
  '{"windows":[{"start":"09:00","end":"10:00","kind":"peak"}],"windows_version":1}',
  '{"windows":[{"start":"09:00","end":"10:00","kind":"peak"}],"windows_version":null}',
  '{"windows":[{"start":"09:00","end":"10:00","kind":"peak"}],"windows_version":"energy-windows.v1; drop"}',
  '{"windows":null,"windows_version":"energy-windows.v1"}'
]::jsonb[]) bad where pg_temp.refused(bad)),10,'windows and their version travel together, and the version is a version name');
select is(pg_temp.scores()->'windows'->0->>'kind','dip','a refused write leaves the row as it was');

-- The sleep debt trend: one of three words on an available or partial debt, optional, and nothing else.
select is((select count(*)::int from unnest(array['building','easing','steady']) t
  where pg_temp.write(jsonb_build_object('sleep_debt',pg_temp.debt('available',jsonb_build_object('trend',t))))->>'written' = 'true'
    and pg_temp.model_read('win-owner')->'context'->'sleep_debt'->>'trend' = t),3,'each trend word is written on an available sleep debt and read back by the model''s read');
select is(pg_temp.write(jsonb_build_object('sleep_debt',pg_temp.debt('partial',jsonb_build_object('trend','steady'))))->>'written','true','and on a partial one');
select is(pg_temp.write(jsonb_build_object('sleep_debt',pg_temp.debt()))->>'written','true','a sleep debt with no trend is written as ever');
select ok(not (pg_temp.model_read('win-owner')->'context'->'sleep_debt' ? 'trend'),'and holds none');
select is((select count(*)::int from unnest(array[
  pg_temp.debt('unavailable','{"trend":"steady"}'),
  pg_temp.debt('available','{"trend":"rising"}'),pg_temp.debt('available','{"trend":"Building"}'),pg_temp.debt('available','{"trend":""}'),
  pg_temp.debt('available','{"trend":null}'),pg_temp.debt('available','{"trend":1}'),pg_temp.debt('available','{"trend":["steady"]}'),
  pg_temp.debt('available','{"trend":"steady","extra":1}'),pg_temp.debt('partial','{"trend":"flat"}'),pg_temp.debt('partial','{"trend":null}')
]) bad where pg_temp.refused(jsonb_build_object('sleep_debt',bad))),10,'a trend outside the three words, or on an unavailable debt, or with another key beside it, is refused');
select is(pg_temp.model_read('win-owner')->'context'->'sleep_debt'->>'state','available','and a refused write leaves the sleep debt as it was');

select * from finish();
rollback;
