begin;
create extension if not exists pgtap with schema extensions;
select plan(16);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- A place upload answers moved when the newer reading puts the phone in another time zone, or another named city or country,
-- than the row it replaces. Synthetic values: made-up cells and place names.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.dc(op text,owner text,body text default '{}') returns jsonb language plpgsql as $$
declare a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','device_context_'||op) into r using owner,body,a,pg_temp.sig('device_context.'||op||'.'||owner||'.'||md5(body),a);
  return r;
end $$;
create function pg_temp.at(minutes_ago int) returns text language sql as $$
  select to_char((now() - make_interval(mins => minutes_ago)) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') $$;
create function pg_temp.city(cell text,locality text,country text,zone text,minutes_ago int) returns jsonb language sql as $$
  select jsonb_build_object('cell',cell,'locality',locality,'region','Test Region','country',country,'timezone',zone,'platform','ios','observed_at',pg_temp.at(minutes_ago)) $$;
create function pg_temp.zone(zone text,minutes_ago int) returns jsonb language sql as $$
  select jsonb_build_object('timezone',zone,'platform','ios','observed_at',pg_temp.at(minutes_ago)) $$;
create function pg_temp.ingest(id text,device text,place jsonb) returns jsonb language sql as $$
  select pg_temp.dc('place_ingest','dc-owner-m',jsonb_build_object('request_id',id,'expected_epoch',1,'device_id',device,'place',place)::text) $$;
create function pg_temp.moved(id text,place jsonb,device text default '5e910000-0000-0000-0000-0000000000e1') returns jsonb language sql as $$
  select jsonb_build_array(r->>'status',r->'moved') from (select pg_temp.ingest(id,device,place) r) x $$;

insert into auth.users(id,email) values ('5e110000-0000-0000-0000-0000000000d1','dc-m@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('5e310000-0000-0000-0000-0000000000d3','5e110000-0000-0000-0000-0000000000d1','dc-owner-m','dc-m@example.invalid');
select is(pg_temp.dc('consent_grant','dc-owner-m','{"request_id":"moved-grant-1","signal":"place","purpose":"storage_compute","version":1,"expected_epoch":0}')->'consent'->>'status','granted','storage is granted');
select is(pg_temp.dc('consent_grant','dc-owner-m','{"request_id":"moved-grant-2","signal":"place","purpose":"model_processing","version":1,"expected_epoch":0}')->'consent'->>'status','granted','and model use');

select is(pg_temp.moved('moved-0001',pg_temp.city('tdr1w','Pune','IN','Asia/Kolkata',60)),'["accepted",false]'::jsonb,'a first reading is not a move');
select is(pg_temp.moved('moved-0002',pg_temp.city('tdr1y','Pune','IN','Asia/Kolkata',55)),'["accepted",false]'::jsonb,'another cell in the same city and zone is not a move');
select is(pg_temp.moved('moved-0003',pg_temp.zone('Asia/Kolkata',50)),'["accepted",false]'::jsonb,'nor is a zone-only wake in the same zone');
select is(pg_temp.moved('moved-0004',pg_temp.city('tsq4z','Bengaluru','IN','Asia/Kolkata',45)),'["accepted",true]'::jsonb,'a newer reading in another city is a move, in the same zone');
select is(pg_temp.moved('moved-0005',pg_temp.zone('Asia/Dubai',40)),'["accepted",true]'::jsonb,'a newer zone alone is a move: landing, before the app is opened');
select is(pg_temp.moved('moved-0006',pg_temp.zone('Europe/London',120)),'["superseded",false]'::jsonb,'an older reading that loses is never a move');
select is(pg_temp.moved('moved-0007',pg_temp.city('thrr0','Bengaluru','AE','Asia/Dubai',35)),'["accepted",true]'::jsonb,'a city of the same name in another country is a move');
select is(pg_temp.moved('moved-0008',pg_temp.city('thrr1','Bengaluru','AE','Asia/Dubai',30) - array['locality','region','country']),'["accepted",false]'::jsonb,
  'a cell without names says no city, so it is not a move');
select is(pg_temp.ingest('moved-0004','5e910000-0000-0000-0000-0000000000e1',pg_temp.city('tsq4z','Bengaluru','IN','Asia/Kolkata',45)),
  '{"request_id":"moved-0004","replayed":true,"status":"accepted"}'::jsonb,'a replay answers in the receipt''s old shape: the stored receipt never holds moved');
select is((select count(*)::int from waldo.device_context_requests where owner_id='5e310000-0000-0000-0000-0000000000d3' and response ? 'moved'),0,'no stored receipt does');
select is(pg_temp.moved('moved-0010',pg_temp.city('thrr2','Bengaluru','AE','Asia/Dubai',28) - array['country']),'["accepted",false]'::jsonb,
  'a reading that leaves out the country is not a move to another country');
select is(pg_temp.moved('moved-0009',pg_temp.city('tdr1w','Pune','IN','Asia/Kolkata',25),'5e910000-0000-0000-0000-0000000000e2'),'["accepted",false]'::jsonb,
  'a second phone''s first reading is not a move, whatever the first phone said');
select is(pg_temp.dc('consent_withdraw','dc-owner-m','{"request_id":"moved-withdraw-1","signal":"place","purpose":"model_processing","expected_epoch":1}')->'consent'->>'status','withdrawn',
  'the owner withdraws model use of place');
select is(pg_temp.moved('moved-0011',pg_temp.zone('Europe/London',20)),'["accepted",false]'::jsonb,'a new zone is still kept, and is no longer told as a move');

select * from finish();
rollback;
