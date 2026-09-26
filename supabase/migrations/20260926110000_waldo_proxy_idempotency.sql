-- Durable idempotency for effect-bearing proxy calls. The signed HMAC call is replayable inside
-- its 5-minute window, and Gmail Message-ID is not a provider idempotency guarantee: the proxy
-- claims each approved send once and replays get the stored result or a typed pending/unknown.
create table waldo.proxy_idempotency (
  owner_id uuid not null references waldo.owners(id) on delete cascade,
  connection uuid not null,
  pkey text not null,
  digest text not null,
  status text not null default 'pending',
  result jsonb,
  created_at timestamptz not null default now(),
  primary key (owner_id, connection, pkey)
);
-- Same invariant as every owner table: enable + FORCE RLS, no anon/authenticated access, the
-- Edge Function reaches it only as service_role (which bypasses RLS) through the gated RPCs.
alter table waldo.proxy_idempotency enable row level security;
alter table waldo.proxy_idempotency force row level security;
revoke all on waldo.proxy_idempotency from public, anon, authenticated;
grant select, insert, update, delete on waldo.proxy_idempotency to service_role;

-- Claim an intent by its unique immutable approval-intent id plus a content digest: 'new' for
-- the first caller, 'done' (+ stored result) or 'pending' for a same-intent replay, 'conflict'
-- when the intent id returns with different bytes. Two DISTINCT intents with identical content
-- are two sends by design. Owner-gated exactly like proxy_access.
create function waldo.proxy_idem_claim(p_do_name text, p_connection uuid, p_key text, p_digest text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_status text; v_result jsonb; v_digest text;
begin
  v_owner := waldo.owner_id_for(p_do_name);
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

create function waldo.proxy_idem_store(p_do_name text, p_connection uuid, p_key text, p_result jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update waldo.proxy_idempotency set status = 'done', result = p_result
    where owner_id = waldo.owner_id_for(p_do_name) and connection = p_connection and pkey = p_key;
  return found;
end $$;

revoke all on function waldo.proxy_idem_claim(text, uuid, text, text) from public, anon, authenticated;
revoke all on function waldo.proxy_idem_store(text, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function waldo.proxy_idem_claim(text, uuid, text, text) to service_role;
grant execute on function waldo.proxy_idem_store(text, uuid, text, jsonb) to service_role;
