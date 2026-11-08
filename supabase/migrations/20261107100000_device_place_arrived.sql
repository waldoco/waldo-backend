-- Device context: a place upload may say the phone just arrived at a place the owner named on it, home or the gym, so arriving
-- brings Waldo's next look forward the same way a move does (device-context ADR §9). The phone keeps those places and their
-- positions; the upload carries only the word. Its answer gains `arrived`: the word, for a reading observed within the hour that
-- is not superseded, while the owner lets Waldo's model read place (model_processing); otherwise null. Nothing new is stored, and
-- the stored receipt never holds it. Re-created whole from 20261106190000; only the arrival lines are new.
-- Order: deploy the Worker that strips `arrived` first, then apply this; to roll back, revert this first.

create or replace function waldo.device_context_place_ingest(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := waldo.device_context_owner('place_ingest', p_do_name, p_payload, p_at, p_sig);
  v_body jsonb; v_reading jsonb; v_id text; v_prior waldo.device_context_requests; v_epoch integer; v_device uuid; v_observed timestamptz;
  v_place jsonb; v_refusal jsonb; v_status text := 'accepted'; v_result jsonb;
  v_was waldo.device_place_latest; v_moved boolean := false; v_arrived text;
begin
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  perform 1 from waldo.owners where id = v_owner for update;
  if octet_length(p_payload) > 4096 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object'
    or exists (select 1 from jsonb_object_keys(v_body) k where k not in ('request_id', 'expected_epoch', 'device_id', 'place', 'arrived'))
    or (v_body ? 'arrived' and (jsonb_typeof(v_body->'arrived') is distinct from 'string' or v_body->>'arrived' not in ('home', 'gym'))) then return '{"error":"invalid_request"}'; end if;
  v_id := v_body->>'request_id'; v_reading := v_body->'place';
  if jsonb_typeof(v_body->'request_id') is distinct from 'string' or v_id !~ '^[A-Za-z0-9_-]{8,96}$'
    or jsonb_typeof(v_body->'expected_epoch') is distinct from 'number' or (v_body->>'expected_epoch') !~ '^[0-9]{1,9}$'
    or jsonb_typeof(v_body->'device_id') is distinct from 'string' or (v_body->>'device_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(v_reading) is distinct from 'object'
    or exists (select 1 from jsonb_object_keys(v_reading) k where k not in ('cell', 'locality', 'region', 'country', 'timezone', 'platform', 'observed_at'))
    or (v_reading ? 'cell' and (jsonb_typeof(v_reading->'cell') is distinct from 'string' or (v_reading->>'cell') !~ '^[0-9b-hjkmnp-z]{5}$'))
    or (not v_reading ? 'cell' and (v_reading ?| array['locality', 'region', 'country']))
    or exists (select 1 from jsonb_each(v_reading - array['cell', 'timezone', 'platform', 'observed_at']) e where jsonb_typeof(e.value) is distinct from 'string')
    or not waldo.device_place_names_ok(v_reading->>'locality', v_reading->>'region')
    or jsonb_typeof(v_reading->'timezone') is distinct from 'string' or not exists (select 1 from pg_timezone_names where name = v_reading->>'timezone')
    or v_reading->>'platform' is null or v_reading->>'platform' not in ('ios', 'android')
    or jsonb_typeof(v_reading->'observed_at') is distinct from 'string' then return '{"error":"invalid_request"}'; end if;
  begin v_observed := (v_reading->>'observed_at')::timestamptz; exception when others then return '{"error":"invalid_request"}'; end;
  if v_observed > now() + interval '10 minutes' or v_observed < now() - interval '30 days' then return '{"error":"invalid_request"}'; end if;
  select * into v_prior from waldo.device_context_requests where owner_id = v_owner and request_id = v_id;
  if found then
    if v_prior.operation <> 'place_ingest' or v_prior.payload_digest <> md5(p_payload) then return '{"error":"idempotency_conflict"}'; end if;
    return jsonb_set(v_prior.response, '{replayed}', 'true');
  end if;
  v_refusal := waldo.device_context_refusal(v_owner, 'place', array['storage_compute']);
  if v_refusal is not null then return v_refusal; end if;
  select epoch into v_epoch from waldo.device_context_scopes where owner_id = v_owner and signal = 'place' and purpose = 'storage_compute';
  if (v_body->>'expected_epoch')::integer <> v_epoch then return '{"error":"epoch_conflict"}'; end if;
  v_device := (v_body->>'device_id')::uuid;
  if not exists (select 1 from waldo.device_place_latest where owner_id = v_owner and device_id = v_device)
    and (select count(*) from waldo.device_place_latest where owner_id = v_owner) >= 8 then return '{"error":"invalid_request"}'; end if;
  if v_reading ? 'cell' then v_place := v_reading - array['timezone', 'platform', 'observed_at']; end if;
  select * into v_was from waldo.device_place_latest where owner_id = v_owner and device_id = v_device;
  -- Moved: this newer reading puts the phone in another time zone, or in another named city or country, than the row it
  -- replaces. A first reading, a reading that loses to a newer one, or a cell without names is not a move.
  if found then
    v_moved := (v_was.timezone_observed_at <= v_observed and v_reading->>'timezone' is distinct from v_was.timezone)
      or (v_place is not null and v_was.place is not null and v_was.place_observed_at <= v_observed
        and v_place->>'locality' is not null and v_was.place->>'locality' is not null
        and (v_place->>'locality' is distinct from v_was.place->>'locality'
          or (v_place->>'country' is not null and v_was.place->>'country' is not null and v_place->>'country' is distinct from v_was.place->>'country')));
    v_moved := v_moved and waldo.device_context_refusal(v_owner, 'place', array['storage_compute', 'model_processing']) is null;
  end if;
  -- Arrived: the phone says it just reached a place the owner named on it. Told only for a reading observed within the hour, and
  -- only while the owner lets Waldo's model read place; never stored.
  if v_body ? 'arrived' and v_observed >= now() - interval '1 hour'
    and waldo.device_context_refusal(v_owner, 'place', array['storage_compute', 'model_processing']) is null then v_arrived := v_body->>'arrived'; end if;
  insert into waldo.device_place_latest as t (owner_id, device_id, epoch, platform, timezone, timezone_observed_at, place, place_observed_at)
    values (v_owner, v_device, v_epoch, v_reading->>'platform', v_reading->>'timezone', v_observed, v_place, case when v_place is not null then v_observed end)
    on conflict (owner_id, device_id) do update set
      epoch = excluded.epoch,
      platform = case when t.timezone_observed_at <= excluded.timezone_observed_at then excluded.platform else t.platform end,
      timezone = case when t.timezone_observed_at <= excluded.timezone_observed_at then excluded.timezone else t.timezone end,
      timezone_observed_at = greatest(t.timezone_observed_at, excluded.timezone_observed_at),
      place = case when excluded.place is not null and (t.place_observed_at is null or t.place_observed_at <= excluded.place_observed_at) then excluded.place else t.place end,
      place_observed_at = case when excluded.place is not null and (t.place_observed_at is null or t.place_observed_at <= excluded.place_observed_at) then excluded.place_observed_at else t.place_observed_at end,
      received_at = now()
    where t.timezone_observed_at <= excluded.timezone_observed_at
      or (excluded.place is not null and (t.place_observed_at is null or t.place_observed_at <= excluded.place_observed_at));
  if not found then v_status := 'superseded'; v_moved := false; v_arrived := null; end if;
  v_result := jsonb_build_object('request_id', v_id, 'replayed', false, 'status', v_status);
  insert into waldo.device_context_requests (owner_id, request_id, operation, payload_digest, response) values (v_owner, v_id, 'place_ingest', md5(p_payload), v_result);
  return v_result || jsonb_build_object('moved', v_moved, 'arrived', v_arrived);
end $$;
