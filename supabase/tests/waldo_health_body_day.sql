begin;
create extension if not exists pgtap with schema extensions;
select plan(66);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- Health contract revision 10: the day's load, today's measured Form curve and today's hourly stress curve, on the derived row in
-- columns of their own (ADR-0081 amendment of 2 Nov 2026, §5 and §6). Written through the current writer in their closed shapes
-- only, returned by the app's scores read (the curves for the owner's own today only), never by the model's read or the history.
-- Synthetic values.
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
create function pg_temp.pillar(score int,zone text,version text default 'recovery.v5') returns jsonb language sql as $$
  select jsonb_build_object('score',score,'zone',zone,'algorithm_version',version,'activation','accepted','hrv_method','rmssd','confidence',0.8) $$;
create function pg_temp.day(back int default 0) returns text language sql as $$ select to_char((now() at time zone 'UTC')::date-back,'YYYY-MM-DD') $$;
create function pg_temp.ctx(extra jsonb default '{}',days_back int default 0) returns jsonb language sql as $$
  select jsonb_build_object('day',pg_temp.day(days_back),'timezone','UTC',
    'basis',jsonb_build_array(jsonb_build_object('source','apple','consent_epoch',1)),
    'form',pg_temp.pillar(64,'good','form.v9'),'recovery',pg_temp.pillar(72,'good'),'weight',pg_temp.pillar(51,'moderate','weight.v5'),'freshness','fresh') || extra $$;
create function pg_temp.write(extra jsonb default '{}',days_back int default 0) returns jsonb language sql as $$ select pg_temp.h('context_write','day-owner',pg_temp.ctx(extra,days_back)) $$;
create function pg_temp.scores(days_back int default null) returns jsonb language sql as $$
  select pg_temp.h('scores_read','day-owner',case when days_back is null then '{}'::jsonb else jsonb_build_object('day',pg_temp.day(days_back)) end)->'scores' $$;
create function pg_temp.refused(extra jsonb) returns boolean language sql as $$ select pg_temp.write(extra)->>'error' = 'invalid_request' $$;

-- The day's load: available with a personal band, available with a provisional one, and unavailable.
create function pg_temp.load(over jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('state','available','version','day-load.candidate.v1','activation','candidate_unaccepted','score',61.4,'method','hr_zones','approximate',false,
    'window_days',28,'band',jsonb_build_object('state','personal','low',22.1,'centre',43.8,'high',65.5,'own_days',24,'days_until_personal',0)) || over $$;
create function pg_temp.band(over jsonb) returns jsonb language sql as $$ select pg_temp.load(jsonb_build_object('band',pg_temp.load()->'band' || over)) $$;
create function pg_temp.provisional(own int,over jsonb default '{}') returns jsonb language sql as $$
  select pg_temp.load(jsonb_build_object('band',jsonb_build_object('state','provisional','own_days',own,'days_until_personal',14-own)) || over) $$;
-- The curves: n measured points a quarter of an hour apart from 09:00 today in UTC, the last at the row's own Form score (64).
create function pg_temp.curve(n int default 3,over jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('version','form.v9','points',(select jsonb_agg(jsonb_build_object(
    'at',to_char(date_trunc('day',now() at time zone 'UTC') + interval '9 hours' + k * interval '15 minutes','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'score',case when k = n - 1 then 64 else 50 + k % 40 end,'kind','measured') order by k) from generate_series(0,n-1) k)) || over $$;
create function pg_temp.hours(items text) returns jsonb language sql as $$ select jsonb_build_object('version','stress-curve.candidate.v1','hours',items::jsonb) $$;
create function pg_temp.stress() returns jsonb language sql as $$
  select pg_temp.hours('[{"at":"2026-03-20T07:00:00Z","value":null,"band":null,"reason":"no_reading"},{"at":"2026-03-20T08:00:00Z","value":41.5,"band":"medium"},{"at":"2026-03-20T09:00:00Z","value":73.9,"band":"high"},{"at":"2026-03-20T10:00:00Z","value":27.4,"band":"low"},{"at":"2026-03-20T11:00:00Z","value":null,"band":null,"reason":"workout"}]') $$;

insert into auth.users(id,email) values ('f1000000-0000-0000-0000-0000000000b1','day@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('f3000000-0000-0000-0000-0000000000b3','f1000000-0000-0000-0000-0000000000b1','day-owner','day@example.invalid');
select is(pg_temp.h('consent_grant','day-owner',pg_temp.grant_body('grant-d-storage1','storage_compute'))->'consent'->>'status','granted','the owner grants storage');
select is(pg_temp.h('consent_grant','day-owner',pg_temp.grant_body('grant-d-model0001','model_processing'))->'consent'->>'status','granted','and model use');

select is((select array_agg(column_name::text||':'||data_type||':'||is_nullable order by column_name) from information_schema.columns where table_schema='public' and table_name='health_context_daily' and column_name in ('day_load','form_curve','stress_curve')),
  array['day_load:jsonb:YES','form_curve:jsonb:YES','stress_curve:jsonb:YES']::text[],'the derived row has the three columns, each jsonb and nullable, so a row written without them holds nothing');
select ok((select relrowsecurity from pg_class where oid='public.health_context_daily'::regclass),'row level security is still on for the table that holds them');

-- The day's load: written as given and read back by the scores read, never by the model or the history.
select is(pg_temp.write(jsonb_build_object('day_load',pg_temp.load()))->>'written','true','a row with a day load is written');
select is(pg_temp.scores()->'day_load',pg_temp.load(),'the scores read returns the load as written');
select ok(not (pg_temp.model_read('day-owner')::text ~ 'day_load|day-load|hr_zones|above_usual|candidate_unaccepted\W+score\W+61'),'the model''s read returns no part of it');
select ok(not (pg_temp.h('scores_history','day-owner','{"days":7,"parts":true}')::text ~ 'day_load|day-load|hr_zones'),'and neither does the history, with or without its parts');
select is(pg_temp.write(jsonb_build_object('day_load',pg_temp.provisional(9)))->>'written','true','a load with no band yet, only the days still needed, is written');
select is(pg_temp.scores()->'day_load'->'band',jsonb_build_object('state','provisional','own_days',9,'days_until_personal',5),'and read back as it is');
select is(pg_temp.write(jsonb_build_object('day_load','{"state":"unavailable","reason":"no_readings"}'::jsonb))->>'written','true','a day nothing worn saw is written as unavailable, never as a low score');
select is(pg_temp.write()->>'written','true','a write without a day load lands');
select ok(not (pg_temp.scores() ? 'day_load') and (select day_load is null from public.health_context_daily where user_id='f1000000-0000-0000-0000-0000000000b1' and day=pg_temp.day()::date),'and clears it: the key is left out, never a null');

-- Each shape the writer refuses leaves the row as it was.
select ok(pg_temp.refused(jsonb_build_object('day_load',pg_temp.load('{"score":101}'))) and pg_temp.refused(jsonb_build_object('day_load',pg_temp.load('{"score":-1}'))) and pg_temp.refused(jsonb_build_object('day_load',pg_temp.load('{"score":"61"}'))),'a score outside 0 to 100 or not a number is refused');
select ok(pg_temp.refused(jsonb_build_object('day_load',pg_temp.load('{"method":"passive"}'))) and pg_temp.refused(jsonb_build_object('day_load',pg_temp.load('{"method":null}'))),'a method outside the four is refused: there is no passive load');
select ok(pg_temp.refused(jsonb_build_object('day_load',pg_temp.load('{"version":"day-load.v1"}'))) and pg_temp.refused(jsonb_build_object('day_load',pg_temp.load('{"activation":"accepted"}'))) and pg_temp.refused(jsonb_build_object('day_load',pg_temp.load('{"window_days":30}'))),'another version, an accepted activation or another window is refused');
select ok(pg_temp.refused(jsonb_build_object('day_load',pg_temp.load('{"approximate":true}'))) and pg_temp.refused(jsonb_build_object('day_load',pg_temp.load('{"method":"hr_zones_observed_peak"}'))),'the approximate label belongs to exactly the observed-peak method');
select is(pg_temp.write(jsonb_build_object('day_load',pg_temp.load('{"method":"hr_zones_observed_peak","approximate":true}')))->>'written','true','and that method with its label is written');
select ok(pg_temp.refused(jsonb_build_object('day_load',pg_temp.load('{"direction":"usual"}'))) and pg_temp.refused(jsonb_build_object('day_load',pg_temp.load('{"direction":null}'))),'a direction of the score against the band is refused: today''s score is the load so far, so none is stored');
select ok(pg_temp.write(jsonb_build_object('day_load',pg_temp.load('{"score":90}')))->>'written'='true' and pg_temp.write(jsonb_build_object('day_load',pg_temp.load('{"score":5}')))->>'written'='true' and pg_temp.write(jsonb_build_object('day_load',pg_temp.load('{"score":65.5}')))->>'written'='true','a score above, below or on the edge of the band is written as it is');
select ok(pg_temp.refused(jsonb_build_object('day_load',pg_temp.band('{"low":70}'))) and pg_temp.refused(jsonb_build_object('day_load',pg_temp.band('{"high":40}'))) and pg_temp.refused(jsonb_build_object('day_load',pg_temp.band('{"high":101}'))) and pg_temp.refused(jsonb_build_object('day_load',pg_temp.band('{"low":-1}'))),'a band out of order or outside 0 to 100 is refused');
select ok(pg_temp.refused(jsonb_build_object('day_load',pg_temp.band('{"own_days":13}'))) and pg_temp.refused(jsonb_build_object('day_load',pg_temp.band('{"own_days":29}'))) and pg_temp.refused(jsonb_build_object('day_load',pg_temp.band('{"days_until_personal":1}'))),'a personal band is from fourteen own days to twenty-eight, with none left to wait');
select ok(pg_temp.refused(jsonb_build_object('day_load',pg_temp.provisional(14))) and pg_temp.refused(jsonb_build_object('day_load',pg_temp.provisional(9,'{"band":{"state":"provisional","own_days":9,"days_until_personal":4}}'))) and pg_temp.refused(jsonb_build_object('day_load',pg_temp.provisional(9,'{"band":{"state":"provisional","own_days":9,"days_until_personal":5,"low":1,"centre":2,"high":3}}'))),'a provisional band is under fourteen days, counts the days left and carries no band');
select ok(pg_temp.refused(jsonb_build_object('day_load',pg_temp.load('{"target":70}'))) and pg_temp.refused(jsonb_build_object('day_load',pg_temp.load('{"trimp":310}'))) and pg_temp.refused(jsonb_build_object('day_load','{"state":"unavailable","reason":"baseline_immature"}'::jsonb)) and pg_temp.refused(jsonb_build_object('day_load','{"state":"unavailable","reason":"no_readings","score":0}'::jsonb)) and pg_temp.refused(jsonb_build_object('day_load','"load"'::jsonb)) and pg_temp.refused(jsonb_build_object('day_load','{}'::jsonb)),'an extra key, a figure beside an unavailable load, another reason and a bare value are refused');
select ok(pg_temp.write(jsonb_build_object('day_load',pg_temp.load(),'backfilled',true,'form',jsonb_build_object('reason','intraday_inputs_unavailable'),'weight',jsonb_build_object('reason','calendar_demand_unavailable')),5)->>'error'='invalid_request','a backfilled row never carries a day load');
select is(pg_temp.write(jsonb_build_object('backfilled',true,'form',jsonb_build_object('reason','intraday_inputs_unavailable'),'weight',jsonb_build_object('reason','calendar_demand_unavailable')),5)->>'written','true','though a backfilled row without one is written');

-- Today's measured Form curve and hourly stress curve.
select is(pg_temp.write(jsonb_build_object('form_curve',pg_temp.curve(),'stress_curve',pg_temp.stress(),'day_load',pg_temp.load()))->>'written','true','a row for today with both curves is written');
select is(pg_temp.scores()->'form_curve',pg_temp.curve(),'the scores read returns the Form curve as written for the owner''s own today');
select is(pg_temp.scores()->'stress_curve',pg_temp.stress(),'and the stress curve');
select ok(not (pg_temp.model_read('day-owner')::text ~ 'form_curve|stress_curve|measured|stress-curve'),'the model''s read returns neither');
select ok(not (pg_temp.h('scores_history','day-owner','{"days":7,"parts":true}')::text ~ 'form_curve|stress_curve|measured|stress-curve'),'nor does the history');
select is((select form_curve is not null and stress_curve is not null from public.health_context_daily where user_id='f1000000-0000-0000-0000-0000000000b1' and day=pg_temp.day()::date),true,'and both are on the row');
select is(pg_temp.write()->>'written','true','a write for today without them lands');
select ok(not (pg_temp.scores() ? 'form_curve') and not (pg_temp.scores() ? 'stress_curve') and (select form_curve is null and stress_curve is null from public.health_context_daily where user_id='f1000000-0000-0000-0000-0000000000b1' and day=pg_temp.day()::date),'and clears both: the keys are left out, never nulls');

-- A curve is today's: it is refused for any other day, and a past day''s stored curve is kept when that day is rewritten without one.
select is(pg_temp.write(jsonb_build_object('form_curve',pg_temp.curve()),1)->>'error','invalid_request','a Form curve on yesterday''s row is refused');
select is(pg_temp.write(jsonb_build_object('stress_curve',pg_temp.stress()),1)->>'error','invalid_request','and a stress curve');
select is(pg_temp.write('{}',1)->>'written','true','yesterday''s row without them is written');
update public.health_context_daily set form_curve=pg_temp.curve(), stress_curve=pg_temp.stress() where user_id='f1000000-0000-0000-0000-0000000000b1' and day=pg_temp.day(1)::date;
select is(pg_temp.write('{}',1)->>'written','true','and rewritten, as the producer does on every run');
select ok((select form_curve = pg_temp.curve() and stress_curve = pg_temp.stress() from public.health_context_daily where user_id='f1000000-0000-0000-0000-0000000000b1' and day=pg_temp.day(1)::date),'the curves that day held are kept');
select ok(not (pg_temp.scores(1) ? 'form_curve') and not (pg_temp.scores(1) ? 'stress_curve'),'though nothing returns a past day''s curve');
select is(jsonb_array_length(pg_temp.h('scores_history','day-owner','{"days":7}')->'history'->'days')>=2 and not (pg_temp.h('scores_history','day-owner','{"days":7}')::text ~ 'form_curve|stress_curve'),true,'nor does the history');

-- Each Form curve shape the writer refuses.
select ok(pg_temp.refused(jsonb_build_object('form_curve',pg_temp.curve(3,'{"version":"form.v8"}'))),'a curve whose version is not the row''s Form version is refused');
select ok(pg_temp.refused(jsonb_build_object('form_curve',jsonb_set(pg_temp.curve(),'{points,2,score}','63'))),'and one whose latest point is not the row''s Form score');
select ok(pg_temp.refused(jsonb_build_object('form_curve',pg_temp.curve(2,'{}')) || jsonb_build_object('form',jsonb_build_object('reason','stale_inputs'))),'and any curve beside a Form that is unavailable');
select ok(pg_temp.refused(jsonb_build_object('form_curve',jsonb_set(pg_temp.curve(),'{points,0,kind}','"projected"'))),'a projected point is refused: the projection stays off the owner''s screens');
select ok(pg_temp.refused(jsonb_build_object('form_curve',jsonb_set(pg_temp.curve(),'{points,0,score}','101'))) and pg_temp.refused(jsonb_build_object('form_curve',jsonb_set(pg_temp.curve(),'{points,0,score}','"50"'))),'a point score out of range or not a number is refused');
select ok(pg_temp.refused(jsonb_build_object('form_curve',jsonb_build_object('version','form.v9','points','[]'::jsonb))) and pg_temp.refused(jsonb_build_object('form_curve',pg_temp.curve(97))),'no points, or more than ninety-six, is refused');
select ok(pg_temp.refused(jsonb_build_object('form_curve',jsonb_set(jsonb_set(pg_temp.curve(),'{points,0,at}',(pg_temp.curve()->'points'->1->'at')),'{points,1,at}',(pg_temp.curve()->'points'->0->'at')))) and pg_temp.refused(jsonb_build_object('form_curve',jsonb_set(pg_temp.curve(),'{points,1,at}',(pg_temp.curve()->'points'->0->'at')))),'points out of order or at the same instant are refused');
select ok(pg_temp.refused(jsonb_build_object('form_curve',pg_temp.curve(3,'{"trend":"rising"}'))) and pg_temp.refused(jsonb_build_object('form_curve',jsonb_set(pg_temp.curve(),'{points,0,band}','"high"'))) and pg_temp.refused(jsonb_build_object('form_curve',jsonb_set(pg_temp.curve(),'{points,0,at}','"nine"'))) and pg_temp.refused(jsonb_build_object('form_curve',pg_temp.curve(3,'{"version":"Form 9"}'))) and pg_temp.refused(jsonb_build_object('form_curve','[]'::jsonb)),'an extra key, a bad instant, a bad version name or a bare array is refused');
select ok(pg_temp.refused(jsonb_build_object('stress_trend','rising')),'the stress trend word is not a key of the row');

-- Each stress curve shape the writer refuses.
select ok(pg_temp.refused(jsonb_build_object('stress_curve',pg_temp.hours('[{"at":"2026-03-20T08:00:00Z","value":73.9,"band":"low"}]'))) and pg_temp.refused(jsonb_build_object('stress_curve',pg_temp.hours('[{"at":"2026-03-20T08:00:00Z","value":70,"band":"medium"}]'))) and pg_temp.refused(jsonb_build_object('stress_curve',pg_temp.hours('[{"at":"2026-03-20T08:00:00Z","value":30,"band":"medium"}]'))),'a band that is not read off the value (70 and up high, 30 and down low) is refused');
select ok(pg_temp.write(jsonb_build_object('stress_curve',pg_temp.hours('[{"at":"2026-03-20T08:00:00Z","value":70,"band":"high"},{"at":"2026-03-20T09:00:00Z","value":30,"band":"low"},{"at":"2026-03-20T10:00:00Z","value":69.9,"band":"medium"},{"at":"2026-03-20T11:00:00Z","value":0,"band":"low"},{"at":"2026-03-20T12:00:00Z","value":100,"band":"high"}]')))->>'written'='true','the edges of the bands are written');
select ok(pg_temp.refused(jsonb_build_object('stress_curve',pg_temp.hours('[{"at":"2026-03-20T08:00:00Z","value":101,"band":"high"}]'))) and pg_temp.refused(jsonb_build_object('stress_curve',pg_temp.hours('[{"at":"2026-03-20T08:00:00Z","value":"50","band":"medium"}]'))) and pg_temp.refused(jsonb_build_object('stress_curve',pg_temp.hours('[{"at":"2026-03-20T08:00:00Z","value":-1,"band":"low"}]'))),'a value out of range or not a number is refused');
select ok(pg_temp.refused(jsonb_build_object('stress_curve',pg_temp.hours('[{"at":"2026-03-20T08:00:00Z","value":50,"band":"medium"},{"at":"2026-03-20T09:00:00Z","value":0,"band":null,"reason":"workout"}]'))) and pg_temp.refused(jsonb_build_object('stress_curve',pg_temp.hours('[{"at":"2026-03-20T08:00:00Z","value":50,"band":"medium"},{"at":"2026-03-20T09:00:00Z","value":null,"band":"low","reason":"workout"}]'))) and pg_temp.refused(jsonb_build_object('stress_curve',pg_temp.hours('[{"at":"2026-03-20T08:00:00Z","value":50,"band":"medium"},{"at":"2026-03-20T09:00:00Z","value":null,"band":null}]'))) and pg_temp.refused(jsonb_build_object('stress_curve',pg_temp.hours('[{"at":"2026-03-20T08:00:00Z","value":50,"band":"medium"},{"at":"2026-03-20T09:00:00Z","value":null,"band":null,"reason":"asleep"}]'))),'an hour with no value carries no figure or band and one of the four reasons, or it is refused: never a zero');
select ok(pg_temp.refused(jsonb_build_object('stress_curve',pg_temp.hours('[{"at":"2026-03-20T08:00:00Z","value":null,"band":null,"reason":"moving"}]'))) and pg_temp.refused(jsonb_build_object('stress_curve',pg_temp.hours('[]'))),'a curve with no hour that has a value, or no hour at all, is no curve');
select ok(pg_temp.refused(jsonb_build_object('stress_curve',pg_temp.hours('[{"at":"2026-03-20T09:00:00Z","value":50,"band":"medium"},{"at":"2026-03-20T08:00:00Z","value":50,"band":"medium"}]'))) and pg_temp.refused(jsonb_build_object('stress_curve',pg_temp.hours('[{"at":"2026-03-20T08:00:00Z","value":50,"band":"medium"},{"at":"2026-03-20T08:00:00Z","value":50,"band":"medium"}]'))),'hours out of order or repeated are refused');
select ok(pg_temp.refused(jsonb_build_object('stress_curve',jsonb_build_object('version','stress-curve.candidate.v1','hours',(select jsonb_agg(jsonb_build_object('at',to_char(timestamptz '2026-03-20 00:00+00' + k * interval '1 hour','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'value',50,'band','medium') order by k) from generate_series(0,24) k)))),'more than twenty-four hours is refused');
select ok(pg_temp.refused(jsonb_build_object('stress_curve',jsonb_set(pg_temp.stress(),'{version}','"stress-curve.v1"'))) and pg_temp.refused(jsonb_build_object('stress_curve',pg_temp.stress() || '{"trend":"rising"}')) and pg_temp.refused(jsonb_build_object('stress_curve',pg_temp.hours('[{"at":"2026-03-20T08:00:00Z","value":50,"band":"medium","heart_rate":61}]'))) and pg_temp.refused(jsonb_build_object('stress_curve','[]'::jsonb)),'another version, an extra key anywhere or a bare array is refused');
select ok(pg_temp.write(jsonb_build_object('form_curve',pg_temp.curve(),'backfilled',true,'form',jsonb_build_object('reason','intraday_inputs_unavailable'),'weight',jsonb_build_object('reason','calendar_demand_unavailable')),5)->>'error'='invalid_request' and pg_temp.write(jsonb_build_object('stress_curve',pg_temp.stress(),'backfilled',true,'form',jsonb_build_object('reason','intraday_inputs_unavailable'),'weight',jsonb_build_object('reason','calendar_demand_unavailable')),5)->>'error'='invalid_request','a backfilled row never carries a curve');
select is(pg_temp.write(jsonb_build_object('form_curve',pg_temp.curve(96)))->>'written','true','and ninety-six points is the most a Form curve holds');

-- The payload limit moved from 16 KiB to 32 KiB so an owner with every column on keeps their scores.
create function pg_temp.band_of(signal text,method text,shrunk boolean) returns jsonb language sql as $$
  select jsonb_build_object('signal',signal,'method',method,'state','personal','low',40.123456,'centre',45.123456,'high',52.123456,'own_days',21,'days_until_personal',0,
    'own_share',case when shrunk then 0.912345 else 1 end,'window_days',30,'estimator',case when shrunk then 'shrunk_predictive' else 'own_mean_sd' end) $$;
create function pg_temp.part(key text,score numeric,share numeric,points numeric,over jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('key',key,'state','available','score',score,'share',share,'points',points,'direction','usual','signals','["overnight_hrv","resting_heart_rate","movement"]'::jsonb,
    'baseline',jsonb_build_object('state','personal','own_days',21,'own_share',0.912345,'days_until_personal',0)) || over $$;
create function pg_temp.parts() returns jsonb language sql as $$
  select jsonb_build_object(
    'recovery',jsonb_build_array(pg_temp.part('sleep',80,0.5,40,jsonb_build_object('direction',null,'need_minutes',462,'need_basis','blended_average')),pg_temp.part('hrv',70,0.3,21),pg_temp.part('resting_heart_rate',55,0.2,11)),
    'form',jsonb_build_array(pg_temp.part('from_the_night',70,0.4,28),pg_temp.part('sleep_midpoint',80,0.1,8),pg_temp.part('daylight',50,0.1,5),pg_temp.part('movement',60,0.2,12),pg_temp.part('stress',55,0.2,11)),
    'weight',jsonb_build_array(pg_temp.part('calendar',40,0.636364,25.45456),pg_temp.part('physical_load',70,0.363636,25.45452))) $$;
create function pg_temp.biggest() returns jsonb language sql as $$
  select pg_temp.ctx(jsonb_build_object(
    'form_curve',pg_temp.curve(96,'{}'),'stress_curve',(select jsonb_build_object('version','stress-curve.candidate.v1','hours',jsonb_agg(jsonb_build_object('at',to_char(timestamptz '2026-03-20 00:00+00' + k * interval '1 hour','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'value',50.5,'band','medium') order by k)) from generate_series(0,23) k),
    'day_load',pg_temp.load(),'components',pg_temp.parts(),
    'usual',(select jsonb_agg(pg_temp.band_of(s,case s when 'overnight_hrv' then 'rmssd' when 'resting_heart_rate' then 'overnight_resting' when 'wrist_temperature' then 'absolute' end,s in ('overnight_hrv','resting_heart_rate','sleep_midpoint','daylight','movement','stress_heart_rate')))
      from unnest(array['overnight_hrv','resting_heart_rate','sleep_midpoint','daylight','movement','stress_heart_rate','breathing_rate','spo2','wrist_temperature','awake_time','walking_heart_rate','steps','active_energy','vo2_max']) s),
    'drivers',jsonb_build_array('breathing rate far above usual','wrist temperature far below usual','blood oxygen far above usual','awake time in the night far above usual','walking heart rate far below usual'),
    'windows',jsonb_build_array(jsonb_build_object('start','08:00','end','10:00','kind','peak'),jsonb_build_object('start','11:00','end','12:00','kind','dip')),'windows_version','energy-windows.v1')) $$;
select ok(octet_length(pg_temp.biggest()::text) between 14000 and 32767,'a row with a full Form curve, a full stress curve, the day load, the parts, every band and the energy windows is within a kilobyte or two of the old 16 KiB limit and under the new one');
select is(pg_temp.h('context_write','day-owner',pg_temp.biggest())->>'written','true','and is written');
select is(pg_temp.h('context_write','day-owner',pg_temp.ctx(jsonb_build_object('tags',(select jsonb_agg(repeat('x',30)) from generate_series(1,9)),'usual',(select jsonb_agg(pg_temp.band_of('steps',null,false)) from generate_series(1,2000)))))->>'error','invalid_request','and a row over 32 KiB is refused whole, with nothing written');

-- Withdrawing storage deletes the row, and the load and both curves with it.
select pg_temp.write(jsonb_build_object('day_load',pg_temp.load(),'form_curve',pg_temp.curve(),'stress_curve',pg_temp.stress()));
select pg_temp.h('consent_withdraw','day-owner',jsonb_build_object('request_id','withdraw-day-01','source','apple','purpose','storage_compute','expected_epoch',1));
select is((select count(*)::int from public.health_context_daily where user_id='f1000000-0000-0000-0000-0000000000b1'),0,'withdrawing storage deletes every row, and the load and the curves with them');
select is(pg_temp.write(jsonb_build_object('day_load',pg_temp.load()))->>'error','consent_required','and a write after the withdrawal is refused');
select ok(not (pg_temp.h('scores_read','day-owner')::text ~ 'day_load|form_curve|stress_curve'),'and the scores read returns none of them');

select * from finish();
rollback;
