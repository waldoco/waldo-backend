begin;
create extension if not exists pgtap with schema extensions;
select plan(14);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- The inventory names each kind of body data, its newest reading time and how many days hold one, and never a value. It answers
-- only for a source whose storage and model-use grants are both live. Readings go in through the real ingest. Synthetic owners
-- and synthetic values throughout.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.grant_body(rid text,purpose text) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','health_connect','purpose',purpose,'version',2,'expected_epoch',0,'age_attested_18_plus',true) $$;
create function pg_temp.withdraw_body(rid text,purpose text,epoch int) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','health_connect','purpose',purpose,'expected_epoch',epoch) $$;
create function pg_temp.iso(t timestamptz) returns text language sql as $$ select to_char(t at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') $$;
create function pg_temp.hour_start(back int) returns timestamptz language sql as $$ select date_trunc('hour',now())-make_interval(hours=>back) $$;
create function pg_temp.steps(id text,back int,val numeric) returns jsonb language sql as $$
  select jsonb_build_object('sample_id',id,'revision',1,'signal','steps_window','unit','count','value',val,
    'day',(pg_temp.hour_start(back) at time zone 'UTC')::date,'start_at',pg_temp.iso(pg_temp.hour_start(back)),'end_at',pg_temp.iso(pg_temp.hour_start(back)+interval '1 hour'),'utc_offset_minutes',0) $$;
create function pg_temp.sleep(id text,back_days int,val numeric) returns jsonb language sql as $$
  select jsonb_build_object('sample_id',id,'revision',1,'signal','sleep_duration','unit','minutes','method','asleep_duration','value',val,
    'day',((now() at time zone 'UTC')::date-back_days),'start_at',pg_temp.iso(date_trunc('day',now())-make_interval(days=>back_days,hours=>7)),
    'end_at',pg_temp.iso(date_trunc('day',now())-make_interval(days=>back_days)),'utc_offset_minutes',0) $$;
create function pg_temp.batch(rid text,samples jsonb) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','health_connect','consent_epoch',1,'timezone','UTC','anchor_before',null,'anchor_after','a-'||rid,'samples',samples,'deletions','[]'::jsonb) $$;
create function pg_temp.window_(back int) returns jsonb language sql as $$
  select jsonb_build_object('from',to_char((now() at time zone 'UTC')::date-back,'YYYY-MM-DD'),'to',to_char((now() at time zone 'UTC')::date,'YYYY-MM-DD')) $$;

insert into auth.users(id,email) values ('e1000000-0000-0000-0000-0000000000f8','inventory@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('e3000000-0000-0000-0000-0000000000f8','e1000000-0000-0000-0000-0000000000f8','inventory-owner','inventory@example.invalid');

select throws_ok($$select waldo.health_inventory_read('inventory-owner','{}',extract(epoch from now())::bigint,'forged')$$,'42501','unsigned router call','a forged signature is refused');
select is(pg_temp.h('inventory_read','inventory-owner-nobody',pg_temp.window_(6))->>'error','not_linked','an unprovisioned locator has no inventory');
select is(pg_temp.h('inventory_read','inventory-owner','{"from":"2026-01-01","to":"2026-02-01"}')->>'error','invalid_request','a window longer than 31 days is refused');
select is(pg_temp.h('inventory_read','inventory-owner','{"from":"2026-01-01","to":"2026-01-02","signals":["steps_window"]}')->>'error','invalid_request','an unknown key is refused');
select is(pg_temp.h('inventory_read','inventory-owner','{"from":"2026-02-30","to":"2026-03-01"}')->>'error','invalid_request','an impossible date is refused without a raw database error');
select is(pg_temp.h('inventory_read','inventory-owner',pg_temp.window_(6)),'{"sources":[]}'::jsonb,'with no grant there is no source');

select is(pg_temp.h('consent_grant','inventory-owner',pg_temp.grant_body('inv-grant-storage','storage_compute'))->'consent'->>'status','granted','the owner grants storage');
select is(pg_temp.h('ingest','inventory-owner',pg_temp.batch('inv-batch-0001',jsonb_build_array(
  pg_temp.steps('inv-step-1',1,410),pg_temp.steps('inv-step-2',2,377),pg_temp.steps('inv-step-3',50,912),pg_temp.sleep('inv-sleep-1',0,431),pg_temp.sleep('inv-sleep-old',40,402))))->>'accepted','5',
  'steps over two days and two nights are stored');
select is(pg_temp.h('inventory_read','inventory-owner',pg_temp.window_(6)),'{"sources":[]}'::jsonb,'storage alone does not let the inventory reach the model');

select is(pg_temp.h('consent_grant','inventory-owner',pg_temp.grant_body('inv-grant-model','model_processing'))->'consent'->>'status','granted','the owner grants model use');
select is(pg_temp.h('inventory_read','inventory-owner',pg_temp.window_(6)),
  jsonb_build_object('sources',jsonb_build_array(jsonb_build_object('source','health_connect','kinds',jsonb_build_array(
    jsonb_build_object('signal','sleep_duration','newest_at',pg_temp.iso(date_trunc('day',now())),'days',1),
    jsonb_build_object('signal','steps_window','newest_at',pg_temp.iso(pg_temp.hour_start(1)+interval '1 hour'),
      'days',(select count(distinct d) from unnest(array[(pg_temp.hour_start(1) at time zone 'UTC')::date,(pg_temp.hour_start(2) at time zone 'UTC')::date,(pg_temp.hour_start(50) at time zone 'UTC')::date]) d)))))),
  'each kind in the window: its newest reading time and its days, and nothing older than the window');
select ok(pg_temp.h('inventory_read','inventory-owner',pg_temp.window_(6))::text !~ '410|377|912|431|402|inv-step|inv-sleep','no value and no sample id leaves');

select is(pg_temp.h('consent_withdraw','inventory-owner',pg_temp.withdraw_body('inv-withdraw-model','model_processing',1))->'consent'->>'status','withdrawn','the owner withdraws model use');
select is(pg_temp.h('inventory_read','inventory-owner',pg_temp.window_(6)),'{"sources":[]}'::jsonb,'and the inventory no longer answers for that source');

select * from finish();
rollback;
