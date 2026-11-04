-- Beta admin: an admin owner lists owners and invites and can invite or revoke. Signed calls only.
alter table waldo.owners add column is_admin boolean not null default false;

create function waldo.is_admin(p_do_name text) returns boolean language sql stable security definer set search_path = '' as
$$ select exists (select 1 from waldo.owners where do_name = p_do_name and is_admin and state = 'active') $$;
revoke all on function waldo.is_admin(text) from public, anon, authenticated;

create function waldo.admin_overview(p_do_name text, p_at bigint, p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not waldo.router_signed('admin.' || p_do_name, p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  if not waldo.is_admin(p_do_name) then return null; end if;
  return jsonb_build_object(
    'owners', coalesce((select jsonb_agg(jsonb_build_object('email', o.email, 'state', o.state, 'created_at', o.created_at,
      'presences', (select coalesce(jsonb_agg(p.provider), '[]'::jsonb) from waldo.presences p where p.owner_id = o.id and p.state = 'active')) order by o.created_at) from waldo.owners o), '[]'::jsonb),
    'invites', coalesce((select jsonb_agg(jsonb_build_object('id', i.code_hash, 'email', i.email, 'created_at', i.created_at, 'used_at', i.used_at, 'revoked_at', i.revoked_at) order by i.created_at desc) from waldo.invites i), '[]'::jsonb));
end $$;

create function waldo.admin_invite(p_do_name text, p_email text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not waldo.router_signed('invite.' || p_do_name || '.' || lower(p_email), p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  if not waldo.is_admin(p_do_name) or position('@' in p_email) < 2 then return false; end if;
  if exists (select 1 from waldo.invites where lower(email) = lower(p_email) and used_at is null and revoked_at is null) then return true; end if;
  insert into waldo.invites (code_hash, email) values ('invite-' || gen_random_uuid()::text, lower(p_email));
  return true;
end $$;

create function waldo.admin_revoke(p_do_name text, p_invite text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not waldo.router_signed('revoke.' || p_do_name || '.' || p_invite, p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  if not waldo.is_admin(p_do_name) then return false; end if;
  update waldo.invites set revoked_at = now() where code_hash = p_invite and used_at is null and revoked_at is null;
  return found;
end $$;

revoke all on function waldo.admin_overview(text, bigint, text) from public;
revoke all on function waldo.admin_invite(text, text, bigint, text) from public;
revoke all on function waldo.admin_revoke(text, text, bigint, text) from public;
grant execute on function waldo.admin_overview(text, bigint, text) to anon;
grant execute on function waldo.admin_invite(text, text, bigint, text) to anon;
grant execute on function waldo.admin_revoke(text, text, bigint, text) to anon;
