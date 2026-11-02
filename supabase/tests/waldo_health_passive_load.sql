begin;
create extension if not exists pgtap with schema extensions;
select plan(23);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- Health contract revision 12 (passive load, ADR-0081 amendment of 2 Nov 2026, §5a): an hour's heart-rate bins stored as a raw
-- reading and returned by the series read under `bins`, an hourly window's highest under `max`, and the day load's fence admitting
-- a v2 load with its parts and the day's v1 load beside it, or a v1 load with parts. Synthetic values.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.iso(t timestamptz) returns text language sql as $$ select to_char(t at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') $$;
-- One whole local hour (UTC), three hours back, so it is over.
create function pg_temp.hour(id text,sig text,unit text,val numeric,extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('sample_id',id,'revision',1,'signal',sig,'unit',unit,'value',val,'day',((date_trunc('hour',now())-interval '3 hours') at time zone 'UTC')::date,
    'start_at',pg_temp.iso(date_trunc('hour',now())-interval '3 hours'),'end_at',pg_temp.iso(date_trunc('hour',now())-interval '2 hours'),'utc_offset_minutes',0) || extra $$;
create function pg_temp.bins(id text,val numeric,extra jsonb default '{}') returns jsonb language sql as $$
  select pg_temp.hour(id,'heart_rate_bins_window','seconds',val,'{"from_bpm":70,"bin_bpm":5,"outside_workouts":[600,1200,0,0,0,0,0,0],"in_workouts":[0,0,0,0,0,600,900,300]}'::jsonb || extra) $$;
create function pg_temp.batch(rid text,samples jsonb,per_sample boolean default false) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','apple','consent_epoch',1,'timezone','UTC','anchor_before',null,'anchor_after','a-'||rid,'samples',samples,'deletions','[]'::jsonb)
    || case when per_sample then '{"rejection":"per_sample"}'::jsonb else '{}'::jsonb end $$;
create function pg_temp.stored(sid text) returns jsonb language sql as $$
  select s.payload from waldo.health_samples s join waldo.owners o on o.id=s.owner_id where o.do_name='passive-owner' and s.sample_id=sid $$;
create function pg_temp.series(signals jsonb) returns jsonb language sql as $$
  select pg_temp.h('series_read','passive-owner',jsonb_build_object('from',((now() at time zone 'UTC')::date-3)::text,'to',((now() at time zone 'UTC')::date+1)::text,'signals',signals))->'sources'->0->'samples' $$;
create function pg_temp.pillar(score int,zone text,version text default 'recovery.v5') returns jsonb language sql as $$
  select jsonb_build_object('score',score,'zone',zone,'algorithm_version',version,'activation','accepted','hrv_method','rmssd','confidence',0.8) $$;
create function pg_temp.write(extra jsonb) returns jsonb language sql as $$
  select pg_temp.h('context_write','passive-owner',jsonb_build_object('day',to_char((now() at time zone 'UTC')::date,'YYYY-MM-DD'),'timezone','UTC',
    'basis',jsonb_build_array(jsonb_build_object('source','apple','consent_epoch',1)),
    'form',pg_temp.pillar(64,'good','form.v9'),'recovery',pg_temp.pillar(72,'good'),'weight',pg_temp.pillar(51,'moderate','weight.v5'),'freshness','fresh') || extra) $$;
create function pg_temp.refused(load jsonb) returns boolean language sql as $$ select pg_temp.write(jsonb_build_object('day_load',load))->>'error' = 'invalid_request' $$;
create function pg_temp.v1(over jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('state','available','version','day-load.candidate.v1','activation','candidate_unaccepted','score',61.4,'method','hr_zones','approximate',false,
    'window_days',28,'band',jsonb_build_object('state','personal','low',22.1,'centre',43.8,'high',65.5,'own_days',24,'days_until_personal',0)) || over $$;
create function pg_temp.v2(over jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('state','available','version','day-load.candidate.v2','activation','candidate_unaccepted','score',52.1,'method','hr_zones_observed_peak','approximate',true,
    'window_days',28,'band',jsonb_build_object('state','personal','low',9.6,'centre',18.4,'high',27.2,'own_days',19,'days_until_personal',0),
    'parts','{"workouts":{"share":0.2},"passive":{"state":"available","share":0.8,"observed_hours":24}}'::jsonb,'v1',pg_temp.v1()) || over $$;
create function pg_temp.with_parts(parts text) returns jsonb language sql as $$ select pg_temp.v1(jsonb_build_object('parts',parts::jsonb)) $$;

insert into auth.users(id,email) values ('9a100000-0000-0000-0000-0000000000a1','passive@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('9a300000-0000-0000-0000-0000000000a3','9a100000-0000-0000-0000-0000000000a1','passive-owner','passive@example.invalid');
select pg_temp.h('consent_grant','passive-owner',jsonb_build_object('request_id','grant-passive-st','source','apple','purpose','storage_compute','version',2,'expected_epoch',0,'age_attested_18_plus',true));
select pg_temp.h('consent_grant','passive-owner',jsonb_build_object('request_id','grant-passive-md','source','apple','purpose','model_processing','version',2,'expected_epoch',0,'age_attested_18_plus',true));

-- The reading: stored whole, then read back as bins beside an hourly window's highest.
select is(pg_temp.h('ingest','passive-owner',pg_temp.batch('passive-ok-00001',jsonb_build_array(
  pg_temp.bins('bins-1',3600),
  pg_temp.hour('hr-1','heart_rate_window','beats_per_minute',96,'{"min":62,"max":164,"n_samples":120}'))))->>'accepted','2','an hour''s bins and its heart-rate window are stored');
select is(pg_temp.stored('bins-1')->'in_workouts','[0,0,0,0,0,600,900,300]'::jsonb,'the bins are stored as sent');
select is((select r->'bins' from jsonb_array_elements(pg_temp.series('["heart_rate_bins_window"]')) r),
  '{"from_bpm":70,"outside_workouts":[600,1200,0,0,0,0,0,0],"in_workouts":[0,0,0,0,0,600,900,300]}'::jsonb,'the series read returns the bins under their fixed keys');
select is((select r->>'value' from jsonb_array_elements(pg_temp.series('["heart_rate_bins_window"]')) r),'3600','and the covered seconds as the value');
select is((select r->>'max' from jsonb_array_elements(pg_temp.series('["heart_rate_window"]')) r),'164','an hourly heart-rate window returns its highest under max');
select ok(not (pg_temp.series('["heart_rate_window"]')::text ~ '"bins"|"min"|n_samples'),'and neither its lowest, its count, nor bins');
select ok(not (pg_temp.series('["heart_rate_bins_window"]')::text ~ '"max"|bin_bpm|"origin"'),'the bins carry no max, no bin width and no origin');
select is(jsonb_array_length(pg_temp.series('["heart_rate_bins_window","steps_window"]')),1,'the bins can be read on their own call beside steps');

-- Per sample: each bad hour of bins is refused alone.
create temp table mixed as select pg_temp.h('ingest','passive-owner',pg_temp.batch('passive-mixed-01',jsonb_build_array(
  pg_temp.bins('two-lengths',3600,'{"in_workouts":[0,0,0,0,600,900,300]}'),
  pg_temp.bins('short-sum',3599),
  pg_temp.bins('off-grid',3600,'{"from_bpm":72}'),
  pg_temp.bins('past-top',3600,'{"from_bpm":195}'),
  pg_temp.bins('fraction',3600.5,'{"outside_workouts":[600.5,1200,0,0,0,0,0,0]}'),
  pg_temp.bins('wide',3600,'{"bin_bpm":10}'),
  pg_temp.bins('no-seconds',0,'{"outside_workouts":[0],"in_workouts":[0]}'),
  pg_temp.bins('good-2',3600,'{"sample_id":"good-2"}')),true)) as r;
select is((select r->>'accepted' from mixed),'1','a per-sample batch stores its one good hour of bins');
select is((select jsonb_agg(e->>'index' order by (e->>'index')::int) from mixed, jsonb_array_elements(r->'rejected') e),'["0","1","2","3","4","5","6"]'::jsonb,'and refuses unequal arrays, a sum that is not the value, a start off the grid, bins past 225, fractions, another width and no seconds');
select ok((select bool_and(e->>'signal' = 'heart_rate_bins_window' and e->>'reason' = 'invalid_sample') from mixed, jsonb_array_elements(r->'rejected') e),'each by its signal, as invalid');
select ok(pg_temp.stored('short-sum') is null and pg_temp.stored('off-grid') is null,'and stores none of them');
select is((pg_temp.h('ingest','passive-owner',pg_temp.batch('passive-unit-001',jsonb_build_array(pg_temp.bins('bpm-unit',3600,'{"unit":"beats_per_minute"}')))))->>'error','invalid_request','a whole batch with bins in the wrong unit is refused');

-- The day load's fence.
select is(pg_temp.write(jsonb_build_object('day_load',pg_temp.v2()))->>'written','true','a v2 load with its parts and the day''s v1 load beside it is written');
select is(pg_temp.h('scores_read','passive-owner')->'scores'->'day_load',pg_temp.v2(),'and read back as written, v1 included, for the Worker to choose');
select is(pg_temp.write(jsonb_build_object('day_load',pg_temp.with_parts('{"workouts":{"share":1},"passive":{"state":"unavailable","reason":"sparse"}}')))->>'written','true','a v1 load with parts that say why passive is missing is written');
select is(pg_temp.write(jsonb_build_object('day_load',pg_temp.v1()))->>'written','true','a plain v1 load is written as before');
select is(pg_temp.write(jsonb_build_object('day_load',pg_temp.v2('{"score":0,"parts":{"workouts":{"share":0},"passive":{"state":"available","share":0,"observed_hours":12}}}')))->>'written','true','a v2 day with no load has two zero shares');
select ok(pg_temp.refused(pg_temp.v2() - 'v1') and pg_temp.refused(pg_temp.v2() - 'parts') and pg_temp.refused(pg_temp.v2(jsonb_build_object('v1',pg_temp.v1('{"score":101}')))),'a v2 load without its v1, without parts, or with a v1 that is not a v1 load is refused');
select ok(pg_temp.refused(pg_temp.v2('{"method":"hr_zones","approximate":false}')) and pg_temp.refused(pg_temp.v2('{"approximate":false}')) and pg_temp.refused(pg_temp.v2('{"direction":"above_usual"}')) and pg_temp.refused(pg_temp.v2('{"score":101}')),'a v2 load on another method, without its label, with a direction, or out of range is refused');
select ok(pg_temp.refused(pg_temp.v2('{"parts":{"workouts":{"share":0.5},"passive":{"state":"available","share":0.4,"observed_hours":24}}}'))
  and pg_temp.refused(pg_temp.v2('{"parts":{"workouts":{"share":0.2},"passive":{"state":"available","share":0.8,"observed_hours":11}}}'))
  and pg_temp.refused(pg_temp.v2('{"parts":{"workouts":{"share":0.2},"passive":{"state":"unavailable","reason":"sparse"}}}'))
  and pg_temp.refused(pg_temp.v2('{"parts":{"workouts":{"share":0.2,"load":40},"passive":{"state":"available","share":0.8,"observed_hours":24}}}')),'v2 parts whose shares do not add up, with too few hours, without a passive part, or with a load are refused');
select ok(pg_temp.refused(pg_temp.with_parts('{"workouts":{"share":0.7},"passive":{"state":"available","share":0.3,"observed_hours":20}}'))
  and pg_temp.refused(pg_temp.with_parts('{"workouts":{"share":0.5},"passive":{"state":"unavailable","reason":"sparse"}}'))
  and pg_temp.refused(pg_temp.with_parts('{"workouts":{"share":1},"passive":{"state":"unavailable","reason":"watch_off"}}'))
  and pg_temp.refused('{"state":"unavailable","reason":"no_readings","parts":{"workouts":{"share":0},"passive":{"state":"unavailable","reason":"no_bins"}}}'::jsonb),'v1 parts claiming a passive share, a split share, an unnamed reason, or on an unavailable load are refused');
select ok((select r is not null and r::text ~ 'recovery' and not (r::text ~ 'day_load|day-load|observed_hours|passive') from (select waldo.health_context_read('passive-owner',extract(epoch from now())::bigint,pg_temp.sig('healthctx.read.passive-owner',extract(epoch from now())::bigint))) x(r)),'the model''s read returns the row and none of the load');

select * from finish();
rollback;
