begin;
create extension if not exists pgtap with schema extensions;
select plan(23);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- What changed today on the derived row: written through the current writer in its closed shape only, for the owner's own
-- today or yesterday, read back by the scores read, and by the model's read only while the row is today's. Synthetic values.
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
create function pg_temp.day(days_back int default 0) returns text language sql as $$ select to_char((now() at time zone 'UTC')::date-days_back,'YYYY-MM-DD') $$;
create function pg_temp.ctx(extra jsonb default '{}',days_back int default 0) returns jsonb language sql as $$
  select jsonb_build_object('day',pg_temp.day(days_back),'timezone','UTC',
    'basis',jsonb_build_array(jsonb_build_object('source','apple','consent_epoch',1)),
    'form',jsonb_build_object('score',71,'zone','good','algorithm_version','form.v9','activation','accepted','hrv_method','rmssd','confidence',0.8),
    'recovery',jsonb_build_object('score',72,'zone','good','algorithm_version','recovery.v5','activation','accepted','hrv_method','rmssd','confidence',0.8),
    'weight',jsonb_build_object('reason','calendar_demand_unavailable'),'freshness','fresh') || extra $$;
create function pg_temp.write(extra jsonb default '{}',days_back int default 0) returns jsonb language sql as $$ select pg_temp.h('context_write','change-owner',pg_temp.ctx(extra,days_back)) $$;
create function pg_temp.score_change(key text,pillar text,from_ numeric,to_ numeric,verdict text,significant boolean default true) returns jsonb language sql as $$
  select jsonb_build_object('subject',jsonb_build_object('tier',1,'key',key),'pillar',pillar,'from',from_,'to',to_,'unit','score','against','yesterday','verdict',verdict,'significant',significant) $$;
create function pg_temp.reading_change(key text,method text,pillar text,unit text,from_ numeric,to_ numeric,verdict text) returns jsonb language sql as $$
  select jsonb_build_object('subject',jsonb_build_object('tier',3,'key',key,'method',to_jsonb(method)),'pillar',pillar,'from',from_,'to',to_,'unit',unit,'against','usual','verdict',verdict,'significant',true) $$;
create function pg_temp.changes() returns jsonb language sql as $$
  select jsonb_build_array(
    pg_temp.score_change('recovery','recovery',60,72,'improved'),
    jsonb_build_object('subject',jsonb_build_object('tier',2,'key','resting_state'),'pillar','recovery','from',50,'to',42,'unit','score','against','yesterday','verdict','declined','significant',false),
    pg_temp.reading_change('resting_heart_rate','provider_resting_daily','recovery','beats_per_minute',55,50.4,'improved'),
    pg_temp.reading_change('breathing_rate',null,'recovery','breaths_per_minute',14,16.2,'neutral')) $$;
create function pg_temp.refused(changes jsonb) returns boolean language sql as $$ select pg_temp.write(jsonb_build_object('changes',changes))->>'error' = 'invalid_request' $$;
create function pg_temp.stored(days_back int default 0) returns jsonb language sql as $$
  select changes from public.health_context_daily where user_id='f1000000-0000-0000-0000-0000000000d1' and day=pg_temp.day(days_back)::date $$;

insert into auth.users(id,email) values ('f1000000-0000-0000-0000-0000000000d1','change@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('f3000000-0000-0000-0000-0000000000d3','f1000000-0000-0000-0000-0000000000d1','change-owner','change@example.invalid');
select is(pg_temp.h('consent_grant','change-owner',pg_temp.grant_body('grant-d-storage1','storage_compute'))->'consent'->>'status','granted','the owner grants storage');
select is(pg_temp.h('consent_grant','change-owner',pg_temp.grant_body('grant-d-model0001','model_processing'))->'consent'->>'status','granted','and model use');

select col_type_is('public','health_context_daily','changes','jsonb','the derived row has a changes column');
select ok(not has_function_privilege('anon','waldo.health_changes_valid(jsonb)','execute') and not has_function_privilege('authenticated','waldo.health_changes_valid(jsonb)','execute')
  and not has_function_privilege('service_role','waldo.health_changes_valid(jsonb)','execute'),'no client role may call the shape check');

select is(pg_temp.write(jsonb_build_object('changes',pg_temp.changes()))->>'written','true','today''s row is written with what changed');
select is(pg_temp.stored(),pg_temp.changes(),'and the row holds it as written');
select is(pg_temp.h('scores_read','change-owner',jsonb_build_object('day',pg_temp.day()))->'scores'->'changes',pg_temp.changes(),'the scores read returns it for that day');
select is(pg_temp.model_read('change-owner')->'context'->'changes',pg_temp.changes(),'the model''s read returns today''s list, which the Worker turns into words');
select ok(pg_temp.h('scores_history','change-owner','{"days":7}'::jsonb)::text !~ 'changes','the history read never returns it');
select is(pg_temp.write()->>'written','true','a write for today without changes lands');
select is(pg_temp.stored(),null,'and clears them, so no list outlives the recompute that had none');

-- Yesterday keeps the list it held; the model never reads a list that is not today's.
select is(pg_temp.write(jsonb_build_object('changes',pg_temp.changes()),1)->>'written','true','a write for yesterday may carry its list');
select is(pg_temp.write('{}',1)->>'written','true','and a later write for yesterday without one lands');
select is(pg_temp.stored(1),pg_temp.changes(),'leaving the list yesterday held');
select ok(pg_temp.write(jsonb_build_object('changes',pg_temp.changes()),2)->>'error' = 'invalid_request','a list for a day older than yesterday is refused');
select ok(pg_temp.write(jsonb_build_object('changes',pg_temp.changes(),'backfilled',true,'form',jsonb_build_object('reason','intraday_inputs_unavailable')),3)->>'error' = 'invalid_request','a list on a backfilled row is refused');
delete from public.health_context_daily where user_id='f1000000-0000-0000-0000-0000000000d1' and day=pg_temp.day()::date;
delete from waldo.health_context_basis where owner_id='f3000000-0000-0000-0000-0000000000d3' and day=pg_temp.day()::date;
select ok(not (pg_temp.model_read('change-owner')->'context' ? 'changes'),'the model never reads yesterday''s list as today''s');

-- Everything outside the closed shape is refused whole.
select is((select count(*)::int from unnest(array[
  'null', '{}', '[]', '"improved"', '[1]',
  jsonb_build_array(pg_temp.score_change('recovery','recovery',60,72,'improved') || '{"note":"good night"}'),
  jsonb_build_array(pg_temp.score_change('recovery','form',60,72,'improved')),
  jsonb_build_array(pg_temp.score_change('stamina','recovery',60,72,'improved')),
  jsonb_build_array(pg_temp.score_change('recovery','recovery',60,72.5,'improved')),
  jsonb_build_array(pg_temp.score_change('recovery','recovery',60,101,'improved')),
  jsonb_build_array(pg_temp.score_change('recovery','recovery',60,72,'great')),
  jsonb_build_array(pg_temp.score_change('recovery','recovery',60,60,'improved')),
  jsonb_build_array(pg_temp.score_change('recovery','recovery',60,60,'neutral',true)),
  jsonb_build_array(pg_temp.score_change('recovery','recovery',60,72,'improved') || '{"unit":"percent"}'),
  jsonb_build_array(pg_temp.score_change('recovery','recovery',60,72,'improved') || '{"against":"usual"}'),
  jsonb_build_array(pg_temp.score_change('recovery','recovery',60,72,'improved') || '{"significant":"yes"}'),
  jsonb_build_array(pg_temp.score_change('recovery','recovery',60,72,'improved'),pg_temp.score_change('recovery','recovery',61,72,'improved')),
  jsonb_build_array(pg_temp.reading_change('resting_heart_rate',null,'recovery','beats_per_minute',55,50.4,'improved')),
  jsonb_build_array(pg_temp.reading_change('breathing_rate','rmssd','recovery','breaths_per_minute',14,16.2,'neutral')),
  jsonb_build_array(pg_temp.reading_change('breathing_rate',null,'recovery','beats_per_minute',14,16.2,'neutral')),
  jsonb_build_array(pg_temp.reading_change('breathing_rate',null,'form','breaths_per_minute',14,16.2,'neutral')),
  jsonb_build_array(pg_temp.reading_change('breathing_rate',null,'recovery','breaths_per_minute',14,16.2,'neutral') || '{"from":"14"}'),
  jsonb_build_array(pg_temp.score_change('recovery','recovery',60,72,'improved') - 'verdict')
]::jsonb[]) bad where pg_temp.refused(bad)),23,'every list outside its shape is refused');
select ok(pg_temp.refused((select jsonb_agg(pg_temp.reading_change('steps',null,'form','count',n,n + 1,'neutral')) from generate_series(1,33) n)),'a list of thirty-three is refused');
select is(pg_temp.write(jsonb_build_object('changes',jsonb_build_array(
  pg_temp.score_change('weight','weight',60,70,'declined'),
  pg_temp.reading_change('sleep_midpoint',null,'form','local_minute',20,1410,'declined'),
  pg_temp.reading_change('wrist_temperature','baseline_delta','recovery','celsius',0,0.45,'neutral'),
  pg_temp.reading_change('overnight_hrv','sdnn','recovery','milliseconds',60,47,'declined'))))->>'written','true','each tier, unit and method the contract names is written');
select ok(pg_temp.stored()::text !~ '[A-Za-z]{2,} [a-z]','and the list holds no text beyond its closed words');

-- A withdrawal leaves nothing behind for the model or the app.
select is(pg_temp.h('consent_withdraw','change-owner',jsonb_build_object('request_id','withdraw-d-storage','source','apple','purpose','storage_compute','expected_epoch',1))->'consent'->>'status','withdrawn','the owner withdraws storage');
select is((select count(*)::int from public.health_context_daily where user_id='f1000000-0000-0000-0000-0000000000d1'),0,'and every derived row, its list with it, is gone');

select * from finish();
rollback;
