-- The handle's Email Routing rule, and the signed calls that claim and release a handle. The owner's object is the only
-- caller: it records each claim here before it creates the rule, and reports the outcome back. A handle routes mail
-- whatever its rule state; the state is what the owner is shown.
alter table waldo.agent_mail_handles add column rule_state text not null default 'pending'
  check (rule_state in ('pending', 'live', 'failed', 'unknown'));

-- Claims one handle for the owner. A different handle the owner held is released in the same transaction (its release
-- record keeps it from anyone for 180 days); the owner's current handle claimed again after its rule failed is retried.
-- Cloudflare holds at most 200 routing rules per zone: new claims stop at 190, leaving room for the team's own addresses.
create function waldo.claim_agent_mail_handle(p_do_name text, p_handle text, p_at bigint, p_sig text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_current text; v_state text;
begin
  if not waldo.router_signed('mailclaim.' || p_do_name || '.' || p_handle, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select id into v_owner from waldo.owners where do_name = p_do_name and state = 'active' for update;
  if v_owner is null then return 'no_owner'; end if;
  select handle, rule_state into v_current, v_state from waldo.agent_mail_handles where owner_id = v_owner;
  if v_current = p_handle then
    if v_state in ('failed', 'unknown') then
      update waldo.agent_mail_handles set rule_state = 'pending' where handle = p_handle;
      return 'claimed';
    end if;
    return 'unchanged';
  end if;
  perform pg_advisory_xact_lock(hashtext('waldo.agent_mail_handles'));
  if v_current is null and (select count(*) from waldo.agent_mail_handles) >= 190 then return 'full'; end if;
  begin
    delete from waldo.agent_mail_handles where owner_id = v_owner;
    insert into waldo.agent_mail_handles (handle, owner_id) values (p_handle, v_owner);
  exception
    when unique_violation then return 'taken';
    when check_violation then return 'unavailable';
  end;
  return 'claimed';
end $$;

-- Releases the owner's handle, whatever the owner's state. Its route stops at once; the owner's object deletes its rule.
create function waldo.release_agent_mail_handle(p_do_name text, p_at bigint, p_sig text) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if not waldo.router_signed('mailrelease.' || p_do_name, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  delete from waldo.agent_mail_handles h using waldo.owners o where h.owner_id = o.id and o.do_name = p_do_name;
  return case when found then 'released' else 'none' end;
end $$;

create function waldo.agent_mail_handle(p_do_name text, p_at bigint, p_sig text)
returns table (handle text, rule_state text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not waldo.router_signed('mailhandle.' || p_do_name, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  return query select h.handle, h.rule_state from waldo.agent_mail_handles h join waldo.owners o on o.id = h.owner_id
    where o.do_name = p_do_name;
end $$;

-- Reports how creating the rule ended. Only a pending handle of this owner moves: a handle released or renamed while the
-- rule was being made answers false, and the owner's object deletes what it made.
create function waldo.settle_agent_mail_rule(p_do_name text, p_handle text, p_state text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not waldo.router_signed('mailsettle.' || p_do_name || '.' || p_handle || '.' || p_state, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  if p_state not in ('live', 'failed', 'unknown') then raise exception 'rule state' using errcode = '22023'; end if;
  update waldo.agent_mail_handles h set rule_state = p_state from waldo.owners o
    where h.owner_id = o.id and o.do_name = p_do_name and h.handle = p_handle and h.rule_state = 'pending';
  return found;
end $$;

-- Which of these comma-separated handles any owner holds: the rule sweep deletes only rules no held handle accounts for.
create function waldo.agent_mail_held_handles(p_handles text, p_at bigint, p_sig text) returns setof text
language plpgsql stable security definer set search_path = '' as $$
begin
  if not waldo.router_signed('mailheld.' || p_handles, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  return query select h.handle from waldo.agent_mail_handles h where h.handle = any (string_to_array(p_handles, ','));
end $$;

-- Signed like route_agent_mail: the Worker's publishable key is the anon role, and the router signature is the gate.
revoke all on function waldo.claim_agent_mail_handle(text, text, bigint, text) from public, anon, authenticated, service_role;
revoke all on function waldo.release_agent_mail_handle(text, bigint, text) from public, anon, authenticated, service_role;
revoke all on function waldo.agent_mail_handle(text, bigint, text) from public, anon, authenticated, service_role;
revoke all on function waldo.settle_agent_mail_rule(text, text, text, bigint, text) from public, anon, authenticated, service_role;
revoke all on function waldo.agent_mail_held_handles(text, bigint, text) from public, anon, authenticated, service_role;
grant execute on function waldo.claim_agent_mail_handle(text, text, bigint, text) to anon;
grant execute on function waldo.release_agent_mail_handle(text, bigint, text) to anon;
grant execute on function waldo.agent_mail_handle(text, bigint, text) to anon;
grant execute on function waldo.settle_agent_mail_rule(text, text, text, bigint, text) to anon;
grant execute on function waldo.agent_mail_held_handles(text, bigint, text) to anon;
