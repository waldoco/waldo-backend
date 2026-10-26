-- Apple and Google identities Waldo trusts to sign an existing owner in. Supabase links a new provider identity to the
-- Auth user that holds the same verified email, and a provider's email_verified speaks only for the provider's view of
-- the address (Google's covers a custom domain's past holders too). So an identity that reaches an existing owner signs
-- in only once the owner has proven the mailbox with an email code, or when it created the owner through an invite.
-- Keyed by the provider's subject, which auth.identities holds unique per provider.
create table waldo.owner_signin_identities (
  owner_id uuid not null references waldo.owners (id) on delete cascade,
  provider text not null check (provider in ('apple', 'google')),
  subject text not null check (length(subject) between 1 and 255),
  trusted_at timestamptz not null default now(),
  primary key (owner_id, provider, subject)
);
alter table waldo.owner_signin_identities enable row level security;
alter table waldo.owner_signin_identities force row level security;
revoke all on waldo.owner_signin_identities from public, anon, authenticated, service_role;

-- True only for the active owner bound to this Auth user and email, holding this identity.
create function waldo.signin_identity_trusted(p_auth_user uuid, p_email text, p_provider text, p_subject text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if waldo.router_signed('signinid.trusted.' || p_auth_user::text || '.' || lower(p_email) || '.' || p_provider || '.' || p_subject, p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  return exists (
    select 1 from waldo.owner_signin_identities t join waldo.owners o on o.id = t.owner_id
    where o.auth_user_id = p_auth_user and lower(o.email) = lower(p_email) and o.state = 'active'
      and t.provider = p_provider and t.subject = p_subject);
end $$;

-- Records trust after the runtime has seen the owner prove the mailbox, or create the owner, in this sign-in. The
-- identity must be one Supabase links to this Auth user, so a subject from anywhere else is never trusted.
create function waldo.trust_signin_identity(p_auth_user uuid, p_email text, p_provider text, p_subject text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if waldo.router_signed('signinid.trust.' || p_auth_user::text || '.' || lower(p_email) || '.' || p_provider || '.' || p_subject, p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  if p_provider not in ('apple', 'google') then return false; end if;
  perform 1 from auth.identities where user_id = p_auth_user and provider = p_provider and provider_id = p_subject;
  if not found then return false; end if;
  select id into v_owner from waldo.owners where auth_user_id = p_auth_user and lower(email) = lower(p_email) and state = 'active';
  if v_owner is null then return false; end if;
  insert into waldo.owner_signin_identities (owner_id, provider, subject) values (v_owner, p_provider, p_subject)
    on conflict do nothing;
  return true;
end $$;

revoke all on function waldo.signin_identity_trusted(uuid, text, text, text, bigint, text) from public, anon, authenticated, service_role;
revoke all on function waldo.trust_signin_identity(uuid, text, text, text, bigint, text) from public, anon, authenticated, service_role;
grant execute on function waldo.signin_identity_trusted(uuid, text, text, text, bigint, text) to anon;
grant execute on function waldo.trust_signin_identity(uuid, text, text, text, bigint, text) to anon;

-- Joining with an invite. The body of signup_owner_for_auth moves here unchanged so the caller learns whether this
-- transaction created the owner or found one already bound to the Auth user (a retry, or the member's own email-code
-- redemption committing first). Only a creation may trust the identity that joined. Not callable through the API.
create function waldo.signup_owner_core(p_auth_user uuid, p_email text, p_phone text, p_code_hash text, out do_name text, out created boolean)
language plpgsql set search_path = '' as $$
declare v_owner uuid; v_invite text; v_phone text;
begin
  created := false;
  v_phone := nullif(p_phone, '');
  if p_email is null or length(p_email) > 254 or position('@' in p_email) < 2
     or (v_phone is not null and v_phone !~ '^\+[1-9][0-9]{6,14}$') then return; end if;

  -- The runtime verifies the OTP response; the database independently binds its
  -- subject to the matching confirmed Auth email. Locking this identity also
  -- serializes repeated completions before the owner/invite reads and keeps an
  -- Auth email change from racing this transaction.
  perform 1 from auth.users
    where id = p_auth_user and lower(email) = lower(p_email) and email_confirmed_at is not null
    for update;
  if not found then return; end if;

  -- A retry after a lost response/session grant resolves only the already-bound
  -- active canonical identity. It cannot update contacts or spend another invite.
  select o.do_name into do_name from waldo.owners o
    where o.auth_user_id = p_auth_user and lower(o.email) = lower(p_email) and o.state = 'active'
    for update;
  if do_name is not null then return; end if;
  if p_code_hash !~ '^[0-9a-f]{64}$' then return; end if;

  -- The exact recipient-bound invite is the only new-member admission authority.
  -- This row lock and every following write belong to the same transaction.
  update waldo.invites set used_at = now()
    where code_hash = p_code_hash and lower(email) = lower(p_email)
      and used_at is null and revoked_at is null and expires_at > now()
    returning code_hash into v_invite;
  if v_invite is null then return; end if;
  insert into waldo.owners (auth_user_id, do_name, email, phone)
    values (p_auth_user, 'owner-' || gen_random_uuid()::text, lower(p_email), v_phone)
    on conflict do nothing returning id, waldo.owners.do_name into v_owner, do_name;
  if v_owner is null then
    -- Collisions include seeded/unbound and suspended identities. Raising rolls
    -- back invite consumption instead of rebinding a different owner by email.
    raise exception 'owner already exists' using errcode = '23505';
  end if;
  update waldo.invites set used_by = v_owner where code_hash = v_invite;
  insert into waldo.owner_settings (owner_id) values (v_owner);
  created := true;
end $$;
revoke all on function waldo.signup_owner_core(uuid, text, text, text) from public, anon, authenticated, service_role;

create or replace function waldo.signup_owner_for_auth(
  p_auth_user uuid,
  p_email text,
  p_at bigint,
  p_sig text,
  p_phone text default null,
  p_code_hash text default ''
) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if waldo.router_signed('signup.owner.' || p_auth_user::text || '.' || lower(p_email) || '.'
      || coalesce(nullif(p_phone, ''), '') || '.' || p_code_hash, p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  return (select do_name from waldo.signup_owner_core(p_auth_user, p_email, p_phone, p_code_hash));
end $$;

-- Joining through Apple or Google: the owner, and created only when this transaction made it. The identity that
-- created the owner is trusted in the same transaction; one that finds an existing owner is not.
create function waldo.signup_owner_with_signin_identity(p_auth_user uuid, p_email text, p_provider text, p_subject text,
  p_phone text, p_code_hash text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_do text; v_created boolean;
begin
  if waldo.router_signed('signinid.signup.' || p_auth_user::text || '.' || lower(p_email) || '.' || p_provider || '.' || p_subject
      || '.' || coalesce(nullif(p_phone, ''), '') || '.' || p_code_hash, p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select do_name, created into v_do, v_created from waldo.signup_owner_core(p_auth_user, p_email, p_phone, p_code_hash);
  if v_do is null then return null; end if;
  if v_created and p_provider in ('apple', 'google') and exists (
      select 1 from auth.identities where user_id = p_auth_user and provider = p_provider and provider_id = p_subject) then
    insert into waldo.owner_signin_identities (owner_id, provider, subject)
      select id, p_provider, p_subject from waldo.owners where do_name = v_do;
  end if;
  return jsonb_build_object('do_name', v_do, 'created', v_created);
end $$;
revoke all on function waldo.signup_owner_with_signin_identity(uuid, text, text, text, text, text, bigint, text) from public, anon, authenticated, service_role;
grant execute on function waldo.signup_owner_with_signin_identity(uuid, text, text, text, text, text, bigint, text) to anon;
