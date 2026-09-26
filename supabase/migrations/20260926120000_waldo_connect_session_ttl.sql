-- #215 owner release-blocking review: the owner-facing connect ticket still expired 30 minutes
-- after issue while the expired-page copy promised about 12 hours. Align the ticket lifetime
-- with the promise, and let a CLICKED ticket complete past its resolve window: after the click
-- the single-use OAuth state nonce (CONSENT_TTL_MS, enforced by the runtime at the callback)
-- governs the flow, so the ticket's resolve window is no longer the completion gate.
create or replace function waldo.connect_session_issue(p_do_name text, p_provider text, p_channel text, p_ticket_hash text, p_at bigint, p_sig text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_id uuid;
begin
  if not waldo.router_signed('connsess.issue.' || p_do_name || '.' || p_provider || '.' || p_channel || '.' || p_ticket_hash, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  v_owner := waldo.owner_id_for(p_do_name);
  if v_owner is null or p_ticket_hash = '' then return null; end if;
  update waldo.connect_sessions set status = 'revoked'
    where owner_id = v_owner and provider = p_provider and status in ('issued', 'clicked');
  insert into waldo.connect_sessions (owner_id, provider, channel, ticket_hash, expires_at)
    values (v_owner, p_provider, p_channel, p_ticket_hash, now() + interval '12 hours')
    returning id into v_id;
  return v_id;
end $$;

-- Completion keys off the click, not the resolve window: a flow clicked near ticket expiry can
-- finish the OAuth callback minutes later and must still record the completion. The state nonce
-- (single-use, own TTL) is what authorizes the callback; the ticket already did its job.
create or replace function waldo.connect_session_complete(p_ticket_hash text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not waldo.router_signed('connsess.complete.' || p_ticket_hash, p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  update waldo.connect_sessions set status = 'completed', completed_at = now()
    where ticket_hash = p_ticket_hash and status = 'clicked';
  return found;
end $$;
