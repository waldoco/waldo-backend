begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- Every health call is signed over 'health.<operation>.<owner locator>.<md5 of the payload text>'.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.hz(op text,owner text,body text,sig text) returns jsonb language plpgsql as $$
declare r jsonb;
begin execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,body,extract(epoch from now())::bigint,sig; return r; end $$;

insert into auth.users(id,email) values
 ('a1000000-0000-0000-0000-0000000000a1','health-a@example.invalid'),
 ('b1000000-0000-0000-0000-0000000000b1','health-b@example.invalid'),
 ('c1000000-0000-0000-0000-0000000000c1','health-c@example.invalid'),
 ('d1000000-0000-0000-0000-0000000000d1','health-d@example.invalid');
-- No public.users rows: health identity comes from the owner row, not the legacy profile table.
insert into waldo.owners(id,auth_user_id,do_name,email) values
 ('a3000000-0000-0000-0000-0000000000a3','a1000000-0000-0000-0000-0000000000a1','health-owner-a','health-a@example.invalid'),
 ('b3000000-0000-0000-0000-0000000000b3','b1000000-0000-0000-0000-0000000000b1','health-owner-b','health-b@example.invalid'),
 ('c3000000-0000-0000-0000-0000000000c3','c1000000-0000-0000-0000-0000000000c1','health-owner-c','health-c@example.invalid'),
 ('d3000000-0000-0000-0000-0000000000d3','d1000000-0000-0000-0000-0000000000d1','health-owner-d','health-d@example.invalid');
update waldo.owners set state='suspended' where do_name='health-owner-c';

create function pg_temp.grant_body(rid text,src text,purpose text,epoch int default 0) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source',src,'purpose',purpose,'version',2,'expected_epoch',epoch,'age_attested_18_plus',true) $$;
create function pg_temp.hour_start(back int) returns timestamptz language sql as $$ select date_trunc('hour',now())-make_interval(hours=>back) $$;
create function pg_temp.iso(t timestamptz) returns text language sql as $$ select to_char(t at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') $$;
create function pg_temp.steps(id text,back int,val numeric,rev bigint default null,offset_min int default 0) returns jsonb language sql as $$
  select jsonb_build_object('sample_id',id,'revision',coalesce(rev,extract(epoch from now())::bigint),'signal','steps_window','unit','count','value',val,
    'day',((pg_temp.hour_start(back)+make_interval(mins=>offset_min)) at time zone 'UTC')::date,
    'start_at',pg_temp.iso(pg_temp.hour_start(back)),'end_at',pg_temp.iso(pg_temp.hour_start(back)+interval '1 hour'),'utc_offset_minutes',offset_min) $$;
create function pg_temp.sleep(id text,val numeric,rev bigint default null) returns jsonb language sql as $$
  select jsonb_build_object('sample_id',id,'revision',coalesce(rev,extract(epoch from now())::bigint),'signal','sleep_duration','unit','minutes','value',val,
    'day',((now()-interval '2 hours') at time zone 'UTC')::date,'start_at',pg_temp.iso(now()-interval '9 hours'),'end_at',pg_temp.iso(now()-interval '2 hours'),'utc_offset_minutes',0) $$;
create function pg_temp.batch(rid text,epoch int,before_anchor text,after_anchor text,samples jsonb,deletions jsonb default '[]',src text default 'apple') returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source',src,'consent_epoch',epoch,'timezone','UTC','anchor_before',before_anchor,'anchor_after',after_anchor,'samples',samples,'deletions',deletions) $$;
create function pg_temp.n(owner text,src text default 'apple') returns int language sql as $$
  select count(*)::int from waldo.health_samples s join waldo.owners o on o.id=s.owner_id where o.do_name=owner and s.source=src and s.payload is not null $$;

-- Consent: explicit, versioned, owner-keyed, never created by an upload.
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('ingest-pre-0001',0,null,'a0',jsonb_build_array(pg_temp.steps('s1',1,10))))->>'error','consent_required','an upload cannot create consent');
select is(pg_temp.h('consent_grant','health-owner-a',pg_temp.grant_body('grant-x-000001','apple','storage_compute')-'age_attested_18_plus')->>'error','invalid_request','a grant without age evidence is refused');
select is(pg_temp.h('consent_grant','health-owner-a',pg_temp.grant_body('grant-x-000002','apple','storage_compute')||'{"version":1}')->>'error','invalid_request','a grant of the old copy version is refused');
select is(pg_temp.h('consent_grant','health-owner-a',pg_temp.grant_body('grant-x-000003','garmin','storage_compute'))->>'error','invalid_request','a source the app cannot read is refused');
select is(pg_temp.h('consent_grant','health-owner-a',pg_temp.grant_body('grant-x-000004','apple','everything'))->>'error','invalid_request','an unknown purpose is refused');
select is(pg_temp.h('consent_grant','health-owner-a',pg_temp.grant_body('short','apple','storage_compute'))->>'error','invalid_request','a malformed request id is refused');
select is(pg_temp.h('consent_grant','health-owner-a',pg_temp.grant_body('grant-a-storage1','apple','storage_compute'))->'consent'->>'status','granted','an explicit grant is recorded for the owner');
select is(pg_temp.h('consent_grant','health-owner-a',pg_temp.grant_body('grant-a-storage1','apple','storage_compute'))->>'replayed','true','replaying the same grant is stable');
select is(pg_temp.h('consent_grant','health-owner-a',pg_temp.grant_body('grant-a-storage2','apple','storage_compute',1))->>'error','epoch_conflict','granting again while granted is refused');
select is(pg_temp.h('consent_grant','health-owner-a',pg_temp.grant_body('grant-a-storage3','samsung','storage_compute',7))->>'error','epoch_conflict','a grant at the wrong epoch is refused');
select is(pg_temp.h('consent_grant','health-owner-a',pg_temp.grant_body('grant-a-hconnect','health_connect','storage_compute'))->'consent'->>'source','health_connect','Health Connect is a grantable source');
select is((select count(*)::int from waldo.health_consents c join waldo.owners o on o.id=c.owner_id where o.do_name='health-owner-a' and c.withdrawn_at is null),2,'each active grant is one audit row');
select is(pg_temp.h('consent_grant','health-owner-b',pg_temp.grant_body('grant-b-storage1','apple','storage_compute'))->'consent'->>'epoch','1','another owner consents independently');
select is(jsonb_array_length(pg_temp.h('consent_list','health-owner-a')->'consents'),2,'the list shows an owner its own scopes');
select is((pg_temp.h('consent_list','health-owner-a')->'consents'->0)->>'consent_class','health_processing','the consent class is health processing');
select is(pg_temp.h('consent_list','health-owner-c')->>'error','not_linked','a suspended owner has no health plane');
select is(pg_temp.h('consent_list','health-owner-nobody')->>'error','not_linked','an unprovisioned locator has no health plane');
select throws_ok($$update waldo.health_consents set granted_at=granted_at-interval '1 day'$$,'23514',null,'consent history cannot be rewritten');

-- Ingest: idempotent, atomic, revision-ordered.
create temp table hb as select pg_temp.batch('ingest-a-000001',1,null,'anchor-1',jsonb_build_array(pg_temp.steps('step-h1',2,1200),pg_temp.sleep('sleep:apple:today',420))) as body;
select is(pg_temp.h('ingest','health-owner-a',(select body from hb))->>'accepted','2','a valid batch is accepted');
select is(pg_temp.h('ingest','health-owner-a',(select body from hb))->>'replayed','true','replaying a batch changes nothing');
select is(pg_temp.n('health-owner-a'),2,'a replay creates no duplicate reading');
select is(pg_temp.h('ingest','health-owner-a',jsonb_set((select body from hb),'{samples,0,value}','1300'))->>'error','idempotency_conflict','the same request id with another body is refused');
select is(pg_temp.h('ingest','health-owner-b',pg_temp.batch('ingest-a-000001',1,null,'anchor-1',jsonb_build_array(pg_temp.steps('step-h1',2,5))))->>'accepted','1','the same ids belong to each owner separately');
select is(pg_temp.n('health-owner-a'),2,'another owner upload leaves this owner unchanged');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('ingest-a-bad-001',1,'anchor-1','anchor-2',jsonb_build_array(pg_temp.steps('ok-one',3,10),pg_temp.steps('bad-one',3,10)||'{"signal":"unknown_signal"}')))->>'error','invalid_request','one bad reading refuses the whole batch');
select is(pg_temp.n('health-owner-a'),2,'a refused batch stores nothing');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('ingest-a-bad-002',1,'anchor-1','anchor-2',jsonb_build_array(pg_temp.steps('u1',3,10)||'{"unit":"steps"}')))->>'error','invalid_request','a wrong unit is refused');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('ingest-a-bad-003',1,'anchor-1','anchor-2',jsonb_build_array(pg_temp.steps('v1',3,-1))))->>'error','invalid_request','a value below its bound is refused');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('ingest-a-bad-004',1,'anchor-1','anchor-2',jsonb_build_array(pg_temp.steps('v2',3,300001))))->>'error','invalid_request','a value above its bound is refused');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('ingest-a-bad-005',1,'anchor-1','anchor-2',jsonb_build_array(pg_temp.steps('w1',3,10)||jsonb_build_object('end_at',pg_temp.iso(pg_temp.hour_start(3)+interval '30 minutes')))))->>'error','invalid_request','a window that is not one hour is refused');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('ingest-a-bad-006',1,'anchor-1','anchor-2',jsonb_build_array(pg_temp.steps('w2',3,10)||jsonb_build_object('start_at',pg_temp.iso(pg_temp.hour_start(3)+interval '15 minutes'),'end_at',pg_temp.iso(pg_temp.hour_start(3)+interval '75 minutes')))))->>'error','invalid_request','a window off the local hour is refused');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('ingest-a-bad-007',1,'anchor-1','anchor-2',jsonb_build_array(pg_temp.steps('d1',3,10)||'{"day":"2001-01-01"}')))->>'error','invalid_request','a day that is not the reading local date is refused');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('ingest-a-bad-008',1,'anchor-1','anchor-2',jsonb_build_array(pg_temp.steps('o1',3,10)||'{"utc_offset_minutes":900}')))->>'error','invalid_request','an impossible UTC offset is refused');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('ingest-a-bad-009',1,'anchor-1','anchor-2',jsonb_build_array(pg_temp.steps('r1',3,10,extract(epoch from now())::bigint+3600))))->>'error','invalid_request','an observation-time revision from the future is refused');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('ingest-a-bad-010',1,'anchor-1','anchor-2',jsonb_build_array(pg_temp.steps('f1',-3,10))))->>'error','invalid_request','a window that ends in the future is refused');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('ingest-a-bad-011',1,'anchor-1','anchor-2','[]')||'{"timezone":"Not/AZone"}')->>'error','invalid_request','an unknown time zone is refused');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('ingest-a-bad-012',1,'anchor-1','anchor-2',(select jsonb_agg(pg_temp.steps('big'||g,5,1)) from generate_series(1,129) g)))->>'error','invalid_request','more than 128 changes are refused');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('ingest-a-bad-013',0,'anchor-1','anchor-2','[]'))->>'error','epoch_conflict','an upload at another consent epoch is refused');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('ingest-a-000002',1,'anchor-1','anchor-2','[]'))->>'accepted','0','a zero-change batch advances the anchor');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('ingest-a-000003',1,'anchor-1','anchor-3','[]'))->>'error','anchor_conflict','a stale anchor is refused');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('ingest-a-000004',1,null,'anchor-fresh','[]'))->>'accepted','0','a null anchor is always accepted as a resync');

-- Revisions, tombstones, travel.
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('rev-a-000001',1,'anchor-fresh','a-r1',jsonb_build_array(pg_temp.steps('step-h1',2,1300,extract(epoch from now())::bigint+1))))->>'accepted','1','a higher revision replaces the stored reading');
select is((select (payload->>'value')::numeric from waldo.health_samples s join waldo.owners o on o.id=s.owner_id where o.do_name='health-owner-a' and s.sample_id='step-h1'),1300::numeric,'the replacement value is stored');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('rev-a-000002',1,'a-r1','a-r2',jsonb_build_array(pg_temp.steps('step-h1',2,900,extract(epoch from now())::bigint-100))))->>'ignored','1','a lower revision is ignored');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('rev-a-000003',1,'a-r2','a-r3',jsonb_build_array(pg_temp.steps('step-h1',2,5555,extract(epoch from now())::bigint+1))))->>'error','sample_conflict','the same revision with different content is a conflict');
select is(pg_temp.n('health-owner-a'),2,'a conflicting batch leaves the readings as they were');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('rev-a-000004',1,'a-r2','a-r4','[]',jsonb_build_array(jsonb_build_object('sample_id','step-h1','signal','steps_window','revision',extract(epoch from now())::bigint+1))))->>'deleted','1','a deletion at the same revision removes the reading');
select is(pg_temp.n('health-owner-a'),1,'the deleted reading is gone');
select is((select payload is null and deleted_at is not null from waldo.health_samples s join waldo.owners o on o.id=s.owner_id where o.do_name='health-owner-a' and s.sample_id='step-h1'),true,'a deletion leaves a value-free tombstone');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('rev-a-000005',1,'a-r4','a-r5',jsonb_build_array(pg_temp.steps('step-h1',2,1300,extract(epoch from now())::bigint+1))))->>'ignored','1','an upload at the tombstone revision cannot resurrect the reading');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('rev-a-000006',1,'a-r5','a-r6',jsonb_build_array(pg_temp.steps('step-h1',2,1400,extract(epoch from now())::bigint+2))))->>'accepted','1','a later revision after a deletion is a new reading');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('rev-a-000007',1,'a-r6','a-r7','[]',jsonb_build_array(jsonb_build_object('sample_id','step-h1','signal','steps_window','revision',extract(epoch from now())::bigint-500))))->>'ignored','1','an older deletion cannot remove a newer reading');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('trav-a-000001',1,'a-r7','a-t1',jsonb_build_array(pg_temp.steps('trav-west',6,10,null,-480),pg_temp.steps('trav-east',6,11,null,120))))->>'accepted','2','one batch may carry readings from two zones');
select is((select count(distinct (payload->>'utc_offset_minutes'))::int from waldo.health_samples s join waldo.owners o on o.id=s.owner_id where o.do_name='health-owner-a' and s.sample_id like 'trav-%'),2,'each reading keeps its own offset');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('hrv-a-000001',1,'a-t1','a-h1',jsonb_build_array(
  jsonb_build_object('sample_id','hrv-r','revision',1,'signal','overnight_hrv','unit','milliseconds','method','rmssd','value',48,'day',((now()-interval '2 hours') at time zone 'UTC')::date,'start_at',pg_temp.iso(now()-interval '9 hours'),'end_at',pg_temp.iso(now()-interval '2 hours'),'utc_offset_minutes',0),
  jsonb_build_object('sample_id','hrv-s','revision',1,'signal','overnight_hrv','unit','milliseconds','method','sdnn','value',61,'day',((now()-interval '2 hours') at time zone 'UTC')::date,'start_at',pg_temp.iso(now()-interval '9 hours'),'end_at',pg_temp.iso(now()-interval '2 hours'),'utc_offset_minutes',0))))->>'accepted','2','RMSSD and SDNN readings are stored under their own labels');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('hrv-a-bad-001',1,'a-h1','a-h2',jsonb_build_array(jsonb_build_object('sample_id','hrv-nomethod','revision',1,'signal','overnight_hrv','unit','milliseconds','value',48,'day',((now()-interval '2 hours') at time zone 'UTC')::date,'start_at',pg_temp.iso(now()-interval '9 hours'),'end_at',pg_temp.iso(now()-interval '2 hours'),'utc_offset_minutes',0))))->>'error','invalid_request','an HRV reading without a method is refused');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('hrv-a-bad-002',1,'a-h1','a-h2',jsonb_build_array(jsonb_build_object('sample_id','hrv-pnn','revision',1,'signal','hrv_window','unit','milliseconds','method','pnn50','value',48,'day',((pg_temp.hour_start(3)) at time zone 'UTC')::date,'start_at',pg_temp.iso(pg_temp.hour_start(3)),'end_at',pg_temp.iso(pg_temp.hour_start(3)+interval '1 hour'),'utc_offset_minutes',0))))->>'error','invalid_request','an HRV method other than rmssd or sdnn is refused');
select is((select array_agg(distinct payload->>'method' order by payload->>'method') from waldo.health_samples s join waldo.owners o on o.id=s.owner_id where o.do_name='health-owner-a' and s.signal='overnight_hrv'),array['rmssd','sdnn'],'no method is relabelled or blended');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('old-a-000001',1,'a-h1','a-o1',jsonb_build_array(jsonb_build_object('sample_id','ancient','revision',1,'signal','steps_window','unit','count','value',5,'day',((now()-interval '100 days') at time zone 'UTC')::date,'start_at',pg_temp.iso(date_trunc('hour',now()-interval '100 days')),'end_at',pg_temp.iso(date_trunc('hour',now()-interval '100 days')+interval '1 hour'),'utc_offset_minutes',0))))->>'ignored','1','a reading older than the raw retention is ignored');

-- Withdrawal removes the source, withdraws every purpose, and fences late work.
select is(pg_temp.h('consent_grant','health-owner-a',pg_temp.grant_body('grant-a-model001','apple','model_processing'))->'consent'->>'purpose','model_processing','a separate model purpose is a separate grant');
select is(pg_temp.h('consent_withdraw','health-owner-a',jsonb_build_object('request_id','withdraw-a-bad01','source','apple','purpose','storage_compute','expected_epoch',9))->>'error','epoch_conflict','a withdrawal at the wrong epoch is refused');
select is(pg_temp.h('consent_withdraw','health-owner-a',jsonb_build_object('request_id','withdraw-a-0001','source','apple','purpose','storage_compute','expected_epoch',1))->>'deletion_routed','true','a withdrawal routes deletion');
select is(pg_temp.n('health-owner-a'),0,'withdrawal deletes the source readings');
select is((select count(*)::int from waldo.health_anchors a join waldo.owners o on o.id=a.owner_id where o.do_name='health-owner-a' and a.source='apple'),0,'withdrawal deletes the source anchor');
select is((select count(*)::int from waldo.health_consents c join waldo.owners o on o.id=c.owner_id where o.do_name='health-owner-a' and c.source='apple' and c.withdrawn_at is null),0,'withdrawing one purpose withdraws both for the source');
select is((select count(*)::int from waldo.health_consents c join waldo.owners o on o.id=c.owner_id where o.do_name='health-owner-a' and c.source='health_connect' and c.withdrawn_at is null),1,'another source is untouched');
select is(pg_temp.h('consent_withdraw','health-owner-a',jsonb_build_object('request_id','withdraw-a-0001','source','apple','purpose','storage_compute','expected_epoch',1))->>'replayed','true','replaying a withdrawal is stable');
select is(pg_temp.h('ingest','health-owner-a',(select body from hb))->>'error','consent_withdrawn','a replay of an old upload cannot bypass the withdrawal');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('late-a-000001',1,null,'late',jsonb_build_array(pg_temp.steps('late',2,5))))->>'error','consent_withdrawn','a late upload after withdrawal is refused');
select is(pg_temp.h('consent_grant','health-owner-a',pg_temp.grant_body('grant-a-regrant1','apple','storage_compute',2))->'consent'->>'epoch','3','a fresh grant raises the epoch');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('late-a-000002',1,null,'late2',jsonb_build_array(pg_temp.steps('late',2,5))))->>'error','epoch_conflict','an upload made before the regrant cannot repopulate the data');
select is(pg_temp.n('health-owner-b'),1,'another owner data survives this owner withdrawal');

-- The read model has one writer: the signed function.
create function pg_temp.ctx(day text default null) returns jsonb language sql as $$
  select jsonb_build_object('day',coalesce(day,to_char(now() at time zone 'UTC','YYYY-MM-DD')),'form',jsonb_build_object('score',72,'zone','good','drivers','[]'::jsonb,'confidence',0.8),
    'recovery',jsonb_build_object('score',64,'zone','moderate'),'weight',jsonb_build_object('score',40,'zone','low'),'drivers','["sleep below baseline"]'::jsonb,'confidence',0.8,'freshness','fresh','tags','["degraded"]'::jsonb) $$;
select is(pg_temp.h('context_write','health-owner-c',pg_temp.ctx())->>'error','not_linked','a suspended owner cannot write a read-model row');
select is(pg_temp.h('consent_grant','health-owner-b',pg_temp.grant_body('grant-b-model001','apple','model_processing'))->'consent'->>'status','granted','owner B also holds the model purpose');
select is(pg_temp.h('context_write','health-owner-d',pg_temp.ctx())->>'error','consent_required','an owner without a live storage grant gets no derived row');
select is(pg_temp.h('context_write','health-owner-b',pg_temp.ctx())->>'written','true','a consented owner gets a derived row');
select is((select count(*)::int from public.health_context_daily where user_id='b1000000-0000-0000-0000-0000000000b1'),1,'one row per owner and day');
select is(pg_temp.h('context_write','health-owner-b',pg_temp.ctx())->>'written','true','writing the same day again updates it');
select is((select count(*)::int from public.health_context_daily where user_id='b1000000-0000-0000-0000-0000000000b1'),1,'the second write did not add a row');
select ok((select updated_at=now() from public.health_context_daily where user_id='b1000000-0000-0000-0000-0000000000b1'),'the compile time is the database write time');
select is(pg_temp.h('context_write','health-owner-b',jsonb_set(pg_temp.ctx(),'{form,zone}','"excellent"'))->>'error','invalid_request','a zone word outside the stored vocabulary is refused');
select is(pg_temp.h('context_write','health-owner-b',jsonb_set(pg_temp.ctx(),'{recovery,score}','101'))->>'error','invalid_request','a score above 100 is refused');
select is(pg_temp.h('context_write','health-owner-b',pg_temp.ctx('not-a-date'))->>'error','invalid_request','a malformed day is refused');
select is(pg_temp.h('context_write','health-owner-b',pg_temp.ctx()||'{"owner_id":"x"}')->>'error','invalid_request','an unknown field is refused');
select is(pg_temp.h('context_write','health-owner-a',pg_temp.ctx())->>'written','true','owner A with a live grant can write');
select is((select count(*)::int from public.health_context_daily),2,'each owner has only their own row');
select is(pg_temp.h('context_write','health-owner-b',pg_temp.ctx()||'{"form":null}')->>'written','true','a pillar may be absent');
select is((select form from public.health_context_daily where user_id='b1000000-0000-0000-0000-0000000000b1') is null,true,'an absent pillar is stored as absent');
set local role service_role;
select throws_ok($$insert into public.health_context_daily(user_id,day) values ('b1000000-0000-0000-0000-0000000000b1','2001-01-01')$$,'42501',null,'the service role cannot write the read model directly');
select throws_ok($$update public.health_context_daily set form='{}'$$,'42501',null,'the service role cannot rewrite the read model');
select lives_ok($$select count(*) from public.health_context_daily$$,'the service role can still read it');
reset role;

-- Purge and retention.
select is(pg_temp.h('ingest','health-owner-b',pg_temp.batch('ingest-b-000009',1,'anchor-1','anchor-9',jsonb_build_array(pg_temp.steps('keep-me',4,7))))->>'accepted','1','owner B has a reading to purge');
select is((pg_temp.h('purge','health-owner-b'))->>'state','completed','an account purge completes');
select is(pg_temp.n('health-owner-b'),0,'purge removes the readings');
select is((select count(*)::int from public.health_context_daily where user_id='b1000000-0000-0000-0000-0000000000b1'),0,'purge removes the read-model rows');
select is((select count(*)::int from waldo.health_requests r join waldo.owners o on o.id=r.owner_id where o.do_name='health-owner-b'),0,'purge removes request receipts');
select is((select count(*)::int from waldo.health_consents c join waldo.owners o on o.id=c.owner_id where o.do_name='health-owner-b' and c.withdrawn_at is null),0,'purge withdraws every grant');
select ok((select count(*)>0 from waldo.health_consents c join waldo.owners o on o.id=c.owner_id where o.do_name='health-owner-b'),'consent audit evidence survives the purge');
select is(pg_temp.h('ingest','health-owner-b',pg_temp.batch('ingest-b-000010',1,null,'x',jsonb_build_array(pg_temp.steps('after',4,7))))->>'error','consent_withdrawn','nothing can be stored after a purge without a fresh grant');
-- Retention keeps recent readings and removes old ones and old tombstones.
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('ret-a-000001',3,null,'ret-1',jsonb_build_array(pg_temp.steps('ret-old',2,3),pg_temp.steps('ret-new',3,4),pg_temp.steps('ret-gone',4,5))))->>'accepted','3','owner A stores readings at the current epoch');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('ret-a-000002',3,'ret-1','ret-2','[]',jsonb_build_array(jsonb_build_object('sample_id','ret-gone','signal','steps_window','revision',extract(epoch from now())::bigint+5))))->>'deleted','1','one reading becomes a tombstone');
update waldo.health_samples set start_at=now()-interval '121 days',end_at=now()-interval '120 days' where sample_id='ret-old';
update waldo.health_samples set deleted_at=now()-interval '120 days' where sample_id='ret-gone';
select is((pg_temp.h('retention','health-owner-a'))->>'raw_deleted','2','retention removes the old reading and the old tombstone');
select is((select count(*)::int from waldo.health_samples s join waldo.owners o on o.id=s.owner_id where o.do_name='health-owner-a' and s.sample_id='ret-new'),1,'retention keeps the recent reading');

-- Authentication and privileges.
select throws_ok($$select waldo.health_consent_list('health-owner-a','{}',extract(epoch from now())::bigint,'forged')$$,'42501','unsigned router call','a forged signature is refused on the list');
select throws_ok($$select waldo.health_ingest('health-owner-a','{}',extract(epoch from now())::bigint,'forged')$$,'42501','unsigned router call','a forged signature is refused on ingest');
select throws_ok($$select waldo.health_context_write('health-owner-a','{}',extract(epoch from now())::bigint,'forged')$$,'42501','unsigned router call','a forged signature is refused on the read-model write');
select throws_ok($$select waldo.health_purge('health-owner-a','{}',extract(epoch from now())::bigint,'forged')$$,'42501','unsigned router call','a forged signature is refused on purge');
select throws_ok(format($f$select waldo.health_ingest('health-owner-a','{"a":1}',%s,%L)$f$,extract(epoch from now())::bigint,pg_temp.sig('health.consent_list.health-owner-a.'||md5('{"a":1}'),extract(epoch from now())::bigint)),'42501','unsigned router call','a signature for another operation is refused');
select throws_ok(format($f$select waldo.health_ingest('health-owner-b','{"a":1}',%s,%L)$f$,extract(epoch from now())::bigint,pg_temp.sig('health.ingest.health-owner-a.'||md5('{"a":1}'),extract(epoch from now())::bigint)),'42501','unsigned router call','a signature for another owner is refused');
select is((select array_agg(has_function_privilege('anon',p.oid,'execute') order by p.proname) from pg_proc p where p.pronamespace='waldo'::regnamespace and p.proname in ('health_consent_list','health_consent_grant','health_consent_withdraw','health_ingest','health_purge','health_retention','health_context_write')),array[true,true,true,true,true,true,true],'the signed router reaches every health function as anon');
select is((select count(*)::int from pg_proc p where p.pronamespace='waldo'::regnamespace and (has_function_privilege('authenticated',p.oid,'execute') or has_function_privilege('service_role',p.oid,'execute') or has_function_privilege('public',p.oid,'execute')) and p.proname in ('health_consent_list','health_consent_grant','health_consent_withdraw','health_ingest','health_purge','health_retention','health_context_write')),0,'no signed-in member, service role or public caller can execute them');
select is((select count(*)::int from information_schema.table_privileges where table_schema='waldo' and table_name in ('health_consents','health_scopes','health_samples','health_anchors','health_requests') and grantee in ('PUBLIC','anon','authenticated','service_role')),0,'no client or service role holds any privilege on the health tables');
select is((select count(*)::int from pg_class c where c.relnamespace='waldo'::regnamespace and c.relname in ('health_consents','health_scopes','health_samples','health_anchors','health_requests') and c.relkind='r' and not (c.relrowsecurity and c.relforcerowsecurity)),0,'every health table has forced row security');
select * from finish();
rollback;
