-- The undo for a meal or workout log: the owner removes one entry by id. A log written from text Waldo read elsewhere (mail, a
-- page, a connected tool) would otherwise stay in the scores and coaching with no way back.
--
-- - Owner-scoped: the id is matched together with the owner the signed DO name resolves to, so an id from another owner
--   removes nothing and reads as not found.
-- - The removed row is returned, so the tool can say what was removed and the owner can log it again.
-- - The table, its RLS and its grants are unchanged; this is one more signed router call on the health_logs pattern.
create function waldo.health_log_delete(p_do_name text, p_id bigint, p_at bigint, p_sig text) returns setof waldo.health_logs
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if not waldo.router_signed('health.delete.' || p_do_name || '.' || p_id, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  v_owner := waldo.owner_id_for(p_do_name);
  if v_owner is null then return; end if;
  return query delete from waldo.health_logs where id = p_id and owner_id = v_owner returning *;
end $$;

revoke all on function waldo.health_log_delete(text, bigint, bigint, text) from public;
grant execute on function waldo.health_log_delete(text, bigint, bigint, text) to anon;
