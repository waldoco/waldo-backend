-- Waldo owners, presences, settings, invites and link codes. New schema: nothing here depends on the legacy public tables.
create schema if not exists waldo;
grant usage on schema waldo to authenticated, service_role;

create table waldo.owners (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users (id) on delete set null,
  do_name text not null unique,
  email text,
  state text not null default 'active' check (state in ('active', 'suspended')),
  created_at timestamptz not null default now()
);

create table waldo.presences (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references waldo.owners (id) on delete cascade,
  provider text not null check (provider in ('telegram', 'console', 'ios')),
  subject text not null,
  state text not null default 'active' check (state in ('active', 'unlinked')),
  created_at timestamptz not null default now(),
  unlinked_at timestamptz
);
create unique index presences_live_subject on waldo.presences (provider, subject) where state = 'active';

create table waldo.owner_settings (
  owner_id uuid primary key references waldo.owners (id) on delete cascade,
  timezone text not null default 'UTC',
  quiet_start time,
  quiet_end time,
  wind_down time,
  volume text not null default 'normal' check (volume in ('low', 'normal', 'high')),
  initiative text not null default 'balanced' check (initiative in ('ask_first', 'balanced', 'proactive')),
  card_mode text not null default 'auto' check (card_mode in ('auto', 'pin')),
  updated_at timestamptz not null default now()
);

create table waldo.invites (
  code_hash text primary key,
  email text,
  created_at timestamptz not null default now(),
  used_by uuid references waldo.owners (id) on delete set null,
  used_at timestamptz,
  revoked_at timestamptz
);

create table waldo.link_codes (
  code_hash text primary key,
  owner_id uuid not null references waldo.owners (id) on delete cascade,
  provider text not null check (provider in ('telegram', 'ios')),
  expires_at timestamptz not null,
  used_at timestamptz
);

alter table waldo.owners enable row level security;
alter table waldo.presences enable row level security;
alter table waldo.owner_settings enable row level security;
alter table waldo.invites enable row level security;
alter table waldo.link_codes enable row level security;
alter table waldo.owners force row level security;
alter table waldo.presences force row level security;
alter table waldo.owner_settings force row level security;
alter table waldo.invites force row level security;
alter table waldo.link_codes force row level security;

create function waldo.current_owner() returns uuid language sql stable security definer set search_path = '' as
$$ select id from waldo.owners where auth_user_id = auth.uid() $$;
revoke all on function waldo.current_owner() from public;
grant execute on function waldo.current_owner() to authenticated;

create policy owners_self on waldo.owners for select to authenticated using (auth_user_id = auth.uid());
create policy presences_self on waldo.presences for select to authenticated using (owner_id = waldo.current_owner());
create policy settings_self_read on waldo.owner_settings for select to authenticated using (owner_id = waldo.current_owner());
create policy settings_self_write on waldo.owner_settings for update to authenticated using (owner_id = waldo.current_owner()) with check (owner_id = waldo.current_owner());

grant select on waldo.owners, waldo.presences, waldo.owner_settings to authenticated;
grant update (timezone, quiet_start, quiet_end, wind_down, volume, initiative, card_mode, updated_at) on waldo.owner_settings to authenticated;
grant all on all tables in schema waldo to service_role;

-- One transaction binds a presence from a one-time code: the code must be unused and unexpired, and a live subject can belong to one owner only.
create function waldo.redeem_link_code(p_code_hash text, p_provider text, p_subject text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  update waldo.link_codes set used_at = now()
    where code_hash = p_code_hash and provider = p_provider and used_at is null and expires_at > now()
    returning owner_id into v_owner;
  if v_owner is null then return null; end if;
  update waldo.presences set state = 'unlinked', unlinked_at = now()
    where provider = p_provider and owner_id = v_owner and state = 'active';
  if exists (select 1 from waldo.presences where provider = p_provider and subject = p_subject and state = 'active') then
    raise exception 'presence already linked to another owner';
  end if;
  insert into waldo.presences (owner_id, provider, subject) values (v_owner, p_provider, p_subject);
  return v_owner;
end $$;
revoke all on function waldo.redeem_link_code(text, text, text) from public, anon, authenticated;
grant execute on function waldo.redeem_link_code(text, text, text) to service_role;

-- The runtime never holds the service-role key (ADR-0052). It calls only these two functions with the publishable key,
-- signing each call with a secret kept in Supabase Vault as 'waldo_router_hmac'. The secret opens nothing else.
create function waldo.router_signed(p_message text, p_at bigint, p_sig text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_secret text;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'waldo_router_hmac';
  if v_secret is null or abs(extract(epoch from now()) - p_at) > 300 then return false; end if;
  return encode(extensions.hmac(p_at::text || '.' || p_message, v_secret, 'sha256'), 'hex') = p_sig;
end $$;
revoke all on function waldo.router_signed(text, bigint, text) from public, anon, authenticated;

create function waldo.route_presence(p_provider text, p_subject text, p_at bigint, p_sig text)
returns table (do_name text, subject text, timezone text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not waldo.router_signed('route.' || p_provider || '.' || p_subject, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  return query select o.do_name, p.subject, s.timezone
    from waldo.presences p join waldo.owners o on o.id = p.owner_id left join waldo.owner_settings s on s.owner_id = o.id
    where p.provider = p_provider and p.subject = p_subject and p.state = 'active' and o.state = 'active' limit 1;
end $$;

create function waldo.redeem_link(p_code_hash text, p_provider text, p_subject text, p_at bigint, p_sig text) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  if not waldo.router_signed('redeem.' || p_code_hash || '.' || p_provider || '.' || p_subject, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  return waldo.redeem_link_code(p_code_hash, p_provider, p_subject);
end $$;

revoke all on function waldo.route_presence(text, text, bigint, text) from public;
revoke all on function waldo.redeem_link(text, text, text, bigint, text) from public;
grant usage on schema waldo to anon;
grant execute on function waldo.route_presence(text, text, bigint, text) to anon;
grant execute on function waldo.redeem_link(text, text, text, bigint, text) to anon;
