-- Synthetic test only, on a new isolated database. Fixtures are rolled back.
begin;
insert into auth.users(id,email) values
  ('a1000000-0000-0000-0000-000000000001','health-a@example.invalid'),
  ('b1000000-0000-0000-0000-000000000001','health-b@example.invalid');
insert into public.users(id,auth_id,name,email) values
  ('a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001','Synthetic A','health-a@example.invalid'),
  ('b2000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001','Synthetic B','health-b@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values
  ('a3000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001','health-fixture-a','health-a@example.invalid'),
  ('b3000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001','health-fixture-b','health-b@example.invalid');
select vault.create_secret('synthetic-health-router-test-secret-only','waldo_router_hmac');
create function pg_temp.health_test_call(p_owner text,p_operation text,p_payload jsonb) returns jsonb language plpgsql as $$
declare v_body text:=p_payload::text; v_at bigint:=extract(epoch from now())::bigint;
begin
  return waldo.health_plane(p_owner,p_operation,v_body,v_at,
    encode(extensions.hmac(v_at::text||'.healthplane.'||p_owner||'.'||p_operation||'.'||md5(v_body),'synthetic-health-router-test-secret-only','sha256'),'hex'));
end $$;
do $$
declare
  r jsonb; grant_body jsonb; batch jsonb; sample jsonb; cursor_token text; first_page jsonb; second_page jsonb; native_origin jsonb; sleep_context jsonb;
  day_text text:=to_char(now() at time zone 'UTC','YYYY-MM-DD');
  observed text:=to_char((now()-interval '1 hour') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  old_day date:=(now()-interval '100 days')::date;
  checks integer:=0;
begin
  grant_body:=jsonb_build_object('request_id','grant-storage-0001','source','apple','purpose','storage_compute','version',1,'expected_epoch',0,'age_attested_18_plus',true);
  sample:=jsonb_build_object('sample_id','shared-sample','revision',1,'metric','sleep_duration','unit','minutes','value',420,'day',day_text,'start_at',observed,'end_at',observed);
  batch:=jsonb_build_object('request_id','ingest-first-0001','source','apple','consent_epoch',1,'timezone','UTC','anchor_before',null,'anchor_after','anchor-1','samples',jsonb_build_array(sample),'deletions','[]'::jsonb);
  r:=pg_temp.health_test_call('health-fixture-a','ingest',batch);
  assert r->>'error'='consent_required','ingest cannot create consent'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-a','grant',grant_body-'age_attested_18_plus');
  assert r->>'error'='invalid_request','missing age evidence rejected in DB'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-a','grant',grant_body-'version');
  assert r->>'error'='invalid_request','missing copy version rejected in DB'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-a','grant',grant_body);
  assert r->'consent'->>'epoch'='1' and r->'consent'->>'status'='granted','explicit grant mapped to owner'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-a','grant',grant_body);
  assert r->>'replayed'='true','grant replay stable'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-a','ingest',jsonb_set(batch,'{samples}',jsonb_build_array(sample-'unit')));
  assert r->>'error'='invalid_request','metric unit required in DB'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-a','ingest',batch);
  assert r->>'accepted'='1' and r->>'replayed'='false','real SQL ingests'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-a','ingest',batch);
  assert r->>'accepted'='1' and r->>'replayed'='true','ingest duplicate stable count-only receipt'; checks:=checks+1;
  assert (select count(*) from waldo.health_samples where owner_id='a3000000-0000-0000-0000-000000000001')=1,'duplicate creates one sample'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-a','ingest',jsonb_set(batch,'{samples}',jsonb_build_array(jsonb_set(sample,'{value}','430'))));
  assert r->>'error'='idempotency_conflict','changed upload body cannot replay'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-b','grant',grant_body);
  assert r->'consent'->>'epoch'='1','second owner independent consent'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-b','today','{"source":"apple"}');
  assert r='null'::jsonb,'second owner has no first-owner daily context'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-b','ingest',batch);
  assert r->>'accepted'='1','same sample and request ids isolated by owner'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-a','readings',jsonb_build_object('source','apple','from',day_text,'to',day_text,'consent_epoch',1,'audience','model'));
  assert r->>'error'='consent_required','storage grant does not authorize model processing'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-a','grant',jsonb_build_object('request_id','grant-model-00001','source','apple','purpose','model_processing','version',1,'expected_epoch',0,'age_attested_18_plus',true));
  assert r->'consent'->>'epoch'='1','separate model grant accepted'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-a','readings',jsonb_build_object('source','apple','from',day_text,'to',day_text,'consent_epoch',1,'audience','model'));
  assert r->>'count'='1','explicit model grant authorizes bounded source read'; checks:=checks+1;
  batch:=jsonb_set(jsonb_set(batch,'{request_id}','"ingest-wrong-anchor"'),'{anchor_before}','"wrong"');
  r:=pg_temp.health_test_call('health-fixture-a','ingest',batch);
  assert r->>'error'='anchor_conflict','unacknowledged anchor rejected'; checks:=checks+1;
  batch:=jsonb_set(jsonb_set(jsonb_set(batch,'{request_id}','"ingest-conflict-001"'),'{anchor_before}','"anchor-1"'),'{samples}',jsonb_build_array(jsonb_set(sample,'{value}','430')));
  r:=pg_temp.health_test_call('health-fixture-a','ingest',batch);
  assert r->>'error'='sample_conflict','same sample revision changed value rejected'; checks:=checks+1;
  batch:=jsonb_set(jsonb_set(jsonb_set(batch,'{request_id}','"ingest-delete-0001"'),'{samples}','[]'),'{deletions}','[{"sample_id":"shared-sample","metric":"sleep_duration","revision":2}]');
  batch:=jsonb_set(batch,'{anchor_after}','"anchor-2"');
  r:=pg_temp.health_test_call('health-fixture-a','ingest',batch);
  assert r->>'deleted'='1','sample deletion acknowledged'; checks:=checks+1;
  batch:=jsonb_set(jsonb_set(jsonb_set(batch,'{request_id}','"ingest-stale-00001"'),'{samples}',jsonb_build_array(sample)),'{deletions}','[]');
  batch:=jsonb_set(jsonb_set(batch,'{anchor_before}','"anchor-2"'),'{anchor_after}','"anchor-3"');
  r:=pg_temp.health_test_call('health-fixture-a','ingest',batch);
  assert r->>'ignored'='1','late revision cannot resurrect tombstoned sample'; checks:=checks+1;
  assert (select count(*) from waldo.health_samples where owner_id='a3000000-0000-0000-0000-000000000001' and payload is not null)=0,'tombstone retained without raw value'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-a','ingest',jsonb_build_object('request_id','ingest-empty-00001','source','apple','consent_epoch',1,'timezone','UTC','anchor_before','anchor-3','anchor_after','anchor-4','samples','[]'::jsonb,'deletions','[]'::jsonb));
  assert r->>'accepted'='0' and r->>'anchor_after'='anchor-4','empty OS query advances acknowledged anchor'; checks:=checks+1;
  native_origin:='{"read_api":"healthkit","source_bundle_id":"com.synthetic.external-sensor","source_package_name":null,"source_version":"1","source_revision":"native-rev-1","device_ref":"sha256:1111111111111111111111111111111111111111111111111111111111111111","recording_method":"automatic"}';
  sleep_context:=jsonb_build_object('source_ref','com.synthetic.external-sensor','session_ref','native-night-session','waking_day',day_text,'reducer_version','asleep-interval-union.v1','contributor_ids',jsonb_build_array('native-asleep-a','native-asleep-b','native-bed'),
    'intervals',jsonb_build_array(
      jsonb_build_object('contributor_id','native-asleep-a','start_at',to_char((observed::timestamptz-interval '420 minutes') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'end_at',to_char((observed::timestamptz-interval '180 minutes') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'kind','asleep'),
      jsonb_build_object('contributor_id','native-asleep-b','start_at',to_char((observed::timestamptz-interval '240 minutes') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'end_at',observed,'kind','asleep'),
      jsonb_build_object('contributor_id','native-bed','start_at',to_char((observed::timestamptz-interval '480 minutes') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'end_at',observed,'kind','in_bed')));
  batch:=jsonb_build_object('request_id','ingest-intraday-0001','source','apple','consent_epoch',1,'timezone','UTC','anchor_before','anchor-4','anchor_after','anchor-5','deletions','[]'::jsonb,
    'samples',jsonb_build_array(
      sample||'{"sample_id":"form-sleep","revision":0,"method":"asleep_duration"}'::jsonb||jsonb_build_object('origin',native_origin,'sleep_context',sleep_context),
      (sample-'value'-'metric'-'unit')||'{"sample_id":"form-hrv","metric":"overnight_hrv","unit":"milliseconds","method":"rmssd","value":50}'::jsonb||jsonb_build_object('origin',native_origin,'sleep_context',sleep_context,
        'start_at',to_char((observed::timestamptz-interval '250 minutes') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'end_at',to_char((observed::timestamptz-interval '170 minutes') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      (sample-'value'-'metric'-'unit')||'{"sample_id":"form-efficiency","metric":"sleep_efficiency","unit":"ratio","value":0.875}'::jsonb||jsonb_build_object('origin',native_origin,'sleep_context',sleep_context),
      (sample-'value'-'metric'-'unit')||'{"sample_id":"form-rhr","metric":"resting_heart_rate","method":"provider_resting_daily","unit":"beats_per_minute","value":60}'::jsonb||jsonb_build_object('origin',native_origin),
      (sample-'value'-'metric'-'unit')||'{"sample_id":"form-midpoint","metric":"sleep_midpoint","unit":"local_minute","method":"sleep_midpoint","value":240}'::jsonb,
      (sample-'value'-'metric'-'unit')||'{"sample_id":"form-daylight","metric":"daylight_duration","unit":"minutes","method":"daylight_duration","context_ref":"intraday-fixture","value":0}'::jsonb,
      (sample-'value'-'metric'-'unit')||'{"sample_id":"form-movement","metric":"movement_duration","unit":"minutes","method":"active_minutes","context_ref":"intraday-fixture","value":0}'::jsonb,
      (sample-'value'-'metric'-'unit')||'{"sample_id":"form-stress","metric":"perceived_stress","unit":"rating_0_10","method":"self_report_0_10","context_ref":"intraday-fixture","value":0}'::jsonb,
      (sample-'value'-'metric'-'unit')||'{"sample_id":"weight-physical","metric":"physical_load","unit":"source_units","method":"provider_load","context_ref":"intraday-fixture","value":100}'::jsonb));
  r:=pg_temp.health_test_call('health-fixture-a','ingest',jsonb_set(batch,'{samples,0,value}','480'));
  assert r->>'error'='invalid_request','overlapping sleep stages reduce to actual union rather than summed stages'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-a','ingest',jsonb_set(batch,'{samples,0,sleep_context,source_ref}','"com.other.sensor"'));
  assert r->>'error'='invalid_request','sleep evidence cannot substitute another native producer'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-a','ingest',jsonb_set(jsonb_set(batch,'{samples,1,start_at}',to_jsonb(to_char((observed::timestamptz+interval '5 minutes') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),'{samples,1,end_at}',to_jsonb(to_char((observed::timestamptz+interval '6 minutes') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))));
  assert r->>'error'='invalid_request','HRV outside observed sleep is rejected'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-a','ingest',jsonb_set(batch,'{samples,2,sleep_context,intervals}',(sleep_context->'intervals')-2));
  assert r->>'error'='invalid_request','efficiency cannot use an invented time-in-bed denominator'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-a','ingest',batch);
  assert r->>'accepted'='9','real SQL admits full Form/physical load and HRV crossing overlapping asleep stages'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-a','today','{"source":"apple"}');
  assert r->'aggregates'->0->'values'->>'perceived_stress'='0.00000000000000000000'
    or (r->'aggregates'->0->'values'->>'perceived_stress')::numeric=0,'observed zero is preserved'; checks:=checks+1;
  assert r->'aggregates'->0->'observations'->'physical_load'->>'method'='provider_load'
    and r->'aggregates'->0->'observations'->'daylight_duration'->>'context_ref'='intraday-fixture','actual Form/Weight methods and contexts survive aggregate serving'; checks:=checks+1;
  assert jsonb_array_length(r->'samples')=0,'daily summary supplier does not duplicate raw custody'; checks:=checks+1;
  assert r->'aggregates'->0->'observations'->'resting_heart_rate'->'origin'=native_origin
    and r->'aggregates'->0->'observations'->'resting_heart_rate'->>'method'='provider_resting_daily','native read API remains separate from actual producer and resting method'; checks:=checks+1;
  insert into waldo.health_samples(owner_id,source,metric,sample_id,revision,epoch,timezone,day,start_at,end_at,payload)
    select 'a3000000-0000-0000-0000-000000000001','apple','sleep_duration','dense-'||lpad(i::text,5,'0'),1,1,'UTC',day_text::date,observed::timestamptz,observed::timestamptz,
      sample||jsonb_build_object('sample_id','dense-'||lpad(i::text,5,'0')) from generate_series(1,4100) i;
  first_page:=pg_temp.health_test_call('health-fixture-a','readings',jsonb_build_object('source','apple','from',day_text,'to',day_text,'consent_epoch',1,'audience','owner'));
  assert first_page->>'count'='4096' and first_page->>'has_more'='true' and first_page->>'next_cursor' is not null,'dense raw day returns actionable continuation'; checks:=checks+1;
  cursor_token:=first_page->>'next_cursor';
  second_page:=pg_temp.health_test_call('health-fixture-a','readings',jsonb_build_object('source','apple','from',day_text,'to',day_text,'consent_epoch',1,'audience','owner','cursor',cursor_token));
  assert (first_page->>'count')::integer+(second_page->>'count')::integer=(select count(*) from waldo.health_samples where owner_id='a3000000-0000-0000-0000-000000000001' and payload is not null)
    and second_page->>'has_more'='false' and second_page->'next_cursor'='null'::jsonb,'continuation exhausts entire dense day with truthful terminal cursor'; checks:=checks+1;
  assert (select count(*)=count(distinct (x->>'metric',x->>'sample_id')) from jsonb_array_elements(first_page->'samples'||second_page->'samples') x),'export pages never duplicate samples'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-b','readings',jsonb_build_object('source','apple','from',day_text,'to',day_text,'consent_epoch',1,'audience','owner','cursor',cursor_token));
  assert r->>'error'='invalid_request','cursor cannot cross owner boundary'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-a','readings',jsonb_build_object('source','apple','from',day_text::date-1,'to',day_text,'consent_epoch',1,'audience','owner','cursor',cursor_token));
  assert r->>'error'='invalid_request','cursor cannot cross query range'; checks:=checks+1;
  delete from waldo.health_samples where owner_id='a3000000-0000-0000-0000-000000000001' and sample_id='dense-00001';
  r:=pg_temp.health_test_call('health-fixture-a','readings',jsonb_build_object('source','apple','from',day_text,'to',day_text,'consent_epoch',1,'audience','owner','cursor',cursor_token));
  assert r->>'error'='anchor_conflict','changed data revision requires export restart instead of missing a mutation'; checks:=checks+1;
  assert not has_function_privilege('anon','waldo.health_sample_revision_change()','execute'),'value-free revision trigger has no public bypass'; checks:=checks+1;

  insert into waldo.health_daily_aggregates(owner_id,source,day,epoch,timezone,metrics,compiled_at)
    select 'a3000000-0000-0000-0000-000000000001','apple',day_text::date-age,1,'UTC',
      jsonb_build_object('sleep_duration',jsonb_build_object('mean',480,'count',1,'distinct_values',1,'methods',jsonb_build_array('asleep_duration'),'contexts',jsonb_build_array('overnight_daily'),'observed_at',to_char((day_text::date-age)::timestamp at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'revision',0)),
      (day_text::date-age)::timestamp at time zone 'UTC'
    from generate_series(1,43) age;
  r:=pg_temp.health_test_call('health-fixture-a','today','{"source":"apple"}');
  assert jsonb_array_length(r->'aggregates')=44,'full separated sleep-debt reference window reaches producer'; checks:=checks+1;
  insert into waldo.health_daily_aggregates(owner_id,source,day,epoch,timezone,metrics,compiled_at)
    values('a3000000-0000-0000-0000-000000000001','apple',old_day,1,'UTC','{"sleep_duration":{"mean":420,"count":1,"distinct_values":1,"methods":[null]},"overnight_hrv":{"mean":50,"count":1,"distinct_values":1,"methods":["rmssd"]}}',now()-interval '100 days');
  r:=pg_temp.health_test_call('health-fixture-a','history',jsonb_build_object('source','apple','from',old_day,'to',old_day,'consent_epoch',1));
  assert jsonb_array_length(r->'days'->0->'samples')=0 and jsonb_array_length(r->'days'->0->'aggregates'->0->'metrics')=2,'retained aggregate coverage survives raw expiry'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-a','withdraw','{"request_id":"withdraw-model-001","source":"apple","purpose":"model_processing","expected_epoch":1}');
  assert r->'consent'->>'status'='withdrawn' and r->'consent'->>'epoch'='2' and r->>'deletion_routed'='true','withdrawal changes epoch and routes deletion'; checks:=checks+1;
  assert (select count(*) from waldo.health_samples where owner_id='a3000000-0000-0000-0000-000000000001')=0 and (select count(*) from waldo.health_daily_aggregates where owner_id='a3000000-0000-0000-0000-000000000001')=0,'withdrawal removes raw and aggregate values'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-a','ingest',batch);
  assert r->>'error'='consent_withdrawn','late upload cannot repopulate withdrawal'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-a','grant',grant_body);
  assert r->>'error'='consent_withdrawn','old grant replay cannot restore withdrawn authority'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-b','today','{"source":"apple"}');
  assert r->>'source'='apple','first owner withdrawal preserves second-owner data'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-a','grant',jsonb_set(jsonb_set(grant_body,'{request_id}','"grant-restart-0001"'),'{expected_epoch}','2'));
  assert r->'consent'->>'epoch'='3','regrant appends a new epoch'; checks:=checks+1;
  r:=pg_temp.health_test_call('health-fixture-a','ingest',batch);
  assert r->>'error'='epoch_conflict','old upload fenced after fresh regrant'; checks:=checks+1;
  assert (select count(*) from public.user_consents where user_id='a2000000-0000-0000-0000-000000000001' and purpose='storage_compute')=2,'consent grant history append-only'; checks:=checks+1;
  assert not has_table_privilege('authenticated','waldo.health_samples','select') and not has_table_privilege('anon','waldo.health_samples','select'),'no direct raw bypass reads'; checks:=checks+1;
  assert not has_function_privilege('anon','waldo.health_consent_view(waldo.health_scopes)','execute'),'internal health helper inaccessible'; checks:=checks+1;
  begin
    perform waldo.health_plane('health-fixture-a','consents','{}',extract(epoch from now())::bigint,'unsigned');
    raise exception 'unsigned call was allowed';
  exception when insufficient_privilege then checks:=checks+1;
  end;
  raise notice 'health-production synthetic SQL assertions passed: %',checks;
end $$;
rollback;
