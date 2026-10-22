begin;
create extension if not exists pgtap with schema extensions;
select plan(31);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

-- Per-sample rejection: a payload the Worker marks "rejection":"per_sample" stores its good changes and lists the bad ones by
-- position, kind and reason; a payload without it is the all-or-nothing batch. Every reading here is synthetic.
create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.grant_body(rid text) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','apple','purpose','storage_compute','version',2,'expected_epoch',0,'age_attested_18_plus',true) $$;
create function pg_temp.hour_start(back int) returns timestamptz language sql as $$ select date_trunc('hour',now())-make_interval(hours=>back) $$;
create function pg_temp.iso(t timestamptz) returns text language sql as $$ select to_char(t at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') $$;
create function pg_temp.steps(id text,back int,val numeric,rev bigint default null) returns jsonb language sql as $$
  select jsonb_build_object('sample_id',id,'revision',coalesce(rev,extract(epoch from now())::bigint),'signal','steps_window','unit','count','value',val,
    'day',(pg_temp.hour_start(back) at time zone 'UTC')::date,'start_at',pg_temp.iso(pg_temp.hour_start(back)),'end_at',pg_temp.iso(pg_temp.hour_start(back)+interval '1 hour'),'utc_offset_minutes',0) $$;
create function pg_temp.spo2(id text,rev bigint,val numeric,at_ts timestamptz default now()-interval '1 hour') returns jsonb language sql as $$
  select jsonb_build_object('sample_id',id,'revision',rev,'signal','spo2','unit','percent','value',val,'day',(at_ts at time zone 'UTC')::date,
    'start_at',pg_temp.iso(at_ts),'end_at',pg_temp.iso(at_ts),'utc_offset_minutes',0) $$;
create function pg_temp.batch(rid text,after_anchor text,samples jsonb,deletions jsonb default '[]',per_sample boolean default true) returns jsonb language sql as $$
  select jsonb_build_object('request_id',rid,'source','apple','consent_epoch',1,'timezone','UTC','anchor_before',null,'anchor_after',after_anchor,'samples',samples,'deletions',deletions)
    || case when per_sample then '{"rejection":"per_sample"}'::jsonb else '{}'::jsonb end $$;
create function pg_temp.stored(sid text) returns jsonb language sql as $$
  select s.payload from waldo.health_samples s join waldo.owners o on o.id=s.owner_id where o.do_name='per-sample-owner' and s.sample_id=sid $$;
create function pg_temp.n() returns int language sql as $$
  select count(*)::int from waldo.health_samples s join waldo.owners o on o.id=s.owner_id where o.do_name='per-sample-owner' and s.payload is not null $$;
create function pg_temp.anchor() returns text language sql as $$
  select a.anchor from waldo.health_anchors a join waldo.owners o on o.id=a.owner_id where o.do_name='per-sample-owner' $$;
create function pg_temp.rejected(sig text,rsn text,idx int,kind text default 'sample') returns jsonb language sql as $$
  select jsonb_build_object('change',kind,'index',idx,'signal',sig,'reason',rsn) $$;

insert into auth.users(id,email) values ('5a100000-0000-0000-0000-0000000000a1','per-sample@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('5a300000-0000-0000-0000-0000000000a3','5a100000-0000-0000-0000-0000000000a1','per-sample-owner','per-sample@example.invalid');
select pg_temp.h('consent_grant','per-sample-owner',pg_temp.grant_body('grant-ps-apple-s'));

-- A mixed batch: two good readings, the Worker's two rejections, one the database refuses (a point reading that ends in the
-- future), a string where a reading should be, and a malformed day; then a good deletion and the Worker's rejected one.
create temp table mixed as select pg_temp.batch('ps-mixed-000001','m1',jsonb_build_array(
  pg_temp.steps('ok-steps',3,1200),
  '{"rejected":"invalid_sample","signal":"steps_window"}'::jsonb,
  '{"rejected":"unsupported_signal","signal":null}'::jsonb,
  pg_temp.spo2('future-spo2',1,97,now()+interval '2 hours'),
  '"not a reading"'::jsonb,
  pg_temp.steps('bad-day',4,10)||'{"day":"garbage"}',
  pg_temp.spo2('ok-spo2',1,96)),
  jsonb_build_array(jsonb_build_object('sample_id','never-sent','signal','spo2','revision',5),'{"rejected":"unsupported_signal","signal":null}'::jsonb)) as body;
create temp table mixed_answer as select pg_temp.h('ingest','per-sample-owner',(select body from mixed)) as r;
select is((select r->>'accepted' from mixed_answer),'2','a mixed batch stores its good readings');
select is((select r->>'deleted' from mixed_answer),'1','and its good deletion');
select is((select r->'rejected' from mixed_answer),jsonb_build_array(
  pg_temp.rejected('steps_window','invalid_sample',1),pg_temp.rejected(null,'unsupported_signal',2),pg_temp.rejected('spo2','invalid_sample',3),
  pg_temp.rejected(null,'invalid_sample',4),pg_temp.rejected('steps_window','invalid_sample',5),pg_temp.rejected(null,'unsupported_signal',1,'deletion')),
  'and lists every bad change by position, kind and reason, the Worker''s and its own, in order');
select is(pg_temp.n(),2,'only the good readings are stored');
select ok(pg_temp.stored('future-spo2') is null and pg_temp.stored('bad-day') is null,'no rejected reading is stored');
select is(pg_temp.anchor(),'m1','the anchor advances: the receipt is the trace of what was not stored');
select ok((select r from mixed_answer)::text !~ '97|garbage|not a reading','the receipt carries no value of a rejected reading');
select is(pg_temp.h('ingest','per-sample-owner',(select body from mixed)),(select r||'{"replayed":true}' from mixed_answer),'a replay returns the same receipt and rejections');
select is((select response from waldo.health_requests r join waldo.owners o on o.id=r.owner_id where o.do_name='per-sample-owner' and r.request_id='ps-mixed-000001'),
  (select r from mixed_answer),'the stored receipt is the one answered');

-- Same reading, same revision, other content: only that change is rejected.
select is(pg_temp.h('ingest','per-sample-owner',pg_temp.batch('ps-conflict-001','c1',jsonb_build_array(pg_temp.spo2('ok-spo2',1,95),pg_temp.steps('ok-later',2,40))))
  - 'request_id' - 'anchor_after' - 'source' - 'consent_epoch',
  jsonb_build_object('accepted',1,'deleted',0,'ignored',0,'replayed',false,'rejected',jsonb_build_array(pg_temp.rejected('spo2','revision_conflict',0))),
  'a same-revision change with other content is a revision conflict for that reading only');
select is(pg_temp.stored('ok-spo2')->>'value','96','the stored reading keeps its content');

-- Duplicates and out-of-order revisions in one batch.
select is(pg_temp.h('ingest','per-sample-owner',pg_temp.batch('ps-dup-000001','d1',jsonb_build_array(pg_temp.steps('dup',5,10,100),pg_temp.steps('dup',5,10,100))))
  - 'request_id' - 'anchor_after' - 'source' - 'consent_epoch',
  jsonb_build_object('accepted',1,'deleted',0,'ignored',1,'replayed',false,'rejected','[]'::jsonb),'a reading sent twice in one batch is stored once');
select is(pg_temp.h('ingest','per-sample-owner',pg_temp.batch('ps-order-00001','o1',jsonb_build_array(pg_temp.steps('ord',6,9,300),pg_temp.steps('ord',6,8,200))))
  - 'request_id' - 'anchor_after' - 'source' - 'consent_epoch',
  jsonb_build_object('accepted',1,'deleted',0,'ignored',1,'replayed',false,'rejected','[]'::jsonb),'an older revision after a newer one is ignored');
select is(pg_temp.stored('ord')->>'value','9','the newest revision stays');

-- All bad, and empty.
select is(pg_temp.h('ingest','per-sample-owner',pg_temp.batch('ps-allbad-0001','a1',jsonb_build_array('{"rejected":"invalid_sample","signal":"spo2"}'::jsonb,pg_temp.steps('fut',-3,10)),
  jsonb_build_array(jsonb_build_object('sample_id','del-fut','signal','spo2','revision',extract(epoch from now())::bigint+3600))))->'rejected',
  jsonb_build_array(pg_temp.rejected('spo2','invalid_sample',0),pg_temp.rejected('steps_window','invalid_sample',1),pg_temp.rejected('spo2','invalid_sample',0,'deletion')),
  'an all-bad batch stores nothing and lists every change');
select is(pg_temp.anchor(),'a1','an all-bad batch still advances the anchor, with its receipt as the trace');
select is(pg_temp.h('ingest','per-sample-owner',pg_temp.batch('ps-empty-00001','e1','[]'))->'rejected','[]'::jsonb,'an empty batch has nothing to reject');

-- The request itself is still checked whole.
select is(pg_temp.h('ingest','per-sample-owner',pg_temp.batch('ps-epoch-00001','x','[]')||'{"consent_epoch":7}')->>'error','epoch_conflict','a batch at another epoch is refused whole');
select is(pg_temp.h('ingest','per-sample-owner',pg_temp.batch('ps-anchor-0001','x','[]')||'{"anchor_before":"stale"}')->>'error','anchor_conflict','a stale anchor is refused whole');
select is(pg_temp.h('ingest','per-sample-owner',pg_temp.batch('ps-mode-000001','x','[]')||'{"rejection":"all"}')->>'error','invalid_request','an unknown mode is refused');
select is(pg_temp.h('ingest','per-sample-owner',pg_temp.batch('ps-worker-0001','x',jsonb_build_array(pg_temp.steps('half',7,10),'{"rejected":"too_high","signal":"steps_window"}'::jsonb)))->>'error',
  'invalid_request','a Worker rejection with an unknown reason is a fault: the whole batch is refused');
select is(pg_temp.h('ingest','per-sample-owner',pg_temp.batch('ps-worker-0002','x',jsonb_build_array(pg_temp.steps('half',7,10),'{"rejected":"invalid_sample","signal":"steps_window","value":5}'::jsonb)))->>'error',
  'invalid_request','a Worker rejection that carries anything but its reason and kind is refused');
select is(pg_temp.h('ingest','per-sample-owner',pg_temp.batch('ps-worker-0003','x',jsonb_build_array(pg_temp.steps('half',7,10),'{"rejected":"invalid_sample","signal":"vo2_max"}'::jsonb)))->>'error',
  'invalid_request','a Worker rejection naming a signal this backend does not know is refused');
select is(pg_temp.h('ingest','per-sample-owner',pg_temp.batch('ps-worker-0004','x',jsonb_build_array(pg_temp.steps('half',7,10),'{"rejected":null,"signal":null}'::jsonb)))->>'error',
  'invalid_request','a Worker rejection without a reason is refused');
select is(pg_temp.stored('half'),null,'a refused batch stores nothing');

-- An older build: the same kind of batch without the mode is all-or-nothing, with the same answers as before.
select is(pg_temp.h('ingest','per-sample-owner',pg_temp.batch('ps-old-000001','old1',jsonb_build_array(pg_temp.steps('old-ok',8,10),pg_temp.spo2('old-fut',1,97,now()+interval '2 hours')),'[]',false))->>'error',
  'invalid_request','without the mode one bad reading refuses the whole batch');
select is(pg_temp.stored('old-ok'),null,'and its good reading is not stored');
select is(pg_temp.h('ingest','per-sample-owner',pg_temp.batch('ps-old-000002','old2',jsonb_build_array(pg_temp.steps('old-ok',8,10),pg_temp.spo2('ok-spo2',1,94)),'[]',false))->>'error',
  'sample_conflict','without the mode a same-revision conflict refuses the whole batch');
select is(pg_temp.h('ingest','per-sample-owner',pg_temp.batch('ps-old-000003','old3',jsonb_build_array(pg_temp.steps('old-ok',8,10)),'[]',false)) ? 'rejected',false,
  'an older build''s receipt never carries a rejection list');
select is(pg_temp.h('ingest','per-sample-owner',pg_temp.batch('ps-old-000003','old3',jsonb_build_array(pg_temp.steps('old-ok',8,10))))->>'error','idempotency_conflict',
  'the same request id in the other mode is another request');
select is(pg_temp.anchor(),'old3','an older build''s accepted batch advances the anchor as before');

select * from finish();
rollback;
