begin;
create extension if not exists pgtap with schema extensions;
select plan(28);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- A run's late days go to the database in one call. Each is written by waldo.health_context_write itself, in order, and the
-- batch ends at the first consent or epoch refusal. Synthetic owners and values.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.grant_body(rid text,purpose text) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','apple','purpose',purpose,'version',2,'expected_epoch',0,'age_attested_18_plus',true) $$;
create function pg_temp.d(back int) returns text language sql as $$ select to_char((now() at time zone 'UTC')::date - back,'YYYY-MM-DD') $$;
create function pg_temp.recovery(score int, zone text) returns jsonb language sql as $$
  select jsonb_build_object('score',score,'zone',zone,'algorithm_version','recovery.v5','activation','accepted','hrv_method','rmssd','confidence',0.8) $$;
create function pg_temp.live(back int, score int, zone text) returns jsonb language sql as $$
  select jsonb_build_object('day',pg_temp.d(back),'timezone','UTC','basis',jsonb_build_array(jsonb_build_object('source','apple','consent_epoch',1)),
    'form',jsonb_build_object('reason','intraday_inputs_unavailable'),'recovery',pg_temp.recovery(score,zone),
    'weight',jsonb_build_object('reason','calendar_demand_unavailable'),'freshness','fresh') $$;
create function pg_temp.late(back int, score int, zone text) returns jsonb language sql as $$ select pg_temp.live(back,score,zone) || '{"backfilled":true}'::jsonb $$;
-- The same row on a consent epoch the owner never reached: the writer answers epoch_conflict.
create function pg_temp.late_old_epoch(back int) returns jsonb language sql as $$
  select jsonb_set(pg_temp.late(back,50,'moderate'),'{basis,0,consent_epoch}','9'::jsonb) $$;
create function pg_temp.batch(owner text, rows jsonb) returns jsonb language sql as $$ select pg_temp.h('context_write_batch',owner,rows) $$;
create function pg_temp.hist(owner text) returns jsonb language sql as $$ select pg_temp.h('scores_history',owner,'{"days":90}')->'history'->'days' $$;
create function pg_temp.held(owner text, back int) returns boolean language sql as $$
  select exists (select 1 from jsonb_array_elements(pg_temp.hist(owner)) x where x->>'day' = pg_temp.d(back)) $$;
create function pg_temp.sent(owner text, op text, payload text, at bigint default extract(epoch from now())::bigint) returns jsonb language plpgsql as $$
begin return waldo.health_context_write_batch(owner,payload,at,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(payload),at)); end $$;

insert into auth.users(id,email) values ('e1000000-0000-0000-0000-0000000000e1','ba@example.invalid'),('e1000000-0000-0000-0000-0000000000e2','bb@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values
  ('e3000000-0000-0000-0000-0000000000e3','e1000000-0000-0000-0000-0000000000e1','ba-owner','ba@example.invalid'),
  ('e3000000-0000-0000-0000-0000000000e4','e1000000-0000-0000-0000-0000000000e2','bb-owner','bb@example.invalid');
select is(pg_temp.h('consent_grant','ba-owner',pg_temp.grant_body('grant-ba-storage','storage_compute'))->'consent'->>'status','granted','the owner grants storage');
select is(pg_temp.h('consent_grant','ba-owner',pg_temp.grant_body('grant-ba-model00','model_processing'))->'consent'->>'status','granted','and model use');

-- The function: signed security definer with an empty search path, runnable by the runtime key and no other role.
select ok((select p.prosecdef and p.proconfig = array['search_path=""'] from pg_proc p where p.oid = 'waldo.health_context_write_batch(text,text,bigint,text)'::regprocedure),'the batch writer is security definer with an empty search path');
select ok(has_function_privilege('anon','waldo.health_context_write_batch(text,text,bigint,text)','execute')
  and not has_function_privilege('authenticated','waldo.health_context_write_batch(text,text,bigint,text)','execute')
  and not has_function_privilege('service_role','waldo.health_context_write_batch(text,text,bigint,text)','execute'),'the runtime key can call it, and no other role');

-- In order, all written, each answered as the single writer answers it.
select is(pg_temp.batch('ba-owner',jsonb_build_array(pg_temp.late(10,60,'good'),pg_temp.late(9,61,'good'),pg_temp.late(8,62,'good'))),
  '{"results":[{"written":true,"changed":[]},{"written":true,"changed":[]},{"written":true,"changed":[]}]}'::jsonb,'three late days are written and answered one for one, in order');
select ok(pg_temp.held('ba-owner',10) and pg_temp.held('ba-owner',9) and pg_temp.held('ba-owner',8),'and the history holds all three');
select is((select count(*)::int from public.health_context_daily where user_id='e1000000-0000-0000-0000-0000000000e1' and backfilled is true),3,'each labelled backfilled');
select is((select count(*)::int from waldo.health_context_basis where owner_id='e3000000-0000-0000-0000-0000000000e3'),3,'with its consent basis beside it');

-- The writer's own answer for each row, so a later change to it carries into the batch.
select is(pg_temp.batch('ba-owner',jsonb_build_array(pg_temp.late(10,70,'good')))->'results'->0,pg_temp.h('context_write','ba-owner',pg_temp.late(10,70,'good')),'a row is answered exactly as the single writer answers it');
select is((select (recovery->>'score')::int from public.health_context_daily where user_id='e1000000-0000-0000-0000-0000000000e1' and day = (now() at time zone 'UTC')::date - 10),70,'and a backfilled row is replaced by a later backfilled one');

-- A live row stands over a late one, and the batch goes on past the stale answer.
select is(pg_temp.h('context_write','ba-owner',pg_temp.live(7,80,'high'))->>'written','true','a live row for an older day is written');
select is(pg_temp.batch('ba-owner',jsonb_build_array(pg_temp.late(7,10,'low'),pg_temp.late(6,63,'good'))),
  '{"results":[{"written":false,"stale":true},{"written":true,"changed":[]}]}'::jsonb,'a late row over that live row is stale, and the next row is written');
select is((select (recovery->>'score')::int from public.health_context_daily where user_id='e1000000-0000-0000-0000-0000000000e1' and day = (now() at time zone 'UTC')::date - 7),80,'the live row stands');

-- A refusal ends the batch: the rows before it stay written, the rows after it are not touched.
select is(pg_temp.batch('ba-owner',jsonb_build_array(pg_temp.late(20,60,'good'),pg_temp.late(19,60,'good'),pg_temp.late_old_epoch(18),pg_temp.late(17,60,'good'),pg_temp.late(16,60,'good'))),
  '{"results":[{"written":true,"changed":[]},{"written":true,"changed":[]},{"error":"epoch_conflict"}]}'::jsonb,'an epoch the database refuses is answered in its place and ends the answers');
select ok(pg_temp.held('ba-owner',20) and pg_temp.held('ba-owner',19),'the rows before the refusal stay written');
select ok(not pg_temp.held('ba-owner',18) and not pg_temp.held('ba-owner',17) and not pg_temp.held('ba-owner',16),'and neither the refused row nor any after it is');

-- Other answers do not end it: an invalid row is answered in its place and the rest are written.
select is(pg_temp.batch('ba-owner',jsonb_build_array(pg_temp.late(40,60,'good'),pg_temp.late(39,60,'good') || '{"extra":1}','"text"'::jsonb,pg_temp.late(38,60,'good'))),
  '{"results":[{"written":true,"changed":[]},{"error":"invalid_request"},{"error":"invalid_request"},{"written":true,"changed":[]}]}'::jsonb,'an invalid row is answered invalid_request in its place, and so is one that is not an object');
select ok(pg_temp.held('ba-owner',40) and pg_temp.held('ba-owner',38) and not pg_temp.held('ba-owner',39),'and the batch goes on and writes the valid rows around them');

-- Owner scoping: the batch writes for the owner it names, as the single writer does.
select is(pg_temp.batch('bb-owner',jsonb_build_array(pg_temp.late(5,60,'good'),pg_temp.late(4,60,'good'))),'{"results":[{"error":"consent_required"}]}'::jsonb,'another owner with no consent is refused at its first row, as the single writer refuses');
select is(pg_temp.batch('no-such-owner',jsonb_build_array(pg_temp.late(5,60,'good')))->'results'->0,'{"error":"not_linked"}'::jsonb,'an owner that does not exist is not linked');
select is((select count(*)::int from public.health_context_daily where user_id='e1000000-0000-0000-0000-0000000000e2'),0,'and no row lands for either');

-- Bounds: one to thirty rows, an array, and a size.
select is(pg_temp.batch('ba-owner',(select jsonb_agg(pg_temp.late(50 + i,60,'good')) from generate_series(1,31) i)),'{"error":"invalid_request"}'::jsonb,'thirty-one rows are refused whole');
select ok(not pg_temp.held('ba-owner',51),'and none of them is written');
select is(pg_temp.batch('ba-owner',(select jsonb_agg(pg_temp.late(50 + i,60,'good')) from generate_series(1,30) i))->'results'->29->>'written','true','thirty are taken');
select is(pg_temp.batch('ba-owner','[]'),'{"error":"invalid_request"}'::jsonb,'an empty batch is refused');
select is((select count(*)::int from unnest(array['{}','"text"','7','null']::jsonb[]) bad where pg_temp.batch('ba-owner',bad) = '{"error":"invalid_request"}'::jsonb),4,'so is a payload that is not an array');

-- Signature: over the batch operation and its own payload, within the clock window. A single write's signature does not open it.
select throws_ok($$select pg_temp.sent('ba-owner','context_write','[]')$$,'42501','unsigned router call','a signature made for the single writer does not open the batch');
select throws_ok($$select pg_temp.sent('ba-owner','context_write_batch','[]',extract(epoch from now())::bigint - 600)$$,'42501','unsigned router call','nor does one outside the clock window');

select * from finish();
rollback;
