begin;
create extension if not exists pgtap with schema extensions;
select plan(6);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- A day without movement minutes (every Health Connect owner, an iPhone without a Watch) is read on its steps, and the Form
-- pillar names steps among the signals it used. The writer admits that name; any name outside its closed list is still
-- refused whole. Synthetic owner and synthetic values throughout.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.grant_body(rid text,purpose text) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','health_connect','purpose',purpose,'version',2,'expected_epoch',0,'age_attested_18_plus',true) $$;
create function pg_temp.day(back int) returns text language sql as $$ select to_char((now() at time zone 'UTC')::date - back,'YYYY-MM-DD') $$;
create function pg_temp.form(signals text[]) returns jsonb language sql as $$
  select jsonb_build_object('score',64,'zone','good','algorithm_version','form.v10','activation','accepted','hrv_method','rmssd','confidence',0.7,
    'baseline',jsonb_build_object('state','provisional','personal_days',5,'needed',14,'prior','adults'),
    'used',jsonb_build_object('signals',to_jsonb(signals),'days',jsonb_build_array(pg_temp.day(2),pg_temp.day(1),pg_temp.day(0)))) $$;
create function pg_temp.write(signals text[]) returns jsonb language sql as $$
  select pg_temp.h('context_write','steps-owner',jsonb_build_object('day',pg_temp.day(0),'timezone','UTC',
    'basis',jsonb_build_array(jsonb_build_object('source','health_connect','consent_epoch',1)),
    'form',pg_temp.form(signals),'recovery',jsonb_build_object('reason','missing_sleep'),
    'weight',jsonb_build_object('reason','calendar_demand_unavailable'),'freshness','fresh')) $$;

insert into auth.users(id,email) values ('e1000000-0000-0000-0000-0000000000f7','steps@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('e3000000-0000-0000-0000-0000000000f7','e1000000-0000-0000-0000-0000000000f7','steps-owner','steps@example.invalid');
select is(pg_temp.h('consent_grant','steps-owner',pg_temp.grant_body('grant-s-storage1','storage_compute'))->'consent'->>'status','granted','the owner grants storage');

select is(pg_temp.write(array['sleep','hrv','resting_heart_rate','sleep_midpoint','daylight','steps','stress'])->>'written','true',
  'a Form pillar read on steps, with steps among its signals, is written');
select is(pg_temp.h('scores_read','steps-owner')->'scores'->'form'->'used'->'signals',
  '["sleep","hrv","resting_heart_rate","sleep_midpoint","daylight","steps","stress"]'::jsonb,'and its signals read back as written');
select is(pg_temp.write(array['sleep','hrv','resting_heart_rate','sleep_midpoint','daylight','movement','stress','calendar','tasks','messages','physical_load','steps'])->>'written','true',
  'all twelve names of the closed list are admitted together');
select is(pg_temp.write(array['sleep','step'])->>'error','invalid_request','a name outside the closed list is still refused');
select is(pg_temp.write(array['steps','steps'])->>'error','invalid_request','and steps named twice');

select * from finish();
rollback;
