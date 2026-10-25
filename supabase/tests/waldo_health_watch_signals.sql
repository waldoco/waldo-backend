begin;
create extension if not exists pgtap with schema extensions;
select plan(20);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- The Apple Watch wellness tier: five new signals, a method-dependent temperature scale, and sleep stage totals on the
-- series read. Every reading here is synthetic.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.iso(t timestamptz) returns text language sql as $$ select to_char(t at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') $$;
create function pg_temp.point(id text,sig text,unit text,val numeric,extra jsonb default '{}',minutes int default 1) returns jsonb language sql as $$
  select jsonb_build_object('sample_id',id,'revision',1,'signal',sig,'unit',unit,'value',val,'day',((now()-make_interval(mins=>minutes+180)) at time zone 'UTC')::date,
    'start_at',pg_temp.iso(now()-make_interval(mins=>minutes+180)),'end_at',pg_temp.iso(now()-interval '180 minutes'),'utc_offset_minutes',0) || extra $$;
create function pg_temp.batch(rid text,samples jsonb,deletions jsonb default '[]',per_sample boolean default false) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','apple','consent_epoch',1,'timezone','UTC','anchor_before',null,'anchor_after','a-'||rid,'samples',samples,'deletions',deletions)
    || case when per_sample then '{"rejection":"per_sample"}'::jsonb else '{}'::jsonb end $$;
create function pg_temp.rejected(sig text,idx int,rsn text default 'invalid_sample') returns jsonb language sql as $$
  select jsonb_build_object('change','sample','index',idx,'signal',sig,'reason',rsn) $$;
create function pg_temp.stored(sid text) returns jsonb language sql as $$
  select s.payload from waldo.health_samples s join waldo.owners o on o.id=s.owner_id where o.do_name='watch-owner' and s.sample_id=sid $$;
create function pg_temp.series(signals jsonb) returns jsonb language sql as $$
  select pg_temp.h('series_read','watch-owner',jsonb_build_object('from',((now() at time zone 'UTC')::date-2)::text,'to',((now() at time zone 'UTC')::date+1)::text,'signals',signals)) $$;
insert into auth.users(id,email) values ('3a100000-0000-0000-0000-0000000000a1','watch@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('3a300000-0000-0000-0000-0000000000a3','3a100000-0000-0000-0000-0000000000a1','watch-owner','watch@example.invalid');
select pg_temp.h('consent_grant','watch-owner',jsonb_build_object('request_id','grant-watch-st1','source','apple','purpose','storage_compute','version',2,'expected_epoch',0,'age_attested_18_plus',true));

-- Every new signal is stored, in either mode.
select is(pg_temp.h('ingest','watch-owner',pg_temp.batch('watch-all-000001',jsonb_build_array(
  pg_temp.point('t-abs','wrist_temperature','celsius',34.2,'{"method":"absolute"}'),
  pg_temp.point('t-delta','wrist_temperature','celsius',-0.4,'{"method":"baseline_delta"}'),
  pg_temp.point('walk','walking_heart_rate_average','beats_per_minute',101),
  pg_temp.point('vo2','vo2_max','ml_per_kg_min',41.5),
  pg_temp.point('hrr','heart_rate_recovery','beats_per_minute',24),
  pg_temp.point('mind','mindful_duration','minutes',10,'{}',10))))->>'accepted','6','an older build''s batch of the five new signals is stored whole');
select is(pg_temp.stored('t-abs')->>'method','absolute','a temperature keeps its method');

-- Per sample: each bad reading of a new signal is named by its signal, and the Worker''s own rejection of one is accepted.
create temp table mixed as select pg_temp.h('ingest','watch-owner',pg_temp.batch('watch-mixed-0001',jsonb_build_array(
  pg_temp.point('f-temp','wrist_temperature','celsius',95,'{"method":"absolute"}'),
  pg_temp.point('d-temp','wrist_temperature','celsius',34.2,'{"method":"baseline_delta"}'),
  pg_temp.point('n-temp','wrist_temperature','celsius',34.2),
  pg_temp.point('s-temp','wrist_temperature','celsius',34.2,'{"method":"skin"}'),
  pg_temp.point('low-vo2','vo2_max','ml_per_kg_min',5),
  pg_temp.point('walk-unit','walking_heart_rate_average','count',101),
  pg_temp.point('hrr-neg','heart_rate_recovery','beats_per_minute',-1),
  pg_temp.point('mind-long','mindful_duration','minutes',1441),
  '{"rejected":"invalid_sample","signal":"mindful_duration"}'::jsonb,
  '{"rejected":"invalid_sample","signal":"wrist_temperature"}'::jsonb,
  pg_temp.point('hrr-ok','heart_rate_recovery','beats_per_minute',31)),'[]',true)) as r;
select is((select r->>'accepted' from mixed),'1','a per-sample batch stores its one good new reading');
select is((select r->'rejected' from mixed),jsonb_build_array(
  pg_temp.rejected('wrist_temperature',0),pg_temp.rejected('wrist_temperature',1),pg_temp.rejected('wrist_temperature',2),pg_temp.rejected('wrist_temperature',3),
  pg_temp.rejected('vo2_max',4),pg_temp.rejected('walking_heart_rate_average',5),pg_temp.rejected('heart_rate_recovery',6),pg_temp.rejected('mindful_duration',7),
  pg_temp.rejected('mindful_duration',8),pg_temp.rejected('wrist_temperature',9)),
  'and names every bad one, its own and the Worker''s, by the new signal: a Fahrenheit value, a delta on the absolute scale, no method, an unknown method, and out-of-bounds or wrong-unit readings');
select ok(pg_temp.stored('f-temp') is null and pg_temp.stored('d-temp') is null and pg_temp.stored('low-vo2') is null,'no rejected reading is stored');
select ok((select r from mixed)::text !~ '95|1441','the receipt carries no value of a rejected reading');
select is(pg_temp.h('ingest','watch-owner',pg_temp.batch('watch-old-bad01',jsonb_build_array(pg_temp.point('o-ok','vo2_max','ml_per_kg_min',40),pg_temp.point('o-bad','wrist_temperature','celsius',95,'{"method":"absolute"}'))))->>'error',
  'invalid_request','an older build''s batch with one bad new reading is refused whole');
select is(pg_temp.stored('o-ok'),null,'and stores nothing');
select is(pg_temp.h('ingest','watch-owner',pg_temp.batch('watch-unknown-01',jsonb_build_array('{"rejected":"unsupported_signal","signal":"blood_glucose"}'::jsonb),'[]',true))->>'error',
  'invalid_request','a Worker rejection naming a signal the backend still does not know is a fault');

-- Deletions name the new signals.
select is(pg_temp.h('ingest','watch-owner',pg_temp.batch('watch-del-000001','[]',jsonb_build_array(jsonb_build_object('sample_id','vo2','signal','vo2_max','revision',2),jsonb_build_object('sample_id','mind','signal','mindful_duration','revision',2))))->>'deleted',
  '2','a deletion of a new signal removes it');
select ok(pg_temp.stored('vo2') is null and pg_temp.stored('mind') is null,'the deleted readings are gone');
select throws_ok($$ insert into waldo.health_samples(owner_id,source,signal,sample_id,revision,epoch,payload,deleted_at) values ('3a300000-0000-0000-0000-0000000000a3','apple','blood_glucose','x',1,1,null,now()) $$,
  '23514',null,'the table still refuses a signal outside the list');

-- The series read takes every signal at once and returns the new ones with their methods.
select is(pg_temp.series('["sleep_duration","sleep_efficiency","sleep_midpoint","overnight_hrv","resting_heart_rate","daylight_duration","movement_duration","heart_rate_window","hrv_window","spo2","respiratory_rate","steps_window","active_energy_window","workout","wrist_temperature","walking_heart_rate_average","vo2_max","heart_rate_recovery","mindful_duration"]')->>'access',
  'granted','the series read takes all nineteen signals in one call');
select is((select jsonb_agg(jsonb_build_array(s->'value',s->'method',s->'signal') order by s->>'start_at', s->>'method') from jsonb_array_elements(pg_temp.series('["wrist_temperature"]')->'sources'->0->'samples') s),
  '[[34.2,"absolute","wrist_temperature"],[-0.4,"baseline_delta","wrist_temperature"]]'::jsonb,
  'each temperature reading comes back with its method');
select is(pg_temp.series('["sleep_duration","wrist_temperature","bogus"]')->>'error','invalid_request','an unknown signal is still refused');

-- A staged night: the series read returns its stage totals with its time asleep, and nothing for an unstaged reading.
select is(pg_temp.h('ingest','watch-owner',pg_temp.batch('watch-sleep-0001',jsonb_build_array(
  pg_temp.point('night-staged','sleep_duration','minutes',430,'{"method":"asleep_duration","stages":{"light":120,"deep":60,"rem":60,"unspecified":190,"awake":20}}',430),
  pg_temp.point('night-plain','sleep_duration','minutes',300,'{"method":"time_in_bed"}',300))))->>'accepted','2','a staged and an unstaged sleep reading are stored');
select is((select s->'stages' from jsonb_array_elements(pg_temp.series('["sleep_duration"]')->'sources'->0->'samples') s where (s->>'value')::numeric = 430),
  '{"light":120,"deep":60,"rem":60,"unspecified":190,"awake":20}'::jsonb,'the series read returns a staged night''s totals');
select ok(not exists (select 1 from jsonb_array_elements(pg_temp.series('["sleep_duration"]')->'sources'->0->'samples') s where (s->>'value')::numeric = 300 and s ? 'stages'),
  'and no stages key for a reading without them');
select ok(not exists (select 1 from jsonb_array_elements(pg_temp.series('["wrist_temperature","vo2_max"]')->'sources'->0->'samples') s where s ? 'stages'),
  'nor for any other signal');

-- Withdrawing storage deletes the new readings with the rest.
select pg_temp.h('consent_withdraw','watch-owner',jsonb_build_object('request_id','withdraw-watch-1','source','apple','purpose','storage_compute','expected_epoch',1));
select is((select count(*)::int from waldo.health_samples s join waldo.owners o on o.id=s.owner_id where o.do_name='watch-owner' and s.payload is not null),0,'withdrawing storage deletes every new-signal reading');

select * from finish();
rollback;
