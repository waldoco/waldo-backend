-- Weather for the owner's place (Wave 2 B3): the agent's get_weather reads the latest cell with purpose weather, which the
-- database grants only while storage, model use and provider lookup are all granted, so withdrawing provider_lookup alone stops
-- every weather call while the place itself still works. The Worker sends the cell's centre, with no owner or device id, to the
-- weather provider; nothing about the call is stored here. The design is docs/proposals/ADR_DEVICE_CONTEXT_2026-11-05.md.

-- The latest zone and place per device, most recently heard from first, leaving out a zone or a cell observed more than 30 days
-- ago even before the sweep reaches it. purpose owner is the owner's own view and needs storage consent; purpose model is the
-- agent's read and needs storage and model use; purpose weather is the agent's weather lookup, which sends the cell's centre to
-- the provider the consent names, and needs all three.
create or replace function waldo.device_context_place_read(p_do_name text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := waldo.device_context_owner('place_read', p_do_name, p_payload, p_at, p_sig); v_body jsonb; v_refusal jsonb;
begin
  if v_owner is null then return '{"error":"not_linked"}'; end if;
  if octet_length(p_payload) > 256 then return '{"error":"invalid_request"}'; end if;
  begin v_body := p_payload::jsonb; exception when others then return '{"error":"invalid_request"}'; end;
  if jsonb_typeof(v_body) is distinct from 'object' or exists (select 1 from jsonb_object_keys(v_body) k where k <> 'purpose')
    or v_body->>'purpose' is null or v_body->>'purpose' not in ('owner', 'model', 'weather') then return '{"error":"invalid_request"}'; end if;
  v_refusal := waldo.device_context_refusal(v_owner, 'place', case v_body->>'purpose'
    when 'model' then array['storage_compute', 'model_processing']
    when 'weather' then array['storage_compute', 'model_processing', 'provider_lookup']
    else array['storage_compute'] end);
  if v_refusal is not null then return v_refusal; end if;
  return jsonb_build_object('places', coalesce((select jsonb_agg(jsonb_build_object('device_id', p.device_id,
      'received_at', to_char(p.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'platform', p.platform, 'timezone', p.timezone,
      'timezone_observed_at', to_char(p.timezone_observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'place', case when p.place is null or p.place_observed_at < now() - interval '30 days' then null else p.place || jsonb_build_object('observed_at',
        to_char(p.place_observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) end)
      order by p.timezone_observed_at desc, p.device_id)
    from waldo.device_place_latest p where p.owner_id = v_owner and p.timezone_observed_at >= now() - interval '30 days'), '[]'::jsonb));
end $$;
