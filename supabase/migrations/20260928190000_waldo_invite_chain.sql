-- Closed cohort: existing owners keep access; new owners need a live, one-use code.
-- Codes issued from the console are stored as SHA-256 hashes, scoped to the issuing owner,
-- limited to five per member and expire after 14 days. Old admin attribution rows
-- used non-secret identifiers, so they cannot serve as bearer codes; admins must issue new secret codes for anyone not yet onboarded.
alter table waldo.invites add column issued_by uuid references waldo.owners (id) on delete cascade;
alter table waldo.invites add column expires_at timestamptz;
-- Old rows were created for attribution, not as secret bearer codes. Kill those still
-- open before enforcing the new gate. The owner may reissue a real code later.
update waldo.invites set revoked_at = now() where used_at is null and revoked_at is null;
update waldo.invites set expires_at = created_at + interval '14 days' where expires_at is null;
create index waldo_invites_live_email on waldo.invites (lower(email), expires_at) where used_at is null and revoked_at is null;

create or replace function waldo.signin_allowed(p_email text, p_at bigint, p_sig text, p_code_hash text default '') returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  if not waldo.router_signed('signin.' || lower(p_email) || '.' || p_code_hash, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  return exists (select 1 from waldo.owners where lower(email) = lower(p_email) and state = 'active' and auth_user_id is not null)
    or exists (select 1 from waldo.owners where lower(email) = lower(p_email) and state = 'active' and bootstrap_claimable)
    or exists (select 1 from waldo.invites where code_hash = p_code_hash and lower(email) = lower(p_email)
      and used_at is null and revoked_at is null and expires_at > now());
end $$;
drop function waldo.signin_allowed(text, bigint, text);
revoke all on function waldo.signin_allowed(text, bigint, text, text) from public;
grant execute on function waldo.signin_allowed(text, bigint, text, text) to anon;

create or replace function waldo.owner_for_auth(p_auth_user uuid, p_email text, p_at bigint, p_sig text, p_phone text default null, p_code_hash text default '') returns text
language plpgsql security definer set search_path = '' as $$
declare v_do text; v_owner uuid; v_invite text;
begin
  if not waldo.router_signed('owner.' || p_auth_user::text || '.' || lower(p_email) || '.' || coalesce(nullif(p_phone, ''), '') || '.' || p_code_hash, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  -- Existing bound owners can sign in without an invite. The verified Auth user, not an
  -- email form field, selects this path. The caller also verifies Auth's email matches.
  select do_name into v_do from waldo.owners where auth_user_id = p_auth_user and lower(email) = lower(p_email) and state = 'active';
  if v_do is not null then return v_do; end if;
  if nullif(p_phone, '') is null then return null; end if;
  -- The original bootstrap path is deliberately one-use and requires a prior hand mark.
  update waldo.owners set auth_user_id = p_auth_user, phone = p_phone, bootstrap_claimable = false
    where lower(email) = lower(p_email) and auth_user_id is null and state = 'active' and bootstrap_claimable
    returning do_name into v_do;
  if v_do is not null then return v_do; end if;
  -- This UPDATE is the concurrency lock and the only consumption point. A losing redemption
  -- sees no row. Failure to create a new owner rolls this UPDATE back with the transaction.
  update waldo.invites set used_at = now()
    where code_hash = p_code_hash and lower(email) = lower(p_email) and used_at is null and revoked_at is null and expires_at > now()
    returning code_hash into v_invite;
  if v_invite is null then return null; end if;
  insert into waldo.owners (auth_user_id, do_name, email, phone)
    values (p_auth_user, 'owner-' || gen_random_uuid()::text, lower(p_email), p_phone)
    on conflict do nothing returning id, do_name into v_owner, v_do;
  if v_owner is null then
    -- Losing an owner-identity race must not spend the code. The exception rolls back
    -- the prior UPDATE atomically; the caller can retry its already-bound identity.
    raise exception 'owner already exists' using errcode = '23505';
  end if;
  update waldo.invites set used_by = v_owner where code_hash = v_invite;
  insert into waldo.owner_settings (owner_id) values (v_owner) on conflict (owner_id) do nothing;
  return v_do;
end $$;
drop function waldo.owner_for_auth(uuid, text, bigint, text, text);
revoke all on function waldo.owner_for_auth(uuid, text, bigint, text, text, text) from public;
grant execute on function waldo.owner_for_auth(uuid, text, bigint, text, text, text) to anon;

create function waldo.issue_member_invite(p_do_name text, p_email text, p_code_hash text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_count integer;
begin
  if not waldo.router_signed('memberinvite.' || p_do_name || '.' || lower(p_email) || '.' || p_code_hash, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  if position('@' in p_email) < 2 or p_code_hash !~ '^[0-9a-f]{64}$' then return false; end if;
  -- Lock the issuer row before counting to prevent parallel issue requests exceeding five.
  select id into v_owner from waldo.owners where do_name = p_do_name and state = 'active' for update;
  if v_owner is null then return false; end if;
  -- Serialise same-email issuance across different issuers, not only one issuer's quota.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lower(p_email), 0));
  select count(*) into v_count from waldo.invites where issued_by = v_owner;
  if v_count >= 5 or exists (select 1 from waldo.owners where lower(email) = lower(p_email) and state = 'active')
    or exists (select 1 from waldo.invites where lower(email) = lower(p_email) and used_at is null and revoked_at is null and expires_at > now()) then return false; end if;
  insert into waldo.invites (code_hash, email, issued_by, expires_at)
    values (p_code_hash, lower(p_email), v_owner, now() + interval '14 days') on conflict do nothing;
  return found;
end $$;
revoke all on function waldo.issue_member_invite(text, text, text, bigint, text) from public;
grant execute on function waldo.issue_member_invite(text, text, text, bigint, text) to anon;

-- Admin remains the root for tomorrow's first cohort. It too emits a one-use code and
-- no longer accepts a guessed email alone; display the raw code once at issuance.
create or replace function waldo.admin_invite(p_do_name text, p_email text, p_at bigint, p_sig text, p_code_hash text default '') returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_count integer;
begin
  if not waldo.router_signed('invite.' || p_do_name || '.' || lower(p_email) || '.' || p_code_hash, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  if position('@' in p_email) < 2 or p_code_hash !~ '^[0-9a-f]{64}$' then return false; end if;
  select id into v_owner from waldo.owners where do_name = p_do_name and state = 'active' and is_admin for update;
  if v_owner is null then return false; end if;
  -- Serialise same-email issuance across different issuers, not only one issuer's quota.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lower(p_email), 0));
  select count(*) into v_count from waldo.invites where issued_by = v_owner;
  if v_count >= 5 or exists (select 1 from waldo.owners where lower(email) = lower(p_email) and state = 'active')
    or exists (select 1 from waldo.invites where lower(email) = lower(p_email) and used_at is null and revoked_at is null and expires_at > now()) then return false; end if;
  insert into waldo.invites (code_hash, email, issued_by, expires_at)
    values (p_code_hash, lower(p_email), v_owner, now() + interval '14 days') on conflict do nothing;
  return found;
end $$;
drop function waldo.admin_invite(text, text, bigint, text);
revoke all on function waldo.admin_invite(text, text, bigint, text, text) from public;
grant execute on function waldo.admin_invite(text, text, bigint, text, text) to anon;

create or replace function waldo.admin_overview(p_do_name text, p_at bigint, p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not waldo.router_signed('admin.' || p_do_name, p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  if not waldo.is_admin(p_do_name) then return null; end if;
  return jsonb_build_object(
    'owners', coalesce((select jsonb_agg(jsonb_build_object('email', o.email, 'state', o.state, 'created_at', o.created_at,
      'presences', (select coalesce(jsonb_agg(p.provider), '[]'::jsonb) from waldo.presences p where p.owner_id = o.id and p.state = 'active')) order by o.created_at) from waldo.owners o), '[]'::jsonb),
    'invites', coalesce((select jsonb_agg(jsonb_build_object('id', i.code_hash, 'email', i.email, 'created_at', i.created_at,
      'expires_at', i.expires_at, 'used_at', i.used_at, 'revoked_at', i.revoked_at) order by i.created_at desc) from waldo.invites i), '[]'::jsonb));
end $$;

create function waldo.member_invites(p_do_name text, p_at bigint, p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if not waldo.router_signed('memberinvites.' || p_do_name, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select id into v_owner from waldo.owners where do_name = p_do_name and state = 'active';
  if v_owner is null then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('email', email, 'created_at', created_at,
      'expires_at', expires_at, 'used_at', used_at, 'revoked_at', revoked_at) order by created_at desc)
    from waldo.invites where issued_by = v_owner), '[]'::jsonb);
end $$;
revoke all on function waldo.member_invites(text, bigint, text) from public;
grant execute on function waldo.member_invites(text, bigint, text) to anon;
