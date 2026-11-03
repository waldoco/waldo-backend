begin;
create extension if not exists pgtap with schema extensions;
select plan(33);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.grant_body(rid text) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','apple','purpose','storage_compute','version',2,'expected_epoch',0,'age_attested_18_plus',true) $$;
create function pg_temp.iso(t timestamptz) returns text language sql as $$ select to_char(t at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') $$;
-- A night of sleep that ended `back` days ago, and an hourly step window of the same day.
create function pg_temp.sleep(id text,back int,val numeric) returns jsonb language sql as $$
  select jsonb_build_object('sample_id',id,'revision',extract(epoch from now())::bigint,'signal','sleep_duration','unit','minutes','value',val,
    'day',((now()-make_interval(days=>back)-interval '2 hours') at time zone 'UTC')::date,
    'start_at',pg_temp.iso(now()-make_interval(days=>back)-interval '9 hours'),'end_at',pg_temp.iso(now()-make_interval(days=>back)-interval '2 hours'),'utc_offset_minutes',0) $$;
create function pg_temp.steps(id text,val numeric) returns jsonb language sql as $$
  select jsonb_build_object('sample_id',id,'revision',extract(epoch from now())::bigint,'signal','steps_window','unit','count','value',val,
    'day',(date_trunc('hour',now()-interval '2 hours') at time zone 'UTC')::date,
    'start_at',pg_temp.iso(date_trunc('hour',now()-interval '2 hours')),'end_at',pg_temp.iso(date_trunc('hour',now()-interval '1 hour')),'utc_offset_minutes',0) $$;
create function pg_temp.batch(rid text,tz text,after_anchor text,samples jsonb) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','apple','consent_epoch',1,'timezone',tz,'anchor_before',null,'anchor_after',after_anchor,'samples',samples,'deletions','[]'::jsonb) $$;
create function pg_temp.read(owner text,days integer,signals text[]) returns jsonb language sql as $$ select pg_temp.h('signal_read',owner,jsonb_build_object('days',days,'signals',to_jsonb(signals))) $$;
create function pg_temp.values_of(owner text,days integer,signals text[]) returns numeric[] language sql as $$
  select coalesce(array_agg((s->>'value')::numeric order by s->>'day'),array[]::numeric[])
  from jsonb_array_elements(coalesce((pg_temp.read(owner,days,signals)->'sources'->0->'samples'),'[]'::jsonb)) s $$;

insert into auth.users(id,email) values ('a1000000-0000-0000-0000-0000000000a1','signal-a@example.invalid'),('b1000000-0000-0000-0000-0000000000b1','signal-b@example.invalid'),('c1000000-0000-0000-0000-0000000000c1','signal-c@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values
 ('a3000000-0000-0000-0000-0000000000a3','a1000000-0000-0000-0000-0000000000a1','signal-owner-a','signal-a@example.invalid'),
 ('b3000000-0000-0000-0000-0000000000b3','b1000000-0000-0000-0000-0000000000b1','signal-owner-b','signal-b@example.invalid'),
 ('c3000000-0000-0000-0000-0000000000c3','c1000000-0000-0000-0000-0000000000c1','signal-owner-c','signal-c@example.invalid');

select has_function('waldo','health_signal_read',array['text','text','bigint','text'],'the signal read exists with the router-signed signature');
select ok(not has_function_privilege('authenticated','waldo.health_signal_read(text,text,bigint,text)','execute'),'a signed-in client cannot call it directly');
select ok(has_function_privilege('anon','waldo.health_signal_read(text,text,bigint,text)','execute'),'the Worker reaches it as its siblings are reached');
select throws_ok($$ select waldo.health_signal_read('signal-owner-a','{"days":7,"signals":["sleep_duration"]}',extract(epoch from now())::bigint,'0') $$,'42501',null,'an unsigned call is refused');
select is(pg_temp.h('signal_read','nobody-owner','{"days":7,"signals":["sleep_duration"]}'::jsonb),'{"error":"not_linked"}'::jsonb,'an owner that is not linked is told so');

select is(pg_temp.read('signal-owner-a',7,array['sleep_duration'])->>'error',null,'a well-formed request is answered');
select is((select count(*)::int from unnest(array[
  '{"days":14,"signals":["sleep_duration"]}','{"days":"7","signals":["sleep_duration"]}','{"days":7}','{"days":7,"signals":[]}','{"days":7,"signals":["steps_window"]}',
  '{"days":7,"signals":["sleep_duration"],"extra":1}','{"days":7,"signals":"sleep_duration"}','{"days":7,"signals":[1]}','[]','{"days":7,"signals":["sleep_duration","sleep_midpoint","sleep_efficiency","overnight_hrv","resting_heart_rate","heart_rate_window","hrv_window","daylight_duration","movement_duration"]}'
 ]) b where pg_temp.h('signal_read','signal-owner-a',b::jsonb)->>'error' = 'invalid_request'),10,'a bad window, an unlisted or too many signals, an extra key or a wrong type are refused');

select is(pg_temp.read('signal-owner-a',7,array['sleep_duration'])->>'access','consent_required','before any grant it says consent is required, and returns nothing');
select is(pg_temp.read('signal-owner-a',7,array['sleep_duration'])->'sources','[]'::jsonb,'no source is listed');
select is(pg_temp.h('consent_grant','signal-owner-a',pg_temp.grant_body('grant-sig-a-0001'))->'consent'->>'status','granted','the owner grants storage');
select is(pg_temp.read('signal-owner-a',7,array['sleep_duration'])->>'access','granted','after the grant the read is allowed');
select is(pg_temp.read('signal-owner-a',7,array['sleep_duration'])->'sources'->0->'samples','[]'::jsonb,'with nothing stored the source holds no readings');

select is(pg_temp.h('ingest','signal-owner-a',pg_temp.batch('ingest-sig-a-0001','UTC','anchor-1',jsonb_build_array(
  pg_temp.sleep('night-0',0,400),pg_temp.sleep('night-3',3,410),pg_temp.sleep('night-10',10,420),pg_temp.sleep('night-40',40,430),pg_temp.sleep('night-80',80,440),pg_temp.steps('steps-0',55))))->>'accepted','6','six synthetic readings are stored');

select is(pg_temp.values_of('signal-owner-a',7,array['sleep_duration']),array[410,400]::numeric[],'seven days holds the nights of the last seven days, oldest first');
select is(pg_temp.values_of('signal-owner-a',30,array['sleep_duration']),array[420,410,400]::numeric[],'thirty days holds three nights');
select is(pg_temp.values_of('signal-owner-a',90,array['sleep_duration']),array[440,430,420,410,400]::numeric[],'ninety days holds them all');
select is(pg_temp.read('signal-owner-a',30,array['sleep_duration'])->>'to',to_char((now() at time zone 'UTC')::date,'YYYY-MM-DD'),'the window ends on the owner''s today');
select is((pg_temp.read('signal-owner-a',30,array['sleep_duration'])->>'to')::date-(pg_temp.read('signal-owner-a',30,array['sleep_duration'])->>'from')::date,29,'and spans exactly the days asked for');
select is((select array_agg(distinct s->>'signal') from jsonb_array_elements(pg_temp.read('signal-owner-a',90,array['sleep_duration'])->'sources'->0->'samples') s),array['sleep_duration'],'only the signal asked for is returned');
select is(pg_temp.read('signal-owner-a',7,array['sleep_duration','steps_window'])->>'error','invalid_request','a signal outside the closed list refuses the whole request, not only itself');
select ok(not exists (select 1 from jsonb_array_elements(pg_temp.read('signal-owner-a',90,array['sleep_duration','sleep_midpoint'])->'sources'->0->'samples') s where s ? 'min' or s ? 'max' or s ? 'payload'),'no stored payload or bound leaks beyond the reading''s own fields');
select is(pg_temp.read('signal-owner-a',30,array['sleep_duration'])->'sources'->0->>'truncated','false','a small read is not marked truncated');

-- Another owner's readings never appear, and the zone of the owner's newest reading decides their today.
select is(pg_temp.h('consent_grant','signal-owner-b',pg_temp.grant_body('grant-sig-b-0001'))->'consent'->>'status','granted','another owner grants storage');
select is(pg_temp.h('ingest','signal-owner-b',pg_temp.batch('ingest-sig-b-0001','Pacific/Kiritimati','anchor-b1',jsonb_build_array(pg_temp.sleep('night-b0',0,300))))->>'accepted','1','and stores a reading in a zone far ahead of UTC');
select is(pg_temp.values_of('signal-owner-b',90,array['sleep_duration']),array[300]::numeric[],'they see their own reading only');
select is(pg_temp.values_of('signal-owner-a',90,array['sleep_duration']),array[440,430,420,410,400]::numeric[],'and the first owner is unchanged');
select is(pg_temp.read('signal-owner-b',7,array['sleep_duration'])->>'to',to_char((now() at time zone 'Pacific/Kiritimati')::date,'YYYY-MM-DD'),'the window ends on today in the zone of their newest reading');
select is(pg_temp.read('signal-owner-a',7,array['sleep_duration'])->'sources'->0->'samples'->0->>'timezone','UTC','a reading carries the zone it was read in');

-- Withdrawal: nothing is returned without a live consent.
select is(pg_temp.h('consent_withdraw','signal-owner-a',jsonb_build_object('request_id','withdraw-sig-a-1','source','apple','purpose','storage_compute','expected_epoch',1))->'consent'->>'status','withdrawn','the owner withdraws storage');
select is(pg_temp.read('signal-owner-a',90,array['sleep_duration'])->>'access','consent_withdrawn','a withdrawn consent is named');
select is(pg_temp.read('signal-owner-a',90,array['sleep_duration'])->'sources','[]'::jsonb,'and no reading is returned');
select is(pg_temp.read('signal-owner-c',7,array['sleep_duration'])->>'access','consent_required','an owner who never granted is told consent is required');
select is(pg_temp.read('signal-owner-c',7,array['sleep_duration'])->>'to',to_char((now() at time zone 'UTC')::date,'YYYY-MM-DD'),'with no reading the window ends on today in UTC');

select * from finish();
rollback;
