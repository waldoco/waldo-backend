-- Each owner's Waldo receives mail at <handle>@<agent mail domain>. One handle per owner and one owner per handle; the row
-- goes with the owner's account (account deletion deletes the owner, which cascades here).
-- The RFC 2142 role names are reserved: postmaster@ and abuse@ reach the team, never an owner.
create table waldo.agent_mail_handles (
  handle text primary key check (
    handle ~ '^[a-z0-9][a-z0-9.-]{1,30}[a-z0-9]$' and position('..' in handle) = 0
    and handle not in ('postmaster', 'abuse', 'hostmaster', 'webmaster', 'admin', 'support', 'info', 'security', 'noreply', 'waldo')),
  owner_id uuid not null unique references waldo.owners (id) on delete cascade,
  claimed_at timestamptz not null default now()
);
alter table waldo.agent_mail_handles enable row level security;
alter table waldo.agent_mail_handles force row level security;
revoke all on waldo.agent_mail_handles from public, anon, authenticated, service_role;

-- A released handle is not reissued for 180 days, so mail meant for its old owner cannot reach a new one. The record keeps
-- only a digest of the handle and when it was released: nothing names the owner who held it.
create table waldo.agent_mail_released_handles (
  handle_digest bytea primary key,
  released_at timestamptz not null
);
alter table waldo.agent_mail_released_handles enable row level security;
alter table waldo.agent_mail_released_handles force row level security;
revoke all on waldo.agent_mail_released_handles from public, anon, authenticated, service_role;

create function waldo.agent_mail_handle_released() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.handle = old.handle then return new; end if;
  insert into waldo.agent_mail_released_handles (handle_digest, released_at)
    values (extensions.digest(old.handle, 'sha256'), now())
    on conflict (handle_digest) do update set released_at = excluded.released_at;
  return null;
end $$;
create trigger agent_mail_handle_released after delete or update of handle on waldo.agent_mail_handles
  for each row execute function waldo.agent_mail_handle_released();

create function waldo.agent_mail_handle_reissue() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from waldo.agent_mail_released_handles
    where handle_digest = extensions.digest(new.handle, 'sha256') and released_at > now() - interval '180 days') then
    raise exception 'agent mail handle released within 180 days' using errcode = '23514';
  end if;
  delete from waldo.agent_mail_released_handles where handle_digest = extensions.digest(new.handle, 'sha256');
  return new;
end $$;
create trigger agent_mail_handle_reissue before insert or update of handle on waldo.agent_mail_handles
  for each row execute function waldo.agent_mail_handle_reissue();
revoke all on function waldo.agent_mail_handle_released() from public, anon, authenticated, service_role;
revoke all on function waldo.agent_mail_handle_reissue() from public, anon, authenticated, service_role;

-- The inbound route for one handle: the owner's object and the confirmed sign-in address that route_presence trusts. The
-- address decides only which mail is read; mail never authenticates the owner. An unknown, released or suspended handle
-- answers no row.
create function waldo.route_agent_mail(p_handle text, p_at bigint, p_sig text)
returns table (do_name text, timezone text, owner_id uuid, owner_email text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not waldo.router_signed('mailroute.' || p_handle, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  return query select o.do_name, s.timezone, o.id, lower(u.email)::text
    from waldo.agent_mail_handles h join waldo.owners o on o.id = h.owner_id
    left join waldo.owner_settings s on s.owner_id = o.id
    left join auth.users u on u.id = o.auth_user_id
      and lower(u.email) = lower(o.email) and u.email_confirmed_at is not null
    where h.handle = p_handle and o.state = 'active' limit 1;
end $$;
-- Signed like route_presence: the Worker's publishable key is the anon role, and the router signature is the gate.
revoke all on function waldo.route_agent_mail(text, bigint, text) from public, anon, authenticated, service_role;
grant execute on function waldo.route_agent_mail(text, bigint, text) to anon;
