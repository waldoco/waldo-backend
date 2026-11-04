-- Derived rows record the instant their inputs were read, and a write from an older read is refused as stale. The producer
-- runs after every ingest and more than one can be in flight for an owner; without this an older run that finishes last would
-- replace a score computed from newer data. read_at is optional on the wire and null on rows written without it.
-- Signature, security definer, search_path and grants are unchanged.
alter table waldo.health_context_basis add column read_at timestamptz;

create or replace function waldo.health_context_write(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid; v_auth uuid; v_body jsonb; v_pillar text; v_p jsonb; v_day date; v_conf numeric; v_tz text; v_entry jsonb;
  v_scope waldo.health_scopes; v_consent waldo.health_consents; v_read_at timestamptz; v_held timestamptz;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.context_write.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id, o.auth_user_id into v_owner, v_auth from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active' for update of o;
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload) > 16384 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' or exists (select 1 from jsonb_object_keys(v_body) k where k not in ('day','timezone','basis','form','recovery','weight','drivers','confidence','freshness','tags','read_at')) then return '{"error":"invalid_request"}'; end if;
  if jsonb_typeof(v_body->'timezone') is distinct from 'string' or not exists (select 1 from pg_timezone_names where name = v_body->>'timezone') then return '{"error":"invalid_request"}'; end if;
  v_tz := v_body->>'timezone';
  if v_body ? 'read_at' then
    if jsonb_typeof(v_body->'read_at') is distinct from 'string' or (v_body->>'read_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$' then return '{"error":"invalid_request"}'; end if;
    v_read_at := (v_body->>'read_at')::timestamptz;
  end if;
  if jsonb_typeof(v_body->'day') is distinct from 'string' or (v_body->>'day') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return '{"error":"invalid_request"}'; end if;
  v_day := (v_body->>'day')::date;
  -- A row is for a day the owner can be in: at most tomorrow by their own clock, within the aggregate retention.
  if v_day > (now() at time zone v_tz)::date + 1 or v_day < (now() at time zone v_tz)::date - 731 then return '{"error":"invalid_request"}'; end if;
  if jsonb_typeof(v_body->'basis') is distinct from 'array' or jsonb_array_length(v_body->'basis') not between 1 and 3
    or exists (select 1 from jsonb_array_elements(v_body->'basis') b where jsonb_typeof(b) is distinct from 'object'
      or exists (select 1 from jsonb_object_keys(b) k where k not in ('source','consent_epoch'))
      or b->>'source' is null or b->>'source' not in ('apple','samsung','health_connect')
      or jsonb_typeof(b->'consent_epoch') is distinct from 'number' or b->>'consent_epoch' !~ '^[0-9]{1,9}$')
    or (select count(distinct b->>'source') from jsonb_array_elements(v_body->'basis') b) <> jsonb_array_length(v_body->'basis') then return '{"error":"invalid_request"}'; end if;
  foreach v_pillar in array array['form','recovery','weight'] loop
    -- Every pillar is present, either available or unavailable with its reason, so the app never has to guess one.
    v_p := v_body->v_pillar;
    if jsonb_typeof(v_p) is distinct from 'object' then return '{"error":"invalid_request"}'; end if;
    if v_p ? 'reason' then
      -- An unavailable pillar says why and carries nothing else.
      if (select count(*) from jsonb_object_keys(v_p)) <> 1 or v_p->>'reason' not in ('not_linked','consent_required','consent_withdrawn','no_readings','baseline_immature','missing_sleep',
        'missing_resting_signal','stale_inputs','conflicting_inputs','intraday_inputs_unavailable','calendar_demand_unavailable') then return '{"error":"invalid_request"}'; end if;
    elsif exists (select 1 from jsonb_object_keys(v_p) k where k not in ('score','zone','drivers','confidence','algorithm_version','activation','hrv_method'))
      or jsonb_typeof(v_p->'score') is distinct from 'number' or (v_p->>'score')::numeric not between 0 and 100
      or jsonb_typeof(v_p->'zone') is distinct from 'string' or (v_p->>'zone') not in ('low','moderate','good','high','unknown')
      or jsonb_typeof(v_p->'algorithm_version') is distinct from 'string' or (v_p->>'algorithm_version') !~ '^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*\.v[0-9]+$' or char_length(v_p->>'algorithm_version') > 64
      or jsonb_typeof(v_p->'activation') is distinct from 'string' or (v_p->>'activation') not in ('candidate_unaccepted','accepted')
      or (v_p ? 'hrv_method' and jsonb_typeof(v_p->'hrv_method') <> 'null' and (jsonb_typeof(v_p->'hrv_method') is distinct from 'string' or (v_p->>'hrv_method') not in ('rmssd','sdnn')))
      or (v_p ? 'confidence' and jsonb_typeof(v_p->'confidence') <> 'null' and (jsonb_typeof(v_p->'confidence') is distinct from 'number' or (v_p->>'confidence')::numeric not between 0 and 1))
      or (v_p ? 'drivers' and (jsonb_typeof(v_p->'drivers') is distinct from 'array' or jsonb_array_length(v_p->'drivers') > 8
        or exists (select 1 from jsonb_array_elements(v_p->'drivers') d where jsonb_typeof(d) <> 'string' or char_length(d #>> '{}') > 80))) then return '{"error":"invalid_request"}'; end if;
  end loop;
  if (v_body ? 'drivers' and (jsonb_typeof(v_body->'drivers') is distinct from 'array' or jsonb_array_length(v_body->'drivers') > 8 or exists (select 1 from jsonb_array_elements(v_body->'drivers') d where jsonb_typeof(d) <> 'string' or char_length(d #>> '{}') > 80)))
    or (v_body ? 'tags' and (jsonb_typeof(v_body->'tags') is distinct from 'array' or jsonb_array_length(v_body->'tags') > 10 or exists (select 1 from jsonb_array_elements(v_body->'tags') t where jsonb_typeof(t) <> 'string' or char_length(t #>> '{}') > 40)))
    or (v_body ? 'confidence' and v_body->'confidence' <> 'null'::jsonb and (jsonb_typeof(v_body->'confidence') is distinct from 'number' or (v_body->>'confidence')::numeric not between 0 and 1))
    or jsonb_typeof(v_body->'freshness') is distinct from 'string' or (v_body->>'freshness') not in ('fresh','stale','expired') then return '{"error":"invalid_request"}'; end if;
  for v_entry in select value from jsonb_array_elements(v_body->'basis') loop
    select * into v_scope from waldo.health_scopes where owner_id = v_owner and source = v_entry->>'source' and purpose = 'storage_compute';
    select * into v_consent from waldo.health_consents where id = v_scope.consent_id;
    if v_consent.id is null or v_consent.withdrawn_at is not null then return '{"error":"consent_required"}'; end if;
    if v_scope.epoch <> (v_entry->>'consent_epoch')::integer then return '{"error":"epoch_conflict"}'; end if;
  end loop;
  -- Writes for one owner are serialised by the owner row lock above, so this check cannot race. The instant is the one the
  -- series read reported, so a producer that read before a newer ingest committed cannot replace a score computed after it.
  if v_read_at is not null then
    select b.read_at into v_held from waldo.health_context_basis b where b.owner_id = v_owner and b.day = v_day;
    if v_held is not null and v_held > v_read_at then return '{"written":false,"stale":true}'; end if;
  end if;
  v_conf := case when jsonb_typeof(v_body->'confidence') = 'number' then (v_body->>'confidence')::numeric else null end;
  insert into public.health_context_daily(user_id, day, form, recovery, weight, drivers, confidence, freshness, tags)
    values (v_auth, v_day,
      v_body->'form', v_body->'recovery', v_body->'weight',
      coalesce(v_body->'drivers', '[]'::jsonb), v_conf, v_body->>'freshness',
      coalesce((select array_agg(t) from jsonb_array_elements_text(v_body->'tags') t), '{}'::text[]))
    on conflict (user_id, day) do update set form = excluded.form, recovery = excluded.recovery, weight = excluded.weight, drivers = excluded.drivers,
      confidence = excluded.confidence, freshness = excluded.freshness, tags = excluded.tags;
  insert into waldo.health_context_basis(owner_id, day, consent_basis, timezone, read_at) values (v_owner, v_day, v_body->'basis', v_tz, v_read_at)
    on conflict (owner_id, day) do update set consent_basis = excluded.consent_basis, timezone = excluded.timezone, read_at = excluded.read_at;
  return '{"written":true}'::jsonb;
exception
  when data_exception then return '{"error":"invalid_request"}';
end $$;
