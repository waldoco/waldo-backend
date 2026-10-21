-- A consent grant carries the version of the notice it rested on, and WHOOP has its own notice. Copy 2 is the device
-- sources' (it names intraday window summaries); copy 3 is WHOOP's: Waldo stores the owner's WHOOP data and an AI model provider,
-- a third party the owner opts into with the model-processing grant, processes it to plan the owner's day, which is the express
-- authorization WHOOP's terms ask for. The grant function accepts the
-- version of its own source's copy and stores it; the consent view shows it, including before a grant exists. Both functions
-- are re-created whole from their last definitions (20261021150000 and 20261011000000); only the version rules change.
-- The version column already takes any positive number, so no table changes.
create or replace function waldo.health_consent_view(p_scope waldo.health_scopes) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('consent_class','health_processing','source',p_scope.source,'purpose',p_scope.purpose,'version',coalesce(c.version,case when p_scope.source = 'whoop' then 3 else 2 end),
    'status',case when c.id is null then 'not_granted' when c.withdrawn_at is null then 'granted' else 'withdrawn' end,'epoch',p_scope.epoch,
    'granted_at',to_char(c.granted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'withdrawn_at',to_char(c.withdrawn_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'deletion_state',case when c.withdrawn_at is null then 'not_required'
      when p_scope.purpose = 'model_processing' and exists (select 1 from waldo.health_scopes s2 join waldo.health_consents c2 on c2.id = s2.consent_id
        where s2.owner_id = p_scope.owner_id and s2.source = p_scope.source and s2.purpose = 'storage_compute' and c2.withdrawn_at is null) then 'not_required'
      else 'completed' end)
  from (select 1) x left join waldo.health_consents c on c.id = p_scope.consent_id $$;

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
    or v_purpose is null or v_purpose not in ('storage_compute','model_processing')
    or v_body->>'version' is distinct from (case when v_source = 'whoop' then '3' else '2' end) or v_body->>'age_attested_18_plus' is distinct from 'true'
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
  if (v_body->>'expected_epoch')::integer <> v_epoch
    or exists (select 1 from waldo.health_consents c where c.owner_id = v_owner and c.source = v_source and c.purpose = v_purpose and c.withdrawn_at is null) then return '{"error":"epoch_conflict"}'; end if;
  insert into waldo.health_consents(owner_id, source, purpose, version, age_attested_18_plus) values (v_owner, v_source, v_purpose, case when v_source = 'whoop' then 3 else 2 end, true) returning * into v_consent;
  insert into waldo.health_scopes(owner_id, source, purpose, epoch, consent_id) values (v_owner, v_source, v_purpose, 1, v_consent.id)
    on conflict (owner_id, source, purpose) do update set epoch = waldo.health_scopes.epoch + 1, consent_id = excluded.consent_id returning * into v_scope;
  v_result := jsonb_build_object('consent', waldo.health_consent_view(v_scope), 'replayed', false, 'deletion_routed', false);
  insert into waldo.health_requests(owner_id, request_id, operation, payload_digest, response) values (v_owner, v_id, 'consent_grant', md5(p_payload), v_result);
  return v_result;
end $$;
