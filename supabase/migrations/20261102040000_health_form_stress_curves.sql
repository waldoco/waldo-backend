-- Health contract revision 10 (today's measured Form curve and hourly stress curve), part two: storage and fence. Both are derived
-- values (ADR-0081 amendments of 27 Oct 2026 §1 and 2 Nov 2026 §6), kept on the derived row under its retention, withdrawal purge
-- and account deletion, and read only by the owner's own app read, for the owner's own today.
-- - public.health_context_daily gains form_curve (jsonb) and stress_curve (jsonb), both nullable: a row written without them holds
--   nothing. They are columns of their own for the reason day_load is, and the model's read and the history read return neither.
-- - waldo.health_form_curve_valid and waldo.health_stress_curve_valid are the closed shapes. A Form curve is a version name and one
--   to ninety-six measured points, strictly forward in time, whose version and latest point must be the row's own Form's; it admits
--   no projected point. A stress curve is the candidate version and one to twenty-four hours, each with a value of 0 to 100 and the
--   band read off it, or no value and a closed reason, and at least one hour with a value.
-- - waldo.health_context_write is re-created whole from its last definition (20261102030000) and admits both keys through those
--   functions, only on a write for the owner's own today by the row's zone and never on a backfilled row. A write for today without
--   them clears both. A write for any other day leaves that day's stored curves as they are. Its payload limit moves from 16 KiB to
--   32 KiB: a full Form curve (96 points of about 58 bytes), a full stress curve, the parts, every usual band and the load come to
--   within a kilobyte or two of 16 KiB, and the writer refuses a row over the limit whole, so an owner with every switch on could
--   lose their scores rather than a curve.
--   waldo.health_scores_read is re-created whole from its last definition (20261102030000) and returns each curve only for the
--   owner's own today, as the energy windows are.
-- Signatures, security definer, search_path and grants are unchanged. Rollback: supabase/rollback/20261102040000_health_form_stress_curves.down.sql.
alter table public.health_context_daily add column form_curve jsonb;
alter table public.health_context_daily add column stress_curve jsonb;

create function waldo.health_form_curve_valid(p_curve jsonb, p_form jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare v_last jsonb;
begin
  -- A version name, and one to ninety-six measured points, strictly forward in time, each an
  -- instant and a score of 0 to 100. A projected point is not admitted: the projection stays off the owner's screens.
  if jsonb_typeof(p_curve) is distinct from 'object' or (select array_agg(k order by k) from jsonb_object_keys(p_curve) k) is distinct from array['points','version']
    or jsonb_typeof(p_curve->'version') is distinct from 'string' or (p_curve->>'version') !~ '^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*\.v[0-9]+$' or char_length(p_curve->>'version') > 64
    or jsonb_typeof(p_curve->'points') is distinct from 'array' or jsonb_array_length(p_curve->'points') not between 1 and 96
    or exists (select 1 from jsonb_array_elements(p_curve->'points') pt where jsonb_typeof(pt) is distinct from 'object'
      or (select array_agg(k order by k) from jsonb_object_keys(pt) k) is distinct from array['at','kind','score']
      or jsonb_typeof(pt->'at') is distinct from 'string' or (pt->>'at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'
      or jsonb_typeof(pt->'score') is distinct from 'number' or (pt->>'score')::numeric not between 0 and 100
      or pt->'kind' is distinct from '"measured"'::jsonb) then return false; end if;
  if exists (select 1 from (select (pt.p->>'at')::timestamptz as at, lag((pt.p->>'at')::timestamptz) over (order by pt.n) as before_at
      from jsonb_array_elements(p_curve->'points') with ordinality pt(p, n)) ordered where ordered.before_at >= ordered.at) then return false; end if;
  -- The curve is the row's own Form: the version that scored the row, and the row's score as its latest point.
  v_last := p_curve->'points'->(jsonb_array_length(p_curve->'points') - 1);
  return coalesce(jsonb_typeof(p_form) = 'object' and not (p_form ? 'reason') and p_curve->'version' = p_form->'algorithm_version' and v_last->'score' = p_form->'score', false);
end $$;

create function waldo.health_stress_curve_valid(p_curve jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare v_hour jsonb; v_value numeric; v_before timestamptz; v_at timestamptz; v_valued boolean := false;
begin
  if jsonb_typeof(p_curve) is distinct from 'object' or (select array_agg(k order by k) from jsonb_object_keys(p_curve) k) is distinct from array['hours','version']
    or p_curve->'version' is distinct from '"stress-curve.candidate.v1"'::jsonb
    or jsonb_typeof(p_curve->'hours') is distinct from 'array' or jsonb_array_length(p_curve->'hours') not between 1 and 24 then return false; end if;
  for v_hour in select value from jsonb_array_elements(p_curve->'hours') loop
    if jsonb_typeof(v_hour) is distinct from 'object' or jsonb_typeof(v_hour->'at') is distinct from 'string'
      or (v_hour->>'at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$' then return false; end if;
    v_at := (v_hour->>'at')::timestamptz;
    if v_before is not null and v_before >= v_at then return false; end if;
    v_before := v_at;
    if jsonb_typeof(v_hour->'value') = 'null' then
      -- An hour with no value says why and carries no band, so it can be no score.
      if (select array_agg(k order by k) from jsonb_object_keys(v_hour) k) is distinct from array['at','band','reason','value'] or jsonb_typeof(v_hour->'band') is distinct from 'null'
        or jsonb_typeof(v_hour->'reason') is distinct from 'string' or v_hour->>'reason' not in ('workout','moving','no_reading','baseline_immature') then return false; end if;
    else
      -- An hour with a value: 0 to 100, and a band read off it (70 and up high, 30 and down low), so the two cannot disagree.
      if (select array_agg(k order by k) from jsonb_object_keys(v_hour) k) is distinct from array['at','band','value'] or jsonb_typeof(v_hour->'value') is distinct from 'number'
        or (v_hour->>'value')::numeric not between 0 and 100 then return false; end if;
      v_value := (v_hour->>'value')::numeric;
      if v_hour->'band' is distinct from to_jsonb(case when v_value >= 70 then 'high' when v_value <= 30 then 'low' else 'medium' end) then return false; end if;
      v_valued := true;
    end if;
  end loop;
  -- A curve with no hour that has a value is no curve.
  return v_valued;
end $$;
revoke all on function waldo.health_form_curve_valid(jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function waldo.health_stress_curve_valid(jsonb) from public, anon, authenticated, service_role;

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
  if octet_length(p_payload) > 32768 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' or exists (select 1 from jsonb_object_keys(v_body) k where k not in ('day','timezone','basis','form','recovery','weight','drivers','confidence','freshness','tags','read_at','sleep_debt','windows','windows_version','backfilled','training_load','components','usual','day_load','form_curve','stress_curve')) then return '{"error":"invalid_request"}'; end if;
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
        or jsonb_typeof(v_p->'method') is distinct from 'string' or v_p->>'method' not in ('hr_zones','hr_zones_observed_peak','effort','minutes')
        or v_p->'algorithm_version' is distinct from '"training-load.candidate.v1"'::jsonb or v_p->'activation' is distinct from '"candidate_unaccepted"'::jsonb))
      or v_p->>'state' not in ('available','unavailable') or v_body ? 'backfilled' then return '{"error":"invalid_request"}'; end if;
  end if;
  -- The parts of each available pillar and the owner's usual bands, when sent: each in its own closed shape (waldo.health_parts_valid,
  -- waldo.health_usual_valid), never on a backfilled row, and the parts only for a pillar the row holds as available, so no figure
  -- can ride a key and no part can belong to a pillar the row does not score.
  if v_body ? 'components' then
    v_p := v_body->'components';
    if jsonb_typeof(v_p) is distinct from 'object' or v_body ? 'backfilled' or not exists (select 1 from jsonb_object_keys(v_p))
      or exists (select 1 from jsonb_object_keys(v_p) k where k not in ('recovery','form','weight','groups')) then return '{"error":"invalid_request"}'; end if;
    foreach v_pillar in array array['recovery','form','weight'] loop
      if v_p ? v_pillar and ((v_body->v_pillar) ? 'reason' or not waldo.health_parts_valid(v_pillar, v_p->v_pillar, (v_body->v_pillar->>'score')::numeric)) then return '{"error":"invalid_request"}'; end if;
    end loop;
    if v_p ? 'groups' and not waldo.health_groups_valid(v_p->'groups', v_p) then return '{"error":"invalid_request"}'; end if;
  end if;
  if v_body ? 'usual' and (v_body ? 'backfilled' or not waldo.health_usual_valid(v_body->'usual')) then return '{"error":"invalid_request"}'; end if;
  -- The day's load, when sent: its closed shape (waldo.health_day_load_valid), never on a backfilled row, so no figure can ride
  -- a key and no day other than a live one can hold a load.
  if v_body ? 'day_load' and (v_body ? 'backfilled' or not waldo.health_day_load_valid(v_body->'day_load')) then return '{"error":"invalid_request"}'; end if;
  -- Today's measured Form curve and hourly stress curve, when sent: each in its closed shape, never on a backfilled row and only
  -- on a write for the owner's own today by the row's zone. The Form curve must be the row's own Form: its version the row's
  -- Form version, its last point the row's Form score. A write for today without them clears both.
  if v_body ? 'form_curve' or v_body ? 'stress_curve' then
    if v_body ? 'backfilled' or v_day <> (now() at time zone v_tz)::date then return '{"error":"invalid_request"}'; end if;
  end if;
  if v_body ? 'form_curve' and not waldo.health_form_curve_valid(v_body->'form_curve', v_body->'form') then return '{"error":"invalid_request"}'; end if;
  if v_body ? 'stress_curve' and not waldo.health_stress_curve_valid(v_body->'stress_curve') then return '{"error":"invalid_request"}'; end if;
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
  insert into public.health_context_daily as c(user_id, day, form, recovery, weight, sleep_debt, drivers, confidence, freshness, tags, windows, windows_version, backfilled, training_load, components, usual, day_load, form_curve, stress_curve)
    values (v_auth, v_day,
      v_body->'form', v_body->'recovery', v_body->'weight', v_body->'sleep_debt',
      coalesce(v_body->'drivers', '[]'::jsonb), v_conf, v_body->>'freshness',
      coalesce((select array_agg(t) from jsonb_array_elements_text(v_body->'tags') t), '{}'::text[]),
      v_body->'windows', v_body->>'windows_version', (v_body->>'backfilled')::boolean, v_body->'training_load', v_body->'components', v_body->'usual', v_body->'day_load', v_body->'form_curve', v_body->'stress_curve')
    on conflict (user_id, day) do update set form = excluded.form, recovery = excluded.recovery, weight = excluded.weight, sleep_debt = excluded.sleep_debt, drivers = excluded.drivers,
      confidence = excluded.confidence, freshness = excluded.freshness, tags = excluded.tags,
      windows = excluded.windows, windows_version = excluded.windows_version, backfilled = excluded.backfilled, training_load = excluded.training_load,
      components = excluded.components, usual = excluded.usual, day_load = excluded.day_load,
      -- A curve is today's: a write for any other day (the producer rewrites yesterday on every run and sends it no curve) leaves
      -- that day's stored curve as it is, kept for the row's own retention and deletion. A write for today replaces or clears it.
      form_curve = case when v_day = (now() at time zone v_tz)::date then excluded.form_curve else c.form_curve end,
      stress_curve = case when v_day = (now() at time zone v_tz)::date then excluded.stress_curve else c.stress_curve end;
  insert into waldo.health_context_basis(owner_id, day, consent_basis, timezone, read_at) values (v_owner, v_day, v_body->'basis', v_tz, v_read_at)
    on conflict (owner_id, day) do update set consent_basis = excluded.consent_basis, timezone = excluded.timezone, read_at = excluded.read_at;
  return jsonb_build_object('written', true, 'changed', v_changed);
exception
  when data_exception then return '{"error":"invalid_request"}';
end $$;

create or replace function waldo.health_scores_read(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_auth uuid; v_body jsonb; v_day date; v_row record;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.scores_read.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id, o.auth_user_id into v_owner, v_auth from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active';
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload) > 1024 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' or exists (select 1 from jsonb_object_keys(v_body) k where k <> 'day') then return '{"error":"invalid_request"}'; end if;
  if v_body ? 'day' then
    if jsonb_typeof(v_body->'day') is distinct from 'string' or (v_body->>'day') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return '{"error":"invalid_request"}'; end if;
    v_day := (v_body->>'day')::date;
  end if;
  select c.day, b.timezone, c.updated_at, c.freshness, c.form, c.recovery, c.weight, c.sleep_debt, c.drivers, c.windows, c.components, c.usual, c.day_load, c.form_curve, c.stress_curve into v_row
    from public.health_context_daily c join waldo.health_context_basis b on b.owner_id = v_owner and b.day = c.day
    where c.user_id = v_auth and (v_day is null or c.day = v_day) and (v_day is not null or c.backfilled is not true) and waldo.health_basis_live(v_owner, b.consent_basis, false)
    order by c.day desc limit 1;
  if v_row.day is not null then
    return jsonb_build_object('scores', jsonb_build_object('day', v_row.day, 'timezone', v_row.timezone,
      'compiled_at', to_char(v_row.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'freshness', v_row.freshness, 'form', v_row.form, 'recovery', v_row.recovery, 'weight', v_row.weight)
      || case when v_row.sleep_debt is null then '{}'::jsonb else jsonb_build_object('sleep_debt', v_row.sleep_debt) end
      || jsonb_build_object('drivers', v_row.drivers)
      || case when v_row.windows is null or v_row.day <> (now() at time zone v_row.timezone)::date then '{}'::jsonb else jsonb_build_object('windows', v_row.windows) end
      || case when v_row.components is null then '{}'::jsonb else jsonb_build_object('components', v_row.components) end
      || case when v_row.usual is null then '{}'::jsonb else jsonb_build_object('usual', v_row.usual) end
      || case when v_row.day_load is null then '{}'::jsonb else jsonb_build_object('day_load', v_row.day_load) end
      || case when v_row.form_curve is null or v_row.day <> (now() at time zone v_row.timezone)::date then '{}'::jsonb else jsonb_build_object('form_curve', v_row.form_curve) end
      || case when v_row.stress_curve is null or v_row.day <> (now() at time zone v_row.timezone)::date then '{}'::jsonb else jsonb_build_object('stress_curve', v_row.stress_curve) end);
  end if;
  -- No row to show: say why, so the app can tell a missing grant from missing readings.
  return jsonb_build_object('unavailable', case
    when not exists (select 1 from waldo.health_consents c where c.owner_id = v_owner and c.purpose = 'storage_compute') then 'consent_required'
    when not exists (select 1 from waldo.health_consents c where c.owner_id = v_owner and c.purpose = 'storage_compute' and c.withdrawn_at is null) then 'consent_withdrawn'
    else 'no_readings' end);
exception
  when data_exception then return '{"error":"invalid_request"}';
end $$;
