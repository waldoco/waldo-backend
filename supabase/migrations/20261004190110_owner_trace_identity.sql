-- Extend the existing signed inbound lookup; preserve its owner and effective execution permissions.
-- Email is current confirmed account identity, never a connector address or user-authored metadata.
do $migration$
declare old_acl aclitem[]; old_owner oid; permission record; recipient text;
begin
  select proacl, proowner into strict old_acl, old_owner
    from pg_proc where oid = 'waldo.route_presence(text,text,bigint,text)'::regprocedure;
  drop function waldo.route_presence(text,text,bigint,text);
  execute $definition$
    create function waldo.route_presence(p_provider text, p_subject text, p_at bigint, p_sig text)
    returns table (do_name text, subject text, timezone text, owner_id uuid, owner_email text)
    language plpgsql stable security definer set search_path = '' as $body$
    begin
      if not waldo.router_signed('route.' || p_provider || '.' || p_subject, p_at, p_sig) then
        raise exception 'unsigned router call' using errcode = '42501';
      end if;
      return query select o.do_name, p.subject, s.timezone, o.id, lower(u.email)::text
        from waldo.presences p join waldo.owners o on o.id = p.owner_id
        left join waldo.owner_settings s on s.owner_id = o.id
        left join auth.users u on u.id = o.auth_user_id
          and lower(u.email) = lower(o.email) and u.email_confirmed_at is not null
        where p.provider = p_provider and p.subject = p_subject
          and p.state = 'active' and o.state = 'active' limit 1;
    end $body$;
  $definition$;
  execute format('alter function waldo.route_presence(text,text,bigint,text) owner to %I', pg_get_userbyid(old_owner));
  -- A creator's default ACL must not introduce an additional reader during replacement.
  for permission in select * from aclexplode(coalesce(
    (select proacl from pg_proc where oid = 'waldo.route_presence(text,text,bigint,text)'::regprocedure),
    acldefault('f', old_owner))) loop
    recipient := case when permission.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(permission.grantee)) end;
    execute 'revoke all on function waldo.route_presence(text,text,bigint,text) from ' || recipient;
  end loop;
  for permission in select * from aclexplode(coalesce(old_acl, acldefault('f', old_owner))) loop
    recipient := case when permission.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(permission.grantee)) end;
    execute 'grant execute on function waldo.route_presence(text,text,bigint,text) to ' || recipient
      || case when permission.is_grantable then ' with grant option' else '' end;
  end loop;
end $migration$;
