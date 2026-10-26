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
