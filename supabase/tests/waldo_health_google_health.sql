begin;
create extension if not exists pgtap with schema extensions;
select plan(38);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- Google Health (Fitbit, Pixel Watch) is a cloud source like WHOOP, on its own consent notice (copy 4). Synthetic owners and
-- synthetic values throughout.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
-- The route is signed over the account exactly as given: a Google Health user id is case-sensitive.
create function pg_temp.route(provider text,account text,signed text default null) returns setof text language plpgsql as $$
declare a bigint:=extract(epoch from now())::bigint;
begin return query select r.do_name from waldo.health_provider_route(provider,account,a,pg_temp.sig('provroute.'||provider||'.'||coalesce(signed,account),a)) r; end $$;
create function pg_temp.grant_body(rid text,src text,purpose text,ver int,epoch int default 0) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source',src,'purpose',purpose,'version',ver,'expected_epoch',epoch,'age_attested_18_plus',true) $$;
create function pg_temp.sleep(id text,val numeric) returns jsonb language sql as $$
  select jsonb_build_object('sample_id',id,'revision',extract(epoch from now())::bigint,'signal','sleep_duration','unit','minutes','value',val,
    'day',((now()-interval '2 hours') at time zone 'UTC')::date,
    'start_at',to_char((now()-interval '9 hours') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'end_at',to_char((now()-interval '2 hours') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'utc_offset_minutes',0) $$;
create function pg_temp.batch(rid text,epoch int,samples jsonb) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','google_health','consent_epoch',epoch,'timezone','UTC','anchor_before',null,'anchor_after','cursor-'||rid,'samples',samples,'deletions','[]'::jsonb) $$;
create function pg_temp.n(owner text) returns int language sql as $$
  select count(*)::int from waldo.health_samples s join waldo.owners o on o.id=s.owner_id where o.do_name=owner and s.source='google_health' and s.payload is not null $$;
create function pg_temp.ctx(source text, activation text) returns jsonb language sql as $$
  select jsonb_build_object('day',to_char((now() at time zone 'UTC')::date,'YYYY-MM-DD'),'timezone','UTC',
    'basis',jsonb_build_array(jsonb_build_object('source',source,'consent_epoch',1)),
    'form',jsonb_build_object('reason','intraday_inputs_unavailable'),
    'recovery',jsonb_build_object('score',70,'zone','good','algorithm_version','recovery.v5','activation',activation,'hrv_method','rmssd','confidence',0.8),
    'weight',jsonb_build_object('reason','calendar_demand_unavailable'),'freshness','fresh') $$;

insert into auth.users(id,email) values
 ('a1000000-0000-0000-0000-0000000000c1','gh-a@example.invalid'),
 ('b1000000-0000-0000-0000-0000000000c2','gh-b@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values
 ('a3000000-0000-0000-0000-0000000000c3','a1000000-0000-0000-0000-0000000000c1','gh-owner-a','gh-a@example.invalid'),
 ('b3000000-0000-0000-0000-0000000000c4','b1000000-0000-0000-0000-0000000000c2','gh-owner-b','gh-b@example.invalid');

-- A Google Health grant rests on its own notice, copy 4, and no other source's copy is accepted for it or from it.
select is(pg_temp.h('consent_grant','gh-owner-a',pg_temp.grant_body('grant-g-model-0','google_health','model_processing',4))->>'error','consent_required','Google Health model use is refused while storage is not granted');
select is(pg_temp.h('consent_grant','gh-owner-a',pg_temp.grant_body('grant-g-dev-00','google_health','storage_compute',2))->>'error','invalid_request','Google Health storage on the device copy is refused');
select is(pg_temp.h('consent_grant','gh-owner-a',pg_temp.grant_body('grant-g-whp-00','google_health','storage_compute',3))->>'error','invalid_request','and on the WHOOP copy');
select is(pg_temp.h('consent_grant','gh-owner-a',pg_temp.grant_body('grant-w-ghc-00','whoop','storage_compute',4))->>'error','invalid_request','WHOOP storage on the Google Health copy is refused');
select is(pg_temp.h('consent_grant','gh-owner-a',pg_temp.grant_body('grant-a-ghc-00','apple','storage_compute',4))->>'error','invalid_request','and a device source on it');
select is(pg_temp.h('consent_grant','gh-owner-a',pg_temp.grant_body('grant-f-store-0','fitbit','storage_compute',4))->>'error','invalid_request','fitbit is not a source name; the source is google_health');
select is(pg_temp.h('consent_grant','gh-owner-a',pg_temp.grant_body('grant-g-store-1','google_health','storage_compute',4))->'consent'->>'status','granted','Google Health storage is granted on copy 4');
select is((select c.version from waldo.health_consents c join waldo.owners o on o.id=c.owner_id where o.do_name='gh-owner-a' and c.source='google_health' and c.purpose='storage_compute' and c.withdrawn_at is null),4,'and stored on copy 4');
select is(pg_temp.h('consent_grant','gh-owner-a',pg_temp.grant_body('grant-g-model-1','google_health','model_processing',4))->'consent'->>'version','4','model use is granted on top of it, and the consent shows copy 4');
select is(pg_temp.h('consent_grant','gh-owner-a',pg_temp.grant_body('grant-w-store-1','whoop','storage_compute',3))->'consent'->>'status','granted','WHOOP keeps its own copy 3');

-- Ingest takes Google Health readings under the same rules as any other source.
select is(pg_temp.h('ingest','gh-owner-a',pg_temp.batch('ingest-g-000001',1,jsonb_build_array(pg_temp.sleep('google_health:sleep-1',430))))->>'accepted','1','a Google Health reading is stored');
select is(pg_temp.n('gh-owner-a'),1,'under source google_health');
select is(pg_temp.h('ingest','gh-owner-b',pg_temp.batch('ingest-g-000002',1,jsonb_build_array(pg_temp.sleep('google_health:sleep-9',430))))->>'error','consent_required','an owner who never granted Google Health storage stores nothing');
select is((select s->>'source' from jsonb_array_elements(waldo.health_freshness('a3000000-0000-0000-0000-0000000000c3')->'sources') s where s->>'source'='google_health'),'google_health','the console freshness lists Google Health uploads');

-- The derived row may rest on a Google Health basis, as a candidate or accepted.
select is(pg_temp.h('consent_grant','gh-owner-a',jsonb_build_object('request_id','grant-a-store-01','source','apple','purpose','storage_compute','version',2,'expected_epoch',0,'age_attested_18_plus',true))->'consent'->>'status','granted','the owner also grants a device source');
select is(pg_temp.h('context_write','gh-owner-a',pg_temp.ctx('google_health','candidate_unaccepted'))->>'written','true','a candidate from a Google Health basis is written');
select is(pg_temp.h('context_write','gh-owner-a',pg_temp.ctx('google_health','accepted'))->>'written','true','and an accepted one');
select is(pg_temp.h('context_write','gh-owner-a',pg_temp.ctx('fitbit','accepted'))->>'error','invalid_request','a fitbit basis is refused');

-- Withdrawing storage withdraws the source and removes what it stored.
select is(pg_temp.h('consent_withdraw','gh-owner-a',jsonb_build_object('request_id','withdraw-g-model','source','google_health','purpose','model_processing','expected_epoch',1))->>'deletion_routed','false','withdrawing model use deletes nothing');
select is(pg_temp.n('gh-owner-a'),1,'the stored Google Health readings stay');
select is(pg_temp.h('consent_withdraw','gh-owner-a',jsonb_build_object('request_id','withdraw-g-store','source','google_health','purpose','storage_compute','expected_epoch',1))->>'deletion_routed','true','withdrawing storage routes deletion');
select is(pg_temp.n('gh-owner-a'),0,'the stored Google Health readings are gone');

-- The oauth-proxy holds Google Health tokens, a Google Health account belongs to one owner, and its id is matched exactly.
select is((select custodian from waldo.connection_custody where provider='google_health'),'oauth-proxy','the oauth-proxy is the custodian of Google Health connections');
insert into waldo.connections(owner_id,provider,account,secret_id) values ('a3000000-0000-0000-0000-0000000000c3','google_health','HuId-AbC123',gen_random_uuid());
select throws_ok($$insert into waldo.connections(owner_id,provider,account,secret_id) values ('b3000000-0000-0000-0000-0000000000c4','google_health','HuId-AbC123',gen_random_uuid())$$,'23505',null,'a second owner cannot link the same Google Health account');
select is((select array_agg(x) from pg_temp.route('google_health','HuId-AbC123') x),array['gh-owner-a'],'a Google Health webhook routes to the owner holding that account');
select is((select count(*)::int from pg_temp.route('google_health','huid-abc123')),0,'an id differing only in case routes nowhere');
select throws_ok($$select count(*) from pg_temp.route('google_health','HuId-AbC123','huid-abc123')$$,'42501',null,'and a signature over the lowered id is refused for it');
select is((select count(*)::int from pg_temp.route('google','HuId-AbC123')),0,'Google Workspace connections are not routable through it');
update waldo.connections set status='revoked',revoked_at=now() where provider='google_health' and account='HuId-AbC123';
select is((select count(*)::int from pg_temp.route('google_health','HuId-AbC123')),0,'a revoked connection no longer routes');
select lives_ok($$insert into waldo.connections(owner_id,provider,account,secret_id) values ('b3000000-0000-0000-0000-0000000000c4','google_health','HuId-AbC123',gen_random_uuid())$$,'and its account can be linked again');

-- The edge stores tokens through oauth_store, which keeps a Google Health id exactly as Google gave it.
select isnt(waldo.oauth_store('gh-owner-a','google_health','HuId-XyZ789','sleep','{"issuer":"https://accounts.google.com"}'::jsonb,'fixture-token-bundle')->>'id',null,'the edge stores a Google Health connection');
select is((select account from waldo.connections where provider='google_health' and status<>'revoked' and owner_id='a3000000-0000-0000-0000-0000000000c3'),'HuId-XyZ789','with its id in its own case');
select is((select array_agg(x) from pg_temp.route('google_health','HuId-XyZ789') x),array['gh-owner-a'],'so a webhook naming that id routes to its owner');
select lives_ok($$select waldo.oauth_store('gh-owner-a','whoop','WhOoP-9','read:sleep','{"issuer":"https://api.prod.whoop.com"}'::jsonb,'fixture-token-bundle')$$,'the edge stores a WHOOP connection');
select is((select account from waldo.connections where provider='whoop' and lower(account)='whoop-9'),'whoop-9','with its id lowered as before');

-- WHOOP's numeric ids keep their lowered match and signature.
insert into waldo.connections(owner_id,provider,account,secret_id) values ('a3000000-0000-0000-0000-0000000000c3','whoop','30311',gen_random_uuid());
select is((select array_agg(x) from pg_temp.route('whoop','30311') x),array['gh-owner-a'],'a WHOOP account still routes as before');

-- A Google Health connection starts from the app, so its callback must match a connect session.
create function pg_temp.sess(op text,hash text) returns jsonb language plpgsql as $$
declare a bigint:=extract(epoch from now())::bigint;
begin
  if op='issue' then return to_jsonb(waldo.connect_session_issue('gh-owner-a','google_health','app',hash,a,pg_temp.sig('connsess.issue.gh-owner-a.google_health.app.'||hash,a)));
  else return waldo.connect_session_resolve(hash,a,pg_temp.sig('connsess.resolve.'||hash,a)); end if;
end $$;
select isnt(pg_temp.sess('issue',repeat('c',64)),'null'::jsonb,'a Google Health attempt can be issued');
select is(pg_temp.sess('resolve',repeat('c',64))->>'do_name','gh-owner-a','and its callback state resolves to the owner who started it');

select * from finish();
rollback;
