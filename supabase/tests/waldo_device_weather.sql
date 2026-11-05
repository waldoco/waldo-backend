begin;
create extension if not exists pgtap with schema extensions;
select plan(7);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- The weather read: the agent's lookup of the latest cell, granted only while storage, model use and provider lookup all are.
-- Synthetic values: a made-up cell and zone.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.dc(op text,owner text,body text default '{}') returns jsonb language plpgsql as $$
declare a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','device_context_'||op) into r using owner,body,a,pg_temp.sig('device_context.'||op||'.'||owner||'.'||md5(body),a);
  return r;
end $$;
create function pg_temp.grant_(owner text,id text,purpose text,epoch int) returns jsonb language sql as $$
  select pg_temp.dc('consent_grant',owner,jsonb_build_object('request_id',id,'signal','place','purpose',purpose,'version',1,'expected_epoch',epoch)::text) $$;
create function pg_temp.withdraw(owner text,id text,purpose text,epoch int) returns jsonb language sql as $$
  select pg_temp.dc('consent_withdraw',owner,jsonb_build_object('request_id',id,'signal','place','purpose',purpose,'expected_epoch',epoch)::text) $$;
create function pg_temp.weather(owner text) returns jsonb language sql as $$ select pg_temp.dc('place_read',owner,'{"purpose":"weather"}') $$;

insert into auth.users(id,email) values ('6e110000-0000-0000-0000-0000000000a1','dw-a@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('6e310000-0000-0000-0000-0000000000a3','6e110000-0000-0000-0000-0000000000a1','dw-owner-a','dw-a@example.invalid');

select is(pg_temp.weather('dw-owner-a'),'{"error":"consent_required"}'::jsonb,'no weather read before any consent');
select pg_temp.grant_('dw-owner-a','dw-grant-store','storage_compute',0), pg_temp.grant_('dw-owner-a','dw-grant-model','model_processing',0);
select pg_temp.dc('place_ingest','dw-owner-a',jsonb_build_object('request_id','dw-place-1','expected_epoch',1,'device_id','6e910000-0000-0000-0000-000000000001',
  'place',jsonb_build_object('cell','tdr1v','locality','Testville','timezone','Asia/Kolkata','platform','ios','observed_at',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')))::text);
select is(pg_temp.weather('dw-owner-a'),'{"error":"consent_required"}'::jsonb,'nor with storage and model use but no provider lookup');
select is(pg_temp.dc('place_read','dw-owner-a','{"purpose":"model"}')->'places'->0->'place'->>'cell','tdr1v','while the model read already works');
select pg_temp.grant_('dw-owner-a','dw-grant-lookup','provider_lookup',0);
select is(pg_temp.weather('dw-owner-a')->'places'->0->'place'->>'cell','tdr1v','with all three granted, the weather read gives the cell');
select is(pg_temp.withdraw('dw-owner-a','dw-wd-lookup','provider_lookup',1)->'deletion_routed','false'::jsonb,'withdrawing provider lookup alone deletes nothing');
select is(pg_temp.weather('dw-owner-a'),'{"error":"consent_withdrawn"}'::jsonb,'and stops every weather read');
select is(pg_temp.dc('place_read','dw-owner-a','{"purpose":"model"}')->'places'->0->'place'->>'cell','tdr1v','while the place itself still works');

select * from finish();
rollback;
