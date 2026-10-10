-- Channels remain ingress/egress bindings. No account/session/browser/workspace
-- state is deleted by these operations. Reuse the existing signed router rail.
create function waldo.app_channel_owner(p_do_name text, p_session_hash text, p_expected_revision text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_revision text;
begin
  if p_do_name is null or length(p_do_name) not between 1 and 240 or p_session_hash is null
    or p_session_hash !~ '^[a-f0-9]{64}$' or p_expected_revision is null then return null; end if;
  select o.id, o.state_version::text || ':' || o.admission_revision::text into v_owner, v_revision
    from waldo.owners o join auth.users u on u.id = o.auth_user_id
    where o.do_name = p_do_name and o.state = 'active' for no key update of o;
  if v_owner is null or v_revision <> p_expected_revision then return null; end if;
  -- Row lock makes revocation and the bounded mutation serialize in one transaction.
  perform 1 from waldo.console_sessions s where s.owner_id = v_owner and s.session_hash = p_session_hash
    and s.created_at > now() - interval '12 hours' for share;
  if not found then return null; end if;
  return v_owner;
end $$;
revoke all on function waldo.app_channel_owner(text,text,text) from public,anon,authenticated,service_role;

create function waldo.owner_channel_inventory(p_do_name text, p_session_hash text, p_expected_revision text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if waldo.router_signed('app.channels.inventory.' || p_do_name || '.' || p_session_hash || '.' || p_expected_revision, p_at, p_sig) is distinct from true then
    raise exception 'unsigned channel call' using errcode = '42501'; end if;
  v_owner := waldo.app_channel_owner(p_do_name, p_session_hash, p_expected_revision);
  if v_owner is null then return null; end if;
  return jsonb_build_object('owner_id',v_owner,'do_name',p_do_name,'revision',p_expected_revision,
    'linked',coalesce((select jsonb_agg(provider order by provider) from (select distinct provider from waldo.presences
      where owner_id=v_owner and state='active' and provider in ('telegram','whatsapp')) p),'[]'::jsonb));
end $$;
revoke all on function waldo.owner_channel_inventory(text,text,text,bigint,text) from public,anon,authenticated,service_role;
grant execute on function waldo.owner_channel_inventory(text,text,text,bigint,text) to anon;

-- Additive overload: console's existing Telegram issuer remains unchanged.
create function waldo.issue_link_code(p_do_name text, p_session_hash text, p_expected_revision text, p_provider text, p_code_hash text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_expires timestamptz := now() + interval '10 minutes';
begin
  if p_provider is null or p_provider not in ('telegram','whatsapp') or p_code_hash is null or p_code_hash !~ '^[a-f0-9]{64}$'
    or waldo.router_signed('app.channels.link.' || p_do_name || '.' || p_session_hash || '.' || p_expected_revision || '.' || p_provider || '.' || p_code_hash, p_at, p_sig) is distinct from true then
    raise exception 'unsigned or invalid channel call' using errcode = '42501'; end if;
  v_owner := waldo.app_channel_owner(p_do_name,p_session_hash,p_expected_revision);
  if v_owner is null then return null; end if;
  delete from waldo.link_codes where owner_id=v_owner and provider=p_provider and used_at is null;
  insert into waldo.link_codes(code_hash,owner_id,provider,expires_at) values(p_code_hash,v_owner,p_provider,v_expires);
  return jsonb_build_object('owner_id',v_owner,'do_name',p_do_name,'revision',p_expected_revision,'expires_at',floor(extract(epoch from v_expires)*1000));
end $$;
revoke all on function waldo.issue_link_code(text,text,text,text,text,bigint,text) from public,anon,authenticated,service_role;
grant execute on function waldo.issue_link_code(text,text,text,text,text,bigint,text) to anon;

-- Additive overload: revoke presence and unused linking codes, never the owner.
create function waldo.unlink_presence(p_do_name text, p_session_hash text, p_expected_revision text, p_provider text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_revision text;
begin
  if p_provider is null or p_provider not in ('telegram','whatsapp')
    or waldo.router_signed('app.channels.unlink.' || p_do_name || '.' || p_session_hash || '.' || p_expected_revision || '.' || p_provider, p_at, p_sig) is distinct from true then
    raise exception 'unsigned or invalid channel call' using errcode = '42501'; end if;
  v_owner := waldo.app_channel_owner(p_do_name,p_session_hash,p_expected_revision);
  if v_owner is null then return null; end if;
  update waldo.presences set state='unlinked',unlinked_at=now() where owner_id=v_owner and provider=p_provider and state='active';
  delete from waldo.link_codes where owner_id=v_owner and provider=p_provider and used_at is null;
  select state_version::text || ':' || admission_revision::text into v_revision from waldo.owners where id=v_owner;
  return jsonb_build_object('owner_id',v_owner,'do_name',p_do_name,'revision',v_revision);
end $$;
revoke all on function waldo.unlink_presence(text,text,text,text,bigint,text) from public,anon,authenticated,service_role;
grant execute on function waldo.unlink_presence(text,text,text,text,bigint,text) to anon;
