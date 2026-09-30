-- Add attribution and lifetime issuance counts to the existing restricted read.
-- Issuance, revocation, authentication and admin policy remain unchanged.
create or replace function waldo.admin_overview(p_do_name text, p_at bigint, p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not waldo.router_signed('admin.' || p_do_name, p_at, p_sig) then raise exception 'unsigned router call' using errcode = '42501'; end if;
  if not waldo.is_admin(p_do_name) then return null; end if;
  return jsonb_build_object(
    'current_issuer', (select jsonb_build_object('id', o.id, 'email', o.email,
      'issued_count', (select count(*) from waldo.invites i where i.issued_by = o.id))
      from waldo.owners o where o.do_name = p_do_name),
    'owners', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'email', o.email,
      'state', o.state, 'created_at', o.created_at,
      'issued_count', (select count(*) from waldo.invites i where i.issued_by = o.id),
      'presences', (select coalesce(jsonb_agg(p.provider), '[]'::jsonb) from waldo.presences p where p.owner_id = o.id and p.state = 'active'))
      order by o.created_at) from waldo.owners o), '[]'::jsonb),
    'invites', coalesce((select jsonb_agg(jsonb_build_object('id', i.code_hash, 'email', i.email,
      'created_at', i.created_at, 'expires_at', i.expires_at, 'used_at', i.used_at, 'revoked_at', i.revoked_at,
      'issued_by', i.issued_by, 'issuer_email', issuer.email) order by i.created_at desc)
      from waldo.invites i left join waldo.owners issuer on issuer.id = i.issued_by), '[]'::jsonb));
end $$;
