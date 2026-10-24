begin;
create extension if not exists pgtap with schema extensions;
select plan(56);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.h(op text,owner text,body text default '{}') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,body,pg_temp.at(),pg_temp.sig('health.'||op||'.'||owner||'.'||md5(body),pg_temp.at());
  return r;
end $$;
create function pg_temp.admin(owner text) returns jsonb language sql as $$
  select waldo.admin_health_freshness(owner,pg_temp.at(),pg_temp.sig('admin_health.'||owner,pg_temp.at())) $$;
create function pg_temp.of(admin jsonb,owner_email text) returns jsonb language sql as $$
  select o from jsonb_array_elements(admin->'owners') o where o->>'email'=owner_email $$;
create function pg_temp.src(freshness jsonb,source text) returns jsonb language sql as $$
  select s from jsonb_array_elements(freshness->'sources') s where s->>'source'=source $$;
create function pg_temp.keys(j jsonb) returns text[] language sql as $$ select array_agg(k order by k) from jsonb_object_keys(j) k $$;

insert into auth.users(id,email) values
 ('a1000000-0000-0000-0000-0000000000f1','hf-admin@example.invalid'),
 ('b1000000-0000-0000-0000-0000000000f1','hf-tester@example.invalid'),
 ('c1000000-0000-0000-0000-0000000000f1','hf-quiet@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email,is_admin) values
 ('a3000000-0000-0000-0000-0000000000f3','a1000000-0000-0000-0000-0000000000f1','hf-owner-a','hf-admin@example.invalid',true),
 ('b3000000-0000-0000-0000-0000000000f3','b1000000-0000-0000-0000-0000000000f1','hf-owner-b','hf-tester@example.invalid',false),
 ('c3000000-0000-0000-0000-0000000000f3','c1000000-0000-0000-0000-0000000000f1','hf-owner-c','hf-quiet@example.invalid',false);

-- The tester shares Apple storage, withdrew Apple model processing, and has a WHOOP storage grant.
select pg_temp.h('consent_grant','hf-owner-b',jsonb_build_object('request_id','hf-grant-apple-s','source','apple','purpose','storage_compute','version',2,'expected_epoch',0,'age_attested_18_plus',true)::text);
select pg_temp.h('consent_grant','hf-owner-b',jsonb_build_object('request_id','hf-grant-apple-m','source','apple','purpose','model_processing','version',2,'expected_epoch',0,'age_attested_18_plus',true)::text);
select pg_temp.h('consent_withdraw','hf-owner-b',jsonb_build_object('request_id','hf-withdraw-apple-m','source','apple','purpose','model_processing','expected_epoch',1)::text);

-- Receipts as the ingest stores them (count-only responses), plus a stored reading and a derived row carrying
-- distinctive values that must never appear in either projection.
insert into waldo.health_requests(owner_id,request_id,operation,payload_digest,response,created_at) values
 ('b3000000-0000-0000-0000-0000000000f3','hf-in-1','ingest','d1','{"source":"apple","accepted":3,"ignored":0,"deleted":0,"rejected":[{"change":"sample","index":0,"signal":"spo2","reason":"invalid_sample"},{"change":"sample","index":1,"signal":"spo2","reason":"invalid_sample"},{"change":"sample","index":2,"signal":"vo2_max","reason":"unsupported_signal"}]}',now()-interval '2 hours'),
 ('b3000000-0000-0000-0000-0000000000f3','hf-in-2','ingest','d2','{"source":"apple","accepted":1,"ignored":0,"deleted":0}',now()-interval '1 hour'),
 ('b3000000-0000-0000-0000-0000000000f3','hf-in-3','ingest','d3','{"source":"apple","accepted":9,"ignored":0,"deleted":0,"rejected":[{"change":"sample","index":0,"signal":"spo2","reason":"invalid_sample"}]}',now()-interval '10 days'),
 ('b3000000-0000-0000-0000-0000000000f3','hf-in-4','ingest','d4','{"source":"whoop","accepted":2,"ignored":0,"deleted":0}',now()-interval '3 days'),
 ('b3000000-0000-0000-0000-0000000000f3','hf-grant-x','consent_grant','d5','{"source":"samsung"}',now());
insert into waldo.health_samples(owner_id,source,signal,sample_id,revision,epoch,day,start_at,end_at,utc_offset_minutes,payload) values
 ('b3000000-0000-0000-0000-0000000000f3','apple','steps_window','hf-s-1',1,1,current_date,now()-interval '1 hour',now(),0,'{"unit":"count","value":4321}');
insert into public.health_context_daily(user_id,day,recovery,form,weight,freshness) values
 ('b1000000-0000-0000-0000-0000000000f1',current_date-1,'{"score":87.5,"zone":"peak"}','{"score":61.25,"zone":"steady"}','{"score":42.75,"zone":"low"}','fresh'),
 ('b1000000-0000-0000-0000-0000000000f1',current_date,'{"score":87.5,"zone":"peak"}','{"score":61.25,"zone":"steady"}','{"score":42.75,"zone":"low"}','fresh');
insert into waldo.health_context_basis(owner_id,day,consent_basis,timezone) values
 ('b3000000-0000-0000-0000-0000000000f3',current_date-1,'[{"source":"apple","purpose":"storage_compute","epoch":1}]','Europe/London'),
 ('b3000000-0000-0000-0000-0000000000f3',current_date,'[{"source":"apple","purpose":"storage_compute","epoch":1}]','Europe/London');

-- Privileges: the shared projection and the counter table are reachable only through the signed functions.
select has_table('waldo','health_ingest_refusals','refused uploads are counted in their own table');
select ok(not has_function_privilege('anon','waldo.health_freshness(uuid)','execute'),'the publishable key cannot run the shared projection');
select ok(not has_function_privilege('authenticated','waldo.health_freshness(uuid)','execute'),'a signed-in user cannot run the shared projection');
select ok(not has_function_privilege('service_role','waldo.health_freshness(uuid)','execute'),'the trusted role cannot run the shared projection');
select ok(not has_table_privilege('anon','waldo.health_ingest_refusals','select'),'the publishable key cannot read refusal counts');
select ok(not has_table_privilege('service_role','waldo.health_ingest_refusals','select'),'the trusted role cannot read refusal counts');
select ok((select relforcerowsecurity from pg_class where oid='waldo.health_ingest_refusals'::regclass),'refusal counts force row-level security');
select ok(has_function_privilege('anon','waldo.admin_health_freshness(text,bigint,text)','execute'),'the admin read is callable only over the signed rail');

-- Admin authority.
select throws_ok($$ select waldo.admin_health_freshness('hf-owner-a',pg_temp.at(),'unsigned') $$,'42501',null,'an unsigned admin read is refused');
select throws_ok($$ select waldo.admin_health_freshness('hf-owner-a',pg_temp.at(),pg_temp.sig('admin.hf-owner-a',pg_temp.at())) $$,'42501',null,
  'an admin overview signature cannot be replayed against the health read');
select is(pg_temp.admin('hf-owner-b'),null,'a signed read from a non-admin owner returns nothing');
select is(jsonb_array_length(pg_temp.admin('hf-owner-a')->'owners'),3,'the admin sees every owner');

-- What the admin sees for the tester: counts, timestamps, closed codes and consent states.
select is(pg_temp.keys(pg_temp.of(pg_temp.admin('hf-owner-a'),'hf-tester@example.invalid')),array['consents','created_at','email','freshness','id','state'],'an owner row carries only identity, consent and freshness');
select is(pg_temp.keys(pg_temp.of(pg_temp.admin('hf-owner-a'),'hf-tester@example.invalid')->'freshness'),array['newest_derived','refusals_7d','sources'],'freshness carries only sources, refusals and the newest derived day');
select is(pg_temp.keys(pg_temp.src(pg_temp.of(pg_temp.admin('hf-owner-a'),'hf-tester@example.invalid')->'freshness','apple')),array['newest_upload_at','rejected_readings_7d','source','uploads_7d'],'a source carries only its newest upload and seven-day counts');
select is((pg_temp.src(pg_temp.of(pg_temp.admin('hf-owner-a'),'hf-tester@example.invalid')->'freshness','apple')->>'newest_upload_at')::timestamptz,
  (select date_trunc('milliseconds',created_at) from waldo.health_requests where request_id='hf-in-2'),'the newest Apple upload is the latest accepted receipt, to the millisecond');
select is((pg_temp.src(pg_temp.of(pg_temp.admin('hf-owner-a'),'hf-tester@example.invalid')->'freshness','apple')->>'uploads_7d')::int,2,'only uploads from the last seven days are counted');
select is(pg_temp.src(pg_temp.of(pg_temp.admin('hf-owner-a'),'hf-tester@example.invalid')->'freshness','apple')->'rejected_readings_7d',
  '[{"count":2,"reason":"invalid_sample"},{"count":1,"reason":"unsupported_signal"}]'::jsonb,'per-reading rejections in the window are counted by reason, never by signal');
select is((pg_temp.src(pg_temp.of(pg_temp.admin('hf-owner-a'),'hf-tester@example.invalid')->'freshness','whoop')->>'uploads_7d')::int,1,'a provider source is listed like a phone source');
select is(pg_temp.src(pg_temp.of(pg_temp.admin('hf-owner-a'),'hf-tester@example.invalid')->'freshness','samsung'),null,'a receipt that is not an upload is not a source');
select is(pg_temp.of(pg_temp.admin('hf-owner-a'),'hf-tester@example.invalid')->'freshness'->'newest_derived'->>'day',current_date::text,'the newest derived day is the latest row with a basis');
select ok((pg_temp.of(pg_temp.admin('hf-owner-a'),'hf-tester@example.invalid')->'freshness'->'newest_derived'->>'compiled_at') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$','the derived row carries its compile time in UTC');
select is((select jsonb_agg(c->>'purpose'||':'||(c->>'status') order by c->>'purpose') from jsonb_array_elements(pg_temp.of(pg_temp.admin('hf-owner-a'),'hf-tester@example.invalid')->'consents') c where c->>'source'='apple'),
  '["model_processing:withdrawn","storage_compute:granted"]'::jsonb,'each purpose shows its own state');
select is(pg_temp.keys((pg_temp.of(pg_temp.admin('hf-owner-a'),'hf-tester@example.invalid')->'consents')->0),array['granted_at','purpose','source','status','withdrawn_at'],'a consent row carries only its state and times');
select is(pg_temp.of(pg_temp.admin('hf-owner-a'),'hf-quiet@example.invalid')->'consents','[]'::jsonb,'an owner who never shared shows no consent rows');
select is(pg_temp.of(pg_temp.admin('hf-owner-a'),'hf-quiet@example.invalid')->'freshness','{"sources":[],"refusals_7d":[],"newest_derived":null}'::jsonb,'an owner with nothing uploaded shows empty freshness');

-- No value reaches the admin: not the stored reading, not a score, and no key that could carry one.
select ok(not jsonb_path_exists(pg_temp.admin('hf-owner-a'),'$.** ? (@ == 4321)'),'the stored reading value never appears');
select ok(not jsonb_path_exists(pg_temp.admin('hf-owner-a'),'$.** ? (@ == 87.5 || @ == 61.25 || @ == 42.75)'),'no derived score appears');
select ok(pg_temp.admin('hf-owner-a')::text !~ '"(score|zone|payload|value|anchor|anchor_after|signal|sample_id|request_id|recovery|form|weight|drivers|tags)":','no key that can carry a value or an id appears');

-- The owner reads the same projection for themself, and only for themself.
select throws_ok($$ select waldo.health_freshness_read('hf-owner-b','{}',pg_temp.at(),'unsigned') $$,'42501',null,'an unsigned owner read is refused');
select is(pg_temp.h('freshness_read','hf-owner-b')->'freshness',pg_temp.of(pg_temp.admin('hf-owner-a'),'hf-tester@example.invalid')->'freshness','the owner sees exactly what the admin sees for them');
select is(pg_temp.h('freshness_read','hf-owner-a')->'freshness'->'sources','[]'::jsonb,'another owner''s uploads never appear');
select is(pg_temp.h('freshness_read','hf-owner-b','{"owner":"hf-owner-a"}'),'{"error":"invalid_request"}'::jsonb,'the owner read takes no selector');
select is(pg_temp.h('freshness_read','hf-owner-missing'),'{"error":"not_linked"}'::jsonb,'an unknown owner is not linked');

-- A refused upload is counted by closed code and status only.
select is(pg_temp.h('refusal_note','hf-owner-b','{"code":"invalid_request","status":400}'),'{"noted":true}'::jsonb,'a refusal is noted');
select pg_temp.h('refusal_note','hf-owner-b','{"code":"invalid_request","status":400}');
select pg_temp.h('refusal_note','hf-owner-b','{"code":"consent_withdrawn","status":403}');
select is((select refusals from waldo.health_ingest_refusals r join waldo.owners o on o.id=r.owner_id where o.do_name='hf-owner-b' and code='invalid_request'),2,'the same code and status on one day add up');
select is((select jsonb_agg(r->>'code'||':'||(r->>'status')||':'||(r->>'count') order by r->>'code') from jsonb_array_elements(pg_temp.h('freshness_read','hf-owner-b')->'freshness'->'refusals_7d') r),
  '["consent_withdrawn:403:1","invalid_request:400:2"]'::jsonb,'refusals in the window are listed by code and status');
select is(pg_temp.h('refusal_note','hf-owner-b','{"code":"unknown_code","status":400}'),'{"error":"invalid_request"}'::jsonb,'only a closed code is counted');
select is(pg_temp.h('refusal_note','hf-owner-b','{"code":"invalid_request","status":200}'),'{"error":"invalid_request"}'::jsonb,'only a refusal status is counted');
select is(pg_temp.h('refusal_note','hf-owner-b','{"code":"invalid_request","status":400,"detail":"x"}'),'{"error":"invalid_request"}'::jsonb,'a note carries nothing but its code and status');
select is(pg_temp.h('refusal_note','hf-owner-b','{"code":"invalid_request","status":"400"}'),'{"error":"invalid_request"}'::jsonb,'a status is a number');
select is(pg_temp.h('refusal_note','hf-owner-missing','{"code":"invalid_request","status":400}'),'{"error":"not_linked"}'::jsonb,'an unknown owner cannot be counted');
select throws_ok($$ select waldo.health_refusal_note('hf-owner-b','{"code":"invalid_request","status":400}',pg_temp.at(),'unsigned') $$,'42501',null,'an unsigned note is refused');

-- No other owner's receipts or refusals reach an owner's freshness: the admin owner now has receipts and refusals of its own.
insert into waldo.health_requests(owner_id,request_id,operation,payload_digest,response,created_at) values
 ('a3000000-0000-0000-0000-0000000000f3','hf-a-1','ingest','d','{"source":"apple","accepted":1,"ignored":0,"deleted":0,"rejected":[{"change":"sample","index":0,"signal":"spo2","reason":"invalid_sample"},{"change":"sample","index":1,"signal":"hrv","reason":"revision_conflict"}]}',now()-interval '1 hour');
select pg_temp.h('refusal_note','hf-owner-a','{"code":"epoch_conflict","status":409}');
select pg_temp.h('refusal_note','hf-owner-a','{"code":"invalid_request","status":400}');
select is(pg_temp.src(pg_temp.h('freshness_read','hf-owner-b')->'freshness','apple')->'rejected_readings_7d',
  '[{"count":2,"reason":"invalid_sample"},{"count":1,"reason":"unsupported_signal"}]'::jsonb,'an owner sees only their own rejected readings');
select is((select jsonb_agg(r->>'code'||':'||(r->>'status')||':'||(r->>'count') order by r->>'code') from jsonb_array_elements(pg_temp.h('freshness_read','hf-owner-b')->'freshness'->'refusals_7d') r),
  '["consent_withdrawn:403:1","invalid_request:400:2"]'::jsonb,'an owner sees only their own refusal counts, and no code only another owner has');
select is(pg_temp.src(pg_temp.h('freshness_read','hf-owner-a')->'freshness','apple')->'rejected_readings_7d',
  '[{"count":1,"reason":"invalid_sample"},{"count":1,"reason":"revision_conflict"}]'::jsonb,'the other owner sees only theirs');
select is((select jsonb_agg(r->>'code'||':'||(r->>'status')||':'||(r->>'count') order by r->>'code') from jsonb_array_elements(pg_temp.h('freshness_read','hf-owner-a')->'freshness'->'refusals_7d') r),
  '["epoch_conflict:409:1","invalid_request:400:1"]'::jsonb,'and only their own refusal counts');

-- The window: eight days back is stored but not listed.
insert into waldo.health_ingest_refusals(owner_id,day,code,status,refusals,newest_at) values
 ('b3000000-0000-0000-0000-0000000000f3',(now() at time zone 'UTC')::date-8,'sample_conflict',409,5,now()-interval '8 days');
select ok(not exists (select 1 from jsonb_array_elements(pg_temp.h('freshness_read','hf-owner-b')->'freshness'->'refusals_7d') r where r->>'code'='sample_conflict'),'a refusal older than the window is not listed');

-- Retention belongs to the health retention calls, not to the note: counts are kept 30 days, and an owner whose only
-- expired rows are counts is still found by the sweep.
insert into waldo.health_ingest_refusals(owner_id,day,code,status,refusals,newest_at) values
 ('b3000000-0000-0000-0000-0000000000f3',(now() at time zone 'UTC')::date-31,'anchor_conflict',409,1,now()-interval '31 days'),
 ('c3000000-0000-0000-0000-0000000000f3',(now() at time zone 'UTC')::date-31,'anchor_conflict',409,1,now()-interval '31 days');
select pg_temp.h('refusal_note','hf-owner-b','{"code":"invalid_request","status":413}');
select is((select count(*)::int from waldo.health_ingest_refusals where owner_id='c3000000-0000-0000-0000-0000000000f3'),1,'a note never deletes another owner''s counts');
select pg_temp.h('retention','hf-owner-b');
select is((select count(*)::int from waldo.health_ingest_refusals where owner_id='b3000000-0000-0000-0000-0000000000f3' and day<(now() at time zone 'UTC')::date-30),0,'the owner''s retention call ages out their counts older than 30 days');
select is((select refusals from waldo.health_ingest_refusals where owner_id='b3000000-0000-0000-0000-0000000000f3' and code='sample_conflict'),5,'counts inside 30 days are kept');
select waldo.health_retention_sweep('{"limit":50}',pg_temp.at(),pg_temp.sig('health.retention_sweep.'||md5('{"limit":50}'),pg_temp.at()));
select is((select count(*)::int from waldo.health_ingest_refusals where owner_id='c3000000-0000-0000-0000-0000000000f3'),0,'the sweep finds an owner whose only expired rows are refusal counts');

-- Withdrawing storage purges the owner's counts. They are not kept by source, so all of them go; a model-processing
-- withdrawal keeps them.
select is((select count(*)::int from waldo.health_ingest_refusals where owner_id='b3000000-0000-0000-0000-0000000000f3')>0,true,'the earlier model-processing withdrawal kept the counts');
select pg_temp.h('consent_withdraw','hf-owner-b',jsonb_build_object('request_id','hf-withdraw-apple-s','source','apple','purpose','storage_compute','expected_epoch',1)::text);
select is((select count(*)::int from waldo.health_ingest_refusals where owner_id='b3000000-0000-0000-0000-0000000000f3'),0,'withdrawing storage purges the owner''s refusal counts');
select is((select count(*)::int from waldo.health_ingest_refusals where owner_id='a3000000-0000-0000-0000-0000000000f3'),2,'and no other owner''s');

-- Deleting an owner deletes their counts.
select pg_temp.h('refusal_note','hf-owner-c','{"code":"consent_required","status":403}');
delete from waldo.owners where do_name='hf-owner-c';
select is((select count(*)::int from waldo.health_ingest_refusals where owner_id='c3000000-0000-0000-0000-0000000000f3'),0,'an owner''s counts go with the owner');

select * from finish();
rollback;
