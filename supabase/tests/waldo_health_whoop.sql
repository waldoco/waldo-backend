begin;
create extension if not exists pgtap with schema extensions;
select plan(30);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.route(provider text,account text) returns setof text language plpgsql as $$
declare a bigint:=extract(epoch from now())::bigint;
begin return query select r.do_name from waldo.health_provider_route(provider,account,a,pg_temp.sig('provroute.'||provider||'.'||lower(account),a)) r; end $$;
create function pg_temp.grant_body(rid text,src text,purpose text,epoch int default 0) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source',src,'purpose',purpose,'version',2,'expected_epoch',epoch,'age_attested_18_plus',true) $$;
create function pg_temp.sleep(id text,val numeric,rev bigint default null) returns jsonb language sql as $$
  select jsonb_build_object('sample_id',id,'revision',coalesce(rev,extract(epoch from now())::bigint),'signal','sleep_duration','unit','minutes','value',val,
    'day',((now()-interval '2 hours') at time zone 'UTC')::date,
    'start_at',to_char((now()-interval '9 hours') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'end_at',to_char((now()-interval '2 hours') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'utc_offset_minutes',0) $$;
create function pg_temp.batch(rid text,epoch int,samples jsonb,src text) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source',src,'consent_epoch',epoch,'timezone','UTC','anchor_before',null,'anchor_after','cursor-'||rid,'samples',samples,'deletions','[]'::jsonb) $$;
create function pg_temp.n(owner text,src text) returns int language sql as $$
  select count(*)::int from waldo.health_samples s join waldo.owners o on o.id=s.owner_id where o.do_name=owner and s.source=src and s.payload is not null $$;

insert into auth.users(id,email) values
 ('a1000000-0000-0000-0000-0000000000a1','whoop-a@example.invalid'),
 ('b1000000-0000-0000-0000-0000000000b1','whoop-b@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values
 ('a3000000-0000-0000-0000-0000000000a3','a1000000-0000-0000-0000-0000000000a1','whoop-owner-a','whoop-a@example.invalid'),
 ('b3000000-0000-0000-0000-0000000000b3','b1000000-0000-0000-0000-0000000000b1','whoop-owner-b','whoop-b@example.invalid');

-- WHOOP storage needs the express authorization first. The authorization belongs to WHOOP alone.
select is(pg_temp.h('consent_grant','whoop-owner-a',pg_temp.grant_body('grant-w-store-0','whoop','storage_compute'))->>'error','consent_required','WHOOP storage is refused without the express authorization');
select is(pg_temp.h('consent_grant','whoop-owner-a',pg_temp.grant_body('grant-w-model-0','whoop','model_processing'))->>'error','consent_required','and so is model use');
select is(pg_temp.h('consent_grant','whoop-owner-a',pg_temp.grant_body('grant-a-terms-0','apple','provider_terms'))->>'error','invalid_request','the authorization is not a purpose for a device source');
select is(pg_temp.h('consent_grant','whoop-owner-a',pg_temp.grant_body('grant-g-store-0','garmin','storage_compute'))->>'error','invalid_request','a source that is still unknown is refused');
select is(pg_temp.h('consent_grant','whoop-owner-a',pg_temp.grant_body('grant-o-store-0','oura','storage_compute'))->>'error','invalid_request','Oura is not a source yet');
select is(pg_temp.h('consent_grant','whoop-owner-a',pg_temp.grant_body('grant-w-terms-1','whoop','provider_terms'))->'consent'->>'status','granted','the express authorization is granted on its own');
select is(pg_temp.h('consent_grant','whoop-owner-a',pg_temp.grant_body('grant-w-store-1','whoop','storage_compute'))->'consent'->>'status','granted','then storage');
select is(pg_temp.h('consent_grant','whoop-owner-a',pg_temp.grant_body('grant-w-model-1','whoop','model_processing'))->'consent'->>'status','granted','then model use');
select is(pg_temp.h('consent_grant','whoop-owner-a',pg_temp.grant_body('grant-w-store-1','whoop','storage_compute'))->>'replayed','true','a replayed grant answers the same way');

-- Ingest takes WHOOP readings under the same rules as any other source.
select is(pg_temp.h('ingest','whoop-owner-a',pg_temp.batch('ingest-w-000001',1,jsonb_build_array(pg_temp.sleep('whoop:sleep-1',420)),'whoop'))->>'accepted','1','a WHOOP reading is stored');
select is(pg_temp.n('whoop-owner-a','whoop'),1,'under source whoop');
select is(pg_temp.h('ingest','whoop-owner-a',pg_temp.batch('ingest-w-000002',1,jsonb_build_array(pg_temp.sleep('oura:sleep-1',420)),'oura'))->>'error','invalid_request','an Oura batch is refused');
select is(pg_temp.h('ingest','whoop-owner-b',pg_temp.batch('ingest-w-000003',1,jsonb_build_array(pg_temp.sleep('whoop:sleep-9',420)),'whoop'))->>'error','consent_required','an owner who never authorized WHOOP stores nothing');

-- Withdrawing the express authorization withdraws the source and removes what it stored.
select is(pg_temp.h('consent_withdraw','whoop-owner-a',jsonb_build_object('request_id','withdraw-w-terms','source','whoop','purpose','provider_terms','expected_epoch',1))->>'deletion_routed','true','withdrawing the authorization routes deletion');
select is(pg_temp.n('whoop-owner-a','whoop'),0,'the stored WHOOP readings are gone');
select is(pg_temp.h('ingest','whoop-owner-a',pg_temp.batch('ingest-w-000004',2,jsonb_build_array(pg_temp.sleep('whoop:sleep-2',400)),'whoop'))->>'error','consent_withdrawn','and a later upload is refused');
select is(pg_temp.h('consent_grant','whoop-owner-a',pg_temp.grant_body('grant-w-store-2','whoop','storage_compute',2))->>'error','consent_required','storage cannot be granted again without a fresh authorization');

-- A provider account resolves to one owner, and only a live WHOOP connection routes.
insert into waldo.connections(owner_id,provider,account,secret_id) values ('a3000000-0000-0000-0000-0000000000a3','whoop','10129',gen_random_uuid());
select throws_ok($$insert into waldo.connections(owner_id,provider,account,secret_id) values ('b3000000-0000-0000-0000-0000000000b3','whoop','10129',gen_random_uuid())$$,'23505',null,'a second owner cannot link the same WHOOP account');
select lives_ok($$insert into waldo.connections(owner_id,provider,account,secret_id) values ('b3000000-0000-0000-0000-0000000000b3','whoop','20240',gen_random_uuid())$$,'another account links');
select is((select array_agg(x) from pg_temp.route('whoop','10129') x),array['whoop-owner-a'],'a WHOOP webhook routes to the owner holding that account');
select is((select count(*)::int from pg_temp.route('whoop','99999')),0,'an unknown account routes nowhere');
select is((select count(*)::int from pg_temp.route('google','10129')),0,'Google connections are not routable through it');
update waldo.connections set status='revoked',revoked_at=now() where provider='whoop' and account='10129';
select is((select count(*)::int from pg_temp.route('whoop','10129')),0,'a revoked connection no longer routes');
select lives_ok($$insert into waldo.connections(owner_id,provider,account,secret_id) values ('b3000000-0000-0000-0000-0000000000b3','whoop','10129',gen_random_uuid())$$,'and its account can be linked again');
select throws_ok($$select waldo.health_provider_route('whoop','10129',extract(epoch from now())::bigint,'0000')$$,'42501',null,'an unsigned route call is refused');

-- The attempt a WHOOP callback has to match is a connect session: single use, and only the hash of the state is stored.
create function pg_temp.sess(op text,message text,hash text) returns jsonb language plpgsql as $$
declare a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  if op='issue' then return to_jsonb(waldo.connect_session_issue('whoop-owner-a','whoop','app',hash,a,pg_temp.sig('connsess.issue.whoop-owner-a.whoop.app.'||hash,a)));
  elsif op='resolve' then return waldo.connect_session_resolve(hash,a,pg_temp.sig('connsess.resolve.'||hash,a));
  else return to_jsonb(waldo.connect_session_complete(hash,a,pg_temp.sig('connsess.complete.'||hash,a))); end if;
end $$;
select isnt(pg_temp.sess('issue','', repeat('a',64)),'null'::jsonb,'a WHOOP attempt can be issued');
select is(pg_temp.sess('resolve','',repeat('a',64))->>'do_name','whoop-owner-a','and the callback state resolves to the owner who started it');
select is(pg_temp.sess('resolve','',repeat('b',64)),null,'a state nobody started resolves to nothing');
select is(pg_temp.sess('complete','',repeat('a',64)),'true'::jsonb,'a linked attempt completes once');
select is(pg_temp.sess('resolve','',repeat('a',64))->>'status','completed','and a reloaded callback sees it completed');

select * from finish();
rollback;
