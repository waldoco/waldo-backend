-- #407: tie replay custody to the actual owner/connection relationship. Refuse an
-- invalid pre-existing ledger instead of silently deleting its effect evidence.
do $$
begin
  if exists (
    select 1 from waldo.proxy_idempotency p
    left join waldo.connections c on c.id = p.connection and c.owner_id = p.owner_id
    where c.id is null
  ) then
    raise exception 'proxy intent relationship audit required before migration';
  end if;
end $$;

alter table waldo.connections add constraint connections_owner_id_id_unique unique (owner_id, id);
alter table waldo.proxy_idempotency add constraint proxy_idempotency_owner_connection_fk
  foreign key (owner_id, connection) references waldo.connections (owner_id, id) deferrable initially deferred;
-- Existing delete_owner deletes connections before cascading the owner ledger.
-- Defer relationship checking to commit so that atomic deletion still works;
-- never cascade on connection deletion alone and silently erase effect evidence.

create or replace function waldo.proxy_idem_claim(p_do_name text, p_connection uuid, p_key text, p_digest text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_status text; v_result jsonb; v_digest text;
begin
  if p_key is null or p_key = '' or p_digest is null or p_digest = '' then return null; end if;
  -- Hold lifecycle/connection rows through this transaction. Revocation cannot
  -- race admission by committing between this check and the ledger write.
  select o.id into v_owner from waldo.owners o join waldo.connections c on c.owner_id = o.id
    where o.do_name = p_do_name and o.state = 'active' and c.id = p_connection and c.status <> 'revoked'
    for share of o, c;
  if v_owner is null then return null; end if;
  insert into waldo.proxy_idempotency (owner_id, connection, pkey, digest) values (v_owner, p_connection, p_key, p_digest)
    on conflict (owner_id, connection, pkey) do nothing;
  if found then return jsonb_build_object('state', 'new'); end if;
  select status, result, digest into v_status, v_result, v_digest from waldo.proxy_idempotency
    where owner_id = v_owner and connection = p_connection and pkey = p_key;
  if v_digest is distinct from p_digest then return jsonb_build_object('state', 'conflict'); end if;
  if v_status = 'done' then return jsonb_build_object('state', 'done', 'result', v_result); end if;
  return jsonb_build_object('state', 'pending');
end $$;

create or replace function waldo.proxy_idem_store(p_do_name text, p_connection uuid, p_key text, p_result jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  select o.id into v_owner from waldo.owners o join waldo.connections c on c.owner_id = o.id
    where o.do_name = p_do_name and o.state = 'active' and c.id = p_connection and c.status <> 'revoked'
    for share of o, c;
  if v_owner is null then return false; end if;
  update waldo.proxy_idempotency set status = 'done', result = p_result
    where owner_id = v_owner and connection = p_connection and pkey = p_key and status = 'pending';
  return found;
end $$;
-- CREATE OR REPLACE preserves the existing service-role-only execute grants.
