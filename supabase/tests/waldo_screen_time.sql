begin;
create extension if not exists pgtap with schema extensions;
select plan(48);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- Screen time on the health plane: its own consent, daily summaries per device, the owner's read-back and the agent's read.
-- Synthetic values.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.st(op text,owner text,body text default '{}') returns jsonb language plpgsql as $$
declare a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','screen_time_'||op) into r using owner,body,a,pg_temp.sig('screen_time.'||op||'.'||owner||'.'||md5(body),a);
  return r;
end $$;
create function pg_temp.sweep(body text) returns jsonb language plpgsql as $$
declare a bigint:=extract(epoch from now())::bigint;
begin return waldo.health_retention_sweep(body,a,pg_temp.sig('health.retention_sweep.'||md5(body),a)); end $$;
create function pg_temp.grant_(owner text,id text,purpose text,epoch int) returns jsonb language sql as $$
  select pg_temp.st('consent_grant',owner,jsonb_build_object('request_id',id,'purpose',purpose,'version',1,'expected_epoch',epoch)::text) $$;
create function pg_temp.withdraw(owner text,id text,purpose text,epoch int) returns jsonb language sql as $$
  select pg_temp.st('consent_withdraw',owner,jsonb_build_object('request_id',id,'purpose',purpose,'expected_epoch',epoch)::text) $$;
create function pg_temp.day(days_ago int,minutes int default 200) returns jsonb language sql as $$
  select jsonb_build_object('day',to_char((now() at time zone 'Asia/Kolkata')::date - days_ago,'YYYY-MM-DD'),'timezone','Asia/Kolkata','platform','android',
    'coverage','complete','screen_on_minutes',minutes,'pickups',40,'unlocks',35,'late_night_minutes',12,'late_night_window','23:00-05:00',
    'first_use_at','07:10','last_use_at','23:40','categories',jsonb_build_array(jsonb_build_object('category','social','minutes',60))) $$;
create function pg_temp.ingest(owner text,id text,epoch int,device text,days jsonb) returns jsonb language sql as $$
  select pg_temp.st('ingest',owner,jsonb_build_object('request_id',id,'expected_epoch',epoch,'device_id',device,'days',days)::text) $$;
create function pg_temp.read(owner text,purpose text,from_ago int default 20,to_ago int default 0) returns jsonb language sql as $$
  select pg_temp.st('days_read',owner,jsonb_build_object('from',to_char((now() at time zone 'Asia/Kolkata')::date - from_ago,'YYYY-MM-DD'),
    'to',to_char((now() at time zone 'Asia/Kolkata')::date - to_ago,'YYYY-MM-DD'),'purpose',purpose)::text) $$;

insert into auth.users(id,email) values ('5e100000-0000-0000-0000-0000000000a1','st-a@example.invalid'),('5e100000-0000-0000-0000-0000000000b1','st-b@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values
  ('5e300000-0000-0000-0000-0000000000a3','5e100000-0000-0000-0000-0000000000a1','st-owner-a','st-a@example.invalid'),
  ('5e300000-0000-0000-0000-0000000000b3','5e100000-0000-0000-0000-0000000000b1','st-owner-b','st-b@example.invalid');

select is(array(select f from unnest(array['consent_list','consent_grant','consent_withdraw','ingest','days_read']) f, unnest(array['anon','authenticated','service_role']) r
  where has_function_privilege(r,'waldo.screen_time_'||f||'(text,text,bigint,text)','execute') and r <> 'anon'),'{}'::text[],'only the runtime key may call them');
select ok((select bool_and(has_function_privilege('anon','waldo.screen_time_'||f||'(text,text,bigint,text)','execute'))
  from unnest(array['consent_list','consent_grant','consent_withdraw','ingest','days_read']) f),'and the runtime key may call all five, with a signature');
select is(array(select r from unnest(array['anon','authenticated','service_role']) r
  where has_function_privilege(r,'waldo.screen_time_consent_change(boolean,text,text,bigint,text)','execute')
     or has_function_privilege(r,'waldo.screen_time_owner(text,text,text,bigint,text)','execute')),'{}'::text[],'no role calls the inner functions');
select is(array(select r||'.'||t from unnest(array['anon','authenticated','service_role']) r,
  unnest(array['waldo.screen_time_consents','waldo.screen_time_scopes','waldo.screen_time_days','waldo.screen_time_requests']) t
  where has_table_privilege(r,t,'select') or has_table_privilege(r,t,'insert') or has_table_privilege(r,t,'update') or has_table_privilege(r,t,'delete')),'{}'::text[],'no role reads or writes the tables directly');
select ok((select bool_and(c.relrowsecurity and c.relforcerowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'waldo' and c.relname like 'screen_time_%' and c.relkind = 'r'),'row-level security is forced on every table');
select throws_ok($$ select waldo.screen_time_consent_list('st-owner-a','{}',extract(epoch from now())::bigint,'forged') $$,'42501','unsigned router call','a forged call is refused');
select throws_ok(format($$ select waldo.screen_time_days_read('st-owner-b','{"from":"2026-01-01","to":"2026-01-02","purpose":"owner"}',%s,%L) $$,extract(epoch from now())::bigint,
  pg_temp.sig('screen_time.days_read.st-owner-a.'||md5('{"from":"2026-01-01","to":"2026-01-02","purpose":"owner"}'),extract(epoch from now())::bigint)),
  '42501','unsigned router call','one owner''s signature never reads another''s days');
select is(pg_temp.st('consent_list','nobody'),'{"error":"not_linked"}'::jsonb,'an unknown owner is not linked');

select is((select jsonb_agg(jsonb_build_array(c->>'purpose',c->>'status',c->'epoch')) from jsonb_array_elements(pg_temp.st('consent_list','st-owner-a')->'consents') c),
  '[["storage_compute","not_granted",0],["model_processing","not_granted",0]]'::jsonb,'an owner who was never asked has both purposes not granted at epoch 0');
select is(pg_temp.ingest('st-owner-a','ingest-0001',0,'5e900000-0000-0000-0000-000000000001',jsonb_build_array(pg_temp.day(1))),'{"error":"consent_required"}'::jsonb,
  'nothing is kept before consent');
select is(pg_temp.grant_('st-owner-a','grant-model-0',  'model_processing',0),'{"error":"consent_required"}'::jsonb,'model use cannot come before storage');
select is(pg_temp.read('st-owner-a','owner'),'{"error":"consent_required"}'::jsonb,'nothing is read before consent');

create temp table g as select pg_temp.grant_('st-owner-a','grant-store-1','storage_compute',0) as v;
select is((select jsonb_build_array(v->'consent'->>'status',v->'consent'->'epoch',v->'replayed',v->'deletion_routed') from g),'["granted",1,false,false]'::jsonb,'storage is granted at epoch 1');
select is(pg_temp.grant_('st-owner-a','grant-store-1','storage_compute',0)->'replayed','true'::jsonb,'the same request again is answered from its receipt');
select is(pg_temp.st('consent_grant','st-owner-a','{"request_id":"grant-store-1","purpose":"model_processing","version":1,"expected_epoch":0}'),'{"error":"idempotency_conflict"}'::jsonb,
  'a request id reused for another body is refused');
select is(pg_temp.grant_('st-owner-a','grant-store-2','storage_compute',1),'{"error":"epoch_conflict"}'::jsonb,'a second live grant is refused');
select is(pg_temp.st('consent_grant','st-owner-a','{"request_id":"grant-store-3","purpose":"storage_compute","version":2,"expected_epoch":1}'),'{"error":"invalid_request"}'::jsonb,
  'an unknown copy version is refused');

select is(pg_temp.ingest('st-owner-a','ingest-0002',0,'5e900000-0000-0000-0000-000000000001',jsonb_build_array(pg_temp.day(1))),'{"error":"epoch_conflict"}'::jsonb,
  'an upload read before the grant carries the old epoch and is refused');
create temp table i as select pg_temp.ingest('st-owner-a','ingest-0003',1,'5e900000-0000-0000-0000-000000000001',
  jsonb_build_array(pg_temp.day(1),pg_temp.day(2),pg_temp.day(20),pg_temp.day(-3))) as v;
select is((select jsonb_agg(r->>'status' order by r->>'day') from i, jsonb_array_elements(v->'results') r),'["rejected","accepted","accepted","rejected"]'::jsonb,
  'days inside the window are kept; one 20 days back and one 3 days ahead are rejected');
select ok((select bool_and(r->>'reason' = 'out_of_window') from i, jsonb_array_elements(v->'results') r where r->>'status' = 'rejected'),'each rejection says why');
select is(pg_temp.ingest('st-owner-a','ingest-0003',1,'5e900000-0000-0000-0000-000000000001',jsonb_build_array(pg_temp.day(1)))->>'error','idempotency_conflict','a reused upload id with a new body is refused');
select is(pg_temp.ingest('st-owner-a','ingest-0004',1,'5e900000-0000-0000-0000-000000000001',jsonb_build_array(pg_temp.day(1,321)))->'results'->0->>'status','accepted','a day re-sent is accepted');
select is((select count(*)::int from waldo.screen_time_days where owner_id='5e300000-0000-0000-0000-0000000000a3'),2,'and replaces the earlier copy rather than adding one');

select is((select count(*)::int from unnest(array[
  jsonb_build_array(pg_temp.day(1) || '{"platform":"ios"}'),
  jsonb_build_array(pg_temp.day(1) || '{"top_apps":[{"package":"com.example.app","minutes":30}]}'),
  jsonb_build_array(pg_temp.day(1) || '{"timezone":"Mars/Olympus"}'),
  jsonb_build_array(pg_temp.day(1) || '{"coverage":"most"}'),
  jsonb_build_array(pg_temp.day(1), pg_temp.day(1))]) d
  where pg_temp.ingest('st-owner-a','ingest-bad-'||md5(d::text),1,'5e900000-0000-0000-0000-000000000001',d) = '{"error":"invalid_request"}'::jsonb),5,
  'another platform, an app or package name, an unknown zone or coverage, and a repeated day are all refused');
select is(pg_temp.st('ingest','st-owner-a',jsonb_build_object('request_id','ingest-0005','expected_epoch',1,'device_id','5e900000-0000-0000-0000-000000000001',
  'days',jsonb_build_array(pg_temp.day(1)),'apps','[]'::jsonb)::text),'{"error":"invalid_request"}'::jsonb,'the upload body is closed');

create temp table own as select pg_temp.read('st-owner-a','owner') as v;
select is((select jsonb_array_length(v->'days') from own),2,'the owner reads back what was kept');
select is((select v->'days'->1->'summary'->'screen_on_minutes' from own),'321'::jsonb,'with the newer copy of a re-sent day, oldest day first');
select ok((select bool_and(d ? 'device_id' and d ? 'received_at' and d->>'device' = '1') from own, jsonb_array_elements(v->'days') d),'with its device and when it arrived');
select is(pg_temp.read('st-owner-b','owner'),'{"error":"consent_required"}'::jsonb,'another owner without consent is refused');
select is((pg_temp.grant_('st-owner-b','grant-b-store','storage_compute',0) is not null, pg_temp.read('st-owner-b','owner')->'days')::text,'(t,[])','and with consent of their own still never sees it');
select is(pg_temp.read('st-owner-a','model'),'{"error":"consent_required"}'::jsonb,'the agent cannot read it with storage consent alone');
select is(pg_temp.st('days_read','st-owner-a','{"from":"2026-01-01","to":"2026-02-15","purpose":"model"}'),'{"error":"invalid_request"}'::jsonb,'a read spans at most 31 days');

select is(pg_temp.grant_('st-owner-a','grant-model-1','model_processing',0)->'consent'->>'status','granted','model use is granted on top of storage');
select ok(pg_temp.ingest('st-owner-a','ingest-0006',1,'5e900000-0000-0000-0000-000000000002',jsonb_build_array(pg_temp.day(1,90)))->'results'->0->>'status' = 'accepted','a second phone sends the same day');
create temp table model as select pg_temp.read('st-owner-a','model') as v;
select is((select jsonb_agg(jsonb_build_array(d->'device',d->'summary'->'screen_on_minutes')) from model, jsonb_array_elements(v->'days') d),'[[1,200],[1,321],[2,90]]'::jsonb,
  'the agent reads each phone''s day apart, numbered in the order the phones first sent');

select is(pg_temp.withdraw('st-owner-a','withdraw-model-1','model_processing',1)->'deletion_routed','false'::jsonb,'withdrawing model use deletes nothing');
select is(pg_temp.read('st-owner-a','model'),'{"error":"consent_withdrawn"}'::jsonb,'and the agent can no longer read');
select is(jsonb_array_length(pg_temp.read('st-owner-a','owner')->'days'),3,'while the owner still sees what was kept');

select is(pg_temp.withdraw('st-owner-a','withdraw-store-1','storage_compute',0),'{"error":"epoch_conflict"}'::jsonb,'a withdrawal at a stale epoch is refused');
create temp table w as select pg_temp.withdraw('st-owner-a','withdraw-store-2','storage_compute',1) as v;
select is((select jsonb_build_array(v->'consent'->>'status',v->'consent'->'epoch',v->'deletion_routed') from w),'["withdrawn",2,true]'::jsonb,'withdrawing storage moves the epoch and routes deletion');
select is((select count(*)::int from waldo.screen_time_days where owner_id='5e300000-0000-0000-0000-0000000000a3'),0,'every stored day is deleted');
select is((select count(*)::int from waldo.screen_time_requests where owner_id='5e300000-0000-0000-0000-0000000000a3' and operation = 'ingest'),0,'with the upload receipts');
select is(pg_temp.ingest('st-owner-a','ingest-0007',1,'5e900000-0000-0000-0000-000000000001',jsonb_build_array(pg_temp.day(1))),'{"error":"consent_withdrawn"}'::jsonb,
  'an upload queued before the withdrawal cannot repopulate it');
select is(pg_temp.grant_('st-owner-a','grant-store-4','storage_compute',2)->'consent'->'epoch','3'::jsonb,'a fresh grant starts a new epoch');
select is(pg_temp.ingest('st-owner-a','ingest-0008',1,'5e900000-0000-0000-0000-000000000001',jsonb_build_array(pg_temp.day(1))),'{"error":"epoch_conflict"}'::jsonb,
  'and an upload from the earlier grant is still refused');

-- Retention: a day older than 90 days is removed by the health sweep, and the sweep finds an owner whose only old rows are these.
insert into waldo.screen_time_days(owner_id,device_id,day,epoch,summary) values
  ('5e300000-0000-0000-0000-0000000000b3','5e900000-0000-0000-0000-0000000000b9',(now() at time zone 'UTC')::date - 91,1,'{"day":"x"}'),
  ('5e300000-0000-0000-0000-0000000000b3','5e900000-0000-0000-0000-0000000000b9',(now() at time zone 'UTC')::date - 89,1,'{"day":"y"}');
select ok((pg_temp.sweep('{"limit":200}')->>'owners')::int >= 1,'the sweep visits an owner with only old screen-time days');
select is((select array_agg(summary->>'day') from waldo.screen_time_days where owner_id='5e300000-0000-0000-0000-0000000000b3'),array['y'],'and removes only the day older than 90 days');

delete from waldo.owners where id='5e300000-0000-0000-0000-0000000000b3';
select is((select count(*)::int from waldo.screen_time_days where owner_id='5e300000-0000-0000-0000-0000000000b3'),0,'account deletion removes the owner''s days');

select * from finish();
rollback;
