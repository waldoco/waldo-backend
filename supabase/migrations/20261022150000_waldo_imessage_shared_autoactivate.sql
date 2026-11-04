-- A shared Waldo number host goes live when it redeems its invitation: no challenge text, no separate activation.
-- The invitation is the operator's proof: only an admin can issue one, it is single use and lives at most an hour.
-- The trade-off is deliberate: a leaked shared invitation is enough to become the shared host, which carries every
-- sender's texts. So issuing and redeeming both refuse while another shared host is active in the environment; an
-- operator revokes the old host first. Owner (per-owner Mac) bridges are unchanged: their challenge proves which
-- sender is bound, and they still go through scope, challenge and activation.

create or replace function waldo.imessage_issue_shared_invitation(p_do_name text, p_environment text, p_code_hash text, p_lifetime_seconds integer, p_locator text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_now timestamptz;
begin
  perform waldo.imessage_signed('invite_shared', p_locator, jsonb_build_array(p_do_name, p_environment, p_code_hash, p_lifetime_seconds), p_at, p_sig);
  if p_code_hash !~ '^[0-9a-f]{64}$' or p_lifetime_seconds not between 60 and 3600 or p_environment !~ '^[a-z][a-z0-9_-]{0,31}$' then return false; end if;
  if not waldo.is_admin(p_do_name) then return false; end if;
  select id into v_owner from waldo.owners where do_name = p_do_name and state = 'active' for update;
  if v_owner is null then return false; end if;
  if exists (select 1 from waldo.imessage_bridges where environment = p_environment and kind = 'shared' and state = 'active') then return false; end if;
  v_now := clock_timestamp();
  if (select count(*) from waldo.imessage_invitations where owner_id = v_owner and used_at is null and expires_at > v_now) >= 3 then return false; end if;
  insert into waldo.imessage_invitations(code_hash, owner_id, environment, created_at, expires_at, kind)
    values (p_code_hash, v_owner, p_environment, v_now, v_now + make_interval(secs => p_lifetime_seconds), 'shared');
  return true;
exception when unique_violation then return false;
end $$;

create or replace function waldo.imessage_redeem_invitation(p_code_hash text, p_environment text, p_bridge_id text, p_account_id text, p_wrapped_credential text,
  p_host_version text, p_transport_version text, p_generation text, p_pending_seconds integer, p_locator text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_invite waldo.imessage_invitations; v_do text; v_now timestamptz := clock_timestamp(); v_shared boolean;
begin
  perform waldo.imessage_signed('redeem', p_locator, jsonb_build_array(p_code_hash, p_environment, p_bridge_id, p_account_id, p_wrapped_credential, p_host_version, p_transport_version, p_generation, p_pending_seconds), p_at, p_sig);
  if p_pending_seconds is null or p_pending_seconds not between 60 and 3600 then return null; end if;
  select * into v_invite from waldo.imessage_invitations where code_hash = p_code_hash and used_at is null for update;
  if v_invite.code_hash is null or v_invite.expires_at <= v_now or v_invite.environment <> p_environment then return null; end if;
  select do_name into v_do from waldo.owners where id = v_invite.owner_id and state = 'active';
  if v_do is null then return null; end if;
  v_shared := v_invite.kind = 'shared';
  -- Refused before the invitation is spent, so the operator can revoke the active host and reuse the code.
  if v_shared and exists (select 1 from waldo.imessage_bridges where environment = p_environment and kind = 'shared' and state = 'active') then return null; end if;
  update waldo.imessage_invitations set used_at = v_now where code_hash = p_code_hash;
  insert into waldo.imessage_bridges(bridge_id, account_id, owner_id, environment, state, wrapped_credential, host_version, transport_version, database_generation,
      pending_expires_at, kind, activated_at)
    values (p_bridge_id, p_account_id, v_invite.owner_id, p_environment, case when v_shared then 'active' else 'pending' end, p_wrapped_credential,
      p_host_version, p_transport_version, p_generation, v_now + make_interval(secs => p_pending_seconds), v_invite.kind, case when v_shared then v_now end);
  return jsonb_build_object('bridge_id', p_bridge_id, 'account_id', p_account_id, 'do_name', v_do, 'state', case when v_shared then 'active' else 'pending' end,
    'expires_at_ms', (extract(epoch from v_now + make_interval(secs => p_pending_seconds)) * 1000)::bigint);
exception when unique_violation or check_violation then return null;
end $$;
