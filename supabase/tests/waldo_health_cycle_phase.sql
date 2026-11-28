begin;
create extension if not exists pgtap with schema extensions;
select plan(32);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- Cycle context, the phase half: the cycle_phase basis on the derived row, written only while cycle_context is live, read back by
-- the scores read and by no other read, and cleared from every stored row on withdrawal while the score values stay. The period
-- read gives the recompute dates only. Synthetic values.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.cy(op text,owner text,body text default '{}') returns jsonb language plpgsql as $$
declare a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','cycle_'||op) into r using owner,body,a,pg_temp.sig('cycle.'||op||'.'||owner||'.'||md5(body),a);
  return r;
end $$;
create function pg_temp.model_read(owner text) returns jsonb language plpgsql as $$
declare a bigint:=extract(epoch from now())::bigint;
begin return waldo.health_context_read(owner,a,pg_temp.sig('healthctx.read.'||owner,a)); end $$;
create function pg_temp.grant_body(rid text,purpose text) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','apple','purpose',purpose,'version',2,'expected_epoch',0,'age_attested_18_plus',true) $$;
create function pg_temp.rid(n int) returns text language sql as $$ select '00000000-0000-4000-8000-'||lpad(n::text,12,'0') $$;
create function pg_temp.day(days_back int default 0) returns text language sql as $$ select to_char((now() at time zone 'UTC')::date-days_back,'YYYY-MM-DD') $$;
create function pg_temp.basis() returns jsonb language sql as $$ select '{"kind":"cycle_phase","explanation":"Read against your own usual for this part of your cycle."}'::jsonb $$;
-- A recovery whose baseline used a day 60 back, as a phase-read row's does.
create function pg_temp.recovery(score numeric,used_back int,days_back int) returns jsonb language sql as $$
  select jsonb_build_object('score',score,'zone','good','algorithm_version','recovery.v5','activation','accepted','hrv_method','rmssd','confidence',0.8,
    'baseline',jsonb_build_object('state','personal','personal_days',14,'needed',14,'prior','none'),
    'used',jsonb_build_object('signals',jsonb_build_array('sleep','hrv'),'days',jsonb_build_array(pg_temp.day(days_back+used_back),pg_temp.day(days_back)))) $$;
create function pg_temp.ctx(extra jsonb,days_back int,score numeric default 72,used_back int default 10) returns jsonb language sql as $$
  select jsonb_build_object('day',pg_temp.day(days_back),'timezone','UTC',
    'basis',jsonb_build_array(jsonb_build_object('source','apple','consent_epoch',1)),
    'form',jsonb_build_object('reason','intraday_inputs_unavailable'),
    'recovery',pg_temp.recovery(score,used_back,days_back),
    'weight',jsonb_build_object('reason','calendar_demand_unavailable'),'freshness','fresh') || extra $$;
create function pg_temp.write(extra jsonb,days_back int default 0,score numeric default 72,used_back int default 10) returns jsonb language sql as $$
  select pg_temp.h('context_write','phase-owner',pg_temp.ctx(extra,days_back,score,used_back)) $$;
create function pg_temp.marked() returns bigint language sql as $$
  select count(*) from public.health_context_daily where user_id='9a100000-0000-0000-0000-0000000000c1' and reading_basis is not null $$;
create function pg_temp.scores() returns jsonb language sql as $$
  select jsonb_agg(recovery order by day) from public.health_context_daily where user_id='9a100000-0000-0000-0000-0000000000c1' $$;

insert into auth.users(id,email) values ('9a100000-0000-0000-0000-0000000000c1','phase@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('9a300000-0000-0000-0000-0000000000c3','9a100000-0000-0000-0000-0000000000c1','phase-owner','phase@example.invalid');
select is(pg_temp.h('consent_grant','phase-owner',pg_temp.grant_body('grant-p-storage1','storage_compute'))->'consent'->>'status','granted','the owner grants health storage');
select is(pg_temp.h('consent_grant','phase-owner',pg_temp.grant_body('grant-p-model0001','model_processing'))->'consent'->>'status','granted','and model use');

-- The column and its shape.
select ok(exists (select 1 from information_schema.columns where table_schema='public' and table_name='health_context_daily' and column_name='reading_basis'),'the derived row has a reading_basis column');
select ok(not waldo.health_reading_basis_valid('{"kind":"cycle_phase","explanation":"x","phase":"luteal"}'),'a basis that names a phase is not a basis');
select ok(not waldo.health_reading_basis_valid('{"kind":"cycle_phase","explanation":""}'),'nor one with no line');
select ok(waldo.health_reading_basis_valid(pg_temp.basis()),'the backend''s basis is one');

-- Before cycle_context is live.
select is(pg_temp.write(jsonb_build_object('reading_basis',pg_temp.basis()),0),'{"error":"consent_required"}'::jsonb,'no basis is written before cycle_context is granted');
select is(pg_temp.cy('periods_read','phase-owner'),'{"error":"consent_required"}'::jsonb,'and no period is read');
select is(pg_temp.write('{}'::jsonb,0,72,60),'{"error":"invalid_request"}'::jsonb,'a row without the basis may not name a used day past the ordinary window');
select is(pg_temp.write('{}'::jsonb,1)->>'written','true','an ordinary row is written as before');

-- Live.
select is(pg_temp.cy('consent_grant','phase-owner',jsonb_build_object('request_id',pg_temp.rid(1),'version',1,'expected_epoch',0)::text)->'consent'->>'status','granted','the owner turns cycle context on');
select is(pg_temp.write(jsonb_build_object('reading_basis',pg_temp.basis()),0,74,60)->>'written','true','a phase-read row is written with its basis and its used days from the lookback');
select is(pg_temp.write(jsonb_build_object('reading_basis',pg_temp.basis() || '{"phase":"luteal"}'),0),'{"error":"invalid_request"}'::jsonb,'a basis carrying anything else is refused');
select is(pg_temp.write(jsonb_build_object('reading_basis',pg_temp.basis(),'backfilled',true),5),'{"error":"invalid_request"}'::jsonb,'a backfilled row never carries one');
select is(pg_temp.h('scores_read','phase-owner',jsonb_build_object('day',pg_temp.day(0)))->'scores'->'reading_basis',pg_temp.basis(),'the scores read returns it');
select ok(pg_temp.model_read('phase-owner')::text !~* 'reading_basis|cycle','the model''s health read never carries it');
select is(pg_temp.write('{}'::jsonb,0,73)->>'written','true','a rewrite the phase did not change is written');
select is(pg_temp.marked(),0::bigint,'and clears the basis');
select is(pg_temp.write(jsonb_build_object('reading_basis',pg_temp.basis()),0,74,60)->>'written','true','the phase changes today''s row again');
select is(pg_temp.write(jsonb_build_object('reading_basis',pg_temp.basis()),2,70)->>'written','true','and an earlier day''s');

-- The period read.
select is(pg_temp.cy('ingest','phase-owner',jsonb_build_object('request_id',pg_temp.rid(2),'expected_epoch',1,'source','apple','window_start',pg_temp.day(60),
  'periods',jsonb_build_array(jsonb_build_object('signal','menstrual_period','start_date',pg_temp.day(40),'end_date',pg_temp.day(36),
    'origin',jsonb_build_object('read_api','healthkit','source_bundle_id','com.example.cycle','source_package_name',null,'source_version',null,'source_revision',null,'device_ref',null,'recording_method','manual'),
    'source_name','Example Cycle')))::text)->'accepted','1'::jsonb,'a period is uploaded');
select is(pg_temp.cy('periods_read','phase-owner'),jsonb_build_object('periods',jsonb_build_array(jsonb_build_object('start_date',pg_temp.day(40),'end_date',pg_temp.day(36)))),
  'the recompute reads its dates and nothing else');

-- Withdrawal: values stay, every marker goes.
select is(pg_temp.marked(),2::bigint,'two stored rows carry the basis');
create temp table before_withdrawal as select pg_temp.scores() as recovery;
select is(pg_temp.cy('consent_withdraw','phase-owner',jsonb_build_object('request_id',pg_temp.rid(3),'expected_epoch',1)::text)->>'state','off','the owner withdraws cycle context');
select is(pg_temp.marked(),0::bigint,'no stored row carries a basis or its explanation any more');
select is(pg_temp.scores(),(select recovery from before_withdrawal),'and every stored score value is as it was, not recomputed');

-- Withdrawing apple storage clears it the same way.
select is(pg_temp.cy('consent_grant','phase-owner',jsonb_build_object('request_id',pg_temp.rid(4),'version',1,'expected_epoch',2)::text)->'consent'->>'status','granted','cycle context is turned on again');
select is(pg_temp.write(jsonb_build_object('reading_basis',pg_temp.basis()),0,74,60)->>'written','true','and a row carries the basis');
update waldo.health_consents set withdrawn_at = now() where owner_id='9a300000-0000-0000-0000-0000000000c3' and purpose='storage_compute' and withdrawn_at is null;
select is(pg_temp.marked(),0::bigint,'withdrawing apple storage clears every basis too');
select is(pg_temp.h('scores_read','phase-owner',jsonb_build_object('day',pg_temp.day(0)))->'scores'->'reading_basis',null,'and no read returns one');

-- Nothing else derived from cycle data is stored: no phase, cycle summary or per-phase baseline table or column.
select is(array(select c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('waldo','public') and c.relkind = 'r'
  and (c.relname ~* 'cycle|phase|period|menstru') order by 1),array['cycle_consents','cycle_periods','cycle_requests','cycle_scopes'],'the only cycle tables are consent, scope, periods and receipts');
select is(array(select table_name||'.'||column_name from information_schema.columns where table_schema in ('waldo','public')
  and column_name ~* 'cycle|phase|menstru' order by 1),'{}'::text[],'and no other table has a cycle or phase column');

select * from finish();
rollback;
