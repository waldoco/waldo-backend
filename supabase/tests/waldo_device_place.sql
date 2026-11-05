begin;
create extension if not exists pgtap with schema extensions;
select plan(59);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- Device context on the health plane, signal place: consent per purpose, the latest coarse place per device, the owner's
-- read-back and the agent's read. Synthetic values: made-up cells and place names.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.dc(op text,owner text,body text default '{}') returns jsonb language plpgsql as $$
declare a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','device_context_'||op) into r using owner,body,a,pg_temp.sig('device_context.'||op||'.'||owner||'.'||md5(body),a);
  return r;
end $$;
create function pg_temp.sweep(body text) returns jsonb language plpgsql as $$
declare a bigint:=extract(epoch from now())::bigint;
begin return waldo.health_retention_sweep(body,a,pg_temp.sig('health.retention_sweep.'||md5(body),a)); end $$;
create function pg_temp.grant_(owner text,id text,purpose text,epoch int) returns jsonb language sql as $$
  select pg_temp.dc('consent_grant',owner,jsonb_build_object('request_id',id,'signal','place','purpose',purpose,'version',1,'expected_epoch',epoch)::text) $$;
create function pg_temp.withdraw(owner text,id text,purpose text,epoch int) returns jsonb language sql as $$
  select pg_temp.dc('consent_withdraw',owner,jsonb_build_object('request_id',id,'signal','place','purpose',purpose,'expected_epoch',epoch)::text) $$;
create function pg_temp.place(cell text,minutes_ago int default 5) returns jsonb language sql as $$
  select jsonb_build_object('cell',cell,'locality','Testville','region','Test Region','country','IN','timezone','Asia/Kolkata','platform','android',
    'observed_at',to_char((now() - make_interval(mins => minutes_ago)) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')) $$;
create function pg_temp.zone(zone text,minutes_ago int default 5) returns jsonb language sql as $$
  select jsonb_build_object('timezone',zone,'platform','android',
    'observed_at',to_char((now() - make_interval(mins => minutes_ago)) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')) $$;
create function pg_temp.ingest(owner text,id text,epoch int,device text,place jsonb) returns jsonb language sql as $$
  select pg_temp.dc('place_ingest',owner,jsonb_build_object('request_id',id,'expected_epoch',epoch,'device_id',device,'place',place)::text) $$;
create function pg_temp.read(owner text,purpose text) returns jsonb language sql as $$
  select pg_temp.dc('place_read',owner,jsonb_build_object('purpose',purpose)::text) $$;

create function pg_temp.batch(owner text,id text,purposes jsonb) returns jsonb language sql as $$
  select pg_temp.dc('consent_grant_batch',owner,jsonb_build_object('request_id',id,'signal','place','version',1,'purposes',purposes)::text) $$;

insert into auth.users(id,email) values ('5e110000-0000-0000-0000-0000000000a1','dc-a@example.invalid'),('5e110000-0000-0000-0000-0000000000b1','dc-b@example.invalid'),
  ('5e110000-0000-0000-0000-0000000000c1','dc-c@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values
  ('5e310000-0000-0000-0000-0000000000a3','5e110000-0000-0000-0000-0000000000a1','dc-owner-a','dc-a@example.invalid'),
  ('5e310000-0000-0000-0000-0000000000b3','5e110000-0000-0000-0000-0000000000b1','dc-owner-b','dc-b@example.invalid'),
  ('5e310000-0000-0000-0000-0000000000c3','5e110000-0000-0000-0000-0000000000c1','dc-owner-c','dc-c@example.invalid');

select is(array(select f from unnest(array['consent_list','consent_grant','consent_grant_batch','consent_withdraw','place_ingest','place_read']) f,
  unnest(array['authenticated','service_role']) r where has_function_privilege(r,'waldo.device_context_'||f||'(text,text,bigint,text)','execute')),'{}'::text[],
  'only the runtime key may call them');
select ok((select bool_and(has_function_privilege('anon','waldo.device_context_'||f||'(text,text,bigint,text)','execute'))
  from unnest(array['consent_list','consent_grant','consent_grant_batch','consent_withdraw','place_ingest','place_read']) f),'and the runtime key may call all six, with a signature');
select is(array(select r from unnest(array['anon','authenticated','service_role']) r
  where has_function_privilege(r,'waldo.device_context_consent_change(boolean,text,text,bigint,text)','execute')
     or has_function_privilege(r,'waldo.device_context_owner(text,text,text,bigint,text)','execute')
     or has_function_privilege(r,'waldo.device_context_grant(uuid,text,text,integer)','execute')
     or has_function_privilege(r,'waldo.device_place_name_ok(text)','execute')),'{}'::text[],'no role calls the inner functions');
select is(array(select r||'.'||t from unnest(array['anon','authenticated','service_role']) r,
  unnest(array['waldo.device_context_consents','waldo.device_context_scopes','waldo.device_place_latest','waldo.device_context_requests']) t
  where has_table_privilege(r,t,'select') or has_table_privilege(r,t,'insert') or has_table_privilege(r,t,'update') or has_table_privilege(r,t,'delete')),'{}'::text[],'no role reads or writes the tables directly');
select ok((select bool_and(c.relrowsecurity and c.relforcerowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'waldo' and c.relname in ('device_context_consents','device_context_scopes','device_place_latest','device_context_requests') and c.relkind = 'r'),
  'row-level security is forced on every table');
select is(array(select column_name::text from information_schema.columns where table_schema = 'waldo' and table_name = 'device_place_latest' order by ordinal_position),
  array['owner_id','device_id','epoch','platform','timezone','timezone_observed_at','place','place_observed_at','created_at','received_at'],
  'the place table holds a zone and a cell per phone, and no coordinate, accuracy or history column');
select throws_ok($$ select waldo.device_context_consent_list('dc-owner-a','{}',extract(epoch from now())::bigint,'forged') $$,'42501','unsigned router call','a forged call is refused');
select throws_ok(format($$ select waldo.device_context_place_read('dc-owner-b','{"purpose":"owner"}',%s,%L) $$,extract(epoch from now())::bigint,
  pg_temp.sig('device_context.place_read.dc-owner-a.'||md5('{"purpose":"owner"}'),extract(epoch from now())::bigint)),
  '42501','unsigned router call','one owner''s signature never reads another''s place');
select is(pg_temp.dc('consent_list','nobody'),'{"error":"not_linked"}'::jsonb,'an unknown owner is not linked');

select is((select jsonb_agg(jsonb_build_array(c->>'signal',c->>'purpose',c->>'status',c->'epoch')) from jsonb_array_elements(pg_temp.dc('consent_list','dc-owner-a')->'consents') c),
  '[["place","storage_compute","not_granted",0],["place","model_processing","not_granted",0],["place","provider_lookup","not_granted",0]]'::jsonb,
  'an owner who was never asked has all three purposes not granted at epoch 0');
select is(pg_temp.ingest('dc-owner-a','place-0001',0,'5e910000-0000-0000-0000-000000000001',pg_temp.place('tdr1w')),'{"error":"consent_required"}'::jsonb,'nothing is kept before consent');
select is(pg_temp.grant_('dc-owner-a','grant-model-0','model_processing',0),'{"error":"consent_required"}'::jsonb,'model use cannot come before storage');
select is(pg_temp.grant_('dc-owner-a','grant-lookup-0','provider_lookup',0),'{"error":"consent_required"}'::jsonb,'nor can a weather lookup');
select is(pg_temp.read('dc-owner-a','owner'),'{"error":"consent_required"}'::jsonb,'nothing is read before consent');

create temp table g as select pg_temp.grant_('dc-owner-a','grant-store-1','storage_compute',0) as v;
select is((select jsonb_build_array(v->'consent'->>'status',v->'consent'->'epoch',v->'replayed',v->'deletion_routed') from g),'["granted",1,false,false]'::jsonb,'storage is granted at epoch 1');
select is(pg_temp.grant_('dc-owner-a','grant-store-1','storage_compute',0)->'replayed','true'::jsonb,'the same request again is answered from its receipt');
select is(pg_temp.dc('consent_grant','dc-owner-a','{"request_id":"grant-store-1","signal":"place","purpose":"model_processing","version":1,"expected_epoch":0}'),
  '{"error":"idempotency_conflict"}'::jsonb,'a request id reused for another body is refused');
select is(pg_temp.dc('consent_grant','dc-owner-a','{"request_id":"grant-store-3","signal":"precise_place","purpose":"storage_compute","version":1,"expected_epoch":0}'),
  '{"error":"invalid_request"}'::jsonb,'an unknown signal is refused');

select is(pg_temp.ingest('dc-owner-a','place-0002',0,'5e910000-0000-0000-0000-000000000001',pg_temp.place('tdr1w')),'{"error":"epoch_conflict"}'::jsonb,
  'an upload read before the grant carries the old epoch and is refused');
select is(pg_temp.ingest('dc-owner-a','place-0003',1,'5e910000-0000-0000-0000-000000000001',pg_temp.place('tdr1w',30))->>'status','accepted','a coarse place is kept');
select is(pg_temp.ingest('dc-owner-a','place-0004',1,'5e910000-0000-0000-0000-000000000001',pg_temp.place('tdr1y',10))->>'status','accepted','a newer one from the same phone');
select is((select array_agg(place->>'cell') from waldo.device_place_latest where owner_id='5e310000-0000-0000-0000-0000000000a3'),array['tdr1y'],
  'replaces it: one row per phone, no history');
select is(pg_temp.ingest('dc-owner-a','place-0005',1,'5e910000-0000-0000-0000-000000000001',pg_temp.place('tdr1z',60))->>'status','superseded',
  'an older observation arriving late is answered superseded');
select is((select place->>'cell' from waldo.device_place_latest where owner_id='5e310000-0000-0000-0000-0000000000a3'),'tdr1y','and changes nothing');
select is(pg_temp.ingest('dc-owner-a','place-0004',1,'5e910000-0000-0000-0000-000000000001',pg_temp.place('tdr1q'))->>'error','idempotency_conflict',
  'a reused upload id with a new body is refused');
select is(pg_temp.ingest('dc-owner-a','zone-0001',1,'5e910000-0000-0000-0000-000000000001',pg_temp.zone('Asia/Dubai',2))->>'status','accepted',
  'a time zone alone, sent on a background wake, is kept');
select is((select jsonb_build_array(timezone,place->>'cell',place_observed_at < timezone_observed_at) from waldo.device_place_latest
  where owner_id='5e310000-0000-0000-0000-0000000000a3'),'["Asia/Dubai","tdr1y",true]'::jsonb,'and leaves the last cell in place, with its own older time');
select is(pg_temp.ingest('dc-owner-a','zone-0002',1,'5e910000-0000-0000-0000-000000000001',pg_temp.zone('Europe/London',90))->>'status','superseded',
  'an older zone arriving late changes nothing');
select is(pg_temp.ingest('dc-owner-a','zone-0003',1,'5e910000-0000-0000-0000-000000000001',pg_temp.place('tdr1v',3) || '{"timezone":"Asia/Kolkata"}')->>'status','accepted',
  'a reading with a cell older than the zone but newer than the cell still moves the cell');
select is((select jsonb_build_array(timezone,place->>'cell') from waldo.device_place_latest where owner_id='5e310000-0000-0000-0000-0000000000a3'),
  '["Asia/Dubai","tdr1v"]'::jsonb,'while the newer zone stays');

select is((select count(*)::int from unnest(array[
  pg_temp.place('tdr1wx'), pg_temp.place('tdr1a'), pg_temp.place('TDR1W'),
  pg_temp.place('tdr1w') || '{"latitude":12.97,"longitude":77.59}',
  pg_temp.place('tdr1w') || '{"timezone":"Mars/Olympus"}',
  pg_temp.place('tdr1w') || '{"platform":"web"}',
  pg_temp.zone('Asia/Kolkata') || '{"locality":"Testville"}',
  pg_temp.place('tdr1w') || '{"locality":42}',
  pg_temp.place('tdr1w') || '{"locality":"12.971599,77.594566"}',
  pg_temp.place('tdr1w') || '{"region":"12°58′N 77°35′E"}',
  pg_temp.place('tdr1w') || '{"locality":"1297 7759"}',
  pg_temp.place('tdr1w',-60),
  pg_temp.place('tdr1w',40 * 24 * 60)]) p
  where pg_temp.ingest('dc-owner-a','place-bad-'||md5(p::text),1,'5e910000-0000-0000-0000-000000000001',p) = '{"error":"invalid_request"}'::jsonb),13,
  'a finer or malformed cell, coordinates in a field or a name, an unknown zone or platform, a name without a cell or not text, and a time an hour ahead or 40 days back are all refused');
select is(pg_temp.ingest('dc-owner-a','place-name-1',1,'5e910000-0000-0000-0000-000000000003',pg_temp.place('tdr1w',4) || '{"locality":"Sector 128"}')->>'status','accepted',
  'a place name with a short number in it is kept');
delete from waldo.device_place_latest where device_id = '5e910000-0000-0000-0000-000000000003';
select is(pg_temp.dc('place_ingest','dc-owner-a',jsonb_build_object('request_id','place-0006','expected_epoch',1,'device_id','5e910000-0000-0000-0000-000000000001',
  'place',pg_temp.place('tdr1w'),'history','[]'::jsonb)::text),'{"error":"invalid_request"}'::jsonb,'the upload body is closed');

create temp table own as select pg_temp.read('dc-owner-a','owner') as v;
select is((select jsonb_build_array(jsonb_array_length(v->'places'),v->'places'->0->'place'->>'cell',v->'places'->0->>'timezone',
  v->'places'->0 ? 'received_at',v->'places'->0->'place' ? 'observed_at',v->'places'->0 ? 'timezone_observed_at') from own),'[1,"tdr1v","Asia/Dubai",true,true,true]'::jsonb,
  'the owner reads back the latest zone and place, each with its own time');
select is(pg_temp.read('dc-owner-b','owner'),'{"error":"consent_required"}'::jsonb,'another owner without consent is refused');
select is((pg_temp.grant_('dc-owner-b','grant-b-store','storage_compute',0) is not null, pg_temp.read('dc-owner-b','owner')->'places')::text,'(t,[])','and with consent of their own still never sees it');
select is(pg_temp.read('dc-owner-a','model'),'{"error":"consent_required"}'::jsonb,'the agent cannot read it with storage consent alone');

select is(pg_temp.grant_('dc-owner-a','grant-model-1','model_processing',0)->'consent'->>'status','granted','model use is granted on top of storage');
select ok(pg_temp.ingest('dc-owner-a','place-0007',1,'5e910000-0000-0000-0000-000000000002',pg_temp.place('tdr4b',1))->>'status' = 'accepted','a second phone sends its place');
select is((select jsonb_agg(p->'place'->>'cell') from jsonb_array_elements(pg_temp.read('dc-owner-a','model')->'places') p),'["tdr4b","tdr1v"]'::jsonb,
  'the agent reads each phone''s latest place, newest first');

select is(pg_temp.withdraw('dc-owner-a','withdraw-model-1','model_processing',1)->'deletion_routed','false'::jsonb,'withdrawing model use deletes nothing');
select is(pg_temp.read('dc-owner-a','model'),'{"error":"consent_withdrawn"}'::jsonb,'and the agent can no longer read');
select is(pg_temp.grant_('dc-owner-a','grant-lookup-1','provider_lookup',0)->'consent'->>'status','granted','a weather lookup is granted on its own');

select is(pg_temp.withdraw('dc-owner-a','withdraw-store-1','storage_compute',0),'{"error":"epoch_conflict"}'::jsonb,'a withdrawal at a stale epoch is refused');
create temp table w as select pg_temp.withdraw('dc-owner-a','withdraw-store-2','storage_compute',1) as v;
select is((select jsonb_build_array(v->'consent'->>'status',v->'consent'->'epoch',v->'deletion_routed') from w),'["withdrawn",2,true]'::jsonb,'withdrawing storage moves the epoch and routes deletion');
select is((select jsonb_agg(jsonb_build_array(c->>'purpose',c->>'status')) from jsonb_array_elements(pg_temp.dc('consent_list','dc-owner-a')->'consents') c),
  '[["storage_compute","withdrawn"],["model_processing","withdrawn"],["provider_lookup","withdrawn"]]'::jsonb,'and withdraws the weather lookup with it');
select is((select count(*)::int from waldo.device_place_latest where owner_id='5e310000-0000-0000-0000-0000000000a3'),0,'every stored place is deleted');
select is((select count(*)::int from waldo.device_context_requests where owner_id='5e310000-0000-0000-0000-0000000000a3' and operation = 'place_ingest'),0,'with the upload receipts');
select is(pg_temp.ingest('dc-owner-a','place-0008',1,'5e910000-0000-0000-0000-000000000001',pg_temp.place('tdr1w')),'{"error":"consent_withdrawn"}'::jsonb,
  'an upload queued before the withdrawal cannot repopulate it');

-- The one consent screen grants its purposes in one call, all or none.
select is(pg_temp.batch('dc-owner-c','batch-c-1','[{"purpose":"storage_compute","expected_epoch":0},{"purpose":"provider_lookup","expected_epoch":3}]'),
  '{"error":"epoch_conflict"}'::jsonb,'a batch with one stale epoch is refused');
select is((select jsonb_agg(c->>'status') from jsonb_array_elements(pg_temp.dc('consent_list','dc-owner-c')->'consents') c),
  '["not_granted","not_granted","not_granted"]'::jsonb,'and grants none of it, storage included');
select is((select count(*)::int from unnest(array[
  '[]'::jsonb, '[{"purpose":"storage_compute","expected_epoch":0},{"purpose":"storage_compute","expected_epoch":0}]',
  '[{"purpose":"precise_place","expected_epoch":0}]', '[{"purpose":"storage_compute","expected_epoch":0,"granted":true}]']) b
  where pg_temp.batch('dc-owner-c','batch-bad-'||md5(b::text),b) = '{"error":"invalid_request"}'::jsonb),4,
  'an empty batch, a repeated or unknown purpose, and an extra key are refused');
create temp table bg as select pg_temp.batch('dc-owner-c','batch-c-2',
  '[{"purpose":"provider_lookup","expected_epoch":0},{"purpose":"model_processing","expected_epoch":0},{"purpose":"storage_compute","expected_epoch":0}]') as v;
select is((select jsonb_agg(jsonb_build_array(c->>'purpose',c->>'status',c->'epoch')) from bg, jsonb_array_elements(v->'consents') c),
  '[["storage_compute","granted",1],["model_processing","granted",1],["provider_lookup","granted",1]]'::jsonb,
  'granting all three at once puts storage first, whatever order they were sent in');
select is(pg_temp.batch('dc-owner-c','batch-c-2',
  '[{"purpose":"provider_lookup","expected_epoch":0},{"purpose":"model_processing","expected_epoch":0},{"purpose":"storage_compute","expected_epoch":0}]')->'replayed',
  'true'::jsonb,'and the same request again is answered from its receipt');

-- Age: nothing observed more than 30 days ago is shown or kept. A phone that wakes every day keeps its zone fresh while its last
-- cell ages: the read hides that cell at once, and the sweep clears it and keeps the zone. A row whose zone is that old is hidden
-- and then removed.
insert into waldo.device_place_latest(owner_id,device_id,epoch,platform,timezone,timezone_observed_at,place,place_observed_at,received_at) values
  ('5e310000-0000-0000-0000-0000000000b3','5e910000-0000-0000-0000-0000000000b7',1,'ios','Asia/Dubai',now() - interval '1 hour','{"cell":"tdr1v","locality":"Oldtown"}',now() - interval '40 days',now()),
  ('5e310000-0000-0000-0000-0000000000b3','5e910000-0000-0000-0000-0000000000b8',1,'ios','UTC',now() - interval '31 days','{"cell":"tdr1x"}',now() - interval '31 days',now()),
  ('5e310000-0000-0000-0000-0000000000b3','5e910000-0000-0000-0000-0000000000b9',1,'ios','UTC',now() - interval '29 days','{"cell":"tdr1y"}',now() - interval '29 days',now() - interval '29 days');
select is((select jsonb_agg(jsonb_build_array(p->>'timezone',p->'place'->>'cell')) from jsonb_array_elements(pg_temp.read('dc-owner-b','owner')->'places') p),
  '[["Asia/Dubai",null],["UTC","tdr1y"]]'::jsonb,'before any sweep, the read leaves out a 40-day-old cell and a 31-day-old row');
insert into waldo.device_context_requests(owner_id,request_id,operation,payload_digest,response,created_at) values
  ('5e310000-0000-0000-0000-0000000000a3','old-upload-1','place_ingest','x','{}',now() - interval '8 days'),
  ('5e310000-0000-0000-0000-0000000000a3','old-grant-1','consent_grant','x','{}',now() - interval '8 days');
select ok((pg_temp.sweep('{"limit":200}')->>'owners')::int >= 1,'the sweep visits an owner with only an old place');
select is((select jsonb_agg(jsonb_build_array(device_id,timezone,place->>'cell',place_observed_at is null) order by device_id) from waldo.device_place_latest
  where owner_id='5e310000-0000-0000-0000-0000000000b3'),
  '[["5e910000-0000-0000-0000-0000000000b7","Asia/Dubai",null,true],["5e910000-0000-0000-0000-0000000000b9","UTC","tdr1y",false]]'::jsonb,
  'and clears the old cell while keeping its fresh zone, removes the row with an old zone, and leaves the rest');
select is((select array_agg(request_id order by request_id) from waldo.device_context_requests where owner_id='5e310000-0000-0000-0000-0000000000a3' and request_id like 'old-%'),
  array['old-grant-1'],'upload receipts go after 7 days, consent receipts stay');

delete from waldo.owners where id='5e310000-0000-0000-0000-0000000000b3';
select is((select count(*)::int from waldo.device_place_latest where owner_id='5e310000-0000-0000-0000-0000000000b3')
  + (select count(*)::int from waldo.device_context_consents where owner_id='5e310000-0000-0000-0000-0000000000b3'),0,'account deletion removes the owner''s place and consents');

select * from finish();
rollback;
