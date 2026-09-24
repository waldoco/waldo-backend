-- S2 (CONNECT_FLOW_DESIGN): short first-party connect tickets. The model never sees a consent URL;
-- chat carries /c/<ticket>, and the provider URL is minted at click time. Only the ticket hash is stored.
create table waldo.connect_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references waldo.owners (id),
  provider text not null check (provider in ('google')),
  channel text not null check (channel in ('telegram', 'console')),
  ticket_hash text not null,
  status text not null default 'issued' check (status in ('issued', 'clicked', 'completed', 'expired', 'revoked')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  clicked_at timestamptz,
  completed_at timestamptz
);
create unique index connect_sessions_live_ticket on waldo.connect_sessions (ticket_hash) where status in ('issued', 'clicked');
alter table waldo.connect_sessions enable row level security;
alter table waldo.connect_sessions force row level security;

-- Issue a ticket for an owner+provider. Re-issuing revokes any still-live tickets for the same pair.
create function waldo.connect_session_issue(p_do_name text, p_provider text, p_channel text, p_ticket_hash text, p_at bigint, p_sig text) returns uuid
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
    values (v_owner, p_provider, p_channel, p_ticket_hash, now() + interval '30 minutes')
    returning id into v_id;
  return v_id;
end $$;

-- Resolve a ticket at click time. Returns the owner handle and provider only, never the ticket.
-- Marks the session clicked (issued -> clicked); expired sessions report expired without a state change past it.
create function waldo.connect_session_resolve(p_ticket_hash text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_row waldo.connect_sessions; v_do text;
begin
  if not waldo.router_signed('connsess.resolve.' || p_ticket_hash, p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  select * into v_row from waldo.connect_sessions where ticket_hash = p_ticket_hash;
  if not found then return null; end if;
  if v_row.status in ('completed', 'revoked') then return jsonb_build_object('status', v_row.status); end if;
  if v_row.status = 'expired' or v_row.expires_at <= now() then
    if v_row.status <> 'expired' then update waldo.connect_sessions set status = 'expired' where id = v_row.id; end if;
    return jsonb_build_object('status', 'expired');
  end if;
  select do_name into v_do from waldo.owners where id = v_row.owner_id and state = 'active';
  if v_do is null then return jsonb_build_object('status', 'revoked'); end if;
  update waldo.connect_sessions set status = 'clicked', clicked_at = coalesce(clicked_at, now()) where id = v_row.id;
  return jsonb_build_object('status', 'ok', 'do_name', v_do, 'provider', v_row.provider, 'session', v_row.id);
end $$;

-- Settle a session after the consent callback links the account. Completes at most once.
create function waldo.connect_session_complete(p_ticket_hash text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not waldo.router_signed('connsess.complete.' || p_ticket_hash, p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  update waldo.connect_sessions set status = 'completed', completed_at = now()
    where ticket_hash = p_ticket_hash and status = 'clicked' and expires_at > now();
  return found;
end $$;

revoke all on function waldo.connect_session_issue(text, text, text, text, bigint, text) from public;
revoke all on function waldo.connect_session_resolve(text, bigint, text) from public;
revoke all on function waldo.connect_session_complete(text, bigint, text) from public;
grant execute on function waldo.connect_session_issue(text, text, text, text, bigint, text) to anon;
grant execute on function waldo.connect_session_resolve(text, bigint, text) to anon;
grant execute on function waldo.connect_session_complete(text, bigint, text) to anon;
