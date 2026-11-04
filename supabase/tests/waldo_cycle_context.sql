begin;
create extension if not exists pgtap with schema extensions;
select plan(39);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- Cycle context on the health plane: its own consent on top of health storage, period dates, the Cycle row, withdrawal and
-- retention. Synthetic values.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.cy(op text,owner text,body text default '{}') returns jsonb language plpgsql as $$
declare a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','cycle_'||op) into r using owner,body,a,pg_temp.sig('cycle.'||op||'.'||owner||'.'||md5(body),a);
  return r;
end $$;
create function pg_temp.sweep(body text) returns jsonb language plpgsql as $$
declare a bigint:=extract(epoch from now())::bigint;
begin return waldo.health_retention_sweep(body,a,pg_temp.sig('health.retention_sweep.'||md5(body),a)); end $$;
create function pg_temp.grant_(owner text,id text,epoch int) returns jsonb language sql as $$
  select pg_temp.cy('consent_grant',owner,jsonb_build_object('request_id',id,'purpose','cycle_context','version',1,'expected_epoch',epoch,'age_attested_18_plus',true)::text) $$;
create function pg_temp.withdraw(owner text,id text,epoch int) returns jsonb language sql as $$
  select pg_temp.cy('consent_withdraw',owner,jsonb_build_object('request_id',id,'purpose','cycle_context','expected_epoch',epoch)::text) $$;
create function pg_temp.period(start_ago int,end_ago int) returns jsonb language sql as $$
  select jsonb_build_object('signal','menstrual_period','start_date',to_char(current_date - start_ago,'YYYY-MM-DD'),
    'end_date',case when end_ago is null then null else to_char(current_date - end_ago,'YYYY-MM-DD') end,
    'origin',jsonb_build_object('read_api','healthkit','source_bundle_id','com.example.cycle','source_package_name',null,'source_version',null,
      'source_revision',null,'device_ref',null,'recording_method','manual'),'source_name','Example Cycle') $$;
create function pg_temp.ingest(owner text,id text,epoch int,source text,window_ago int,periods jsonb) returns jsonb language sql as $$
  select pg_temp.cy('ingest',owner,jsonb_build_object('request_id',id,'expected_epoch',epoch,'source',source,
    'window_start',to_char(current_date - window_ago,'YYYY-MM-DD'),'periods',periods)::text) $$;
create function pg_temp.consent(owner text) returns jsonb language sql as $$ select pg_temp.cy('consent_list',owner)->'consents'->0 $$;
create function pg_temp.stored(owner uuid) returns bigint language sql as $$ select count(*) from waldo.cycle_periods where owner_id = owner $$;

insert into auth.users(id,email) values ('c1100000-0000-0000-0000-0000000000a1','cy-a@example.invalid'),('c1100000-0000-0000-0000-0000000000b1','cy-b@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values
  ('c1300000-0000-0000-0000-0000000000a3','c1100000-0000-0000-0000-0000000000a1','cy-owner-a','cy-a@example.invalid'),
  ('c1300000-0000-0000-0000-0000000000b3','c1100000-0000-0000-0000-0000000000b1','cy-owner-b','cy-b@example.invalid');

select is(array(select f from unnest(array['consent_list','consent_grant','consent_withdraw','ingest','status_read']) f, unnest(array['authenticated','service_role']) r
  where has_function_privilege(r,'waldo.cycle_'||f||'(text,text,bigint,text)','execute')),'{}'::text[],'only the runtime key may call them');
select ok((select bool_and(has_function_privilege('anon','waldo.cycle_'||f||'(text,text,bigint,text)','execute'))
  from unnest(array['consent_list','consent_grant','consent_withdraw','ingest','status_read']) f),'and the runtime key may call all five, with a signature');
select is(array(select r from unnest(array['anon','authenticated','service_role']) r
  where has_function_privilege(r,'waldo.cycle_consent_change(boolean,text,text,bigint,text)','execute')
     or has_function_privilege(r,'waldo.cycle_owner(text,text,text,bigint,text)','execute')
     or has_function_privilege(r,'waldo.cycle_withdraw_all(uuid)','execute')),'{}'::text[],'no role calls the inner functions');
select is(array(select r||'.'||t from unnest(array['anon','authenticated','service_role']) r,
  unnest(array['waldo.cycle_consents','waldo.cycle_scopes','waldo.cycle_periods','waldo.cycle_requests']) t
  where has_table_privilege(r,t,'select') or has_table_privilege(r,t,'insert') or has_table_privilege(r,t,'update') or has_table_privilege(r,t,'delete')),'{}'::text[],'no role reads or writes the tables directly');
select ok((select bool_and(c.relrowsecurity and c.relforcerowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'waldo' and c.relname like 'cycle_%' and c.relkind = 'r'),'row-level security is forced on every table');
select throws_ok($$ select waldo.cycle_status_read('cy-owner-a','{}',extract(epoch from now())::bigint,'forged') $$,'42501','unsigned router call','a forged call is refused');
select throws_ok(format($$ select waldo.cycle_status_read('cy-owner-b','{}',%s,%L) $$,extract(epoch from now())::bigint,
  pg_temp.sig('cycle.status_read.cy-owner-a.'||md5('{}'),extract(epoch from now())::bigint)),'42501','unsigned router call','one owner''s signature never reads another''s row');
select is(pg_temp.cy('consent_list','nobody'),'{"error":"not_linked"}'::jsonb,'an unknown owner is not linked');

-- Before anything is turned on.
select is(pg_temp.consent('cy-owner-a')->>'status','not_granted','an owner who never turned it on is not granted');
select is(pg_temp.cy('status_read','cy-owner-a'),'{"state":"off"}'::jsonb,'and the Cycle row is off');
select is(pg_temp.grant_('cy-owner-a','cy-grant-0',0),'{"error":"consent_required"}'::jsonb,'cycle context cannot come before health storage');
select is(pg_temp.ingest('cy-owner-a','cy-ingest-0',0,'apple',60,jsonb_build_array(pg_temp.period(20,15))),'{"error":"consent_required"}'::jsonb,'nothing is kept before consent');

insert into waldo.health_consents(owner_id,source,purpose,version,age_attested_18_plus) values ('c1300000-0000-0000-0000-0000000000a3','apple','storage_compute',2,true);
select is((pg_temp.grant_('cy-owner-a','cy-grant-1',0)->'consent') - array['granted_at','withdrawn_at'],
  '{"consent_class":"reproductive_health","purpose":"cycle_context","version":1,"status":"granted","epoch":1,"deletion_state":"not_required"}'::jsonb,'with storage, the grant takes epoch 1');
select is(pg_temp.grant_('cy-owner-a','cy-grant-1',0)->'replayed','true'::jsonb,'a replayed grant answers from its receipt');
select is(pg_temp.withdraw('cy-owner-a','cy-grant-1',1),'{"error":"idempotency_conflict"}'::jsonb,'a request id reused for another change conflicts');
select is(pg_temp.grant_('cy-owner-a','cy-grant-2',0),'{"error":"epoch_conflict"}'::jsonb,'a grant from a stale epoch conflicts');
select is(pg_temp.cy('status_read','cy-owner-a'),'{"state":"waiting_for_data"}'::jsonb,'granted with nothing stored waits for data');

-- Ingest.
select is(pg_temp.ingest('cy-owner-a','cy-ingest-1',0,'apple',60,jsonb_build_array(pg_temp.period(20,15))),'{"error":"epoch_conflict"}'::jsonb,'an upload from another epoch is refused');
select is(pg_temp.ingest('cy-owner-a','cy-ingest-2',1,'health_connect',60,'[]'::jsonb),'{"error":"consent_required"}'::jsonb,'a source without its own health storage is refused');
select is(pg_temp.ingest('cy-owner-a','cy-ingest-3',1,'apple',60,jsonb_build_array(pg_temp.period(20,15) || '{"flow":"heavy"}')),'{"error":"invalid_request"}'::jsonb,
  'a flow level is never accepted');
select is(pg_temp.ingest('cy-owner-a','cy-ingest-3b',1,'apple',60,jsonb_build_array(pg_temp.period(40,35),pg_temp.period(30,5))),'{"error":"invalid_request"}'::jsonb,
  'a period longer than 15 days is refused');
select is(pg_temp.ingest('cy-owner-a','cy-ingest-4',1,'apple',130,jsonb_build_array(pg_temp.period(125,120),pg_temp.period(40,35),pg_temp.period(10,null))) - 'request_id',
  '{"replayed":false,"accepted":2,"ignored":1}'::jsonb,'periods are kept, and one that ended more than 90 days ago is ignored');
select is(pg_temp.cy('status_read','cy-owner-a'),jsonb_build_object('state','active','last_period_start',to_char(current_date - 10,'YYYY-MM-DD'),'last_source_name','Example Cycle'),
  'the Cycle row shows the latest start and its app');
select is(pg_temp.ingest('cy-owner-a','cy-ingest-5',1,'apple',15,'[]'::jsonb)->'accepted','0'::jsonb,'an empty window clears that window');
select is(array(select to_char(start_date,'YYYY-MM-DD') from waldo.cycle_periods where owner_id='c1300000-0000-0000-0000-0000000000a3'),
  array[to_char(current_date - 40,'YYYY-MM-DD')],'and keeps what started before it');
select is(pg_temp.cy('status_read','cy-owner-b'),'{"state":"off"}'::jsonb,'another owner sees nothing');

-- Withdrawal.
select is(pg_temp.withdraw('cy-owner-a','cy-withdraw-1',1) - 'consent','{"replayed":false,"deletion_routed":true}'::jsonb,'withdrawing routes deletion');
select is(pg_temp.consent('cy-owner-a') - array['granted_at','withdrawn_at'],
  '{"consent_class":"reproductive_health","purpose":"cycle_context","version":1,"status":"withdrawn","epoch":2,"deletion_state":"completed"}'::jsonb,'and moves the epoch');
select is(pg_temp.stored('c1300000-0000-0000-0000-0000000000a3'),0::bigint,'every stored period is gone');
select is(pg_temp.ingest('cy-owner-a','cy-ingest-6',1,'apple',60,jsonb_build_array(pg_temp.period(20,15))),'{"error":"consent_withdrawn"}'::jsonb,
  'a queued upload cannot repopulate it');
select is(pg_temp.cy('status_read','cy-owner-a'),'{"state":"off"}'::jsonb,'the Cycle row is off again');

-- Withdrawing health storage withdraws cycle context with it.
select is(pg_temp.grant_('cy-owner-a','cy-grant-3',2)->'consent'->>'status','granted','it can be turned on again');
select is(pg_temp.ingest('cy-owner-a','cy-ingest-7',3,'apple',60,jsonb_build_array(pg_temp.period(20,15)))->'accepted','1'::jsonb,'and takes periods at the new epoch');
update waldo.health_consents set withdrawn_at = now() where owner_id='c1300000-0000-0000-0000-0000000000a3' and source='apple' and purpose='storage_compute';
select is(pg_temp.consent('cy-owner-a')->>'status','withdrawn','withdrawing apple storage withdraws cycle context');
select is(pg_temp.stored('c1300000-0000-0000-0000-0000000000a3'),0::bigint,'and deletes its periods');
select throws_ok($$ update waldo.cycle_consents set version = 2 where owner_id = 'c1300000-0000-0000-0000-0000000000a3' $$,'23514',null,'a consent record changes only by withdrawal');

-- Retention and account deletion.
insert into waldo.cycle_periods(owner_id,source,start_date,end_date,epoch,origin) values
  ('c1300000-0000-0000-0000-0000000000b3','apple',current_date - 100,current_date - 96,1,'{}'),
  ('c1300000-0000-0000-0000-0000000000b3','apple',current_date - 30,current_date - 26,1,'{}');
select ok((pg_temp.sweep('{"limit":200}')->>'owners')::int >= 1,'the sweep finds an owner whose only expired rows are periods');
select is(array(select to_char(start_date,'YYYY-MM-DD') from waldo.cycle_periods where owner_id='c1300000-0000-0000-0000-0000000000b3'),
  array[to_char(current_date - 30,'YYYY-MM-DD')],'and removes the period that ended more than 90 days ago, keeping the recent one');

delete from waldo.owners where id='c1300000-0000-0000-0000-0000000000b3';
select is((select count(*) from waldo.cycle_periods where owner_id='c1300000-0000-0000-0000-0000000000b3'),0::bigint,'account deletion removes every period with the owner');

select * from finish();
rollback;
