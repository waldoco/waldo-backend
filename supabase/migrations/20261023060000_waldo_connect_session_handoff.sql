-- A connect link handed to a surface that holds the owner's session (the app) carries a one-time handoff code. The hop
-- redeems the code once, binding the browser that presented it, and only then may that ticket's Continue run. So a link
-- copied out of the app, or the start address left after the code was spent, starts nothing in another browser. Chat
-- links are issued without a code and behave as before. Only the code's sha256 is stored. A code lives 10 minutes: the app
-- opens its link at once, so a copy that leaked unopened stops working soon, while the ticket keeps its own lifetime.
alter table waldo.connect_sessions
  add column handoff_hash text,
  add column handoff_expires_at timestamptz,
  add column handed_off_at timestamptz;

create function waldo.connect_session_issue_handoff(p_do_name text, p_provider text, p_channel text, p_ticket_hash text, p_handoff_hash text, p_at bigint, p_sig text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_id uuid;
begin
  if not waldo.router_signed('connsess.issue_handoff.' || p_do_name || '.' || p_provider || '.' || p_channel || '.' || p_ticket_hash || '.' || p_handoff_hash, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  v_owner := waldo.owner_id_for(p_do_name);
  if v_owner is null or p_ticket_hash = '' or p_handoff_hash = '' then return null; end if;
  update waldo.connect_sessions set status = 'revoked'
    where owner_id = v_owner and provider = p_provider and status in ('issued', 'clicked');
  insert into waldo.connect_sessions (owner_id, provider, channel, ticket_hash, expires_at, handoff_hash, handoff_expires_at)
    values (v_owner, p_provider, p_channel, p_ticket_hash, now() + interval '12 hours', p_handoff_hash, now() + interval '10 minutes')
    returning id into v_id;
  return v_id;
end $$;

-- Redeems the code once, for the one live, not yet begun ticket it was issued with. Any other ticket, a second
-- redemption, or a code past its 10 minutes finds nothing.
create function waldo.connect_session_hand_off(p_ticket_hash text, p_handoff_hash text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not waldo.router_signed('connsess.handoff.' || p_ticket_hash || '.' || p_handoff_hash, p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  update waldo.connect_sessions s set handed_off_at = now()
    where s.ticket_hash = p_ticket_hash and s.status in ('issued', 'clicked') and s.expires_at > now() and s.begun_at is null
      and s.handoff_hash = p_handoff_hash and s.handed_off_at is null and s.handoff_expires_at > now()
      and exists (select 1 from waldo.owners o where o.id = s.owner_id and o.state = 'active');
  return found;
end $$;

-- Resolve also says whether the ticket carries a code, so the hop knows to require the browser that redeemed it.
create or replace function waldo.connect_session_resolve(p_ticket_hash text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_row waldo.connect_sessions; v_do text; v_email text;
begin
  if not waldo.router_signed('connsess.resolve.' || p_ticket_hash, p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  select * into v_row from waldo.connect_sessions where ticket_hash = p_ticket_hash;
  if not found then return null; end if;
  if v_row.status in ('completed', 'revoked') then return jsonb_build_object('status', v_row.status); end if;
  if v_row.status = 'expired' or v_row.expires_at <= now() then
    if v_row.status = 'issued' then update waldo.connect_sessions set status = 'expired' where id = v_row.id; end if;
    return jsonb_build_object('status', 'expired');
  end if;
  select do_name, email into v_do, v_email from waldo.owners where id = v_row.owner_id and state = 'active';
  if v_do is null then return jsonb_build_object('status', 'revoked'); end if;
  update waldo.connect_sessions set status = 'clicked', clicked_at = coalesce(clicked_at, now()) where id = v_row.id;
  return jsonb_build_object('status', 'ok', 'do_name', v_do, 'provider', v_row.provider, 'session', v_row.id, 'begun', v_row.begun_at is not null,
    'handoff', v_row.handoff_hash is not null,
    'owner_hint', case when v_email is null or position('@' in v_email) < 2 then null
      else left(v_email, 1) || '•••' || substr(v_email, position('@' in v_email)) end);
end $$;

-- A ticket issued with a code begins only after its code was redeemed, whatever the caller checked.
create or replace function waldo.connect_session_begin(p_ticket_hash text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_do text;
begin
  if not waldo.router_signed('connsess.begin.' || p_ticket_hash, p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  select s.id, o.do_name into v_id, v_do from waldo.connect_sessions s join waldo.owners o on o.id = s.owner_id and o.state = 'active'
    where s.ticket_hash = p_ticket_hash and s.status in ('issued', 'clicked') and s.begun_at is null and s.expires_at > now()
      and (s.handoff_hash is null or s.handed_off_at is not null)
    for update of s;
  if v_id is null then return null; end if;
  update waldo.connect_sessions set status = 'clicked', clicked_at = coalesce(clicked_at, now()), begun_at = now() where id = v_id;
  return jsonb_build_object('status', 'ok', 'do_name', v_do);
end $$;

revoke all on function waldo.connect_session_issue_handoff(text, text, text, text, text, bigint, text) from public;
revoke all on function waldo.connect_session_hand_off(text, text, bigint, text) from public;
grant execute on function waldo.connect_session_issue_handoff(text, text, text, text, text, bigint, text) to anon;
grant execute on function waldo.connect_session_hand_off(text, text, bigint, text) to anon;
