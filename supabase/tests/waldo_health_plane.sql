begin;
create extension if not exists pgtap with schema extensions;
select plan(216);
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
 ('d1000000-0000-0000-0000-0000000000d1','health-d@example.invalid'),
 ('e1000000-0000-0000-0000-0000000000e1','health-e@example.invalid'),
 ('f1000000-0000-0000-0000-0000000000f1','health-f@example.invalid');
-- No public.users rows: health identity comes from the owner row, not the legacy profile table.
insert into waldo.owners(id,auth_user_id,do_name,email) values
 ('a3000000-0000-0000-0000-0000000000a3','a1000000-0000-0000-0000-0000000000a1','health-owner-a','health-a@example.invalid'),
 ('b3000000-0000-0000-0000-0000000000b3','b1000000-0000-0000-0000-0000000000b1','health-owner-b','health-b@example.invalid'),
 ('c3000000-0000-0000-0000-0000000000c3','c1000000-0000-0000-0000-0000000000c1','health-owner-c','health-c@example.invalid'),
 ('d3000000-0000-0000-0000-0000000000d3','d1000000-0000-0000-0000-0000000000d1','health-owner-d','health-d@example.invalid'),
 ('e3000000-0000-0000-0000-0000000000e3','e1000000-0000-0000-0000-0000000000e1','health-owner-e','health-e@example.invalid'),
 ('f3000000-0000-0000-0000-0000000000f3','f1000000-0000-0000-0000-0000000000f1','health-owner-f','health-f@example.invalid');
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

-- One-hour step bucket that starts at a chosen minute shift and offset, dated by its own local start.
create function pg_temp.stepsm(id text,back int,shift_min int,off int,val numeric default 10) returns jsonb language sql as $$
  select jsonb_build_object('sample_id',id,'revision',extract(epoch from now())::bigint,'signal','steps_window','unit','count','value',val,
    'day',((pg_temp.hour_start(back)+make_interval(mins=>shift_min+off)) at time zone 'UTC')::date,
    'start_at',pg_temp.iso(pg_temp.hour_start(back)+make_interval(mins=>shift_min)),'end_at',pg_temp.iso(pg_temp.hour_start(back)+make_interval(mins=>shift_min+60)),'utc_offset_minutes',off) $$;
create function pg_temp.spo2(id text,rev bigint,val numeric,start_ts timestamptz default now()-interval '1 hour',origin jsonb default null) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('sample_id',id,'revision',rev,'signal','spo2','unit','percent','value',val,'day',(start_ts at time zone 'UTC')::date,
    'start_at',pg_temp.iso(start_ts),'end_at',pg_temp.iso(start_ts),'utc_offset_minutes',0,'origin',origin)) $$;
create function pg_temp.rd(owner text) returns jsonb language plpgsql as $$
declare a bigint:=extract(epoch from now())::bigint;
begin return waldo.health_context_read(owner,a,pg_temp.sig('healthctx.read.'||owner,a)); end $$;
create function pg_temp.epoch_of(p_owner text,p_src text,p_purpose text) returns int language sql as $$
  select s.epoch from waldo.health_scopes s join waldo.owners o on o.id=s.owner_id where o.do_name=p_owner and s.source=p_src and s.purpose=p_purpose $$;

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
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('ingest-a-bad-010',1,'anchor-1','anchor-2',jsonb_build_array(pg_temp.steps('f1',-3,10))))->>'error','invalid_request','a window that starts in the future is refused');
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

-- Bounds: a window is bounded by its start, a point record by its end; a window is dated by its local start.
create function pg_temp.off23() returns int language sql as $$ select (mod(23-extract(hour from pg_temp.hour_start(4) at time zone 'UTC')::int+12,24)-12)*60 $$;
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('bound-a-000001',1,null,'b1',jsonb_build_array(pg_temp.steps('cur-hour',0,100))))->>'accepted','1','the hour still in progress is accepted');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('bound-a-000002',1,null,'b2',jsonb_build_array(pg_temp.spo2('spo2-ok',1,97))))->>'accepted','1','a point reading in the past is accepted');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('bound-a-000003',1,null,'b3',jsonb_build_array(pg_temp.spo2('spo2-fut',1,97,now()+interval '30 minutes'))))->>'error','invalid_request','a point reading that ends in the future is refused');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('bound-a-000013',1,null,'b13',jsonb_build_array(pg_temp.spo2('spo2-day',1,97)||'{"day":"2001-01-01"}')))->>'error','invalid_request','a point reading dated by neither of its local dates is refused');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('bound-a-000004',1,null,'b4',jsonb_build_array(pg_temp.steps('midnight-ok',4,10,null,pg_temp.off23()))))->>'accepted','1','a window that crosses local midnight is accepted on its start date');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('bound-a-000005',1,null,'b5',jsonb_build_array(jsonb_set(pg_temp.steps('midnight-bad',4,10,null,pg_temp.off23()),'{day}',to_jsonb((((pg_temp.steps('x',4,1,null,pg_temp.off23())->>'day')::date)+1)::text)))))->>'error','invalid_request','a window dated by its end date is refused');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('bound-a-000006',1,null,'b6',jsonb_build_array(pg_temp.stepsm('ist-ok',4,30,330),pg_temp.stepsm('npt-ok',4,15,345),pg_temp.stepsm('nl-ok',4,30,-210))))->>'accepted','3','half-hour and quarter-hour zones align on their own local hour');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('bound-a-000007',1,null,'b7',jsonb_build_array(pg_temp.stepsm('ist-bad',4,0,330))))->>'error','invalid_request','a UTC-hour bucket under a half-hour offset is refused');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('bound-a-000008',1,null,'b8',jsonb_build_array(pg_temp.sleep('sleep-inf',420)||'{"start_at":"-infinity"}')))->>'error','invalid_request','an infinite start is refused');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('bound-a-000009',1,null,'b9',jsonb_build_array(pg_temp.steps('bad-day',3,10)||'{"day":"garbage"}')))->>'error','invalid_request','a malformed day is refused without an error');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('bound-a-000010',1,null,'b10',jsonb_build_array(pg_temp.spo2('origin-1',0,97,now()-interval '1 hour','{"read_api":"healthkit","recording_method":"automatic"}'::jsonb))))->>'accepted','1','a reading with its origin is accepted');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('bound-a-000011',1,null,'b11',jsonb_build_array(pg_temp.spo2('origin-1',0,97,now()-interval '1 hour','{"read_api":"healthkit","recording_method":"manual","device_ref":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'::jsonb))))->>'ignored','1','a changed origin at the same revision is ignored, not a conflict');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('bound-a-000012',1,null,'b12',jsonb_build_array(pg_temp.spo2('origin-1',0,96,now()-interval '1 hour','{"read_api":"healthkit","recording_method":"automatic"}'::jsonb))))->>'error','sample_conflict','a changed value at the same revision is still a conflict');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('tomb-a-000001',1,null,'t1',jsonb_build_array(pg_temp.spo2('tomb-1',5,96))))->>'accepted','1','a point reading is stored before its deletions');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('tomb-a-000002',1,null,'t2','[]',jsonb_build_array(jsonb_build_object('sample_id','tomb-1','signal','spo2','revision',10))))->>'deleted','1','it is deleted at revision 10');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('tomb-a-000003',1,null,'t3','[]',jsonb_build_array(jsonb_build_object('sample_id','tomb-1','signal','spo2','revision',20))))->>'ignored','1','a newer deletion of a deleted reading changes nothing visible');
select is((select revision from waldo.health_samples s join waldo.owners o on o.id=s.owner_id where o.do_name='health-owner-a' and s.sample_id='tomb-1'),20::bigint,'but it raises the tombstone revision');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('tomb-a-000004',1,null,'t4',jsonb_build_array(pg_temp.spo2('tomb-1',15,95))))->>'ignored','1','a late reading older than the newest deletion cannot come back');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('tomb-a-000005',1,null,'t5','[]',jsonb_build_array(jsonb_build_object('sample_id','win-empty','signal','steps_window','revision',extract(epoch from now())::bigint))))->>'deleted','1','a window hour with no readings left can be sent as a deletion');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('tomb-a-000006',1,null,'t6',jsonb_build_array(pg_temp.steps('win-empty',3,25,extract(epoch from now())::bigint+10))))->>'accepted','1','a later revision of that hour replaces the deletion');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('hrv-a-000002',1,null,'h2',jsonb_build_array(
  jsonb_build_object('sample_id','hrv-wake-start','revision',1,'signal','overnight_hrv','unit','milliseconds','method','rmssd','value',50,'day',((date_trunc('day',now() at time zone 'UTC')-interval '26 hours'))::date,'start_at',pg_temp.iso(date_trunc('day',now())-interval '26 hours'),'end_at',pg_temp.iso(date_trunc('day',now())-interval '18 hours'),'utc_offset_minutes',0),
  jsonb_build_object('sample_id','hrv-wake-end','revision',1,'signal','overnight_hrv','unit','milliseconds','method','rmssd','value',51,'day',((date_trunc('day',now() at time zone 'UTC')-interval '18 hours'))::date,'start_at',pg_temp.iso(date_trunc('day',now())-interval '26 hours'),'end_at',pg_temp.iso(date_trunc('day',now())-interval '18 hours'),'utc_offset_minutes',0))))->>'accepted','2','a night is dated by either its start or its end, like a sleep session');

-- Withdrawing storage removes the source, withdraws both purposes, and fences late work.
select is(pg_temp.h('consent_grant','health-owner-a',pg_temp.grant_body('grant-a-model001','apple','model_processing'))->'consent'->>'purpose','model_processing','a separate model purpose is a separate grant');
select is(pg_temp.h('consent_withdraw','health-owner-a',jsonb_build_object('request_id','withdraw-a-bad01','source','apple','purpose','storage_compute','expected_epoch',9))->>'error','epoch_conflict','a withdrawal at the wrong epoch is refused');
select is(pg_temp.h('consent_withdraw','health-owner-a',jsonb_build_object('request_id','withdraw-a-0001','source','apple','purpose','storage_compute','expected_epoch',1))->>'deletion_routed','true','a withdrawal routes deletion');
select is(pg_temp.n('health-owner-a'),0,'withdrawal deletes the source readings');
select is((select count(*)::int from waldo.health_anchors a join waldo.owners o on o.id=a.owner_id where o.do_name='health-owner-a' and a.source='apple'),0,'withdrawal deletes the source anchor');
select is((select count(*)::int from waldo.health_consents c join waldo.owners o on o.id=c.owner_id where o.do_name='health-owner-a' and c.source='apple' and c.withdrawn_at is null),0,'withdrawing storage withdraws both purposes for the source');
select is((select count(*)::int from waldo.health_consents c join waldo.owners o on o.id=c.owner_id where o.do_name='health-owner-a' and c.source='health_connect' and c.withdrawn_at is null),1,'another source is untouched');
select is(pg_temp.h('consent_withdraw','health-owner-a',jsonb_build_object('request_id','withdraw-a-0001','source','apple','purpose','storage_compute','expected_epoch',1))->>'replayed','true','replaying a withdrawal is stable');
select is((select count(*)::int from waldo.health_requests r join waldo.owners o on o.id=r.owner_id where o.do_name='health-owner-a' and r.operation='ingest' and r.response->>'source'='apple'),0,'withdrawal removes the source upload receipts');
select ok((select count(*)>0 from waldo.health_requests r join waldo.owners o on o.id=r.owner_id where o.do_name='health-owner-a' and r.operation like 'consent_%'),'consent receipts stay so a replayed request still answers');
select is(pg_temp.h('ingest','health-owner-a',(select body from hb))->>'error','consent_withdrawn','a replay of an old upload cannot bypass the withdrawal');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('late-a-000001',1,null,'late',jsonb_build_array(pg_temp.steps('late',2,5))))->>'error','consent_withdrawn','a late upload after withdrawal is refused');
select is(pg_temp.h('consent_grant','health-owner-a',pg_temp.grant_body('grant-a-regrant1','apple','storage_compute',2))->'consent'->>'epoch','3','a fresh grant raises the epoch');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('late-a-000002',1,null,'late2',jsonb_build_array(pg_temp.steps('late',2,5))))->>'error','epoch_conflict','an upload made before the regrant cannot repopulate the data');
select is(pg_temp.n('health-owner-b'),1,'another owner data survives this owner withdrawal');

-- The read model has one writer: the signed function.
create function pg_temp.ctx(day text default null,src text default 'apple',ep int default 1,tz text default 'UTC') returns jsonb language sql as $$
  select jsonb_build_object('day',coalesce(day,to_char(now() at time zone tz,'YYYY-MM-DD')),'timezone',tz,'basis',jsonb_build_array(jsonb_build_object('source',src,'consent_epoch',ep)),
    'form',jsonb_build_object('score',72,'zone','good','drivers','[]'::jsonb,'confidence',0.8,'algorithm_version','form.v1','activation','candidate_unaccepted','hrv_method',null),
    'recovery',jsonb_build_object('score',64,'zone','moderate','algorithm_version','recovery.v1','activation','candidate_unaccepted','hrv_method','rmssd','confidence',0.7),
    'weight',jsonb_build_object('score',40,'zone','low','algorithm_version','weight.v1','activation','candidate_unaccepted','hrv_method',null),
    'drivers','["sleep below baseline"]'::jsonb,'confidence',0.8,'freshness','fresh','tags','["degraded"]'::jsonb) $$;
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
select is(pg_temp.h('context_write','health-owner-a',pg_temp.ctx(null,'apple',3))->>'written','true','owner A with a live grant can write');
select is((select count(*)::int from public.health_context_daily),2,'each owner has only their own row');
select is(pg_temp.h('context_write','health-owner-b',pg_temp.ctx()||'{"form":null}')->>'error','invalid_request','a pillar cannot be left null');
select is(pg_temp.h('context_write','health-owner-b',pg_temp.ctx()-'weight')->>'error','invalid_request','a missing pillar is refused');
select is(pg_temp.h('context_write','health-owner-b',pg_temp.ctx()-'freshness')->>'error','invalid_request','a row must say how fresh it is');
select is(pg_temp.h('context_write','health-owner-b',pg_temp.ctx()||'{"freshness":null}')->>'error','invalid_request','a null freshness is refused');
select is(pg_temp.h('context_write','health-owner-b',pg_temp.ctx()||jsonb_build_object('form',jsonb_set(pg_temp.ctx()->'form','{drivers}','[1]')))->>'error','invalid_request','a pillar driver must be a short string');
select is(pg_temp.h('context_write','health-owner-b',pg_temp.ctx(null,'apple',1)||jsonb_build_object('form','{"reason":"missing_sleep"}'::jsonb))->>'written','true','an unavailable pillar carries its reason');
select is(pg_temp.h('context_write','health-owner-b',pg_temp.ctx()||jsonb_build_object('form','{"reason":"because"}'::jsonb))->>'error','invalid_request','a reason outside the contract list is refused');
select is(pg_temp.h('context_write','health-owner-b',pg_temp.ctx()||jsonb_build_object('form','{"reason":"missing_sleep","score":50}'::jsonb))->>'error','invalid_request','an unavailable pillar cannot also carry a score');
select is(pg_temp.h('context_write','health-owner-b',pg_temp.ctx()||jsonb_build_object('form',(pg_temp.ctx()->'form')-'algorithm_version'))->>'error','invalid_request','an available pillar must name its algorithm version');
select is(pg_temp.h('context_write','health-owner-b',pg_temp.ctx()||jsonb_build_object('form',jsonb_set(pg_temp.ctx()->'form','{activation}','"maybe"')))->>'error','invalid_request','an available pillar must carry a known activation label');
select is(pg_temp.h('context_write','health-owner-b',pg_temp.ctx()||jsonb_build_object('recovery',jsonb_set(pg_temp.ctx()->'recovery','{hrv_method}','"pnn50"')))->>'error','invalid_request','an HRV method other than rmssd or sdnn is refused on a score');
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
select is((select count(*)::int from waldo.health_context_basis b join waldo.owners o on o.id=b.owner_id where o.do_name='health-owner-b'),0,'purge removes the basis records');
select is((select count(*)::int from waldo.health_consents c join waldo.owners o on o.id=c.owner_id where o.do_name='health-owner-b' and c.withdrawn_at is null),0,'purge withdraws every grant');
select ok((select count(*)>0 from waldo.health_consents c join waldo.owners o on o.id=c.owner_id where o.do_name='health-owner-b'),'consent audit evidence survives the purge');
select is(pg_temp.h('scores_read','health-owner-b')->>'unavailable','consent_withdrawn','after a purge the scores say consent was withdrawn');
select is(pg_temp.h('ingest','health-owner-b',pg_temp.batch('ingest-b-000010',1,null,'x',jsonb_build_array(pg_temp.steps('after',4,7))))->>'error','consent_withdrawn','nothing can be stored after a purge without a fresh grant');
-- Retention keeps recent readings and removes old ones and old tombstones.
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('ret-a-000001',3,null,'ret-1',jsonb_build_array(pg_temp.steps('ret-old',2,3),pg_temp.steps('ret-new',3,4),pg_temp.steps('ret-gone',4,5))))->>'accepted','3','owner A stores readings at the current epoch');
select is(pg_temp.h('ingest','health-owner-a',pg_temp.batch('ret-a-000002',3,'ret-1','ret-2','[]',jsonb_build_array(jsonb_build_object('sample_id','ret-gone','signal','steps_window','revision',extract(epoch from now())::bigint+5))))->>'deleted','1','one reading becomes a tombstone');
update waldo.health_samples set start_at=now()-interval '121 days',end_at=now()-interval '120 days' where sample_id='ret-old';
update waldo.health_samples set deleted_at=now()-interval '120 days' where sample_id='ret-gone';
select is((pg_temp.h('retention','health-owner-a'))->>'raw_deleted','2','retention removes the old reading and the old tombstone');
select is((select count(*)::int from waldo.health_samples s join waldo.owners o on o.id=s.owner_id where o.do_name='health-owner-a' and s.sample_id='ret-new'),1,'retention keeps the recent reading');

-- The prompt read needs the model purpose, for the latest row and the previous one; a row is fenced on the consent it was computed from.
select is(pg_temp.h('consent_grant','health-owner-e',pg_temp.grant_body('grant-e-apple-st1','apple','storage_compute'))->'consent'->>'epoch','1','owner E grants storage for Apple');
select is(pg_temp.h('consent_grant','health-owner-e',pg_temp.grant_body('grant-e-hconn-st1','health_connect','storage_compute'))->'consent'->>'epoch','1','owner E grants storage for Health Connect');
select is(pg_temp.h('context_write','health-owner-e',pg_temp.ctx())->>'written','true','a row is computed from stored data');
select is(pg_temp.rd('health-owner-e'),null,'storage consent alone never reaches the prompt read');
select is(pg_temp.h('scores_read','health-owner-e')->'scores'->>'day',to_char(now() at time zone 'UTC','YYYY-MM-DD'),'the owner sees their own scores with storage consent alone');
select is(pg_temp.h('scores_read','health-owner-e')->'scores'->'recovery'->>'algorithm_version','recovery.v1','a score carries its algorithm version');
select is(pg_temp.h('scores_read','health-owner-e')->'scores'->>'timezone','UTC','and the zone its day was computed in');
select ok((pg_temp.h('scores_read','health-owner-e')->'scores'->>'compiled_at') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$','and when it was compiled');
select is(pg_temp.h('scores_read','health-owner-e','{"day":"2001-01-01"}'::jsonb)->>'unavailable','no_readings','a day with no row has no readings');
select is(pg_temp.h('scores_read','health-owner-e','{"day":"nope"}'::jsonb)->>'error','invalid_request','a malformed day is refused');
select is(pg_temp.h('scores_read','health-owner-e','{"owner":"x"}'::jsonb)->>'error','invalid_request','an unknown field is refused');
select is(pg_temp.h('scores_read','health-owner-d')->>'unavailable','consent_required','an owner who never consented has no scores and is told why');
select is(pg_temp.h('scores_read','health-owner-c')->>'error','not_linked','a suspended owner has no scores');
update waldo.health_scopes s set epoch = epoch + 1 from waldo.owners o where o.id = s.owner_id and o.do_name = 'health-owner-e' and s.source = 'apple' and s.purpose = 'storage_compute';
select is(pg_temp.h('scores_read','health-owner-e')->>'unavailable','no_readings','a row computed before the latest storage grant is not shown');
update waldo.health_scopes s set epoch = epoch - 1 from waldo.owners o where o.id = s.owner_id and o.do_name = 'health-owner-e' and s.source = 'apple' and s.purpose = 'storage_compute';
select is(pg_temp.h('consent_grant','health-owner-e',pg_temp.grant_body('grant-e-apple-md1','apple','model_processing'))->'consent'->>'status','granted','the model purpose is a separate grant');
select is(pg_temp.rd('health-owner-e')->'context'->>'day',to_char(now() at time zone 'UTC','YYYY-MM-DD'),'with the model purpose the row is read');
select is(pg_temp.h('context_write','health-owner-e',pg_temp.ctx(to_char((now() at time zone 'UTC')::date-1,'YYYY-MM-DD'),'health_connect',1))->>'written','true','yesterday is computed from another source');
select is(pg_temp.rd('health-owner-e')->'previous'->>'form_score',null,'a previous row from a source without the model purpose is not shared');
select is(pg_temp.h('consent_grant','health-owner-e',pg_temp.grant_body('grant-e-hconn-md1','health_connect','model_processing'))->'consent'->>'status','granted','Health Connect gets its own model purpose');
select is(pg_temp.rd('health-owner-e')->'previous'->>'form_score','72','with its model purpose the previous row joins');
-- Withdrawing model use alone stops model use only: nothing is deleted, storage keeps flowing, and a regrant releases what was stored.
select is(pg_temp.h('ingest','health-owner-e',pg_temp.batch('ingest-e-000001',1,null,'e1',jsonb_build_array(pg_temp.steps('e-step',2,5)),'[]','health_connect'))->>'accepted','1','owner E stores a reading for Health Connect');
select is(pg_temp.h('consent_withdraw','health-owner-e',jsonb_build_object('request_id','withdraw-e-mdl01','source','health_connect','purpose','model_processing','expected_epoch',pg_temp.epoch_of('health-owner-e','health_connect','model_processing')))->>'deletion_routed','false','withdrawing model use alone routes no deletion');
select is(pg_temp.h('consent_withdraw','health-owner-e',jsonb_build_object('request_id','withdraw-e-mdl01','source','health_connect','purpose','model_processing','expected_epoch',pg_temp.epoch_of('health-owner-e','health_connect','model_processing')-1))->'consent'->>'status','withdrawn','replaying that withdrawal answers the same');
select is(pg_temp.h('consent_list','health-owner-e')->'consents' @> '[{"source":"health_connect","purpose":"model_processing","status":"withdrawn","deletion_state":"not_required"}]'::jsonb,true,'the model consent is withdrawn and says no deletion was needed');
select is(pg_temp.n('health-owner-e','health_connect'),1,'the stored reading is still there');
select is(pg_temp.h('ingest','health-owner-e',pg_temp.batch('ingest-e-000002',1,null,'e2',jsonb_build_array(pg_temp.steps('e-step2',3,6)),'[]','health_connect'))->>'accepted','1','storage keeps accepting uploads');
select is(pg_temp.epoch_of('health-owner-e','health_connect','storage_compute'),1,'and the storage epoch did not move');
select is(pg_temp.rd('health-owner-e')->'previous'->>'form_score',null,'the row computed from that source is no longer shared with the model');
select is(pg_temp.h('scores_read','health-owner-e')->'scores'->>'day',to_char(now() at time zone 'UTC','YYYY-MM-DD'),'the owner still sees their own scores');
select is(pg_temp.h('consent_withdraw','health-owner-e',jsonb_build_object('request_id','withdraw-e-mdl02','source','health_connect','purpose','model_processing','expected_epoch',2))->'consent'->>'epoch','2','withdrawing again changes nothing');
select is(pg_temp.h('consent_withdraw','health-owner-e',jsonb_build_object('request_id','withdraw-e-mdl03','source','health_connect','purpose','model_processing','expected_epoch',99))->>'error','epoch_conflict','a model withdrawal checks the epoch');
select is(pg_temp.h('consent_grant','health-owner-e',pg_temp.grant_body('grant-e-hconn-md2','health_connect','model_processing',pg_temp.epoch_of('health-owner-e','health_connect','model_processing')))->'consent'->>'status','granted','the owner grants model use again');
select is(pg_temp.rd('health-owner-e')->'previous'->>'form_score','72','rows computed before the withdrawal return to the model, because the data was never removed');
select is(pg_temp.h('context_write','health-owner-e',pg_temp.ctx(null,'apple',9))->>'error','epoch_conflict','a row computed from a stale consent epoch is refused');
select is(pg_temp.h('context_write','health-owner-e',pg_temp.ctx(null,'samsung',1))->>'error','consent_required','a source without storage consent cannot be the basis');
select is(pg_temp.h('context_write','health-owner-e',pg_temp.ctx()-'basis')->>'error','invalid_request','a row without its basis is refused');
select is(pg_temp.h('context_write','health-owner-e',pg_temp.ctx()||'{"basis":[]}')->>'error','invalid_request','an empty basis is refused');
select is(pg_temp.h('context_write','health-owner-e',pg_temp.ctx()||'{"basis":[{"source":"apple","consent_epoch":1},{"source":"apple","consent_epoch":1}]}')->>'error','invalid_request','a repeated source in the basis is refused');
select is(pg_temp.h('context_write','health-owner-e',pg_temp.ctx(to_char(now() at time zone 'UTC','YYYY-MM-DD'),'apple',1,'Not/AZone'))->>'error','invalid_request','an unknown time zone is refused');
select is(pg_temp.h('context_write','health-owner-e',pg_temp.ctx()-'timezone')->>'error','invalid_request','a row without its time zone is refused');
select is(pg_temp.h('consent_withdraw','health-owner-e',jsonb_build_object('request_id','withdraw-e-0001','source','apple','purpose','storage_compute','expected_epoch',1))->>'deletion_routed','true','owner E withdraws Apple');
select is((select count(*)::int from public.health_context_daily where user_id='e1000000-0000-0000-0000-0000000000e1'),0,'withdrawal removes the read-model rows written before it');
select is((select count(*)::int from waldo.health_context_basis b join waldo.owners o on o.id=b.owner_id where o.do_name='health-owner-e'),0,'and their basis records');
select is(pg_temp.rd('health-owner-e'),null,'nothing is shared after the withdrawal');
select is(pg_temp.h('scores_read','health-owner-e')->>'unavailable','no_readings','with consent but no rows there are no readings to show');
select is(pg_temp.h('context_write','health-owner-e',pg_temp.ctx(null,'apple',2))->>'error','consent_required','a withdrawn source cannot be the basis at its new epoch');
select is(pg_temp.h('context_write','health-owner-e',pg_temp.ctx(null,'health_connect',1))->>'written','true','the other source still supports a row');
select is(pg_temp.rd('health-owner-e')->'context'->>'day',to_char(now() at time zone 'UTC','YYYY-MM-DD'),'and it is read because that source holds the model purpose');
select is(pg_temp.h('context_write','health-owner-e',pg_temp.ctx(to_char((now() at time zone 'Pacific/Kiritimati')::date+1,'YYYY-MM-DD'),'health_connect',1,'Pacific/Kiritimati'))->>'written','true','tomorrow in the earliest zone is the latest accepted day');
select is(pg_temp.h('context_write','health-owner-e',pg_temp.ctx(to_char((now() at time zone 'Pacific/Kiritimati')::date+2,'YYYY-MM-DD'),'health_connect',1,'Pacific/Kiritimati'))->>'error','invalid_request','a day beyond tomorrow is refused');
select is(pg_temp.h('context_write','health-owner-e',pg_temp.ctx('2020-01-01','health_connect',1))->>'error','invalid_request','a day beyond the aggregate retention is refused');
-- Withdrawing a purpose that was never granted still withdraws the source.
select is(pg_temp.h('consent_grant','health-owner-e',pg_temp.grant_body('grant-e-sams-st1','samsung','storage_compute'))->'consent'->>'status','granted','owner E grants only storage for Samsung');
select is(pg_temp.h('consent_withdraw','health-owner-e',jsonb_build_object('request_id','withdraw-e-0004','source','samsung','purpose','model_processing','expected_epoch',0))->>'error','consent_required','a purpose never granted has nothing to withdraw');
select is(pg_temp.h('consent_withdraw','health-owner-e',jsonb_build_object('request_id','withdraw-e-0003','source','samsung','purpose','storage_compute','expected_epoch',4))->>'error','epoch_conflict','a storage withdrawal checks the epoch');
select is(pg_temp.h('consent_withdraw','health-owner-e',jsonb_build_object('request_id','withdraw-e-0002','source','samsung','purpose','storage_compute','expected_epoch',1))->'consent'->>'source','samsung','the answer to a withdrawal names the source');
select is(pg_temp.h('consent_withdraw','health-owner-e',jsonb_build_object('request_id','withdraw-e-0002','source','samsung','purpose','storage_compute','expected_epoch',1))->'consent'->>'epoch','2','and the epoch it moved to');
select is((select count(*)::int from waldo.health_consents c join waldo.owners o on o.id=c.owner_id where o.do_name='health-owner-e' and c.source='samsung' and c.withdrawn_at is null),0,'withdrawing storage withdraws the source');
select is(pg_temp.h('consent_withdraw','health-owner-e',jsonb_build_object('request_id','withdraw-e-0005','source','samsung','purpose','storage_compute','expected_epoch',2))->'consent'->>'epoch','2','withdrawing a source already withdrawn does not move its epoch again');
select is(pg_temp.h('consent_withdraw','health-owner-d',jsonb_build_object('request_id','withdraw-d-0001','source','apple','purpose','storage_compute','expected_epoch',0))->>'error','consent_required','withdrawing from a source never granted is refused');
select is(pg_temp.h('consent_grant','health-owner-d',pg_temp.grant_body('grant-d-model-01','apple','model_processing'))->>'error','consent_required','model use cannot be granted without storage');
select is(pg_temp.h('consent_grant','health-owner-e',pg_temp.grant_body('grant-e-apple-st2','apple','storage_compute',pg_temp.epoch_of('health-owner-e','apple','storage_compute')))->'consent'->>'status','granted','owner E grants Apple storage again');
select is((select count(*)::int from waldo.health_consents c join waldo.owners o on o.id=c.owner_id where o.do_name='health-owner-e' and c.source='apple' and c.purpose='model_processing' and c.withdrawn_at is null),0,'granting storage again never restores model use');
-- A suspended owner's data still ages out and can still be erased.
select is(pg_temp.h('consent_grant','health-owner-f',pg_temp.grant_body('grant-f-apple-st1','apple','storage_compute'))->'consent'->>'status','granted','owner F consents');
select is(pg_temp.h('ingest','health-owner-f',pg_temp.batch('ingest-f-000001',1,null,'f1',jsonb_build_array(pg_temp.steps('f-old',2,1),pg_temp.steps('f-new',3,2))))->>'accepted','2','owner F stores readings');
update waldo.owners set state='suspended' where do_name='health-owner-f';
update waldo.health_samples set start_at=now()-interval '121 days',end_at=now()-interval '120 days' where sample_id='f-old';
select is(pg_temp.h('retention','health-owner-f')->>'raw_deleted','1','retention still runs for a suspended owner');
select is(pg_temp.h('purge','health-owner-f')->>'raw_deleted','1','erasure still runs for a suspended owner');
select is(pg_temp.n('health-owner-f'),0,'a suspended owner has no readings left after erasure');

-- Authentication and privileges.
select throws_ok($$select waldo.health_consent_list('health-owner-a','{}',extract(epoch from now())::bigint,'forged')$$,'42501','unsigned router call','a forged signature is refused on the list');
select throws_ok($$select waldo.health_ingest('health-owner-a','{}',extract(epoch from now())::bigint,'forged')$$,'42501','unsigned router call','a forged signature is refused on ingest');
select throws_ok($$select waldo.health_context_write('health-owner-a','{}',extract(epoch from now())::bigint,'forged')$$,'42501','unsigned router call','a forged signature is refused on the read-model write');
select throws_ok($$select waldo.health_purge('health-owner-a','{}',extract(epoch from now())::bigint,'forged')$$,'42501','unsigned router call','a forged signature is refused on purge');
select throws_ok($$select waldo.health_scores_read('health-owner-a','{}',extract(epoch from now())::bigint,'forged')$$,'42501','unsigned router call','a forged signature is refused on the scores read');
select throws_ok(format($f$select waldo.health_ingest('health-owner-a','{"a":1}',%s,%L)$f$,extract(epoch from now())::bigint,pg_temp.sig('health.consent_list.health-owner-a.'||md5('{"a":1}'),extract(epoch from now())::bigint)),'42501','unsigned router call','a signature for another operation is refused');
select throws_ok(format($f$select waldo.health_ingest('health-owner-b','{"a":1}',%s,%L)$f$,extract(epoch from now())::bigint,pg_temp.sig('health.ingest.health-owner-a.'||md5('{"a":1}'),extract(epoch from now())::bigint)),'42501','unsigned router call','a signature for another owner is refused');
select is((select array_agg(has_function_privilege('anon',p.oid,'execute') order by p.proname) from pg_proc p where p.pronamespace='waldo'::regnamespace and p.proname in ('health_consent_list','health_consent_grant','health_consent_withdraw','health_ingest','health_purge','health_retention','health_context_write','health_scores_read')),array[true,true,true,true,true,true,true,true],'the signed router reaches every health function as anon');
select is((select count(*)::int from pg_proc p where p.pronamespace='waldo'::regnamespace and (has_function_privilege('authenticated',p.oid,'execute') or has_function_privilege('service_role',p.oid,'execute') or has_function_privilege('public',p.oid,'execute')) and p.proname in ('health_consent_list','health_consent_grant','health_consent_withdraw','health_ingest','health_purge','health_retention','health_context_write','health_scores_read')),0,'no signed-in member, service role or public caller can execute them');
select is((select count(*)::int from information_schema.table_privileges where table_schema='waldo' and table_name in ('health_consents','health_scopes','health_samples','health_anchors','health_requests','health_context_basis') and grantee in ('PUBLIC','anon','authenticated','service_role')),0,'no client or service role holds any privilege on the health tables');
select is((select count(*)::int from pg_class c where c.relnamespace='waldo'::regnamespace and c.relname in ('health_consents','health_scopes','health_samples','health_anchors','health_requests','health_context_basis') and c.relkind='r' and not (c.relrowsecurity and c.relforcerowsecurity)),0,'every health table has forced row security');
select is((select count(*)::int from pg_proc p where p.pronamespace='waldo'::regnamespace and p.proname in ('health_basis_live','health_consent_view','health_consent_history') and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute') or has_function_privilege('service_role',p.oid,'execute') or has_function_privilege('public',p.oid,'execute'))),0,'the internal helpers are not callable by any client role');
select * from finish();
rollback;
