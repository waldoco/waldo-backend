begin;
create extension if not exists pgtap with schema extensions;
select plan(8);
delete from vault.secrets where name='waldo_router_hmac';
select vault.create_secret('fixture-router','waldo_router_hmac');

create function pg_temp.sig(msg text,at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text||'.'||msg,'fixture-router','sha256'),'hex') $$;
create function pg_temp.h(op text,owner text,body jsonb default '{}') returns jsonb language plpgsql as $$
declare t text:=body::text; a bigint:=extract(epoch from now())::bigint; r jsonb;
begin
  execute format('select waldo.%I($1,$2,$3,$4)','health_'||op) into r using owner,t,a,pg_temp.sig('health.'||op||'.'||owner||'.'||md5(t),a);
  return r;
end $$;
create function pg_temp.iso(t timestamptz) returns text language sql as $$ select to_char(t at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') $$;

insert into auth.users(id,email) values ('e1000000-0000-0000-0000-0000000000e1','backfill@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values ('e3000000-0000-0000-0000-0000000000e3','e1000000-0000-0000-0000-0000000000e1','backfill-owner','backfill@example.invalid');
select pg_temp.h('consent_grant','backfill-owner',jsonb_build_object('request_id','backfill-grant-1','source','apple','purpose','storage_compute','version',2,'expected_epoch',0,'age_attested_18_plus',true));

-- A first install uploads the last 30 days, oldest first, in chunks of seven days; each chunk goes up as requests of at
-- most 128 readings with chained anchors. A day holds what an iPhone sends for it: the overnight signals and 24 hourly
-- windows of heart rate, HRV, daylight and movement.
create temp table bf(n serial, day int, s jsonb);
do $$
declare i int; h int; d date; base timestamptz;
begin
  for i in reverse 30..1 loop
    d := (now() at time zone 'UTC')::date - i;
    insert into bf(day,s) values
     (i,jsonb_build_object('sample_id','sleep-'||d,'revision',1,'signal','sleep_duration','unit','minutes','method','asleep_duration','value',450,'day',d,'start_at',pg_temp.iso((d-1)::timestamptz+interval '23 hours'),'end_at',pg_temp.iso(d::timestamptz+interval '7 hours'),'utc_offset_minutes',0)),
     (i,jsonb_build_object('sample_id','mid-'||d,'revision',1,'signal','sleep_midpoint','unit','local_minute','method','sleep_midpoint','value',180,'day',d,'start_at',pg_temp.iso((d-1)::timestamptz+interval '23 hours'),'end_at',pg_temp.iso(d::timestamptz+interval '7 hours'),'utc_offset_minutes',0)),
     (i,jsonb_build_object('sample_id','hrv-'||d,'revision',1,'signal','overnight_hrv','unit','milliseconds','method','rmssd','value',55,'day',d,'start_at',pg_temp.iso((d-1)::timestamptz+interval '23 hours'),'end_at',pg_temp.iso(d::timestamptz+interval '7 hours'),'utc_offset_minutes',0)),
     (i,jsonb_build_object('sample_id','rhr-'||d,'revision',1,'signal','resting_heart_rate','unit','beats_per_minute','value',56,'day',d,'start_at',pg_temp.iso(d::timestamptz+interval '3 hours'),'end_at',pg_temp.iso(d::timestamptz+interval '4 hours'),'utc_offset_minutes',0));
    for h in 0..23 loop
      base := d::timestamptz + make_interval(hours=>h);
      insert into bf(day,s) values
       (i,jsonb_build_object('sample_id','hr-'||d||'-'||h,'revision',1,'signal','heart_rate_window','unit','beats_per_minute','value',70,'min',60,'max',90,'n_samples',20,'day',d,'start_at',pg_temp.iso(base),'end_at',pg_temp.iso(base+interval '1 hour'),'utc_offset_minutes',0)),
       (i,jsonb_build_object('sample_id','hv-'||d||'-'||h,'revision',1,'signal','hrv_window','unit','milliseconds','method','rmssd','value',50,'day',d,'start_at',pg_temp.iso(base),'end_at',pg_temp.iso(base+interval '1 hour'),'utc_offset_minutes',0)),
       (i,jsonb_build_object('sample_id','dl-'||d||'-'||h,'revision',1,'signal','daylight_duration','unit','minutes','value',20,'day',d,'start_at',pg_temp.iso(base),'end_at',pg_temp.iso(base+interval '1 hour'),'utc_offset_minutes',0)),
       (i,jsonb_build_object('sample_id','mv-'||d||'-'||h,'revision',1,'signal','movement_duration','unit','minutes','value',12,'day',d,'start_at',pg_temp.iso(base),'end_at',pg_temp.iso(base+interval '1 hour'),'utc_offset_minutes',0));
    end loop;
  end loop;
end $$;
create temp table bf_result(accepted int, ignored int, refused int);
do $$
declare b int; prev text := null; total int; r jsonb;
begin
  select count(*) into total from bf;
  insert into bf_result values (0,0,0);
  for b in 0..(total-1)/128 loop
    r := pg_temp.h('ingest','backfill-owner',jsonb_build_object('request_id','backfill-batch-'||lpad(b::text,4,'0'),'source','apple','consent_epoch',1,'timezone','UTC','anchor_before',prev,'anchor_after','backfill-anchor-'||b,'samples',
      (select jsonb_agg(s order by n) from bf where n > b*128 and n <= (b+1)*128),'deletions','[]'::jsonb));
    if r ? 'error' then update bf_result set refused = refused + 1; else update bf_result set accepted = accepted + (r->>'accepted')::int, ignored = ignored + (r->>'ignored')::int; end if;
    prev := 'backfill-anchor-'||b;
  end loop;
end $$;

select is((select refused from bf_result), 0, 'every request of a 30-day backfill is accepted, oldest first, with chained anchors');
select is((select accepted from bf_result), 3000, 'all 3000 readings (30 days of 100) are stored');
select is((select ignored from bf_result), 0, 'none of the 30 days falls outside the retention window');
select is(pg_temp.h('series_read','backfill-owner',jsonb_build_object('from',(now() at time zone 'UTC')::date-30,'to',(now() at time zone 'UTC')::date,
  'signals','["sleep_duration","sleep_midpoint","overnight_hrv","resting_heart_rate","heart_rate_window","hrv_window","daylight_duration","movement_duration","workout"]'::jsonb))#>>'{sources,0,truncated}','false','the producer''s nine-signal read of those 30 days is not truncated by the 8000 cap');
select is(jsonb_array_length(pg_temp.h('series_read','backfill-owner',jsonb_build_object('from',(now() at time zone 'UTC')::date-30,'to',(now() at time zone 'UTC')::date))#>'{sources,0,samples}'),3000,'and returns every stored reading');
select is(pg_temp.h('ingest','backfill-owner',jsonb_build_object('request_id','backfill-old-0001','source','apple','consent_epoch',1,'timezone','UTC','anchor_before','backfill-anchor-'||((select count(*) from bf)-1)/128,'anchor_after','backfill-anchor-old','samples',
  jsonb_build_array(jsonb_build_object('sample_id','too-old','revision',1,'signal','resting_heart_rate','unit','beats_per_minute','value',56,'day',(now() at time zone 'UTC')::date-100,
    'start_at',pg_temp.iso(((now() at time zone 'UTC')::date-100)::timestamptz+interval '3 hours'),'end_at',pg_temp.iso(((now() at time zone 'UTC')::date-100)::timestamptz+interval '4 hours'),'utc_offset_minutes',0)),'deletions','[]'::jsonb))->>'ignored','1','a reading older than the 90-day window is ignored, not stored');
select is((select count(*)::int from waldo.health_samples s join waldo.owners o on o.id=s.owner_id where o.do_name='backfill-owner' and s.sample_id='too-old'),0,'and nothing is stored for it');
select is(pg_temp.h('series_read','backfill-owner',jsonb_build_object('from',(now() at time zone 'UTC')::date-30,'to',(now() at time zone 'UTC')::date))->>'access','granted','the owner''s consent is still live after the backfill');

select * from finish();
rollback;
