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

-- Crossed-clock guard (owner re-review): a CLICKED ticket is an OAuth flow in flight. When the
-- owner reopens the link after the resolve window, report expired truthfully, but do NOT rewrite
-- the row - only an unclicked (issued) ticket transitions to expired. The pending callback then
-- still settles through connect_session_complete, authorized by the single-use state nonce.
create or replace function waldo.connect_session_resolve(p_ticket_hash text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_row waldo.connect_sessions; v_do text;
begin
  if not waldo.router_signed('connsess.resolve.' || p_ticket_hash, p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  select * into v_row from waldo.connect_sessions where ticket_hash = p_ticket_hash;
  if not found then return null; end if;
  if v_row.status in ('completed', 'revoked') then return jsonb_build_object('status', v_row.status); end if;
  if v_row.status = 'expired' or v_row.expires_at <= now() then
    if v_row.status = 'issued' then update waldo.connect_sessions set status = 'expired' where id = v_row.id; end if;
    return jsonb_build_object('status', 'expired');
  end if;
  select do_name into v_do from waldo.owners where id = v_row.owner_id and state = 'active';
  if v_do is null then return jsonb_build_object('status', 'revoked'); end if;
  update waldo.connect_sessions set status = 'clicked', clicked_at = coalesce(clicked_at, now()) where id = v_row.id;
  return jsonb_build_object('status', 'ok', 'do_name', v_do, 'provider', v_row.provider, 'session', v_row.id);
end $$;
