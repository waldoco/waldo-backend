begin;
create extension if not exists pgtap with schema extensions;
select plan(34);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- The derived row's pillars carry the baseline label and the provenance of provisional scores, written through the current
-- writer. Synthetic owner and synthetic values throughout.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.grant_body(rid text,purpose text) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','apple','purpose',purpose,'version',2,'expected_epoch',0,'age_attested_18_plus',true) $$;
create function pg_temp.day(back int) returns text language sql as $$ select to_char((now() at time zone 'UTC')::date - back,'YYYY-MM-DD') $$;
create function pg_temp.label(state text default 'provisional',n int default 3) returns jsonb language sql as $$
  select jsonb_build_object('state',state,'personal_days',n,'needed',14,'prior','adults') $$;
create function pg_temp.used() returns jsonb language sql as $$
  select jsonb_build_object('signals',jsonb_build_array('sleep','hrv','resting_heart_rate'),'days',jsonb_build_array(pg_temp.day(2),pg_temp.day(1),pg_temp.day(0))) $$;
create function pg_temp.recovery(extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('score',72,'zone','good','algorithm_version','recovery.v5','activation','accepted','hrv_method','rmssd','confidence',0.8) || extra $$;
create function pg_temp.ctx(recovery jsonb, debt jsonb default null) returns jsonb language sql as $$
  select case when debt is null then '{}'::jsonb else jsonb_build_object('sleep_debt',debt) end || jsonb_build_object('day',to_char((now() at time zone 'UTC')::date,'YYYY-MM-DD'),'timezone','UTC',
    'basis',jsonb_build_array(jsonb_build_object('source','apple','consent_epoch',1)),
    'form',jsonb_build_object('reason','intraday_inputs_unavailable'),'recovery',recovery,
    'weight',jsonb_build_object('reason','calendar_demand_unavailable'),'freshness','fresh') $$;
create function pg_temp.scores() returns jsonb language sql as $$ select pg_temp.h('scores_read','prov-owner')->'scores' $$;
create function pg_temp.write(extra jsonb) returns jsonb language sql as $$ select pg_temp.h('context_write','prov-owner',pg_temp.ctx(pg_temp.recovery(extra))) $$;

insert into auth.users(id,email) values ('e1000000-0000-0000-0000-0000000000e1','prov@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('e3000000-0000-0000-0000-0000000000e3','e1000000-0000-0000-0000-0000000000e1','prov-owner','prov@example.invalid');
select is(pg_temp.h('consent_grant','prov-owner',pg_temp.grant_body('grant-p-storage1','storage_compute'))->'consent'->>'status','granted','the owner grants storage');
select is(pg_temp.h('consent_grant','prov-owner',pg_temp.grant_body('grant-p-model0001','model_processing'))->'consent'->>'status','granted','and model use');

-- A pillar written as before, with neither key, is still written: a Worker that predates them keeps working.
select is(pg_temp.write('{}'),'{"written":true,"changed":[]}'::jsonb,'a pillar without the label or the provenance is written as ever');
select ok(not (pg_temp.scores()->'recovery' ? 'baseline'),'and reads without them');

-- Both keys, together, are written and read back exactly as sent.
select is(pg_temp.write(jsonb_build_object('baseline',pg_temp.label(),'used',pg_temp.used()))->>'written','true','a provisional pillar with its label and provenance is written');
select is(pg_temp.scores()->'recovery'->'baseline',pg_temp.label(),'the label reads back as written');
select is(pg_temp.scores()->'recovery'->'used',pg_temp.used(),'and the provenance');
select is(pg_temp.write(jsonb_build_object('baseline',pg_temp.label('personal',14),'used',pg_temp.used()))->>'written','true','a personal pillar at fourteen days is written');
select is(pg_temp.write(jsonb_build_object('baseline',jsonb_build_object('state','personal','personal_days',30,'needed',14,'prior','none'),'used',pg_temp.used()))->>'written','true','a pillar with no prior at thirty days is written');
select is(pg_temp.write(jsonb_build_object('baseline',pg_temp.label('provisional',0),'used',jsonb_build_object('signals',array['calendar','tasks','messages','physical_load','sleep_midpoint','daylight','movement','stress'],'days',array[pg_temp.day(0)])))->>'written','true','every signal name of the closed list is admitted');

-- Everything outside that shape is refused whole, so a refused write leaves the row as it was.
select is((select count(*)::int from unnest(array[
  'null','"provisional"','[]','{}',
  '{"state":"provisional","personal_days":3,"needed":14}',
  '{"state":"provisional","personal_days":3,"needed":14,"prior":"adults","extra":1}',
  '{"state":"unknown","personal_days":3,"needed":14,"prior":"adults"}',
  '{"state":"personal","personal_days":13,"needed":14,"prior":"adults"}',
  '{"state":"provisional","personal_days":14,"needed":14,"prior":"adults"}',
  '{"state":"provisional","personal_days":-1,"needed":14,"prior":"adults"}',
  '{"state":"personal","personal_days":31,"needed":14,"prior":"adults"}',
  '{"state":"provisional","personal_days":2.5,"needed":14,"prior":"adults"}',
  '{"state":"provisional","personal_days":"3","needed":14,"prior":"adults"}',
  '{"state":"provisional","personal_days":3,"needed":13,"prior":"adults"}',
  '{"state":"provisional","personal_days":3,"needed":"14","prior":"adults"}',
  '{"state":"provisional","personal_days":3,"needed":14,"prior":"age_sex"}',
  '{"state":"provisional","personal_days":3,"needed":14,"prior":"made_up"}',
  '{"state":"provisional","personal_days":3,"needed":14,"prior":null}'
]::jsonb[]) bad where pg_temp.write(jsonb_build_object('baseline',bad,'used',pg_temp.used()))->>'error' = 'invalid_request'),18,'every label outside its shape is refused');
select is((select count(*)::int from unnest(array[
  'null','"sleep"','[]','{}',
  '{"signals":["sleep"]}','{"days":["2026-03-20"]}',
  '{"signals":["sleep"],"days":["2026-03-20"],"extra":1}',
  '{"signals":[],"days":["2026-03-20"]}',
  '{"signals":"sleep","days":["2026-03-20"]}',
  '{"signals":["sleep","sleep"],"days":["2026-03-20"]}',
  '{"signals":["sleep",7],"days":["2026-03-20"]}',
  '{"signals":["Sleep"],"days":["2026-03-20"]}',
  '{"signals":["heart_rate"],"days":["2026-03-20"]}',
  '{"signals":["sleep a night of 6 hours"],"days":["2026-03-20"]}',
  '{"signals":["sleep"],"days":[]}',
  '{"signals":["sleep"],"days":"2026-03-20"}',
  '{"signals":["sleep"],"days":["2026-03-20","2026-03-20"]}',
  '{"signals":["sleep"],"days":[20260320]}',
  '{"signals":["sleep"],"days":["2026-3-20"]}',
  '{"signals":["sleep"],"days":["2026-13-45"]}',
  '{"signals":["sleep"],"days":["2026-03-20T00:00:00Z"]}'
]::jsonb[]) bad where pg_temp.write(jsonb_build_object('baseline',pg_temp.label(),'used',replace(bad::text,'2026-03-20',pg_temp.day(0))::jsonb))->>'error' = 'invalid_request'),21,'every provenance outside its shape is refused');
select is(pg_temp.write(jsonb_build_object('baseline',pg_temp.label(),'used',jsonb_build_object('signals',array['sleep','hrv','resting_heart_rate','sleep_midpoint','daylight','movement','stress','calendar','tasks','messages','physical_load','sleep'],'days',array[pg_temp.day(0)])))->>'error','invalid_request','a provenance with more than twelve signals is refused');
select is(pg_temp.write(jsonb_build_object('baseline',pg_temp.label(),'used',jsonb_build_object('signals',array['sleep'],'days',(select jsonb_agg(to_char((now() at time zone 'UTC')::date - g,'YYYY-MM-DD')) from generate_series(0,31) g))))->>'error','invalid_request','a provenance with more than thirty-one days is refused');
select is(pg_temp.write(jsonb_build_object('baseline',pg_temp.label()))->>'error','invalid_request','a label without its provenance is refused');
select is(pg_temp.write(jsonb_build_object('used',pg_temp.used()))->>'error','invalid_request','and a provenance without its label');
select is(pg_temp.h('context_write','prov-owner',pg_temp.ctx(jsonb_build_object('reason','missing_sleep','baseline',pg_temp.label(),'used',pg_temp.used())))->>'error','invalid_request','an unavailable pillar carries nothing but its reason');
select is(pg_temp.h('context_write','prov-owner',pg_temp.ctx(pg_temp.recovery()) || jsonb_build_object('windows',jsonb_build_array(jsonb_build_object('start','10:00','end','12:00','kind','peak'))))->>'error','invalid_request','energy windows are not admitted until their own column exists');
select is(pg_temp.write(jsonb_build_object('baseline',pg_temp.label(),'used',pg_temp.used()))->>'written','true','a valid write after the refusals lands');
select is(pg_temp.scores()->'recovery'->'baseline',pg_temp.label(),'and the row holds the label of the last write that landed');

-- Sleep debt names a need the owner's nights shrank toward eight hours as its own basis, and still only the closed set.
create function pg_temp.debt(basis text) returns jsonb language sql as $$
  select jsonb_build_object('state','available','debt_minutes',410,'need_basis',basis,'algorithm_version','sleep-debt.v2','activation','accepted') $$;
select is(pg_temp.h('context_write','prov-owner',pg_temp.ctx(pg_temp.recovery(),pg_temp.debt('blended_average')))->>'written','true','a sleep debt on a blended need is written');
select is(pg_temp.scores()->'sleep_debt'->>'need_basis','blended_average','and read back with that basis');
select is(pg_temp.h('context_write','prov-owner',pg_temp.ctx(pg_temp.recovery(),pg_temp.debt('own_average')))->>'written','true','the earlier bases are still written');
select is(pg_temp.h('context_write','prov-owner',pg_temp.ctx(pg_temp.recovery(),pg_temp.debt('guessed')))->>'error','invalid_request','a basis outside the closed set is refused');

-- The days a pillar names are the days it was computed from: the row's own day and the thirty before it, never another time.
select is(pg_temp.write(jsonb_build_object('baseline',pg_temp.label(),'used',jsonb_build_object('signals',array['sleep'],'days',array[pg_temp.day(0),pg_temp.day(31)])))->>'written','true','the row''s own day and the thirty-one before it are admitted');
select is(pg_temp.write(jsonb_build_object('baseline',pg_temp.label(),'used',jsonb_build_object('signals',array['sleep'],'days',array[pg_temp.day(32)])))->>'error','invalid_request','a day more than thirty-one before the row''s is refused');
select is(pg_temp.write(jsonb_build_object('baseline',pg_temp.label(),'used',jsonb_build_object('signals',array['sleep'],'days',array[pg_temp.day(-1)])))->>'error','invalid_request','and a day after it');
select is(pg_temp.write(jsonb_build_object('baseline',pg_temp.label(),'used',jsonb_build_object('signals',array['sleep'],'days',array['1999-01-01'])))->>'error','invalid_request','and one years away');

-- A label travels with a confidence that is a number: a value that was not finite and became null is not written silently.
select is(pg_temp.h('context_write','prov-owner',pg_temp.ctx(pg_temp.recovery(jsonb_build_object('baseline',pg_temp.label(),'used',pg_temp.used(),'confidence',null))))->>'error','invalid_request','a labelled pillar with a null confidence is refused');
select is(pg_temp.h('context_write','prov-owner',pg_temp.ctx((pg_temp.recovery(jsonb_build_object('baseline',pg_temp.label(),'used',pg_temp.used())) - 'confidence')))->>'error','invalid_request','and one with no confidence');
select is(pg_temp.write(jsonb_build_object('baseline',pg_temp.label(),'used',pg_temp.used(),'confidence',1.2))->>'error','invalid_request','and one outside zero to one');

-- Accepted is for the sources the amendment names. The basis list refuses any other source before this check is reached.
create function pg_temp.ctx_source(source text, activation text) returns jsonb language sql as $$
  select pg_temp.ctx(pg_temp.recovery(jsonb_build_object('activation',activation))) || jsonb_build_object('basis',jsonb_build_array(jsonb_build_object('source',source,'consent_epoch',1))) $$;
select is(pg_temp.h('context_write','prov-owner',pg_temp.ctx_source('fitbit','accepted'))->>'error','invalid_request','accepted from a source outside the named ones is refused');
select is(pg_temp.h('context_write','prov-owner',pg_temp.ctx_source('apple','accepted'))->>'written','true','accepted from a named source is written');
select is(pg_temp.h('context_write','prov-owner',pg_temp.ctx_source('apple','candidate_unaccepted'))->>'written','true','and a candidate from it');

select * from finish();
rollback;
