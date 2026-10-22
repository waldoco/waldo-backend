-- A connect link is a bearer link: whoever opens it can start the owner's connect. So the hop shows whose Waldo the
-- account will join before it hands the browser to the provider, and its Continue runs once. Resolve now also returns
-- that owner as a masked hint (first character and domain of the email, never the address) and whether Continue
-- already ran; connect_session_begin is the single-use Continue. The ticket's status machine is unchanged, so a begun
-- ticket is still 'clicked' and completes exactly as before.
alter table waldo.connect_sessions add column begun_at timestamptz;

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
    'owner_hint', case when v_email is null or position('@' in v_email) < 2 then null
      else left(v_email, 1) || '•••' || substr(v_email, position('@' in v_email)) end);
end $$;

-- The Continue on the hop: succeeds once per live ticket. A second Continue, from any browser, finds it begun.
create function waldo.connect_session_begin(p_ticket_hash text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_do text;
begin
  if not waldo.router_signed('connsess.begin.' || p_ticket_hash, p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  select s.id, o.do_name into v_id, v_do from waldo.connect_sessions s join waldo.owners o on o.id = s.owner_id and o.state = 'active'
    where s.ticket_hash = p_ticket_hash and s.status in ('issued', 'clicked') and s.begun_at is null and s.expires_at > now()
    for update of s;
  if v_id is null then return null; end if;
  update waldo.connect_sessions set status = 'clicked', clicked_at = coalesce(clicked_at, now()), begun_at = now() where id = v_id;
  return jsonb_build_object('status', 'ok', 'do_name', v_do);
end $$;

revoke all on function waldo.connect_session_begin(text, bigint, text) from public;
grant execute on function waldo.connect_session_begin(text, bigint, text) to anon;
