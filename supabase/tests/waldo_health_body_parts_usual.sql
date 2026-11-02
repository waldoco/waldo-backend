begin;
create extension if not exists pgtap with schema extensions;
select plan(31);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- Health contract revision 8: the parts of each score and the owner's usual, on the derived row in columns of their own (ADR-0081
-- component scores). Written through the current writer in their closed shapes only, returned by the app's scores read and
-- history, never by the model's read. Synthetic values.
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
create function pg_temp.pillar(score int,zone text) returns jsonb language sql as $$
  select jsonb_build_object('score',score,'zone',zone,'algorithm_version','recovery.v5','activation','accepted','hrv_method','rmssd','confidence',0.8) $$;
create function pg_temp.ctx(extra jsonb default '{}',days_back int default 0) returns jsonb language sql as $$
  select jsonb_build_object('day',to_char((now() at time zone 'UTC')::date-days_back,'YYYY-MM-DD'),'timezone','UTC',
    'basis',jsonb_build_array(jsonb_build_object('source','apple','consent_epoch',1)),
    'form',pg_temp.pillar(64,'good'),'recovery',pg_temp.pillar(72,'good'),'weight',pg_temp.pillar(51,'moderate'),'freshness','fresh') || extra $$;
create function pg_temp.write(extra jsonb default '{}') returns jsonb language sql as $$ select pg_temp.h('context_write','parts-owner',pg_temp.ctx(extra)) $$;
create function pg_temp.part(key text,score numeric,share numeric,points numeric,over jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('key',key,'state','available','score',score,'share',share,'points',points,'direction','usual','signals','[]'::jsonb,
    'baseline',jsonb_build_object('state','personal','own_days',21,'own_share',0.9)) || over $$;
create function pg_temp.sleep(over jsonb default '{}') returns jsonb language sql as $$
  select pg_temp.part('sleep',80,0.5,40,jsonb_build_object('direction',null,'need_minutes',462,'need_basis','blended_average')) || over $$;
create function pg_temp.recovery(extra jsonb default '[]') returns jsonb language sql as $$
  select jsonb_build_array(pg_temp.sleep(),pg_temp.part('hrv',70,0.3,21),pg_temp.part('resting_heart_rate',55,0.2,11)) $$;
create function pg_temp.form() returns jsonb language sql as $$
  select jsonb_build_array(pg_temp.part('from_the_night',70,0.4,28),pg_temp.part('sleep_midpoint',80,0.1,8),pg_temp.part('daylight',50,0.1,5),
    pg_temp.part('movement',60,0.2,12),pg_temp.part('stress',55,0.2,11)) $$;
create function pg_temp.weight() returns jsonb language sql as $$
  select jsonb_build_array(pg_temp.part('calendar',40,0.636364,25.45456),pg_temp.part('physical_load',70,0.363636,25.45452)) $$;
create function pg_temp.parts(over jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('recovery',pg_temp.recovery(),'form',pg_temp.form(),'weight',pg_temp.weight()) || over $$;
create function pg_temp.band(signal text,over jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('signal',signal,'method',case signal when 'overnight_hrv' then 'rmssd' when 'resting_heart_rate' then 'overnight_resting' else null end,
    'state','personal','low',40,'centre',45,'high',52,'own_days',21,'own_share',case when signal in ('overnight_hrv','resting_heart_rate','sleep_midpoint','daylight','movement','stress_heart_rate') then 0.9 else 1 end,
    'window_days',30,'estimator',case when signal in ('overnight_hrv','resting_heart_rate','sleep_midpoint','daylight','movement','stress_heart_rate') then 'shrunk_predictive' else 'own_mean_sd' end) || over $$;
create function pg_temp.usual() returns jsonb language sql as $$
  select jsonb_build_array(pg_temp.band('overnight_hrv'),pg_temp.band('resting_heart_rate'),pg_temp.band('breathing_rate'),pg_temp.band('spo2')) $$;
create function pg_temp.refused_parts(parts jsonb) returns boolean language sql as $$ select pg_temp.write(jsonb_build_object('components',parts))->>'error' = 'invalid_request' $$;
create function pg_temp.refused_usual(usual jsonb) returns boolean language sql as $$ select pg_temp.write(jsonb_build_object('usual',usual))->>'error' = 'invalid_request' $$;
create function pg_temp.hist(n int default 30) returns jsonb language sql as $$ select pg_temp.h('scores_history','parts-owner',jsonb_build_object('days',n))->'history'->'days' $$;

insert into auth.users(id,email) values ('f1000000-0000-0000-0000-0000000000a1','parts@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('f3000000-0000-0000-0000-0000000000a3','f1000000-0000-0000-0000-0000000000a1','parts-owner','parts@example.invalid');
select is(pg_temp.h('consent_grant','parts-owner',pg_temp.grant_body('grant-p-storage1','storage_compute'))->'consent'->>'status','granted','the owner grants storage');
select is(pg_temp.h('consent_grant','parts-owner',pg_temp.grant_body('grant-p-model0001','model_processing'))->'consent'->>'status','granted','and model use');

select col_type_is('public','health_context_daily','components','jsonb','the derived row has a components column');
select col_type_is('public','health_context_daily','usual','jsonb','and a usual column');
select ok((select relrowsecurity from pg_class where oid='public.health_context_daily'::regclass),'row level security is still on for the table that holds them');

-- Written in their closed shapes, read back by the app's reads.
select is(pg_temp.write(jsonb_build_object('components',pg_temp.parts(),'usual',pg_temp.usual()))->>'written','true','a row with parts and usual bands is written');
select is(pg_temp.h('scores_read','parts-owner')->'scores'->'components',pg_temp.parts(),'the app''s scores read returns the parts as written');
select is(pg_temp.h('scores_read','parts-owner')->'scores'->'usual',pg_temp.usual(),'and the bands as written');
select is(pg_temp.hist(7)->0->'components',pg_temp.parts(),'the score history returns each day''s parts');
select ok(not (pg_temp.hist(7)->0 ? 'usual'),'and never the bands');

-- The model's read is not given either column, nor anything in a pillar.
select ok(not (pg_temp.model_read('parts-owner')->'context' ? 'components'),'the model''s read has no parts');
select ok(not (pg_temp.model_read('parts-owner')->'context' ? 'usual'),'and no usual bands');
select is(pg_temp.model_read('parts-owner')->'context'->'recovery',pg_temp.pillar(72,'good'),'its pillar is the pillar as written, with nothing of the parts in it');
select ok(pg_temp.model_read('parts-owner')::text !~ '(points|own_share|need_minutes|above_usual|below_usual|estimator)','and none of their words reach it anywhere');

-- A row written without them clears them, so nothing outlives the recompute that had none.
select is(pg_temp.write()->>'written','true','a row written without parts or bands lands');
select ok(not (pg_temp.h('scores_read','parts-owner')->'scores' ? 'components') and not (pg_temp.h('scores_read','parts-owner')->'scores' ? 'usual'),'and clears both, so the read has neither key');
select ok(not (pg_temp.hist(7)->0 ? 'components'),'and the history day has none');
select is(pg_temp.write(jsonb_build_object('components',pg_temp.parts()-'form'-'weight'))->>'written','true','parts for one pillar alone are written');

-- Parts are refused whole outside the closed shape, so no figure can ride a key.
select is((select count(*)::int from unnest(array[
  'null','[]','{}','"parts"','{"recovery":[]}','{"cardio":[]}',
  pg_temp.parts('{"mood":[]}')::text,
  pg_temp.parts(jsonb_build_object('recovery',jsonb_build_array(pg_temp.part('daylight',50,1,50))))::text,
  pg_temp.parts(jsonb_build_object('recovery',pg_temp.recovery() || jsonb_build_array(pg_temp.part('hrv',70,0.3,21))))::text,
  pg_temp.parts(jsonb_build_object('recovery',jsonb_build_array(pg_temp.sleep('{"score":101}'),pg_temp.part('hrv',70,0.5,21))))::text,
  pg_temp.parts(jsonb_build_object('recovery',jsonb_build_array(pg_temp.sleep(),pg_temp.part('hrv',70,0.3,21,'{"direction":"above usual (62)"}'),pg_temp.part('resting_heart_rate',55,0.2,11))))::text,
  pg_temp.parts(jsonb_build_object('recovery',jsonb_build_array(pg_temp.sleep(),pg_temp.part('hrv',70,0.3,21,'{"direction":"good"}'),pg_temp.part('resting_heart_rate',55,0.2,11))))::text,
  pg_temp.parts(jsonb_build_object('recovery',jsonb_build_array(pg_temp.sleep(),pg_temp.part('hrv',70,0.3,21,'{"signals":["hrv"]}'),pg_temp.part('resting_heart_rate',55,0.2,11))))::text,
  pg_temp.parts(jsonb_build_object('recovery',jsonb_build_array(pg_temp.sleep(),pg_temp.part('hrv',70,0.3,21,'{"target":80}'),pg_temp.part('resting_heart_rate',55,0.2,11))))::text,
  pg_temp.parts(jsonb_build_object('recovery',jsonb_build_array(pg_temp.sleep(),pg_temp.part('hrv',70,0.3,21,'{"need_minutes":480}'),pg_temp.part('resting_heart_rate',55,0.2,11))))::text,
  pg_temp.parts(jsonb_build_object('recovery',jsonb_build_array(pg_temp.part('sleep',80,0.5,40,'{"direction":null}'),pg_temp.part('hrv',70,0.3,21),pg_temp.part('resting_heart_rate',55,0.2,11))))::text
]::jsonb[]) bad where pg_temp.refused_parts(bad)),16,'parts outside their closed shape are refused whole');
select is((select count(*)::int from unnest(array[
  pg_temp.parts(jsonb_build_object('recovery',jsonb_build_array(pg_temp.sleep('{"need_minutes":300}'),pg_temp.part('hrv',70,0.3,21),pg_temp.part('resting_heart_rate',55,0.2,11))))::text,
  pg_temp.parts(jsonb_build_object('recovery',jsonb_build_array(pg_temp.sleep('{"need_minutes":462.5}'),pg_temp.part('hrv',70,0.3,21),pg_temp.part('resting_heart_rate',55,0.2,11))))::text,
  pg_temp.parts(jsonb_build_object('recovery',jsonb_build_array(pg_temp.sleep('{"need_basis":"population"}'),pg_temp.part('hrv',70,0.3,21),pg_temp.part('resting_heart_rate',55,0.2,11))))::text,
  pg_temp.parts(jsonb_build_object('recovery',jsonb_build_array(pg_temp.sleep(),pg_temp.part('hrv',70,0.3,21,'{"baseline":{"state":"personal","own_days":5,"own_share":1}}'),pg_temp.part('resting_heart_rate',55,0.2,11))))::text,
  pg_temp.parts(jsonb_build_object('recovery',jsonb_build_array(pg_temp.sleep(),pg_temp.part('hrv',70,0.3,21,'{"baseline":{"state":"provisional","own_days":20,"own_share":1}}'),pg_temp.part('resting_heart_rate',55,0.2,11))))::text,
  pg_temp.parts(jsonb_build_object('recovery',jsonb_build_array(pg_temp.sleep(),pg_temp.part('hrv',70,0.3,21,'{"baseline":{"state":"personal","own_days":31,"own_share":1}}'),pg_temp.part('resting_heart_rate',55,0.2,11))))::text,
  pg_temp.parts(jsonb_build_object('recovery',jsonb_build_array(pg_temp.sleep(),pg_temp.part('hrv',70,0.3,21,'{"baseline":{"state":"personal","own_days":21,"own_share":1.2}}'),pg_temp.part('resting_heart_rate',55,0.2,11))))::text,
  pg_temp.parts(jsonb_build_object('recovery',jsonb_build_array(pg_temp.sleep(),pg_temp.part('hrv',70,0.3,21,'{"baseline":{"state":"personal","own_days":21}}'),pg_temp.part('resting_heart_rate',55,0.2,11))))::text,
  -- shares and points have to be the pillar's own: the points add up to its stored score and the shares to one
  pg_temp.parts(jsonb_build_object('recovery',jsonb_build_array(pg_temp.sleep(),pg_temp.part('hrv',70,0.3,21),pg_temp.part('resting_heart_rate',55,0.2,30))))::text,
  pg_temp.parts(jsonb_build_object('recovery',jsonb_build_array(pg_temp.sleep(),pg_temp.part('hrv',70,0.4,21),pg_temp.part('resting_heart_rate',55,0.2,11))))::text,
  pg_temp.parts(jsonb_build_object('recovery',jsonb_build_array(pg_temp.sleep(),pg_temp.part('hrv',70,0.3,21))))::text,
  pg_temp.parts(jsonb_build_object('recovery',jsonb_build_array(pg_temp.sleep('{"state":"unavailable","reason":"no_reading"}'))))::text
]::jsonb[]) bad where pg_temp.refused_parts(bad)),12,'the need, the baseline and the sums are held to their closed rules as well');
select is((select count(*)::int from unnest(array[
  jsonb_build_object('recovery',jsonb_build_array(pg_temp.sleep('{"state":"unavailable","reason":"nothing"}'))),
  jsonb_build_object('recovery',jsonb_build_array(pg_temp.sleep(),pg_temp.part('hrv',70,0.5,35,'{"state":"unavailable","reason":"no_reading"}'),pg_temp.part('resting_heart_rate',55,0.2,11))),
  jsonb_build_object('recovery',pg_temp.recovery(),'weight',jsonb_build_array(pg_temp.part('calendar',40,1,40),jsonb_build_object('key','physical_load','state','unavailable','reason','no_reading','score',0)))
]::jsonb[]) bad where pg_temp.refused_parts(bad)),3,'an unavailable part carries its reason and nothing else, and the reason is one of two');
select is(pg_temp.write(jsonb_build_object('components',jsonb_build_object('recovery',jsonb_build_array(pg_temp.sleep(),pg_temp.part('hrv',64,0.5,32),jsonb_build_object('key','resting_heart_rate','state','unavailable','reason','baseline_immature')))))->>'written','true',
  'a part with no baseline yet is written as unavailable with its reason, the shares of the parts that had a reading adding to one');
select ok(pg_temp.h('context_write','parts-owner',pg_temp.ctx(jsonb_build_object('components',pg_temp.parts(),'form',jsonb_build_object('reason','intraday_inputs_unavailable'))))->>'error' = 'invalid_request',
  'parts for a pillar the row holds as unavailable are refused');

-- Bands are refused outside theirs.
select is(pg_temp.write(jsonb_build_object('usual',jsonb_build_array(pg_temp.band('sleep_midpoint','{"low":1400,"centre":1430,"high":20}'))))->>'written','true','a sleep-midpoint band that crosses midnight is written');
select is(pg_temp.write(jsonb_build_object('usual',jsonb_build_array(pg_temp.band('sleep_midpoint','{"low":170,"centre":180,"high":190}'),pg_temp.band('wrist_temperature','{"method":"baseline_delta","low":-0.4,"centre":0.1,"high":0.6}'))))->>'written','true','one that does not, and a band below zero, are written');
select is((select count(*)::int from unnest(array[
  'null','[]','{}','"bands"','[{}]',
  jsonb_build_array(pg_temp.band('overnight_hrv'),pg_temp.band('overnight_hrv'))::text,
  jsonb_build_array(pg_temp.band('overnight_hrv','{"low":50}'))::text, jsonb_build_array(pg_temp.band('overnight_hrv','{"high":41}'))::text,
  jsonb_build_array(pg_temp.band('overnight_hrv','{"method":null}'))::text, jsonb_build_array(pg_temp.band('overnight_hrv','{"method":"overnight_resting"}'))::text,
  jsonb_build_array(pg_temp.band('breathing_rate','{"method":"rmssd"}'))::text, jsonb_build_array(pg_temp.band('wrist_temperature','{"method":null}'))::text,
  jsonb_build_array(pg_temp.band('overnight_hrv','{"estimator":"own_mean_sd"}'))::text, jsonb_build_array(pg_temp.band('breathing_rate','{"estimator":"shrunk_predictive"}'))::text,
  jsonb_build_array(pg_temp.band('overnight_hrv','{"state":"provisional"}'))::text, jsonb_build_array(pg_temp.band('overnight_hrv','{"own_days":9}'))::text,
  jsonb_build_array(pg_temp.band('breathing_rate','{"own_share":0.5}'))::text, jsonb_build_array(pg_temp.band('overnight_hrv','{"own_days":31}'))::text,
  jsonb_build_array(pg_temp.band('overnight_hrv','{"window_days":60}'))::text, jsonb_build_array(pg_temp.band('overnight_hrv','{"signal":"sleep_score"}'))::text,
  jsonb_build_array(pg_temp.band('overnight_hrv','{"target":44}'))::text, jsonb_build_array(pg_temp.band('overnight_hrv','{"low":"40"}'))::text,
  jsonb_build_array(pg_temp.band('sleep_midpoint','{"low":1500,"centre":1430,"high":20}'))::text, jsonb_build_array(pg_temp.band('sleep_midpoint','{"low":1400,"centre":600,"high":20}'))::text,
  jsonb_build_array(pg_temp.band('sleep_midpoint','{"low":700,"centre":650,"high":800}'))::text
]::jsonb[]) bad where pg_temp.refused_usual(bad)),23,'bands outside their closed shape are refused whole');

-- A backfilled row never carries either.
select ok(pg_temp.h('context_write','parts-owner',pg_temp.ctx(jsonb_build_object('components',jsonb_build_object('recovery',jsonb_build_array(pg_temp.sleep('{"share":1,"points":72}'))),'backfilled',true,'form',jsonb_build_object('reason','intraday_inputs_unavailable'),'weight',jsonb_build_object('reason','calendar_demand_unavailable')),5))->>'error' = 'invalid_request','a backfilled row never carries parts');
select ok(pg_temp.h('context_write','parts-owner',pg_temp.ctx(jsonb_build_object('usual',pg_temp.usual(),'backfilled',true,'form',jsonb_build_object('reason','intraday_inputs_unavailable'),'weight',jsonb_build_object('reason','calendar_demand_unavailable')),5))->>'error' = 'invalid_request','nor bands');

-- The functions that hold the shapes are not callable by a client.
select ok(not has_function_privilege('anon','waldo.health_parts_valid(text,jsonb,numeric)','execute') and not has_function_privilege('authenticated','waldo.health_usual_valid(jsonb)','execute'),'the shape checks are not granted to a client role');

-- A row at its largest still fits the writer's size limit.
select ok(octet_length((pg_temp.ctx(jsonb_build_object('components',pg_temp.parts(),'usual',(select jsonb_agg(pg_temp.band(s)) from unnest(array['overnight_hrv','resting_heart_rate','sleep_midpoint','daylight','movement','stress_heart_rate','breathing_rate','spo2','wrist_temperature','awake_time','walking_heart_rate','active_energy']) s))))::text) < 16384,'a row with every part and band is under the writer''s byte limit');

-- Withdrawing storage deletes the row and the columns with it.
select pg_temp.write(jsonb_build_object('components',pg_temp.parts(),'usual',pg_temp.usual()));
select pg_temp.h('consent_withdraw','parts-owner',jsonb_build_object('request_id','withdraw-parts-01','source','apple','purpose','storage_compute','expected_epoch',1));
select is((select count(*)::int from public.health_context_daily where user_id='f1000000-0000-0000-0000-0000000000a1'),0,'withdrawing storage deletes the row, and its parts and bands with it');

select * from finish();
rollback;
