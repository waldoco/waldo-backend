begin;
create extension if not exists pgtap with schema extensions;
select plan(14);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- A place upload may say the phone just arrived at a place the owner named on it, home or the gym. The phone keeps those places;
-- the server sees only the word, never stores it, and answers it back only for a fresh reading the owner lets Waldo's model read.
-- Synthetic values: made-up cells and place names.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.dc(op text,owner text,body text default '{}') returns jsonb language plpgsql as $$
declare a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','device_context_'||op) into r using owner,body,a,pg_temp.sig('device_context.'||op||'.'||owner||'.'||md5(body),a);
  return r;
end $$;
create function pg_temp.at(minutes_ago int) returns text language sql as $$
  select to_char((now() - make_interval(mins => minutes_ago)) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') $$;
create function pg_temp.here(cell text,minutes_ago int) returns jsonb language sql as $$
  select jsonb_build_object('cell',cell,'locality','Pune','region','Test Region','country','IN','timezone','Asia/Kolkata','platform','ios','observed_at',pg_temp.at(minutes_ago)) $$;
create function pg_temp.ingest(id text,place jsonb,arrived jsonb default null,device text default '5ea90000-0000-0000-0000-0000000000e1') returns jsonb language sql as $$
  select pg_temp.dc('place_ingest','dc-owner-a',(jsonb_build_object('request_id',id,'expected_epoch',1,'device_id',device,'place',place)
    || case when arrived is null then '{}'::jsonb else jsonb_build_object('arrived',arrived) end)::text) $$;
create function pg_temp.told(id text,place jsonb,arrived jsonb default null,device text default '5ea90000-0000-0000-0000-0000000000e1') returns jsonb language sql as $$
  select jsonb_build_array(r->>'status',r->'arrived') from (select pg_temp.ingest(id,place,arrived,device) r) x $$;

insert into auth.users(id,email) values ('5ea10000-0000-0000-0000-0000000000d1','dc-a@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('5ea30000-0000-0000-0000-0000000000d3','5ea10000-0000-0000-0000-0000000000d1','dc-owner-a','dc-a@example.invalid');
select is(pg_temp.dc('consent_grant','dc-owner-a','{"request_id":"arrive-grant-1","signal":"place","purpose":"storage_compute","version":1,"expected_epoch":0}')->'consent'->>'status','granted','storage is granted');
select is(pg_temp.dc('consent_grant','dc-owner-a','{"request_id":"arrive-grant-2","signal":"place","purpose":"model_processing","version":1,"expected_epoch":0}')->'consent'->>'status','granted','and model use');

select is(pg_temp.told('arrive-0001',pg_temp.here('tdr1w',30)),'["accepted",null]'::jsonb,'an upload that names no arrival says none');
select is(pg_temp.told('arrive-0002',pg_temp.here('tdr1y',20),'"home"'),'["accepted","home"]'::jsonb,'a fresh reading that says it arrived home is answered home');
select is(pg_temp.told('arrive-0003',pg_temp.here('tdr1z',10),'"gym"'),'["accepted","gym"]'::jsonb,'and the gym, gym');
select is(pg_temp.ingest('arrive-0004',pg_temp.here('tdr1x',5),'"office"')->>'error','invalid_request','a place the contract does not name is refused');
select is(pg_temp.ingest('arrive-0005',pg_temp.here('tdr1x',5),'true')->>'error','invalid_request','and so is anything but its word');
select is(pg_temp.told('arrive-0006',pg_temp.here('tdr1q',90),'"home"'),'["superseded",null]'::jsonb,'a reading that loses to a newer one is no arrival');
select is(pg_temp.ingest('arrive-0003',pg_temp.here('tdr1z',10),'"gym"'),'{"request_id":"arrive-0003","replayed":true,"status":"accepted"}'::jsonb,
  'a replay answers in the receipt''s old shape: it is never told twice');
select is((select count(*)::int from waldo.device_context_requests where owner_id='5ea30000-0000-0000-0000-0000000000d3' and (response ? 'arrived' or response::text ~ 'gym|home')),0,
  'no stored receipt holds the arrival');
select is((select count(*)::int from waldo.device_place_latest where owner_id='5ea30000-0000-0000-0000-0000000000d3' and (place::text ~ 'gym|home')),0,'nor does the stored place');
-- An arrival is "just now": one the phone delivers more than an hour after it happened is kept as a place and not told.
select is(pg_temp.told('arrive-0007',pg_temp.here('tdr1r',70),'"home"','5ea90000-0000-0000-0000-0000000000e2'),'["accepted",null]'::jsonb,'an arrival observed more than an hour ago is not told');
select is(pg_temp.dc('consent_withdraw','dc-owner-a','{"request_id":"arrive-withdraw-1","signal":"place","purpose":"model_processing","expected_epoch":1}')->'consent'->>'status','withdrawn',
  'the owner withdraws model use of place');
select is(pg_temp.told('arrive-0008',pg_temp.here('tdr1s',1),'"home"'),'["accepted",null]'::jsonb,'the place is still kept, and the arrival is no longer told');
select * from finish();
rollback;
