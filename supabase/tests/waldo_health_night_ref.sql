begin;
create extension if not exists pgtap with schema extensions;
select plan(14);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- The night digest on the derived row (ADR-0081 amendment of 1 November 2026): kept on the internal basis row, compared by the
-- writer, and returned by no read. Synthetic values.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.grant_body(rid text,purpose text) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','apple','purpose',purpose,'version',2,'expected_epoch',0,'age_attested_18_plus',true) $$;
create function pg_temp.model_read(owner text) returns jsonb language plpgsql as $$
declare a bigint:=extract(epoch from now())::bigint;
begin return waldo.health_context_read(owner,a,pg_temp.sig('healthctx.read.'||owner,a)); end $$;
create function pg_temp.ctx(extra jsonb default '{}',days_back int default 0) returns jsonb language sql as $$
  select jsonb_build_object('day',to_char((now() at time zone 'UTC')::date-days_back,'YYYY-MM-DD'),'timezone','UTC',
    'basis',jsonb_build_array(jsonb_build_object('source','apple','consent_epoch',1)),
    'form',jsonb_build_object('reason','intraday_inputs_unavailable'),
    'recovery',jsonb_build_object('score',72,'zone','good','algorithm_version','recovery.v5','activation','accepted','hrv_method','rmssd','confidence',0.8),
    'weight',jsonb_build_object('reason','calendar_demand_unavailable'),'freshness','fresh') || extra $$;
create function pg_temp.write(extra jsonb default '{}') returns jsonb language sql as $$ select pg_temp.h('context_write','night-owner',pg_temp.ctx(extra)) $$;
create function pg_temp.night(ref text) returns jsonb language sql as $$ select pg_temp.write(jsonb_build_object('night_ref',ref)) $$;
create function pg_temp.stored() returns text language sql as $$
  select b.night_ref from waldo.health_context_basis b where b.owner_id='f6000000-0000-0000-0000-0000000000f6' and b.day=(now() at time zone 'UTC')::date $$;

insert into auth.users(id,email) values ('f4000000-0000-0000-0000-0000000000f4','night@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('f6000000-0000-0000-0000-0000000000f6','f4000000-0000-0000-0000-0000000000f4','night-owner','night@example.invalid');
select is(pg_temp.h('consent_grant','night-owner',pg_temp.grant_body('grant-n-storage1','storage_compute'))->'consent'->>'status','granted','the owner grants storage');
select is(pg_temp.h('consent_grant','night-owner',pg_temp.grant_body('grant-n-model0001','model_processing'))->'consent'->>'status','granted','and model use');

select col_type_is('waldo','health_context_basis','night_ref','text','the internal basis row has a night_ref column');
select hasnt_column('public','health_context_daily','night_ref','the public read model has none');

select is(pg_temp.night(repeat('a',64)),'{"written":true,"changed":[],"night_changed":true}'::jsonb,'golden: a day''s first night is a change');
select is(pg_temp.night(repeat('a',64))->'night_changed','false'::jsonb,'the same night again is not');
select is(pg_temp.night(repeat('b',64))->'night_changed','true'::jsonb,'another night is');
select ok(not (pg_temp.write() ? 'night_changed'),'a row without a digest answers nothing about the night');
select is(pg_temp.stored(),repeat('b',64),'and leaves the stored digest as it was');

-- No read returns it.
select ok(position(repeat('b',64) in coalesce(pg_temp.model_read('night-owner')::text,'')) = 0,'the model''s read never returns it');
select ok(position(repeat('b',64) in coalesce(pg_temp.h('scores_read','night-owner')::text,'')) = 0,'nor the app''s scores read');

-- Only the digest's own shape, and never on a backfilled row.
select is((select count(*)::int from unnest(array['null','7','"abc"',to_jsonb(repeat('A',64))::text,to_jsonb(repeat('a',63))::text,to_jsonb(repeat('a',65))::text,
  to_jsonb('2026-11-01T06:52:00Z'::text)::text]::jsonb[]) bad
  where pg_temp.write(jsonb_build_object('night_ref',bad))->>'error' = 'invalid_request'),7,'every value outside 64 lowercase hex characters is refused');
select ok(pg_temp.h('context_write','night-owner',pg_temp.ctx(jsonb_build_object('night_ref',repeat('c',64),'backfilled',true,'recovery',jsonb_build_object('reason','missing_sleep')),5))->>'error' = 'invalid_request',
  'a backfilled row never carries one');

-- Withdrawing storage deletes the basis row and its digest with it.
select pg_temp.h('consent_withdraw','night-owner',jsonb_build_object('request_id','withdraw-night-01','source','apple','purpose','storage_compute','expected_epoch',1));
select is((select count(*)::int from waldo.health_context_basis where owner_id='f6000000-0000-0000-0000-0000000000f6'),0,'withdrawing storage deletes the digest');

select * from finish();
rollback;
