begin;
create extension if not exists pgtap with schema extensions;
select plan(11);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.grant_body(rid text,src text,purpose text,epoch int default 0) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source',src,'purpose',purpose,'version',2,'expected_epoch',epoch,'age_attested_18_plus',true) $$;
create function pg_temp.withdraw_body(rid text,src text,purpose text,epoch int) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source',src,'purpose',purpose,'expected_epoch',epoch) $$;
create function pg_temp.today() returns date language sql as $$ select (now() at time zone 'UTC')::date $$;
create function pg_temp.ctx(read_at text default null,score int default 64,day date default null) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('day',to_char(coalesce(day,pg_temp.today()),'YYYY-MM-DD'),'timezone','UTC','read_at',read_at,
    'basis',jsonb_build_array(jsonb_build_object('source','apple','consent_epoch',1)),
    'form',jsonb_build_object('reason','missing_sleep'),
    'recovery',jsonb_build_object('score',score,'zone','moderate','algorithm_version','recovery.v1','activation','candidate_unaccepted','hrv_method','rmssd','confidence',0.7),
    'weight',jsonb_build_object('reason','no_readings'),
    'freshness','fresh')) $$;
create function pg_temp.stored(owner_user uuid) returns int language sql as $$
  select (recovery->>'score')::int from public.health_context_daily where user_id = owner_user and day = pg_temp.today() $$;

insert into auth.users(id,email) values ('f1000000-0000-0000-0000-0000000000f1','fence@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('f3000000-0000-0000-0000-0000000000f3','f1000000-0000-0000-0000-0000000000f1','fence-owner','fence@example.invalid');
select is(pg_temp.h('consent_grant','fence-owner',pg_temp.grant_body('grant-f-storage1','apple','storage_compute'))->'consent'->>'status','granted','the owner grants storage');

-- A write carries the instant its inputs were read. A write computed from an older read cannot replace a newer one.
select is(pg_temp.h('context_write','fence-owner',pg_temp.ctx('2026-10-11T08:00:00.000002Z',60))->>'written','true','a first write lands');
select is(pg_temp.stored('f1000000-0000-0000-0000-0000000000f1'),60,'and is stored');
select is(pg_temp.h('context_write','fence-owner',pg_temp.ctx('2026-10-11T08:00:00.000001Z',10))->>'stale','true','a write from an older read is reported stale');
select is(pg_temp.stored('f1000000-0000-0000-0000-0000000000f1'),60,'and does not replace the newer row');
select is(pg_temp.h('context_write','fence-owner',pg_temp.ctx('2026-10-11T08:00:00.000003Z',75))->>'written','true','a write from a newer read lands');
select is(pg_temp.stored('f1000000-0000-0000-0000-0000000000f1'),75,'and replaces the row');
select is(pg_temp.h('context_write','fence-owner',pg_temp.ctx('2026-10-11T08:00:00.000003Z',76))->>'written','true','a write from the same read instant lands');
select is(pg_temp.h('context_write','fence-owner',pg_temp.ctx('not-a-time'))->>'error','invalid_request','a malformed read instant is refused');

-- The consent fence still holds after a newer read.
select is(pg_temp.h('consent_withdraw','fence-owner',pg_temp.withdraw_body('withdraw-f-store1','apple','storage_compute',1))->'consent'->>'status','withdrawn','the owner withdraws storage');
select is(pg_temp.h('context_write','fence-owner',pg_temp.ctx('2026-10-11T09:00:00.000000Z',90))->>'error','consent_required','a write computed before the withdrawal cannot land after it');

select * from finish();
rollback;
