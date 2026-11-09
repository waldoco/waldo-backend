-- Device place, after the gate's second look at 20261105180000:
-- - A place name may not carry a position in any script. Digits are counted as Unicode decimal digits, not only 0-9: a
--   coordinate in Devanagari, Arabic-Indic or fullwidth digits counts the same. The four-digit cap now covers locality and
--   region together, so two names cannot hold eight digits between them. The ranges below are Unicode 17's decimal digits (Nd),
--   spelled out because the database's character classes follow its locale and miss them under C, and the spacing around a
--   decimal separator is JavaScript's \s (no-break spaces included), so the contract's check and this one agree.
-- - A place kept under the first rule whose names now carry too much keeps its cell, zone and times and loses only those names,
--   before the stricter check goes on, so no stored row stops the migration or a later zone-only upload.
-- - Granting a purpose that is already granted, at the epoch the app read for it, is a no-op that answers the consent as it
--   stands, so an app that re-reads the epochs and retries the same consent screen does not loop on epoch_conflict.

create function waldo.device_place_digits(p_name text) returns integer
language sql immutable set search_path = '' as $$
  select coalesce(length(p_name) - length(regexp_replace(p_name, '[\u0030-\u0039\u0660-\u0669\u06F0-\u06F9\u07C0-\u07C9\u0966-\u096F\u09E6-\u09EF\u0A66-\u0A6F\u0AE6-\u0AEF\u0B66-\u0B6F\u0BE6-\u0BEF\u0C66-\u0C6F\u0CE6-\u0CEF\u0D66-\u0D6F\u0DE6-\u0DEF\u0E50-\u0E59\u0ED0-\u0ED9\u0F20-\u0F29\u1040-\u1049\u1090-\u1099\u17E0-\u17E9\u1810-\u1819\u1946-\u194F\u19D0-\u19D9\u1A80-\u1A89\u1A90-\u1A99\u1B50-\u1B59\u1BB0-\u1BB9\u1C40-\u1C49\u1C50-\u1C59\uA620-\uA629\uA8D0-\uA8D9\uA900-\uA909\uA9D0-\uA9D9\uA9F0-\uA9F9\uAA50-\uAA59\uABF0-\uABF9\uFF10-\uFF19\U000104A0-\U000104A9\U00010D30-\U00010D39\U00010D40-\U00010D49\U00011066-\U0001106F\U000110F0-\U000110F9\U00011136-\U0001113F\U000111D0-\U000111D9\U000112F0-\U000112F9\U00011450-\U00011459\U000114D0-\U000114D9\U00011650-\U00011659\U000116C0-\U000116C9\U000116D0-\U000116E3\U00011730-\U00011739\U000118E0-\U000118E9\U00011950-\U00011959\U00011BF0-\U00011BF9\U00011C50-\U00011C59\U00011D50-\U00011D59\U00011DA0-\U00011DA9\U00011DE0-\U00011DE9\U00011F50-\U00011F59\U00016130-\U00016139\U00016A60-\U00016A69\U00016AC0-\U00016AC9\U00016B50-\U00016B59\U00016D70-\U00016D79\U0001CCF0-\U0001CCF9\U0001D7CE-\U0001D7FF\U0001E140-\U0001E149\U0001E2F0-\U0001E2F9\U0001E4F0-\U0001E4F9\U0001E5F1-\U0001E5FA\U0001E950-\U0001E959\U0001FBF0-\U0001FBF9]', '', 'g')), 0) $$;

-- No decimal number, no degree sign (or the ordinal or ring mark written for one), and at most four digits across both names:
-- "Sector 128" fits, "12.97,77.59" does not, in any script.
create function waldo.device_place_names_ok(p_locality text, p_region text) returns boolean
language sql immutable set search_path = '' as $$
  select waldo.device_place_digits(p_locality) + waldo.device_place_digits(p_region) <= 4
    and not exists (select 1 from unnest(array[p_locality, p_region]) n
      where n ~ '[\u0030-\u0039\u0660-\u0669\u06F0-\u06F9\u07C0-\u07C9\u0966-\u096F\u09E6-\u09EF\u0A66-\u0A6F\u0AE6-\u0AEF\u0B66-\u0B6F\u0BE6-\u0BEF\u0C66-\u0C6F\u0CE6-\u0CEF\u0D66-\u0D6F\u0DE6-\u0DEF\u0E50-\u0E59\u0ED0-\u0ED9\u0F20-\u0F29\u1040-\u1049\u1090-\u1099\u17E0-\u17E9\u1810-\u1819\u1946-\u194F\u19D0-\u19D9\u1A80-\u1A89\u1A90-\u1A99\u1B50-\u1B59\u1BB0-\u1BB9\u1C40-\u1C49\u1C50-\u1C59\uA620-\uA629\uA8D0-\uA8D9\uA900-\uA909\uA9D0-\uA9D9\uA9F0-\uA9F9\uAA50-\uAA59\uABF0-\uABF9\uFF10-\uFF19\U000104A0-\U000104A9\U00010D30-\U00010D39\U00010D40-\U00010D49\U00011066-\U0001106F\U000110F0-\U000110F9\U00011136-\U0001113F\U000111D0-\U000111D9\U000112F0-\U000112F9\U00011450-\U00011459\U000114D0-\U000114D9\U00011650-\U00011659\U000116C0-\U000116C9\U000116D0-\U000116E3\U00011730-\U00011739\U000118E0-\U000118E9\U00011950-\U00011959\U00011BF0-\U00011BF9\U00011C50-\U00011C59\U00011D50-\U00011D59\U00011DA0-\U00011DA9\U00011DE0-\U00011DE9\U00011F50-\U00011F59\U00016130-\U00016139\U00016A60-\U00016A69\U00016AC0-\U00016AC9\U00016B50-\U00016B59\U00016D70-\U00016D79\U0001CCF0-\U0001CCF9\U0001D7CE-\U0001D7FF\U0001E140-\U0001E149\U0001E2F0-\U0001E2F9\U0001E4F0-\U0001E4F9\U0001E5F1-\U0001E5FA\U0001E950-\U0001E959\U0001FBF0-\U0001FBF9][\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*[.,\u00B7\u066B\u066C\uFF0C\uFF0E][\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*[\u0030-\u0039\u0660-\u0669\u06F0-\u06F9\u07C0-\u07C9\u0966-\u096F\u09E6-\u09EF\u0A66-\u0A6F\u0AE6-\u0AEF\u0B66-\u0B6F\u0BE6-\u0BEF\u0C66-\u0C6F\u0CE6-\u0CEF\u0D66-\u0D6F\u0DE6-\u0DEF\u0E50-\u0E59\u0ED0-\u0ED9\u0F20-\u0F29\u1040-\u1049\u1090-\u1099\u17E0-\u17E9\u1810-\u1819\u1946-\u194F\u19D0-\u19D9\u1A80-\u1A89\u1A90-\u1A99\u1B50-\u1B59\u1BB0-\u1BB9\u1C40-\u1C49\u1C50-\u1C59\uA620-\uA629\uA8D0-\uA8D9\uA900-\uA909\uA9D0-\uA9D9\uA9F0-\uA9F9\uAA50-\uAA59\uABF0-\uABF9\uFF10-\uFF19\U000104A0-\U000104A9\U00010D30-\U00010D39\U00010D40-\U00010D49\U00011066-\U0001106F\U000110F0-\U000110F9\U00011136-\U0001113F\U000111D0-\U000111D9\U000112F0-\U000112F9\U00011450-\U00011459\U000114D0-\U000114D9\U00011650-\U00011659\U000116C0-\U000116C9\U000116D0-\U000116E3\U00011730-\U00011739\U000118E0-\U000118E9\U00011950-\U00011959\U00011BF0-\U00011BF9\U00011C50-\U00011C59\U00011D50-\U00011D59\U00011DA0-\U00011DA9\U00011DE0-\U00011DE9\U00011F50-\U00011F59\U00016130-\U00016139\U00016A60-\U00016A69\U00016AC0-\U00016AC9\U00016B50-\U00016B59\U00016D70-\U00016D79\U0001CCF0-\U0001CCF9\U0001D7CE-\U0001D7FF\U0001E140-\U0001E149\U0001E2F0-\U0001E2F9\U0001E4F0-\U0001E4F9\U0001E5F1-\U0001E5FA\U0001E950-\U0001E959\U0001FBF0-\U0001FBF9]' or n ~ '[\u00B0\u00BA\u02DA]') $$;

update waldo.device_place_latest set place = place - array['locality', 'region']
  where place is not null and not waldo.device_place_names_ok(place->>'locality', place->>'region');

alter table waldo.device_place_latest drop constraint device_place_latest_place_check,
  add constraint device_place_latest_place_check check (place is null or (jsonb_typeof(place) = 'object' and place->>'cell' ~ '^[0-9b-hjkmnp-z]{5}$'
    and waldo.device_place_names_ok(place->>'locality', place->>'region')));

-- As before, with one change: a purpose already granted, read at its current epoch, answers null as granted and changes nothing.
create or replace function waldo.device_context_grant(p_owner uuid, p_signal text, p_purpose text, p_expected integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_scope waldo.device_context_scopes; v_consent uuid;
begin
  select * into v_scope from waldo.device_context_scopes where owner_id = p_owner and signal = p_signal and purpose = p_purpose for update;
  if p_expected <> coalesce(v_scope.epoch, 0) then return '{"error":"epoch_conflict"}'; end if;
  -- Model use and provider lookup sit on top of storage.
  if p_purpose <> 'storage_compute' and waldo.device_context_refusal(p_owner, p_signal, array['storage_compute']) is not null then return '{"error":"consent_required"}'; end if;
  if exists (select 1 from waldo.device_context_consents where owner_id = p_owner and signal = p_signal and purpose = p_purpose and withdrawn_at is null) then
    return null;
  end if;
  insert into waldo.device_context_consents (owner_id, signal, purpose, version) values (p_owner, p_signal, p_purpose, 1) returning id into v_consent;
  insert into waldo.device_context_scopes (owner_id, signal, purpose, epoch, consent_id) values (p_owner, p_signal, p_purpose, 1, v_consent)
    on conflict (owner_id, signal, purpose) do update set epoch = waldo.device_context_scopes.epoch + 1, consent_id = excluded.consent_id;
  return null;
end $$;

-- As before, with the names checked together.
create or replace function waldo.device_context_place_ingest(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := waldo.device_context_owner('place_ingest', p_do_name, p_payload, p_at, p_sig);
  v_body jsonb; v_reading jsonb; v_id text; v_prior waldo.device_context_requests; v_epoch integer; v_device uuid; v_observed timestamptz;
  v_place jsonb; v_refusal jsonb; v_status text := 'accepted'; v_result jsonb;
begin
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  perform 1 from waldo.owners where id = v_owner for update;
  if octet_length(p_payload) > 4096 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object'
    or exists (select 1 from jsonb_object_keys(v_body) k where k not in ('request_id', 'expected_epoch', 'device_id', 'place')) then return '{"error":"invalid_request"}'; end if;
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
  if not found then v_status := 'superseded'; end if;
  v_result := jsonb_build_object('request_id', v_id, 'replayed', false, 'status', v_status);
  insert into waldo.device_context_requests (owner_id, request_id, operation, payload_digest, response) values (v_owner, v_id, 'place_ingest', md5(p_payload), v_result);
  return v_result;
end $$;

drop function waldo.device_place_name_ok(text);
revoke all on function waldo.device_place_digits(text), waldo.device_place_names_ok(text, text) from public, anon, authenticated, service_role;
