begin;
create extension if not exists pgtap with schema extensions;
select plan(19);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- Health contract revision 17: wellbeing kinds, stored only under a storage grant on copy 5. Readings go in through the real
-- ingest and out through the real series read. Synthetic owners and synthetic values throughout.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.iso(t timestamptz) returns text language sql as $$ select to_char(t at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') $$;
create function pg_temp.grant_(owner text,rid text,source text,version int) returns jsonb language sql as $$
  select pg_temp.h('consent_grant',owner,jsonb_build_object('request_id',rid,'source',source,'purpose','storage_compute','version',version,'expected_epoch',0,'age_attested_18_plus',true)) $$;
-- A point record three hours ago.
create function pg_temp.point(id text,signal text,unit text,val numeric,extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('sample_id',id,'revision',0,'signal',signal,'unit',unit,'value',val,'day',((now()-interval '180 minutes') at time zone 'UTC')::date,
    'start_at',pg_temp.iso(now()-interval '180 minutes'),'end_at',pg_temp.iso(now()-interval '180 minutes'),'utc_offset_minutes',0) || extra $$;
-- The local hour that ended two hours ago, in UTC.
create function pg_temp.hour_(id text,signal text,unit text,val numeric,extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('sample_id',id,'revision',0,'signal',signal,'unit',unit,'value',val,'day',((date_trunc('hour',now())-interval '3 hours') at time zone 'UTC')::date,
    'start_at',pg_temp.iso(date_trunc('hour',now())-interval '3 hours'),'end_at',pg_temp.iso(date_trunc('hour',now())-interval '2 hours'),'utc_offset_minutes',0) || extra $$;
create function pg_temp.batch(rid text,samples jsonb,per_sample boolean default true) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','apple','consent_epoch',1,'timezone','UTC','anchor_before',null,'anchor_after','a-'||rid,'samples',samples,'deletions','[]'::jsonb)
    || case when per_sample then '{"rejection":"per_sample"}'::jsonb else '{}'::jsonb end $$;
create function pg_temp.reject(idx int,signal text,reason text) returns jsonb language sql as $$ select jsonb_build_object('change','sample','index',idx,'signal',signal,'reason',reason) $$;
create function pg_temp.stored(owner text,sid text) returns jsonb language sql as $$
  select s.payload from waldo.health_samples s join waldo.owners o on o.id=s.owner_id where o.do_name=owner and s.sample_id=sid $$;
create function pg_temp.mood() returns jsonb language sql as $$ select '{"kind":"momentary_emotion","labels":["stressed","drained"],"associations":["work"]}'::jsonb $$;
create function pg_temp.steps(id text) returns jsonb language sql as $$ select pg_temp.hour_(id,'steps_window','count',412) $$;
create function pg_temp.seven() returns jsonb language sql as $$ select jsonb_build_array(
  pg_temp.point('HK:water','hydration','millilitres',350,'{"origin":{"read_api":"healthkit"}}'), pg_temp.point('HK:coffee','caffeine','milligrams',95), pg_temp.point('HK:wine','alcoholic_drinks','count',1),
  pg_temp.point('HK:som','state_of_mind','valence',-0.4,pg_temp.mood()), pg_temp.point('HK:breath','sleep_breathing_disturbances','per_hour',3.2),
  pg_temp.hour_('HK:sound','audio_exposure_window','decibels',71.5,'{"method":"environmental"}'), pg_temp.point('HK:steady','walking_steadiness','percent',88)) $$;

insert into auth.users(id,email) values ('7f100000-0000-0000-0000-0000000000a1','copy2@example.invalid'),('7f100000-0000-0000-0000-0000000000a2','copy5@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values
  ('7f300000-0000-0000-0000-0000000000a1','7f100000-0000-0000-0000-0000000000a1','copy2-owner','copy2@example.invalid'),
  ('7f300000-0000-0000-0000-0000000000a2','7f100000-0000-0000-0000-0000000000a2','copy5-owner','copy5@example.invalid');

-- The copy a grant names: a device source may name 2 or 5, and the grant keeps it; WHOOP stays on 4.
select is(pg_temp.grant_('copy2-owner','grant-copy2-st1','apple',2)->'consent'->>'version','2','a grant on copy 2 is stored on copy 2');
select is(pg_temp.grant_('copy5-owner','grant-copy5-st1','apple',5)->'consent'->>'version','5','a grant on copy 5 is stored on copy 5');
select is(pg_temp.grant_('copy5-owner','grant-copy5-hc1','health_connect',3)->>'error','invalid_request','a device source may not name a copy it never offered');
select is(pg_temp.grant_('copy5-owner','grant-copy5-wh1','whoop',5)->>'error','invalid_request','WHOOP may not name the device copy');

-- Under copy 2, each wellbeing reading comes back consent_required and the rest of the batch is stored.
create temp table early as select pg_temp.h('ingest','copy2-owner',pg_temp.batch('copy2-mixed-001',pg_temp.seven() || jsonb_build_array(pg_temp.steps('HK:steps-1')))) as r;
select is((select r->>'accepted' from early),'1','under copy 2 the steps are stored');
select is((select r->'rejected' from early),jsonb_build_array(pg_temp.reject(0,'hydration','consent_required'),pg_temp.reject(1,'caffeine','consent_required'),
  pg_temp.reject(2,'alcoholic_drinks','consent_required'),pg_temp.reject(3,'state_of_mind','consent_required'),pg_temp.reject(4,'sleep_breathing_disturbances','consent_required'),
  pg_temp.reject(5,'audio_exposure_window','consent_required'),pg_temp.reject(6,'walking_steadiness','consent_required')),'and every wellbeing reading is named consent_required');
select ok(pg_temp.stored('copy2-owner','HK:water') is null and pg_temp.stored('copy2-owner','HK:som') is null,'and none is stored');
select is(pg_temp.h('ingest','copy2-owner',pg_temp.batch('copy2-whole-001',jsonb_build_array(pg_temp.steps('HK:steps-2'),pg_temp.point('HK:water-2','hydration','millilitres',350)),false))->>'error',
  'invalid_request','a batch without per-sample rejection is refused whole');
select ok(pg_temp.stored('copy2-owner','HK:steps-2') is null,'so the steps before it are not kept');

-- Under copy 5, all seven are stored as sent.
select is(pg_temp.h('ingest','copy5-owner',pg_temp.batch('copy5-all-0001',pg_temp.seven()))->>'accepted','7','under copy 5 all seven kinds are stored');
select is(pg_temp.stored('copy5-owner','HK:som')->'labels','["stressed","drained"]'::jsonb,'a state of mind keeps its labels');

-- Each kind's shape is closed.
create temp table bad as select pg_temp.h('ingest','copy5-owner',pg_temp.batch('copy5-bad-0001',jsonb_build_array(
  pg_temp.point('b0','hydration','fluid_ounces',12),
  pg_temp.point('b1','caffeine','milligrams',4000),
  pg_temp.point('b2','state_of_mind','valence',0.5,'{"kind":"momentary_emotion","labels":["elated"]}'),
  pg_temp.point('b3','state_of_mind','valence',0.5,'{"kind":"momentary_emotion","labels":["calm","calm"]}'),
  pg_temp.point('b4','state_of_mind','valence',0.5,'{"kind":"momentary_emotion","note":"after the board call"}'),
  pg_temp.point('b5','state_of_mind','valence',0.5),
  pg_temp.hour_('b6','audio_exposure_window','decibels',71),
  pg_temp.point('b7','audio_exposure_window','decibels',71,'{"method":"headphone"}'),
  pg_temp.point('b8','walking_steadiness','percent',0.88,'{"name":"steady"}')))) as r;
select is((select r->>'accepted' from bad),'0','no malformed wellbeing reading is stored');
select is((select jsonb_agg(e->>'reason') from jsonb_array_elements((select r->'rejected' from bad)) e),
  '["invalid_sample","invalid_sample","invalid_sample","invalid_sample","invalid_sample","invalid_sample","invalid_sample","invalid_sample","invalid_sample"]'::jsonb,
  'a wrong unit, a value past its bound, an unknown or repeated label, free text, a missing kind or method, an hour that is not an hour and an unnamed key are each refused');
select ok((select r from bad)::text !~ 'board call|elated|fluid','the receipt carries no text of a refused reading');

-- The series read returns the kinds, a state of mind's kind, labels and associations, and a sound level's method.
create temp table read_ as select pg_temp.h('series_read','copy5-owner',jsonb_build_object('from',((now() at time zone 'UTC')::date-1)::text,'to',((now() at time zone 'UTC')::date)::text,
  'signals','["hydration","caffeine","alcoholic_drinks","state_of_mind","sleep_breathing_disturbances","audio_exposure_window","walking_steadiness"]'::jsonb)) as r;
select is((select count(*)::int from jsonb_array_elements((select r->'sources'->0->'samples' from read_))),7,'the read returns all seven');
select is((select s->'mood' from jsonb_array_elements((select r->'sources'->0->'samples' from read_)) s where s->>'signal'='state_of_mind'),pg_temp.mood(),'a state of mind reads back its kind, labels and associations');
select is((select s->>'method' from jsonb_array_elements((select r->'sources'->0->'samples' from read_)) s where s->>'signal'='audio_exposure_window'),'environmental','a sound level reads back its method');
select ok((select r from read_)::text !~ 'healthkit','and nothing of where it was read from');

-- Withdrawing storage removes every wellbeing reading with the rest.
select pg_temp.h('consent_withdraw','copy5-owner',jsonb_build_object('request_id','withdraw-copy5-1','source','apple','purpose','storage_compute','expected_epoch',1));
select is((select count(*)::int from waldo.health_samples s join waldo.owners o on o.id=s.owner_id where o.do_name='copy5-owner' and s.payload is not null),0,'a storage withdrawal purges them');

select * from finish();
rollback;
