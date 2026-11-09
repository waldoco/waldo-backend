-- The candidate training load (ADR-0081 amendment of 31 October 2026, section 2): a closed, digit-free phrase on the derived row.
-- - public.health_context_daily gains training_load (jsonb), nullable: a row written without it holds nothing, and a later
--   write without it clears it. It is in the zone, named drivers and trend class; no load figure is stored.
-- - waldo.health_context_write is re-created whole from its last definition (20261027170000) and admits training_load as
--   exactly {state: available, phrase, method, algorithm_version training-load.candidate.v1, activation candidate_unaccepted}
--   or {state: unavailable, reason no_readings | baseline_immature}, with the closed phrase and method lists, and never on a
--   backfilled row. Anything else is invalid_request, so no value can ride it.
-- - waldo.health_context_read is re-created whole from the same definition and returns it with the newest row, for the model's
--   health context. waldo.health_scores_read does not return it, so the app's scores response is unchanged.
-- Signatures, security definer, search_path and grants are unchanged. Apply this before the Worker writes training load.

alter table public.health_context_daily add column training_load jsonb;

create or replace function waldo.health_context_write(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid; v_auth uuid; v_body jsonb; v_pillar text; v_p jsonb; v_day date; v_conf numeric; v_tz text; v_entry jsonb;
  v_scope waldo.health_scopes; v_consent waldo.health_consents; v_read_at timestamptz; v_held timestamptz;
  v_old public.health_context_daily; v_old_basis jsonb; v_changed jsonb := '[]'::jsonb;
  -- The closed driver vocabulary: a signal's plain-word subject, an optional 'far', a direction, 'usual'. Nothing else, so no
  -- value, abbreviation or judgment can ride a driver into the prompt or the app.
  v_driver constant text := '^(breathing rate|wrist temperature|blood oxygen|awake time in the night|walking heart rate)( far)? (above|below) usual$';
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.context_write.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id, o.auth_user_id into v_owner, v_auth from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active' for update of o;
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload) > 16384 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' or exists (select 1 from jsonb_object_keys(v_body) k where k not in ('day','timezone','basis','form','recovery','weight','drivers','confidence','freshness','tags','read_at','sleep_debt','windows','windows_version','backfilled','training_load')) then return '{"error":"invalid_request"}'; end if;
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
      or b->>'source' is null or b->>'source' not in ('apple','samsung','health_connect','whoop')
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
    elsif exists (select 1 from jsonb_object_keys(v_p) k where k not in ('score','zone','drivers','confidence','algorithm_version','activation','hrv_method','baseline','used'))
      or jsonb_typeof(v_p->'score') is distinct from 'number' or (v_p->>'score')::numeric not between 0 and 100
      or jsonb_typeof(v_p->'zone') is distinct from 'string' or (v_p->>'zone') not in ('low','moderate','good','high','unknown')
      or jsonb_typeof(v_p->'algorithm_version') is distinct from 'string' or (v_p->>'algorithm_version') !~ '^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*\.v[0-9]+$' or char_length(v_p->>'algorithm_version') > 64
      or jsonb_typeof(v_p->'activation') is distinct from 'string' or (v_p->>'activation') not in ('candidate_unaccepted','accepted')
      or (v_p ? 'hrv_method' and jsonb_typeof(v_p->'hrv_method') <> 'null' and (jsonb_typeof(v_p->'hrv_method') is distinct from 'string' or (v_p->>'hrv_method') not in ('rmssd','sdnn')))
      or (v_p ? 'confidence' and jsonb_typeof(v_p->'confidence') <> 'null' and (jsonb_typeof(v_p->'confidence') is distinct from 'number' or (v_p->>'confidence')::numeric not between 0 and 1))
      or (v_p ? 'drivers' and (jsonb_typeof(v_p->'drivers') is distinct from 'array' or jsonb_array_length(v_p->'drivers') > 8
        or exists (select 1 from jsonb_array_elements(v_p->'drivers') d where jsonb_typeof(d) <> 'string' or (d #>> '{}') !~ v_driver)))
      -- The label and the provenance travel together. The label has exactly its four fields: a state that follows the count of
      -- the owner's own days against the fourteen needed, and a prior named only from the closed set. The provenance names the
      -- signals the pillar used from the closed list and the days they came from, as day strings only, so no reading rides it.
      or (v_p ? 'baseline') <> (v_p ? 'used')
      or (v_p ? 'baseline' and jsonb_typeof(v_p->'confidence') is distinct from 'number')
      or (v_p ? 'baseline' and (
        jsonb_typeof(v_p->'baseline') is distinct from 'object'
        or (select array_agg(k order by k) from jsonb_object_keys(v_p->'baseline') k) is distinct from array['needed','personal_days','prior','state']
        or jsonb_typeof(v_p #> '{baseline,state}') is distinct from 'string' or (v_p #>> '{baseline,state}') not in ('provisional','personal')
        or jsonb_typeof(v_p #> '{baseline,personal_days}') is distinct from 'number' or (v_p #>> '{baseline,personal_days}') !~ '^[0-9]{1,2}$'
        or jsonb_typeof(v_p #> '{baseline,needed}') is distinct from 'number' or (v_p #>> '{baseline,needed}') <> '14'
        or jsonb_typeof(v_p #> '{baseline,prior}') is distinct from 'string' or (v_p #>> '{baseline,prior}') not in ('adults','none')
        or (v_p #>> '{baseline,personal_days}')::int > 30
        or ((v_p #>> '{baseline,state}') = 'personal') <> ((v_p #>> '{baseline,personal_days}')::int >= 14)))
      or (v_p ? 'used' and (
        jsonb_typeof(v_p->'used') is distinct from 'object'
        or (select array_agg(k order by k) from jsonb_object_keys(v_p->'used') k) is distinct from array['days','signals']
        or jsonb_typeof(v_p #> '{used,signals}') is distinct from 'array' or jsonb_array_length(v_p #> '{used,signals}') not between 1 and 12
        or exists (select 1 from jsonb_array_elements(v_p #> '{used,signals}') s where jsonb_typeof(s) <> 'string'
          or (s #>> '{}') not in ('sleep','hrv','resting_heart_rate','sleep_midpoint','daylight','movement','stress','calendar','tasks','messages','physical_load'))
        or (select count(distinct s) from jsonb_array_elements(v_p #> '{used,signals}') s) <> jsonb_array_length(v_p #> '{used,signals}')
        or jsonb_typeof(v_p #> '{used,days}') is distinct from 'array' or jsonb_array_length(v_p #> '{used,days}') not between 1 and 31
        or exists (select 1 from jsonb_array_elements(v_p #> '{used,days}') d where jsonb_typeof(d) <> 'string' or (d #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          or (d #>> '{}')::date not between v_day - 31 and v_day)
        or (select count(distinct d) from jsonb_array_elements(v_p #> '{used,days}') d) <> jsonb_array_length(v_p #> '{used,days}')))
      then return '{"error":"invalid_request"}'; end if;
  end loop;
  if (v_body ? 'drivers' and (jsonb_typeof(v_body->'drivers') is distinct from 'array' or jsonb_array_length(v_body->'drivers') > 8 or exists (select 1 from jsonb_array_elements(v_body->'drivers') d where jsonb_typeof(d) <> 'string' or (d #>> '{}') !~ v_driver)))
    or (v_body ? 'tags' and (jsonb_typeof(v_body->'tags') is distinct from 'array' or jsonb_array_length(v_body->'tags') > 10 or exists (select 1 from jsonb_array_elements(v_body->'tags') t where jsonb_typeof(t) <> 'string' or char_length(t #>> '{}') > 40)))
    or (v_body ? 'confidence' and v_body->'confidence' <> 'null'::jsonb and (jsonb_typeof(v_body->'confidence') is distinct from 'number' or (v_body->>'confidence')::numeric not between 0 and 1))
    or jsonb_typeof(v_body->'freshness') is distinct from 'string' or (v_body->>'freshness') not in ('fresh','stale','expired') then return '{"error":"invalid_request"}'; end if;
  -- Sleep debt, when sent, has exactly the shape the app reads: unavailable with its reason, partial with the recorded
  -- share of the window and no figure, or available with its weighted minutes and the basis of the need. The key-set CASE
  -- is parenthesised: PL/pgSQL ends an IF condition at the first THEN outside parentheses.
  if v_body ? 'sleep_debt' then
    v_p := v_body->'sleep_debt';
    if jsonb_typeof(v_p) is distinct from 'object' or jsonb_typeof(v_p->'state') is distinct from 'string'
      or (select array_agg(k order by k) from jsonb_object_keys(v_p) k where k <> 'trend') is distinct from (case v_p->>'state'
        when 'unavailable' then array['reason','state']
        when 'partial' then array['activation','algorithm_version','confidence','state']
        when 'available' then array['activation','algorithm_version','debt_minutes','need_basis','state'] end)
      or (v_p->>'state' = 'unavailable' and (jsonb_typeof(v_p->'reason') is distinct from 'string' or v_p->>'reason' not in ('not_linked','consent_required','consent_withdrawn','no_readings','baseline_immature','missing_sleep',
        'missing_resting_signal','stale_inputs','conflicting_inputs','intraday_inputs_unavailable','calendar_demand_unavailable')))
      or (v_p->>'state' <> 'unavailable' and (
        jsonb_typeof(v_p->'algorithm_version') is distinct from 'string' or (v_p->>'algorithm_version') !~ '^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*\.v[0-9]+$' or char_length(v_p->>'algorithm_version') > 64
        or jsonb_typeof(v_p->'activation') is distinct from 'string' or (v_p->>'activation') not in ('candidate_unaccepted','accepted')))
      or (v_p ? 'trend' and (v_p->>'state' = 'unavailable' or jsonb_typeof(v_p->'trend') is distinct from 'string' or (v_p->>'trend') not in ('building','easing','steady')))
      or (v_p->>'state' = 'partial' and (jsonb_typeof(v_p->'confidence') is distinct from 'number' or (v_p->>'confidence')::numeric not between 0 and 1))
      or (v_p->>'state' = 'available' and (jsonb_typeof(v_p->'debt_minutes') is distinct from 'number' or (v_p->>'debt_minutes')::numeric not between 0 and 20160
        or jsonb_typeof(v_p->'need_basis') is distinct from 'string' or (v_p->>'need_basis') not in ('owner_confirmed','own_average','blended_average'))) then return '{"error":"invalid_request"}'; end if;
  end if;
  -- Today's energy windows, when sent: one to four stretches of the day as 24-hour clock times in the row's zone, each ending
  -- after it starts, a kind of peak or dip and nothing else, with the version that computed them, together or not at all.
  if v_body ? 'windows' or v_body ? 'windows_version' then
    if not (v_body ? 'windows' and v_body ? 'windows_version')
      or jsonb_typeof(v_body->'windows') is distinct from 'array' or jsonb_array_length(v_body->'windows') not between 1 and 4
      or jsonb_typeof(v_body->'windows_version') is distinct from 'string' or (v_body->>'windows_version') !~ '^energy-windows\.v[0-9]+$'
      or exists (select 1 from jsonb_array_elements(v_body->'windows') win where jsonb_typeof(win) is distinct from 'object'
        or (select array_agg(k order by k) from jsonb_object_keys(win) k) is distinct from array['end','kind','start']
        or jsonb_typeof(win->'start') is distinct from 'string' or jsonb_typeof(win->'end') is distinct from 'string' or jsonb_typeof(win->'kind') is distinct from 'string'
        or (win->>'start') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or (win->>'end') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        or (win->>'kind') not in ('peak','dip') or (win->>'start') collate "C" >= (win->>'end') collate "C") then return '{"error":"invalid_request"}'; end if;
  end if;
  -- The candidate training load, when sent: a closed phrase, its method, version and the candidate activation, or a closed
  -- reason. Exactly those keys, so no figure can ride it to the model.
  if v_body ? 'training_load' then
    v_p := v_body->'training_load';
    if jsonb_typeof(v_p) is distinct from 'object' or jsonb_typeof(v_p->'state') is distinct from 'string'
      or (v_p->>'state' = 'unavailable' and ((select array_agg(k order by k) from jsonb_object_keys(v_p) k) is distinct from array['reason','state']
        or jsonb_typeof(v_p->'reason') is distinct from 'string' or v_p->>'reason' not in ('no_readings','baseline_immature')))
      or (v_p->>'state' = 'available' and ((select array_agg(k order by k) from jsonb_object_keys(v_p) k) is distinct from array['activation','algorithm_version','method','phrase','state']
        or jsonb_typeof(v_p->'phrase') is distinct from 'string' or v_p->>'phrase' not in ('much lighter than usual','lighter than usual','about usual','heavier than usual','much heavier than usual')
        or jsonb_typeof(v_p->'method') is distinct from 'string' or v_p->>'method' not in ('hr_zones','effort','minutes')
        or v_p->'algorithm_version' is distinct from '"training-load.candidate.v1"'::jsonb or v_p->'activation' is distinct from '"candidate_unaccepted"'::jsonb))
      or v_p->>'state' not in ('available','unavailable') or v_body ? 'backfilled' then return '{"error":"invalid_request"}'; end if;
  end if;
  -- A backfilled row is a day recomputed from history that arrived late: true or absent (never false), for a day older than
  -- yesterday and within the ninety-day raw window, with Form and Weight unavailable and no windows.
  if v_body ? 'backfilled' then
    if v_body->'backfilled' is distinct from 'true'::jsonb
      or v_day > (now() at time zone v_tz)::date - 2 or v_day < (now() at time zone v_tz)::date - 90
      or not (v_body->'form' ? 'reason') or not (v_body->'weight' ? 'reason') or v_body ? 'windows' then return '{"error":"invalid_request"}'; end if;
  end if;
  -- Accepted is for the sources the amendment names. Which writer inside Health Connect may be accepted is decided by the
  -- computation authority, the producer, not here.
  if exists (select 1 from (select v_body->'recovery' as p union all select v_body->'form' union all select v_body->'weight' union all select v_body->'sleep_debt') x where x.p->>'activation' = 'accepted')
    and exists (select 1 from jsonb_array_elements(v_body->'basis') b where b->>'source' not in ('apple','oura','whoop','samsung','health_connect')) then return '{"error":"invalid_request"}'; end if;
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
  -- A backfilled row never replaces a live one: the live row stands, and the answer is the stale one a late writer already gets.
  if v_body ? 'backfilled' and exists (select 1 from public.health_context_daily c where c.user_id = v_auth and c.day = v_day and c.backfilled is not true) then
    return '{"written":false,"stale":true}';
  end if;
  -- Which pillars moved to another zone word: against the row this write replaces or, for a day's first row, the newest
  -- earlier day. Only a row computed from the same sources is compared, so a switch of wearable is never a change. The
  -- answer names pillars only, never a zone or a score. The owner row lock above serialises this with every other write.
  select c.* into v_old from public.health_context_daily c where c.user_id = v_auth and c.day = v_day and c.backfilled is not true;
  if v_old.id is null then
    select c.* into v_old from public.health_context_daily c join waldo.health_context_basis b on b.owner_id = v_owner and b.day = c.day
      where c.user_id = v_auth and c.day < v_day and c.backfilled is not true order by c.day desc limit 1;
  end if;
  if v_old.id is not null then select b.consent_basis into v_old_basis from waldo.health_context_basis b where b.owner_id = v_owner and b.day = v_old.day; end if;
  if not (v_body ? 'backfilled') and v_old.id is not null and waldo.health_basis_sources(v_old_basis) = waldo.health_basis_sources(v_body->'basis') then
    foreach v_pillar in array array['recovery','form','weight'] loop
      if (to_jsonb(v_old)->v_pillar->>'zone') in ('low','moderate','good','high') and (v_body->v_pillar->>'zone') in ('low','moderate','good','high')
        and (to_jsonb(v_old)->v_pillar->>'zone') <> (v_body->v_pillar->>'zone') then v_changed := v_changed || to_jsonb(v_pillar); end if;
    end loop;
  end if;
  v_conf := case when jsonb_typeof(v_body->'confidence') = 'number' then (v_body->>'confidence')::numeric else null end;
  insert into public.health_context_daily(user_id, day, form, recovery, weight, sleep_debt, drivers, confidence, freshness, tags, windows, windows_version, backfilled, training_load)
    values (v_auth, v_day,
      v_body->'form', v_body->'recovery', v_body->'weight', v_body->'sleep_debt',
      coalesce(v_body->'drivers', '[]'::jsonb), v_conf, v_body->>'freshness',
      coalesce((select array_agg(t) from jsonb_array_elements_text(v_body->'tags') t), '{}'::text[]),
      v_body->'windows', v_body->>'windows_version', (v_body->>'backfilled')::boolean, v_body->'training_load')
    on conflict (user_id, day) do update set form = excluded.form, recovery = excluded.recovery, weight = excluded.weight, sleep_debt = excluded.sleep_debt, drivers = excluded.drivers,
      confidence = excluded.confidence, freshness = excluded.freshness, tags = excluded.tags,
      windows = excluded.windows, windows_version = excluded.windows_version, backfilled = excluded.backfilled, training_load = excluded.training_load;
  insert into waldo.health_context_basis(owner_id, day, consent_basis, timezone, read_at) values (v_owner, v_day, v_body->'basis', v_tz, v_read_at)
    on conflict (owner_id, day) do update set consent_basis = excluded.consent_basis, timezone = excluded.timezone, read_at = excluded.read_at;
  return jsonb_build_object('written', true, 'changed', v_changed);
exception
  when data_exception then return '{"error":"invalid_request"}';
end $$;

create or replace function waldo.health_context_read(p_do_name text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_auth uuid;
begin
  if not waldo.router_signed('healthctx.read.' || p_do_name, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select id, auth_user_id into v_owner, v_auth from waldo.owners where do_name = p_do_name and state = 'active';
  if v_auth is null then return null; end if;
  return (
    select jsonb_build_object(
      'context', jsonb_build_object(
        'id', c.id,
        'day', c.day,
        'form', c.form,
        'recovery', c.recovery,
        'weight', c.weight,
        'drivers', c.drivers,
        'confidence', c.confidence,
        'freshness', c.freshness,
        'tags', c.tags,
        'compiled_at', c.updated_at,
        'basis', b.consent_basis
      ) || case when c.sleep_debt is null then '{}'::jsonb else jsonb_build_object('sleep_debt', c.sleep_debt) end
        || case when c.windows is null or c.day <> (now() at time zone b.timezone)::date then '{}'::jsonb else jsonb_build_object('windows', c.windows) end
        || case when c.training_load is null then '{}'::jsonb else jsonb_build_object('training_load', c.training_load) end,
      'previous', (
        select jsonb_build_object('day', p2.day, 'form_score', (p2.form ->> 'score')::numeric,
          'recovery_zone', p2.recovery ->> 'zone', 'weight_zone', p2.weight ->> 'zone', 'basis', pb.consent_basis)
        from public.health_context_daily p2
        join waldo.health_context_basis pb on pb.owner_id = v_owner and pb.day = p2.day
        where p2.user_id = v_auth and p2.day < c.day and p2.backfilled is not true and waldo.health_basis_live(v_owner, pb.consent_basis, true)
        order by p2.day desc
        limit 1
      )
    )
    from public.health_context_daily c
    join waldo.health_context_basis b on b.owner_id = v_owner and b.day = c.day
    where c.user_id = v_auth and c.backfilled is not true and waldo.health_basis_live(v_owner, b.consent_basis, true)
    order by c.day desc
    limit 1
  );
end $$;
