-- Dedicated synthetic health fixture only. Candidate tables/functions are loaded
-- first; all owner, connection, reading and credential fixtures roll back.
begin;
insert into auth.users(id,email) values
 ('a1000000-0000-0000-0000-000000000001','demand-a@example.invalid'),
 ('b1000000-0000-0000-0000-000000000001','demand-b@example.invalid');
insert into public.users(id,auth_id,name,email) values
 ('a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001','Synthetic A','demand-a@example.invalid'),
 ('b2000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001','Synthetic B','demand-b@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values
 ('a3000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001','demand-owner-a','demand-a@example.invalid'),
 ('b3000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001','demand-owner-b','demand-b@example.invalid');
insert into waldo.connections(id,owner_id,provider,account,scopes,secret_id) values
 ('a4000000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-000000000001','google','a@example.invalid',array['https://www.googleapis.com/auth/calendar.events.readonly','https://www.googleapis.com/auth/tasks.readonly','https://www.googleapis.com/auth/gmail.readonly'],vault.create_secret('synthetic-demand-google-a-only')),
 ('b4000000-0000-0000-0000-000000000001','b3000000-0000-0000-0000-000000000001','google','b@example.invalid',array['https://www.googleapis.com/auth/calendar.events.readonly','https://www.googleapis.com/auth/tasks.readonly','https://www.googleapis.com/auth/gmail.readonly'],vault.create_secret('synthetic-demand-google-b-only'));
select vault.create_secret('synthetic-demand-router-secret-only','waldo_router_hmac');
create function pg_temp.health_call(p_owner text,p_operation text,p_payload jsonb,p_demand boolean default true) returns jsonb language plpgsql as $$
declare v_body text:=p_payload::text; v_at bigint:=extract(epoch from now())::bigint; v_prefix text:=case when p_demand then 'healthdemand.' else 'healthplane.' end;
  v_sig text:=encode(extensions.hmac(v_at::text||'.'||v_prefix||p_owner||'.'||p_operation||'.'||md5(v_body),'synthetic-demand-router-secret-only','sha256'),'hex');
begin
  if p_demand then return waldo.health_demand(p_owner,p_operation,v_body,v_at,v_sig); end if;
  return waldo.health_plane(p_owner,p_operation,v_body,v_at,v_sig);
end $$;
do $$
declare
  r jsonb; body jsonb; rows jsonb; observed jsonb; query jsonb; grant_body jsonb;
  today text:=to_char(now() at time zone 'UTC','YYYY-MM-DD');
  checks integer:=0;
begin
  select jsonb_agg(jsonb_build_object('metric',metric,'unit',case when metric='message_count' then 'count' else 'minutes' end,
    'method',case metric when 'calendar_minutes' then 'union_busy_minutes' when 'task_minutes' then 'owner_estimated_due_minutes' else 'requires_owner_response_count' end,
    'supplier',case metric when 'calendar_minutes' then 'google_calendar' when 'task_minutes' then 'google_tasks' else 'responsibilities' end,
    'value',case when age=0 then 120 when age%2=0 then 60 else 180 end,
    'source_ref','actual-selected-accounts','context_ref','complete-local-day-UTC',
    'day',to_char((now()-interval '1 hour')::date-age,'YYYY-MM-DD'),'timezone','UTC',
    'observed_at',to_char((now()-interval '1 hour'-age*interval '1 day') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'queried_at',to_char((now()-interval '1 hour'-age*interval '1 day') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'revision',1,'query_complete',true,'evidence_ref','synthetic-complete-source-read','missing_reason',null,
    'connection_refs',jsonb_build_array('a4000000-0000-0000-0000-000000000001'))||case when metric='task_minutes' then '{"estimate_refs":["synthetic-owner-estimate"]}'::jsonb else '{}'::jsonb end order by age,metric) into rows
    from generate_series(0,14) age cross join unnest(array['calendar_minutes','task_minutes','message_count']) metric;
  body:=jsonb_build_object('request_id','demand-record-0001','source','apple','consent_epoch',1,'observations',rows);
  query:=jsonb_build_object('source','apple','consent_epoch',1,'metric','calendar_minutes','source_ref','actual-selected-accounts','context_ref','complete-local-day-UTC','from',to_char(today::date-30,'YYYY-MM-DD'),'to',today,'audience','owner');
  r:=pg_temp.health_call('demand-owner-a','record',body);
  assert r->>'error'='consent_required','demand cannot create health consent'; checks:=checks+1;
  grant_body:='{"request_id":"demand-storage-grant","source":"apple","purpose":"storage_compute","version":1,"expected_epoch":0,"age_attested_18_plus":true}';
  r:=pg_temp.health_call('demand-owner-a','grant',grant_body,false);
  assert r->'consent'->>'epoch'='1','actual source storage grant'; checks:=checks+1;
  observed:=rows->0;
  r:=pg_temp.health_call('demand-owner-a','record',body||jsonb_build_object('request_id','demand-incomplete-1','observations',jsonb_build_array(jsonb_set(observed,'{query_complete}','false'))));
  assert r->>'error'='invalid_request' and not exists(select 1 from waldo.health_workload_daily),'incomplete non-null query fails atomically'; checks:=checks+1;
  r:=pg_temp.health_call('demand-owner-a','record',body||jsonb_build_object('request_id','demand-cross-owner-1','observations',jsonb_build_array(jsonb_set(observed,'{connection_refs}','["b4000000-0000-0000-0000-000000000001"]'))));
  assert r->>'error'='epoch_conflict' and not exists(select 1 from waldo.health_workload_daily),'cross-owner actual connection rejected before persistence'; checks:=checks+1;
  r:=pg_temp.health_call('demand-owner-a','record',body);
  assert r->>'accepted'='45' and r->>'replayed'='false','all actual declared source baselines persist: '||coalesce(r->>'error','unknown'); checks:=checks+1;
  assert not r::text like '%120%' and not r::text like '%synthetic-complete%','durable admission receipt contains only counts'; checks:=checks+1;
  r:=pg_temp.health_call('demand-owner-a','record',body);
  assert r->>'replayed'='true' and (select count(*) from waldo.health_workload_daily)=45,'duplicate record replays without duplication'; checks:=checks+1;
  r:=pg_temp.health_call('demand-owner-a','record',jsonb_set(body,'{observations,0,value}','121'));
  assert r->>'error'='idempotency_conflict','changed request body cannot reuse operation'; checks:=checks+1;
  r:=pg_temp.health_call('demand-owner-a','read',query);
  assert jsonb_array_length(r->'observations')=15 and r->'observations'->14->>'value'='120','full current and prior daily source observations reach readback'; checks:=checks+1;
  r:=pg_temp.health_call('demand-owner-a','read',jsonb_set(query,'{audience}','"model"'));
  assert r->>'error'='consent_required','storage-only demand cannot reach model'; checks:=checks+1;
  perform pg_temp.health_call('demand-owner-a','grant','{"request_id":"demand-model-grant-1","source":"apple","purpose":"model_processing","version":1,"expected_epoch":0,"age_attested_18_plus":true}',false);
  r:=pg_temp.health_call('demand-owner-a','read',jsonb_set(query,'{audience}','"model"'));
  assert jsonb_array_length(r->'observations')=15,'separate model grant admits model-bound source read'; checks:=checks+1;
  observed:=jsonb_set(jsonb_set(rows->0,'{value}','0'),'{revision}','2');
  r:=pg_temp.health_call('demand-owner-a','record',body||jsonb_build_object('request_id','demand-zero-observed','observations',jsonb_build_array(observed)));
  assert r->>'accepted'='1','genuine complete-query zero is accepted'; checks:=checks+1;
  r:=pg_temp.health_call('demand-owner-a','read',query);
  assert (r->'observations'->14->>'value')::numeric=0,'zero remains zero in source readback'; checks:=checks+1;
  r:=pg_temp.health_call('demand-owner-a','record',body||jsonb_build_object('request_id','demand-stale-revision','observations',jsonb_build_array(rows->0)));
  assert r->>'ignored'='1','old snapshot cannot overwrite a newer daily observation'; checks:=checks+1;
  r:=pg_temp.health_call('demand-owner-a','record',body||jsonb_build_object('request_id','demand-equal-conflict','observations',jsonb_build_array(jsonb_set(observed,'{value}','100'))));
  assert r->>'error'='epoch_conflict','same revision changed source data fails closed'; checks:=checks+1;
  observed:=jsonb_set(jsonb_set(jsonb_set(jsonb_set(observed,'{value}','null'),'{revision}','3'),'{query_complete}','false'),'{missing_reason}','"incomplete_query"');
  r:=pg_temp.health_call('demand-owner-a','record',body||jsonb_build_object('request_id','demand-unknown-query','observations',jsonb_build_array(observed)));
  assert r->>'accepted'='1','explicit unknown supersedes old actual zero'; checks:=checks+1;
  r:=pg_temp.health_call('demand-owner-a','read',query);
  assert r->'observations'->14->'value'='null'::jsonb,'unknown never becomes fabricated zero'; checks:=checks+1;
  update waldo.connections set status='revoked' where id='a4000000-0000-0000-0000-000000000001';
  assert not exists(select 1 from waldo.health_workload_daily),'connection revocation purges all derived source observations'; checks:=checks+1;
  r:=pg_temp.health_call('demand-owner-a','record',body);
  assert r->>'error'='epoch_conflict' and not exists(select 1 from waldo.health_workload_daily),'old successful operation cannot resurrect after revoke'; checks:=checks+1;
  update waldo.connections set status='active' where id='a4000000-0000-0000-0000-000000000001';
  r:=pg_temp.health_call('demand-owner-a','record',body);
  assert r->>'error'='epoch_conflict','reactivation does not restore old request custody'; checks:=checks+1;
  r:=pg_temp.health_call('demand-owner-a','record',body||'{"request_id":"demand-fresh-after-revoke"}'::jsonb);
  assert r->>'accepted'='45','fresh current source read restores authorized dataset'; checks:=checks+1;
  update waldo.connections set scopes='{}' where id='a4000000-0000-0000-0000-000000000001';
  assert not exists(select 1 from waldo.health_workload_daily),'scope narrowing purges derived source observations'; checks:=checks+1;
  update waldo.connections set scopes=array['https://www.googleapis.com/auth/calendar.events.readonly','https://www.googleapis.com/auth/tasks.readonly','https://www.googleapis.com/auth/gmail.readonly'] where id='a4000000-0000-0000-0000-000000000001';
  perform pg_temp.health_call('demand-owner-a','record',body||'{"request_id":"demand-regrant-current"}'::jsonb);
  r:=pg_temp.health_call('demand-owner-a','withdraw','{"request_id":"demand-model-withdraw","source":"apple","purpose":"model_processing","expected_epoch":1}',false);
  assert r->>'deletion_routed'='true' and not exists(select 1 from waldo.health_workload_daily),'withdrawal purges numeric demand in same transaction'; checks:=checks+1;
  r:=pg_temp.health_call('demand-owner-a','record',body);
  assert r->>'error'='consent_withdrawn','late producer cannot repopulate after withdrawal'; checks:=checks+1;
  perform pg_temp.health_call('demand-owner-a','grant',grant_body||'{"request_id":"demand-storage-regrant","expected_epoch":2}'::jsonb,false);
  r:=pg_temp.health_call('demand-owner-a','record',body);
  assert r->>'error'='epoch_conflict','fresh consent epoch rejects queued old demand'; checks:=checks+1;
  assert not has_table_privilege('anon','waldo.health_workload_daily','select') and not has_table_privilege('authenticated','waldo.health_workload_daily','select'),'no raw workload bypass'; checks:=checks+1;
  assert not has_function_privilege('anon','waldo.health_workload_epoch_change()','execute') and not has_function_privilege('anon','waldo.health_workload_connection_change()','execute'),'internal purge triggers cannot be called directly'; checks:=checks+1;
  begin perform waldo.health_demand('demand-owner-a','read',query::text,extract(epoch from now())::bigint,'unsigned'); raise exception 'allowed unsigned'; exception when insufficient_privilege then checks:=checks+1; end;
  raise notice 'health demand: % synthetic SQL assertions PASS',checks;
end $$;
rollback;
