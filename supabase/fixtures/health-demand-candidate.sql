-- Candidate promotion companion to health-production-candidate.sql. Synthetic
-- tests only until the exact migration is reviewed and release-coordinated.
create table if not exists waldo.health_workload_daily (
  owner_id uuid not null references waldo.owners(id) on delete cascade,
  source text not null,
  epoch integer not null check(epoch>0),
  metric text not null check(metric in ('calendar_minutes','task_minutes','message_count')),
  source_ref text not null, context_ref text not null, day date not null,
  revision bigint not null check(revision>=0), payload jsonb not null,
  primary key(owner_id,source,metric,source_ref,context_ref,day)
);
alter table waldo.health_workload_daily enable row level security;
alter table waldo.health_workload_daily force row level security;
revoke all on waldo.health_workload_daily from public,anon,authenticated,service_role;

create or replace function waldo.health_workload_epoch_change() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if old.purpose='storage_compute' and old.epoch<>new.epoch then
    delete from waldo.health_workload_daily where owner_id=old.owner_id and source=old.source;
  end if;
  return new;
end $$;
revoke all on function waldo.health_workload_epoch_change() from public,anon,authenticated,service_role;
drop trigger if exists health_workload_epoch_change on waldo.health_scopes;
create trigger health_workload_epoch_change after update on waldo.health_scopes for each row execute function waldo.health_workload_epoch_change();

create or replace function waldo.health_workload_connection_change() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' or old.status is distinct from new.status or old.scopes is distinct from new.scopes or old.account is distinct from new.account or old.provider is distinct from new.provider or old.owner_id is distinct from new.owner_id then
    delete from waldo.health_workload_daily where owner_id=old.owner_id and payload->'connection_refs' @> jsonb_build_array(old.id::text);
  end if;
  return null;
end $$;
revoke all on function waldo.health_workload_connection_change() from public,anon,authenticated,service_role;
drop trigger if exists health_workload_connection_change on waldo.connections;
create trigger health_workload_connection_change after update of status,scopes,account,provider,owner_id or delete on waldo.connections for each row execute function waldo.health_workload_connection_change();

create or replace function waldo.health_demand(p_do_name text,p_operation text,p_payload text,p_at bigint,p_sig text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_owner uuid; v_auth uuid; v_user uuid; v_payload jsonb; v_source text; v_epoch integer;
  v_scope waldo.health_scopes; v_consent public.user_consents; v_previous waldo.health_requests;
  v_row jsonb; v_prior waldo.health_workload_daily; v_connection text; v_metric text; v_supplier text;
  v_id text; v_day date; v_from date; v_to date; v_observed timestamptz; v_queried timestamptz;
  v_revision bigint; v_value numeric; v_accepted integer:=0; v_ignored integer:=0; v_deleted integer:=0;
  v_result jsonb; v_replay boolean:=false;
begin
  if waldo.router_signed('healthdemand.'||p_do_name||'.'||p_operation||'.'||md5(p_payload),p_at,p_sig) is distinct from true then raise exception 'unsigned call' using errcode='42501'; end if;
  select id,auth_user_id into v_owner,v_auth from waldo.owners where do_name=p_do_name and state='active' for update;
  select id into v_user from public.users where auth_id=v_auth;
  if v_owner is null or v_user is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload)>98304 then return '{"error":"invalid_request"}'; end if;
  begin v_payload:=p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_payload)<>'object' then return '{"error":"invalid_request"}'; end if;
  if p_operation='retention' then
    delete from waldo.health_workload_daily where owner_id=v_owner and day<(now()-interval '24 months')::date;
    get diagnostics v_deleted=row_count;
    return jsonb_build_object('deleted',v_deleted);
  end if;
  v_source:=v_payload->>'source';
  if v_source is null or v_source not in ('apple','oura','whoop','samsung','garmin','manual') then return '{"error":"invalid_request"}'; end if;
  select * into v_scope from waldo.health_scopes where owner_id=v_owner and source=v_source and purpose='storage_compute';
  select * into v_consent from public.user_consents where id=v_scope.consent_id;
  if v_consent.status is distinct from 'granted' or v_consent.version is distinct from 1 or v_consent.age_attested_18_plus is distinct from true then
    return jsonb_build_object('error',case when v_consent.status='withdrawn' then 'consent_withdrawn' else 'consent_required' end);
  end if;
  v_epoch:=v_scope.epoch;
  if v_payload->>'consent_epoch' is null or v_payload->>'consent_epoch'!~'^[0-9]+$' then return '{"error":"invalid_request"}'; end if;
  if (v_payload->>'consent_epoch')::integer<>v_epoch then return '{"error":"epoch_conflict"}'; end if;
  if p_operation='record' then
    v_id:=v_payload->>'request_id';
    if v_id is null or v_id!~'^[A-Za-z0-9_-]{8,96}$' or jsonb_typeof(v_payload->'observations') is distinct from 'array' or jsonb_array_length(v_payload->'observations') not between 1 and 90 then return '{"error":"invalid_request"}'; end if;
    select * into v_previous from waldo.health_requests where owner_id=v_owner and request_id=v_id;
    if found then
      if v_previous.operation<>'demand_record' or v_previous.payload_digest<>md5(p_payload) then return '{"error":"idempotency_conflict"}'; end if;
      v_replay:=true;
    end if;
    if (select count(*)<>count(distinct (row->>'metric',row->>'source_ref',row->>'context_ref',row->>'day')) from jsonb_array_elements(v_payload->'observations') row) then return '{"error":"invalid_request"}'; end if;
    for v_row in select value from jsonb_array_elements(v_payload->'observations') loop
      v_metric:=v_row->>'metric'; v_supplier:=v_row->>'supplier';
      if v_metric is null or v_metric not in ('calendar_minutes','task_minutes','message_count')
        or v_row->>'source_ref' is null or v_row->>'source_ref'!~'^[A-Za-z0-9._:-]{1,128}$'
        or v_row->>'context_ref' is null or v_row->>'context_ref'!~'^[A-Za-z0-9._:-]{1,128}$'
        or v_row->>'evidence_ref' is null or v_row->>'evidence_ref'!~'^[A-Za-z0-9._:-]{1,128}$'
        or v_row->>'revision' is null or v_row->>'revision'!~'^[0-9]+$'
        or v_row->>'query_complete' is null or v_row->>'query_complete' not in ('true','false')
        or jsonb_typeof(v_row->'connection_refs') is distinct from 'array' or jsonb_array_length(v_row->'connection_refs')>32
        or v_row->>'timezone' is null or not exists(select 1 from pg_timezone_names where name=v_row->>'timezone') then raise exception 'invalid demand' using errcode='22023'; end if;
      v_day:=(v_row->>'day')::date; v_observed:=(v_row->>'observed_at')::timestamptz; v_queried:=(v_row->>'queried_at')::timestamptz; v_revision:=(v_row->>'revision')::bigint;
      if v_day is null or v_observed is null or v_queried is null or v_observed>v_queried or v_queried>now()+interval '5 minutes' or (v_observed at time zone (v_row->>'timezone'))::date<>v_day or v_day<(now()-interval '24 months')::date then raise exception 'invalid demand time' using errcode='22023'; end if;
      v_value:=(v_row->>'value')::numeric;
      if v_value is null then
        if v_row->>'missing_reason' is null or v_row->>'missing_reason' not in ('source_unavailable','incomplete_query','missing_owner_estimates','unknown_responsibility_state') then raise exception 'missing evidence' using errcode='22023'; end if;
      elsif v_row->>'query_complete'<>'true' or v_row->>'missing_reason' is not null or v_value<0 then raise exception 'incomplete evidence' using errcode='22023'; end if;
      if (v_metric='calendar_minutes' and (v_supplier is distinct from 'google_calendar' or v_row->>'unit' is distinct from 'minutes' or v_row->>'method' is distinct from 'union_busy_minutes' or v_value>2880))
        or (v_metric='task_minutes' and (v_supplier is null or v_supplier not in ('google_tasks','owner_work') or v_row->>'unit' is distinct from 'minutes' or v_row->>'method' is distinct from 'owner_estimated_due_minutes' or v_value>10080 or jsonb_typeof(v_row->'estimate_refs') is distinct from 'array' or jsonb_array_length(v_row->'estimate_refs')>128 or (v_value>0 and jsonb_array_length(v_row->'estimate_refs')=0)))
        or (v_metric='message_count' and (v_supplier is distinct from 'responsibilities' or v_row->>'unit' is distinct from 'count' or v_row->>'method' is distinct from 'requires_owner_response_count' or v_value>100000 or v_value<>trunc(v_value))) then raise exception 'invalid demand metric' using errcode='22023'; end if;
      if v_supplier in ('google_calendar','google_tasks') and jsonb_array_length(v_row->'connection_refs')=0 then raise exception 'missing source scope' using errcode='22023'; end if;
      for v_connection in select jsonb_array_elements_text(v_row->'connection_refs') loop
        -- Hold each observed account until commit. A concurrent revoke/scope
        -- change then deletes this snapshot after the insert, never before it.
        perform 1 from waldo.connections c where c.id=v_connection::uuid and c.owner_id=v_owner and c.status='active' and c.provider='google'
          and (v_supplier='owner_work' or (v_metric='calendar_minutes' and c.scopes && array['https://www.googleapis.com/auth/calendar','https://www.googleapis.com/auth/calendar.readonly','https://www.googleapis.com/auth/calendar.events','https://www.googleapis.com/auth/calendar.events.readonly'])
            or (v_metric='task_minutes' and c.scopes && array['https://www.googleapis.com/auth/tasks','https://www.googleapis.com/auth/tasks.readonly'])
            or (v_metric='message_count' and c.scopes && array['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.modify','https://www.googleapis.com/auth/gmail.metadata'])) for share;
        if not found then raise exception 'source changed' using errcode='40001'; end if;
      end loop;
      if v_replay then
        if not exists(select 1 from waldo.health_workload_daily where owner_id=v_owner and source=v_source and epoch=v_epoch and metric=v_metric and source_ref=v_row->>'source_ref' and context_ref=v_row->>'context_ref' and day=v_day) then raise exception 'source changed' using errcode='40001'; end if;
        continue;
      end if;
      select * into v_prior from waldo.health_workload_daily where owner_id=v_owner and source=v_source and metric=v_metric and source_ref=v_row->>'source_ref' and context_ref=v_row->>'context_ref' and day=v_day;
      if found and v_prior.revision>=v_revision then
        if v_prior.revision=v_revision and v_prior.payload<>v_row then raise exception 'demand conflict' using errcode='40001'; end if;
        v_ignored:=v_ignored+1; continue;
      end if;
      insert into waldo.health_workload_daily(owner_id,source,epoch,metric,source_ref,context_ref,day,revision,payload)
        values(v_owner,v_source,v_epoch,v_metric,v_row->>'source_ref',v_row->>'context_ref',v_day,v_revision,v_row)
        on conflict(owner_id,source,metric,source_ref,context_ref,day) do update set epoch=excluded.epoch,revision=excluded.revision,payload=excluded.payload;
      v_accepted:=v_accepted+1;
    end loop;
    if v_replay then return jsonb_set(v_previous.response,'{replayed}','true'); end if;
    v_result:=jsonb_build_object('request_id',v_id,'source',v_source,'consent_epoch',v_epoch,'accepted',v_accepted,'ignored',v_ignored,'replayed',false);
    insert into waldo.health_requests(owner_id,request_id,operation,payload_digest,response) values(v_owner,v_id,'demand_record',md5(p_payload),v_result);
    return v_result;
  elsif p_operation='read' then
    if v_payload->>'audience' is null or v_payload->>'audience' not in ('owner','model') then return '{"error":"invalid_request"}'; end if;
    if v_payload->>'audience'='model' and not exists(select 1 from waldo.health_scopes s join public.user_consents c on c.id=s.consent_id where s.owner_id=v_owner and s.source=v_source and s.purpose='model_processing' and c.status='granted' and c.version=1 and c.age_attested_18_plus) then return '{"error":"consent_required"}'; end if;
    v_from:=(v_payload->>'from')::date; v_to:=(v_payload->>'to')::date;
    if v_from is null or v_to is null or v_from>v_to or v_to-v_from>89 or v_payload->>'metric' is null or v_payload->>'metric' not in ('calendar_minutes','task_minutes','message_count') or v_payload->>'source_ref' is null or v_payload->>'context_ref' is null then return '{"error":"invalid_request"}'; end if;
    select jsonb_build_object('source',v_source,'consent_epoch',v_epoch,'observations',coalesce(jsonb_agg(payload order by day),'[]'::jsonb)) into v_result
      from waldo.health_workload_daily where owner_id=v_owner and source=v_source and epoch=v_epoch and metric=v_payload->>'metric' and source_ref=v_payload->>'source_ref' and context_ref=v_payload->>'context_ref' and day between v_from and v_to and day>=(now()-interval '24 months')::date;
    return v_result;
  end if;
  return '{"error":"invalid_request"}';
exception
  when invalid_text_representation or datetime_field_overflow or invalid_parameter_value or numeric_value_out_of_range then return '{"error":"invalid_request"}';
  when serialization_failure then return '{"error":"epoch_conflict"}';
end $$;
revoke all on function waldo.health_demand(text,text,text,bigint,text) from public,anon,authenticated,service_role;
grant execute on function waldo.health_demand(text,text,text,bigint,text) to anon;
