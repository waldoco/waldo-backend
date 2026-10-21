-- Wave 4 wedge: the health trigger's zone-change signal, and WHOOP and Oura as health sources.
-- Signatures, security definer, search_path and grants of every replaced function are unchanged.

-- The sorted source names of a derived row's consent basis, so two rows can be compared without their epochs.
create function waldo.health_basis_sources(p_basis jsonb) returns text
language sql immutable set search_path = '' as $$
  select coalesce(string_agg(b->>'source', ',' order by b->>'source'), '') from jsonb_array_elements(case when jsonb_typeof(p_basis) = 'array' then p_basis else '[]'::jsonb end) b $$;
revoke all on function waldo.health_basis_sources(jsonb) from public, anon, authenticated, service_role;

-- The derived-row writer also says which pillars changed zone, so the owner's agent hears of a change without being
-- told a zone or a score. Basis sources now include whoop and oura.
create or replace function waldo.health_context_write(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid; v_auth uuid; v_body jsonb; v_pillar text; v_p jsonb; v_day date; v_conf numeric; v_tz text; v_entry jsonb;
  v_scope waldo.health_scopes; v_consent waldo.health_consents; v_read_at timestamptz; v_held timestamptz;
  v_old public.health_context_daily; v_old_basis jsonb; v_changed jsonb := '[]'::jsonb;
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
  -- Which pillars moved to another zone word: against the row this write replaces or, for a day's first row, the newest
  -- earlier day. Only a row computed from the same sources is compared, so a switch of wearable is never a change. The
  -- answer names pillars only, never a zone or a score. The owner row lock above serialises this with every other write.
  select c.* into v_old from public.health_context_daily c where c.user_id = v_auth and c.day = v_day;
  if v_old.id is null then
    select c.* into v_old from public.health_context_daily c join waldo.health_context_basis b on b.owner_id = v_owner and b.day = c.day
      where c.user_id = v_auth and c.day < v_day order by c.day desc limit 1;
  end if;
  if v_old.id is not null then select b.consent_basis into v_old_basis from waldo.health_context_basis b where b.owner_id = v_owner and b.day = v_old.day; end if;
  if v_old.id is not null and waldo.health_basis_sources(v_old_basis) = waldo.health_basis_sources(v_body->'basis') then
    foreach v_pillar in array array['recovery','form','weight'] loop
      if (to_jsonb(v_old)->v_pillar->>'zone') in ('low','moderate','good','high') and (v_body->v_pillar->>'zone') in ('low','moderate','good','high')
        and (to_jsonb(v_old)->v_pillar->>'zone') <> (v_body->v_pillar->>'zone') then v_changed := v_changed || to_jsonb(v_pillar); end if;
    end loop;
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
  return jsonb_build_object('written', true, 'changed', v_changed);
exception
  when data_exception then return '{"error":"invalid_request"}';
end $$;

-- The prompt read also returns each row's basis and the earlier day's recovery and load zone words, so the health trigger
-- can say "before" only for a day computed from the same sources. Consent rules are unchanged.
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
      ),
      'previous', (
        select jsonb_build_object('day', p2.day, 'form_score', (p2.form ->> 'score')::numeric,
          'recovery_zone', p2.recovery ->> 'zone', 'weight_zone', p2.weight ->> 'zone', 'basis', pb.consent_basis)
        from public.health_context_daily p2
        join waldo.health_context_basis pb on pb.owner_id = v_owner and pb.day = p2.day
        where p2.user_id = v_auth and p2.day < c.day and waldo.health_basis_live(v_owner, pb.consent_basis, true)
        order by p2.day desc
        limit 1
      )
    )
    from public.health_context_daily c
    join waldo.health_context_basis b on b.owner_id = v_owner and b.day = c.day
    where c.user_id = v_auth and waldo.health_basis_live(v_owner, b.consent_basis, true)
    order by c.day desc
    limit 1
  );
end $$;

-- WHOOP is a cloud source on the same health plane: the app-side grant and withdraw functions and the ingest function take
-- it, and a provider's express-authorization grant is its own purpose. Tables first.
alter table waldo.health_consents drop constraint health_consents_source_check, drop constraint health_consents_purpose_check;
alter table waldo.health_consents add constraint health_consents_source_check check (source in ('apple','samsung','health_connect','whoop')),
  add constraint health_consents_purpose_check check (purpose in ('storage_compute','model_processing','provider_terms'));
alter table waldo.health_scopes drop constraint health_scopes_source_check, drop constraint health_scopes_purpose_check;
alter table waldo.health_scopes add constraint health_scopes_source_check check (source in ('apple','samsung','health_connect','whoop')),
  add constraint health_scopes_purpose_check check (purpose in ('storage_compute','model_processing','provider_terms'));
alter table waldo.health_samples drop constraint health_samples_source_check;
alter table waldo.health_samples add constraint health_samples_source_check check (source in ('apple','samsung','health_connect','whoop'));

-- Each function below is re-created whole from its last definition (consent grant and withdraw: 20261011000000; ingest:
-- 20261011020000). The source list gains whoop and the purpose list gains provider_terms; grant adds the rule that
-- WHOOP storage needs a live provider_terms grant. Signatures and grants are unchanged.
create or replace function waldo.health_consent_grant(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid; v_body jsonb; v_source text; v_purpose text; v_id text; v_prior waldo.health_requests; v_scope waldo.health_scopes;
  v_epoch integer; v_consent waldo.health_consents; v_result jsonb;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.consent_grant.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id into v_owner from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active' for update of o;
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload) > 98304 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' then return '{"error":"invalid_request"}'; end if;
  v_id := v_body->>'request_id'; v_source := v_body->>'source'; v_purpose := v_body->>'purpose';
  if v_id is null or v_id !~ '^[A-Za-z0-9_-]{8,96}$' or v_source is null or v_source not in ('apple','samsung','health_connect','whoop')
    or v_purpose is null or v_purpose not in ('storage_compute','model_processing','provider_terms')
    or (v_purpose = 'provider_terms' and v_source <> 'whoop')
    or v_body->>'version' is distinct from '2' or v_body->>'age_attested_18_plus' is distinct from 'true'
    or (v_body->>'expected_epoch') is null or (v_body->>'expected_epoch') !~ '^[0-9]{1,9}$' then return '{"error":"invalid_request"}'; end if;
  select * into v_scope from waldo.health_scopes where owner_id = v_owner and source = v_source and purpose = v_purpose for update;
  v_epoch := coalesce(v_scope.epoch, 0);
  select * into v_prior from waldo.health_requests where owner_id = v_owner and request_id = v_id;
  if found then
    if v_prior.operation <> 'consent_grant' or v_prior.payload_digest <> md5(p_payload) then return '{"error":"idempotency_conflict"}'; end if;
    if not exists (select 1 from waldo.health_consents c where c.id = v_scope.consent_id and c.withdrawn_at is null) then return '{"error":"consent_withdrawn"}'; end if;
    if v_epoch is distinct from (v_prior.response->'consent'->>'epoch')::integer then return '{"error":"epoch_conflict"}'; end if;
    return jsonb_set(v_prior.response, '{replayed}', 'true');
  end if;
  -- Model use sits on top of storage: it can be granted only while the same source holds live storage consent.
  if v_purpose = 'model_processing' and not exists (select 1 from waldo.health_scopes s join waldo.health_consents c on c.id = s.consent_id
    where s.owner_id = v_owner and s.source = v_source and s.purpose = 'storage_compute' and c.withdrawn_at is null) then return '{"error":"consent_required"}'; end if;
  -- WHOOP's terms need the owner's express authorization for storing the data and using it with AI. That is its own grant,
  -- named in the consent copy, and storage can be granted only while it is live. Withdrawing it withdraws the source.
  if v_purpose = 'storage_compute' and v_source = 'whoop' and not exists (select 1 from waldo.health_scopes s join waldo.health_consents c on c.id = s.consent_id
    where s.owner_id = v_owner and s.source = 'whoop' and s.purpose = 'provider_terms' and c.withdrawn_at is null) then return '{"error":"consent_required"}'; end if;
  if (v_body->>'expected_epoch')::integer <> v_epoch
    or exists (select 1 from waldo.health_consents c where c.owner_id = v_owner and c.source = v_source and c.purpose = v_purpose and c.withdrawn_at is null) then return '{"error":"epoch_conflict"}'; end if;
  insert into waldo.health_consents(owner_id, source, purpose, version, age_attested_18_plus) values (v_owner, v_source, v_purpose, 2, true) returning * into v_consent;
  insert into waldo.health_scopes(owner_id, source, purpose, epoch, consent_id) values (v_owner, v_source, v_purpose, 1, v_consent.id)
    on conflict (owner_id, source, purpose) do update set epoch = waldo.health_scopes.epoch + 1, consent_id = excluded.consent_id returning * into v_scope;
  v_result := jsonb_build_object('consent', waldo.health_consent_view(v_scope), 'replayed', false, 'deletion_routed', false);
  insert into waldo.health_requests(owner_id, request_id, operation, payload_digest, response) values (v_owner, v_id, 'consent_grant', md5(p_payload), v_result);
  return v_result;
end $$;

create or replace function waldo.health_consent_withdraw(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid; v_auth uuid; v_body jsonb; v_source text; v_purpose text; v_id text; v_prior waldo.health_requests; v_scope waldo.health_scopes; v_result jsonb; v_live integer; v_routed boolean;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.consent_withdraw.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id, o.auth_user_id into v_owner, v_auth from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active' for update of o;
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload) > 98304 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' then return '{"error":"invalid_request"}'; end if;
  v_id := v_body->>'request_id'; v_source := v_body->>'source'; v_purpose := v_body->>'purpose';
  if v_id is null or v_id !~ '^[A-Za-z0-9_-]{8,96}$' or v_source is null or v_source not in ('apple','samsung','health_connect','whoop')
    or v_purpose is null or v_purpose not in ('storage_compute','model_processing','provider_terms')
    or (v_purpose = 'provider_terms' and v_source <> 'whoop')
    or (v_body->>'expected_epoch') is null or (v_body->>'expected_epoch') !~ '^[0-9]{1,9}$' then return '{"error":"invalid_request"}'; end if;
  select * into v_prior from waldo.health_requests where owner_id = v_owner and request_id = v_id;
  if found then
    if v_prior.operation <> 'consent_withdraw' or v_prior.payload_digest <> md5(p_payload) then return '{"error":"idempotency_conflict"}'; end if;
    return jsonb_set(v_prior.response, '{replayed}', 'true');
  end if;
  select * into v_scope from waldo.health_scopes where owner_id = v_owner and source = v_source and purpose = v_purpose for update;
  if v_scope.owner_id is null then return '{"error":"consent_required"}'; end if;
  if (v_body->>'expected_epoch')::integer <> v_scope.epoch then return '{"error":"epoch_conflict"}'; end if;
  if v_purpose = 'model_processing' then
    -- Model use only: the owner stops Waldo using the data, which stays stored and keeps flowing. Nothing is deleted
    -- and ingest is not fenced. Re-granting the purpose releases what was stored before, because the data was never
    -- removed and the owner chose to grant again.
    update waldo.health_consents set withdrawn_at = now() where owner_id = v_owner and source = v_source and purpose = 'model_processing' and withdrawn_at is null;
    get diagnostics v_live = row_count;
    if v_live > 0 then update waldo.health_scopes set epoch = epoch + 1 where owner_id = v_owner and source = v_source and purpose = 'model_processing'; end if;
    v_routed := false;
  else
    -- Withdrawing storage withdraws both purposes for this source and removes its data: an upload queued before the
    -- withdrawal cannot repopulate it, and new processing needs fresh explicit grants. The derived rows may mix
    -- sources, so they are removed whole and rebuilt from what remains. Upload receipts go with the data; consent
    -- receipts stay so a replayed request still gets its answer.
    update waldo.health_consents set withdrawn_at = now() where owner_id = v_owner and source = v_source and withdrawn_at is null;
    get diagnostics v_live = row_count;
    if v_live > 0 then update waldo.health_scopes set epoch = epoch + 1 where owner_id = v_owner and source = v_source; end if;
    delete from waldo.health_samples where owner_id = v_owner and source = v_source;
    delete from waldo.health_anchors where owner_id = v_owner and source = v_source;
    delete from waldo.health_requests where owner_id = v_owner and operation = 'ingest' and response->>'source' = v_source;
    delete from public.health_context_daily where user_id = v_auth;
    delete from waldo.health_context_basis where owner_id = v_owner;
    v_routed := true;
  end if;
  select * into v_scope from waldo.health_scopes where owner_id = v_owner and source = v_source and purpose = v_purpose;
  v_result := jsonb_build_object('consent', waldo.health_consent_view(v_scope), 'replayed', false, 'deletion_routed', v_routed);
  insert into waldo.health_requests(owner_id, request_id, operation, payload_digest, response) values (v_owner, v_id, 'consent_withdraw', md5(p_payload), v_result);
  return v_result;
end $$;

create or replace function waldo.health_ingest(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid; v_body jsonb; v_source text; v_id text; v_prior waldo.health_requests; v_scope waldo.health_scopes; v_consent waldo.health_consents;
  v_epoch integer; v_anchor text; v_change jsonb; v_signal text; v_sample_id text; v_revision bigint; v_day date; v_start timestamptz; v_end timestamptz;
  v_offset integer; v_value numeric; v_unit text; v_lo numeric; v_hi numeric; v_windowed boolean; v_stored waldo.health_samples; v_local_start date; v_local_end date;
  v_accepted integer := 0; v_deleted integer := 0; v_ignored integer := 0; v_now_epoch bigint := extract(epoch from now())::bigint; v_result jsonb;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_payload is null
    or waldo.router_signed('health.ingest.' || p_do_name || '.' || md5(p_payload), p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select o.id into v_owner from waldo.owners o join auth.users u on u.id = o.auth_user_id where o.do_name = p_do_name and o.state = 'active' for update of o;
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload) > 98304 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' then return '{"error":"invalid_request"}'; end if;
  v_id := v_body->>'request_id'; v_source := v_body->>'source';
  if v_id is null or v_id !~ '^[A-Za-z0-9_-]{8,96}$' or v_source is null or v_source not in ('apple','samsung','health_connect','whoop') then return '{"error":"invalid_request"}'; end if;
  select * into v_prior from waldo.health_requests where owner_id = v_owner and request_id = v_id;
  if found and (v_prior.operation <> 'ingest' or v_prior.payload_digest <> md5(p_payload)) then return '{"error":"idempotency_conflict"}'; end if;
  select * into v_scope from waldo.health_scopes where owner_id = v_owner and source = v_source and purpose = 'storage_compute' for update;
  select * into v_consent from waldo.health_consents where id = v_scope.consent_id;
  if v_consent.id is null then return '{"error":"consent_required"}'; end if;
  if v_consent.withdrawn_at is not null then return '{"error":"consent_withdrawn"}'; end if;
  v_epoch := v_scope.epoch;
  -- A replay cannot bypass a later withdrawal or epoch change.
  if v_prior.request_id is not null then
    if v_epoch is distinct from (v_prior.response->>'consent_epoch')::integer then return '{"error":"epoch_conflict"}'; end if;
    return jsonb_set(v_prior.response, '{replayed}', 'true');
  end if;
  if (v_body->>'consent_epoch') is null or (v_body->>'consent_epoch') !~ '^[0-9]{1,9}$' then return '{"error":"invalid_request"}'; end if;
  if (v_body->>'consent_epoch')::integer <> v_epoch then return '{"error":"epoch_conflict"}'; end if;
  if jsonb_typeof(v_body->'samples') is distinct from 'array' or jsonb_typeof(v_body->'deletions') is distinct from 'array'
    or jsonb_array_length(v_body->'samples') + jsonb_array_length(v_body->'deletions') > 128
    or jsonb_typeof(v_body->'anchor_after') is distinct from 'string' or char_length(v_body->>'anchor_after') not between 1 and 2048
    or jsonb_typeof(v_body->'anchor_before') not in ('string','null')
    or not exists (select 1 from pg_timezone_names where name = v_body->>'timezone') then return '{"error":"invalid_request"}'; end if;
  -- The anchor is an opaque compare-and-set cursor. A null anchor is always a resync; samples are idempotent.
  if jsonb_typeof(v_body->'anchor_before') = 'string' then
    select anchor into v_anchor from waldo.health_anchors where owner_id = v_owner and source = v_source;
    if v_anchor is distinct from (v_body->>'anchor_before') then return '{"error":"anchor_conflict"}'; end if;
  end if;
  for v_change in select value from jsonb_array_elements(v_body->'samples') loop
    v_signal := v_change->>'signal'; v_sample_id := v_change->>'sample_id';
    select r.unit, r.lo, r.hi, r.windowed into v_unit, v_lo, v_hi, v_windowed from (values
      ('sleep_duration','minutes',0,1440,false), ('sleep_efficiency','ratio',0,1,false), ('sleep_midpoint','local_minute',0,1439.999,false),
      ('overnight_hrv','milliseconds',0.000001,1000,false), ('resting_heart_rate','beats_per_minute',0.000001,300,false),
      ('daylight_duration','minutes',0,60,true), ('movement_duration','minutes',0,60,true), ('heart_rate_window','beats_per_minute',0.000001,300,true),
      ('hrv_window','milliseconds',0.000001,1000,true), ('spo2','percent',50,100,false), ('respiratory_rate','breaths_per_minute',4,80,false),
      ('steps_window','count',0,300000,true), ('active_energy_window','kilocalories',0,30000,true), ('workout','minutes',0,1440,false)
    ) r(signal, unit, lo, hi, windowed) where r.signal = v_signal;
    if v_unit is null or v_sample_id is null or v_sample_id !~ '^[A-Za-z0-9._:-]{1,128}$'
      or (v_change->>'revision') is null or (v_change->>'revision') !~ '^[0-9]{1,15}$'
      or jsonb_typeof(v_change->'value') is distinct from 'number' or v_change->>'unit' is distinct from v_unit
      or (v_change->>'utc_offset_minutes') is null or (v_change->>'utc_offset_minutes') !~ '^-?[0-9]{1,3}$' then raise exception 'invalid health sample' using errcode = '22023'; end if;
    v_revision := (v_change->>'revision')::bigint; v_value := (v_change->>'value')::numeric; v_offset := (v_change->>'utc_offset_minutes')::integer;
    v_day := (v_change->>'day')::date; v_start := (v_change->>'start_at')::timestamptz; v_end := (v_change->>'end_at')::timestamptz;
    if v_day is null or v_start is null or v_end is null or not isfinite(v_day) or not isfinite(v_start) or not isfinite(v_end) then raise exception 'invalid health sample' using errcode = '22023'; end if;
    v_local_start := ((v_start at time zone 'UTC') + make_interval(mins => v_offset))::date; v_local_end := ((v_end at time zone 'UTC') + make_interval(mins => v_offset))::date;
    -- A window is one local hour dated by its start and may still be running; a point record or a sleep session is over.
    if v_value not between v_lo and v_hi or v_offset not between -840 and 840 or v_start > v_end or v_revision > v_now_epoch + 300
      or (v_windowed and v_start > now() + interval '5 minutes') or (not v_windowed and v_end > now() + interval '5 minutes')
      or (v_windowed and v_day <> v_local_start) or (not v_windowed and v_day not in (v_local_start, v_local_end))
      or (v_windowed and (v_end - v_start <> interval '1 hour' or mod((extract(epoch from v_start)::bigint + v_offset * 60), 3600) <> 0))
      or (v_signal in ('overnight_hrv','hrv_window') and coalesce(v_change->>'method','') not in ('rmssd','sdnn')) then raise exception 'invalid health sample' using errcode = '22023'; end if;
    if v_end < now() - interval '90 days' then v_ignored := v_ignored + 1; continue; end if;
    select * into v_stored from waldo.health_samples where owner_id = v_owner and source = v_source and signal = v_signal and sample_id = v_sample_id;
    if found and v_stored.revision > v_revision then v_ignored := v_ignored + 1; continue; end if;
    if found and v_stored.revision = v_revision then
      -- Where a reading was read from may change without its value changing; only the readings themselves conflict.
      if v_stored.payload is not null and ((v_stored.payload - 'origin') is distinct from (v_change - 'origin')) then raise exception 'health sample revision conflict' using errcode = '40001'; end if;
      v_ignored := v_ignored + 1; continue;
    end if;
    insert into waldo.health_samples(owner_id, source, signal, sample_id, revision, epoch, day, start_at, end_at, utc_offset_minutes, timezone, payload, deleted_at)
      values (v_owner, v_source, v_signal, v_sample_id, v_revision, v_epoch, v_day, v_start, v_end, v_offset, v_body->>'timezone', v_change, null)
      on conflict (owner_id, source, signal, sample_id) do update set revision = excluded.revision, epoch = excluded.epoch, day = excluded.day, start_at = excluded.start_at,
        end_at = excluded.end_at, utc_offset_minutes = excluded.utc_offset_minutes, timezone = excluded.timezone, payload = excluded.payload, deleted_at = null;
    v_accepted := v_accepted + 1;
  end loop;
  for v_change in select value from jsonb_array_elements(v_body->'deletions') loop
    v_signal := v_change->>'signal'; v_sample_id := v_change->>'sample_id';
    if v_signal is null or v_signal not in ('sleep_duration','sleep_efficiency','sleep_midpoint','overnight_hrv','resting_heart_rate','daylight_duration','movement_duration','heart_rate_window','hrv_window','spo2','respiratory_rate','steps_window','active_energy_window','workout')
      or v_sample_id is null or v_sample_id !~ '^[A-Za-z0-9._:-]{1,128}$' or (v_change->>'revision') is null or (v_change->>'revision') !~ '^[0-9]{1,15}$'
      or (v_change->>'revision')::bigint > v_now_epoch + 300 then raise exception 'invalid health deletion' using errcode = '22023'; end if;
    v_revision := (v_change->>'revision')::bigint;
    select * into v_stored from waldo.health_samples where owner_id = v_owner and source = v_source and signal = v_signal and sample_id = v_sample_id;
    if found and v_stored.revision > v_revision then v_ignored := v_ignored + 1; continue; end if;
    if found and v_stored.payload is null then
      -- A newer deletion of a deleted reading raises the tombstone, so an older late reading cannot come back.
      if v_stored.revision < v_revision then
        update waldo.health_samples set revision = v_revision, epoch = v_epoch where owner_id = v_owner and source = v_source and signal = v_signal and sample_id = v_sample_id;
      end if;
      v_ignored := v_ignored + 1; continue;
    end if;
    insert into waldo.health_samples(owner_id, source, signal, sample_id, revision, epoch, payload, deleted_at) values (v_owner, v_source, v_signal, v_sample_id, v_revision, v_epoch, null, now())
      on conflict (owner_id, source, signal, sample_id) do update set revision = excluded.revision, epoch = excluded.epoch, day = null, start_at = null, end_at = null, utc_offset_minutes = null, timezone = null, payload = null, deleted_at = now();
    v_deleted := v_deleted + 1;
  end loop;
  insert into waldo.health_anchors(owner_id, source, epoch, anchor) values (v_owner, v_source, v_epoch, v_body->>'anchor_after')
    on conflict (owner_id, source) do update set epoch = excluded.epoch, anchor = excluded.anchor;
  v_result := jsonb_build_object('request_id', v_id, 'source', v_source, 'consent_epoch', v_epoch, 'accepted', v_accepted, 'deleted', v_deleted, 'ignored', v_ignored, 'anchor_after', v_body->>'anchor_after', 'replayed', false);
  insert into waldo.health_requests(owner_id, request_id, operation, payload_digest, response) values (v_owner, v_id, 'ingest', md5(p_payload), v_result);
  return v_result;
exception
  when data_exception then return '{"error":"invalid_request"}';
  when serialization_failure then return '{"error":"sample_conflict"}';
end $$;

-- A provider connection holds the owner's tokens in Vault like Google's, and a provider's own account id resolves to
-- exactly one owner: a second owner linking the same WHOOP account is refused instead of reading the first one's data.
alter table waldo.connections drop constraint connections_provider_check;
alter table waldo.connections add constraint connections_provider_check check (provider in ('google','whoop'));
create unique index connections_live_provider_account on waldo.connections (provider, account) where provider = 'whoop' and status <> 'revoked';

-- A WHOOP webhook names only the provider's user id. Map it to the owner whose live connection holds that account, so the
-- Worker can wake that owner's object; nothing is stored and nothing but the do_name and connection id comes back.
create function waldo.health_provider_route(p_provider text, p_account text, p_at bigint, p_sig text) returns table(do_name text, connection uuid)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not waldo.router_signed('provroute.' || p_provider || '.' || lower(p_account), p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  return query select o.do_name, c.id from waldo.connections c join waldo.owners o on o.id = c.owner_id
    where c.provider = p_provider and p_provider = 'whoop' and c.account = lower(p_account) and c.status <> 'revoked' and o.state = 'active';
end $$;
revoke all on function waldo.health_provider_route(text, text, bigint, text) from public;
grant execute on function waldo.health_provider_route(text, text, bigint, text) to anon;

-- A WHOOP connection starts from the app, so the attempt a callback must match is a connect session like Google's:
-- single use, thirty minutes, only the hash of the state stored.
alter table waldo.connect_sessions drop constraint connect_sessions_provider_check;
alter table waldo.connect_sessions add constraint connect_sessions_provider_check check (provider in ('google','whoop'));
