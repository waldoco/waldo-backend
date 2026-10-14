-- iMessage shared Waldo number. Owner rule (2026-10-14): every person talks only to their own Waldo, and
-- a sender with no Waldo is sent the onboarding link instead of reaching anyone.
--
-- One operator-paired SHARED bridge serves every sender. A sender reaches an owner only through that
-- owner's own active 'imessage' presence, linked by texting a one-time code ("waldo CODE"); the shared
-- bridge itself never carries a presence or a subject. Unknown senders get one fixed, throttled
-- onboarding reply (hashes only are kept) and never reach any owner.
--
-- Link codes become provider-scoped: issue_link_code always wrote 'telegram', so WhatsApp's "waldo CODE"
-- could never redeem. issue_provider_link_code issues telegram, whatsapp or imessage codes.

-- 1. Provider-scoped link codes ---------------------------------------------------------------------
alter table waldo.link_codes drop constraint link_codes_provider_check;
alter table waldo.link_codes add constraint link_codes_provider_check check (provider in ('telegram', 'ios', 'whatsapp', 'imessage'));

-- The original issuer keeps its signature and Telegram behavior; it now replaces only Telegram codes.
create or replace function waldo.issue_link_code(p_do_name text, p_code_hash text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if not waldo.router_signed('link.' || p_do_name || '.' || p_code_hash, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select id into v_owner from waldo.owners where do_name = p_do_name and state = 'active';
  if v_owner is null then return false; end if;
  delete from waldo.link_codes where owner_id = v_owner and provider = 'telegram' and used_at is null;
  insert into waldo.link_codes (code_hash, owner_id, provider, expires_at) values (p_code_hash, v_owner, 'telegram', now() + interval '10 minutes');
  return true;
end $$;

create function waldo.issue_provider_link_code(p_do_name text, p_provider text, p_code_hash text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if not waldo.router_signed('link.' || p_provider || '.' || p_do_name || '.' || p_code_hash, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  if p_provider is null or p_provider not in ('telegram', 'whatsapp', 'imessage') or p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then return false; end if;
  select id into v_owner from waldo.owners where do_name = p_do_name and state = 'active';
  if v_owner is null then return false; end if;
  delete from waldo.link_codes where owner_id = v_owner and provider = p_provider and used_at is null;
  insert into waldo.link_codes (code_hash, owner_id, provider, expires_at) values (p_code_hash, v_owner, p_provider, now() + interval '10 minutes');
  return true;
end $$;
revoke all on function waldo.issue_provider_link_code(text, text, text, bigint, text) from public, anon, authenticated;
grant execute on function waldo.issue_provider_link_code(text, text, text, bigint, text) to anon;

-- 2. Shared bridges ---------------------------------------------------------------------------------
alter table waldo.imessage_invitations add column kind text not null default 'owner' check (kind in ('owner', 'shared'));
alter table waldo.imessage_bridges add column kind text not null default 'owner' check (kind in ('owner', 'shared'));
-- A shared bridge never names a sender: each sender is routed through their own presence.
alter table waldo.imessage_bridges add constraint imessage_bridges_shared_no_presence check (kind = 'owner' or presence_id is null);
-- owner_id on a shared bridge is the operator (admin) who paired and manages it, never a turn owner.
drop index waldo.imessage_bridges_one_active_per_owner;
create unique index imessage_bridges_one_active_per_owner on waldo.imessage_bridges(owner_id) where state = 'active' and kind = 'owner';
create unique index imessage_bridges_one_active_shared on waldo.imessage_bridges(environment) where state = 'active' and kind = 'shared';

create table waldo.imessage_onboarding_replies (
  bridge_id text not null references waldo.imessage_bridges(bridge_id) on delete cascade,
  -- sha256 of the JSON array [bridge_id, sender handle]; the handle itself is never stored.
  subject_hash text not null check (subject_hash ~ '^[0-9a-f]{64}$'),
  last_sent_at timestamptz not null,
  primary key (bridge_id, subject_hash)
);
alter table waldo.imessage_onboarding_replies enable row level security;
alter table waldo.imessage_onboarding_replies force row level security;
revoke all on waldo.imessage_onboarding_replies from public, anon, authenticated;

-- Throttle keys also cover per-sender link-code attempts on a shared bridge.
create or replace function waldo.imessage_throttle(p_key text, p_limit integer, p_window_seconds integer, p_locator text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz := clock_timestamp(); v_times timestamptz[];
begin
  perform waldo.imessage_signed('throttle', p_locator, jsonb_build_array(p_key, p_limit, p_window_seconds), p_at, p_sig);
  if p_key is null or p_key !~ '^(imredeem\.(code|source)|imlink\.sender)\.[0-9a-f]{64}$' or p_limit not between 1 and 20 or p_window_seconds not between 1 and 86400 then return false; end if;
  insert into waldo.imessage_throttle_keys(key) values (p_key) on conflict (key) do nothing;
  select admitted_at into v_times from waldo.imessage_throttle_keys where key = p_key for update;
  v_times := array(select t from unnest(v_times) t where t > v_now - make_interval(secs => p_window_seconds));
  if coalesce(array_length(v_times, 1), 0) >= p_limit then
    update waldo.imessage_throttle_keys set admitted_at = v_times where key = p_key;
    return false;
  end if;
  update waldo.imessage_throttle_keys set admitted_at = v_times || v_now where key = p_key;
  return true;
end $$;

-- Operator (admin) issues a one-use invitation for the shared bridge.
create function waldo.imessage_issue_shared_invitation(p_do_name text, p_environment text, p_code_hash text, p_lifetime_seconds integer, p_locator text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_now timestamptz;
begin
  perform waldo.imessage_signed('invite_shared', p_locator, jsonb_build_array(p_do_name, p_environment, p_code_hash, p_lifetime_seconds), p_at, p_sig);
  if p_code_hash !~ '^[0-9a-f]{64}$' or p_lifetime_seconds not between 60 and 3600 or p_environment !~ '^[a-z][a-z0-9_-]{0,31}$' then return false; end if;
  if not waldo.is_admin(p_do_name) then return false; end if;
  select id into v_owner from waldo.owners where do_name = p_do_name and state = 'active' for update;
  if v_owner is null then return false; end if;
  v_now := clock_timestamp();
  if (select count(*) from waldo.imessage_invitations where owner_id = v_owner and used_at is null and expires_at > v_now) >= 3 then return false; end if;
  insert into waldo.imessage_invitations(code_hash, owner_id, environment, created_at, expires_at, kind)
    values (p_code_hash, v_owner, p_environment, v_now, v_now + make_interval(secs => p_lifetime_seconds), 'shared');
  return true;
exception when unique_violation then return false;
end $$;

-- Redeem now carries the invitation's kind onto the pending bridge (unchanged otherwise).
create or replace function waldo.imessage_redeem_invitation(p_code_hash text, p_environment text, p_bridge_id text, p_account_id text, p_wrapped_credential text,
  p_host_version text, p_transport_version text, p_generation text, p_pending_seconds integer, p_locator text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_invite waldo.imessage_invitations; v_do text;
begin
  perform waldo.imessage_signed('redeem', p_locator, jsonb_build_array(p_code_hash, p_environment, p_bridge_id, p_account_id, p_wrapped_credential, p_host_version, p_transport_version, p_generation, p_pending_seconds), p_at, p_sig);
  if p_pending_seconds is null or p_pending_seconds not between 60 and 3600 then return null; end if;
  select * into v_invite from waldo.imessage_invitations where code_hash = p_code_hash and used_at is null for update;
  if v_invite.code_hash is null or v_invite.expires_at <= clock_timestamp() or v_invite.environment <> p_environment then return null; end if;
  select do_name into v_do from waldo.owners where id = v_invite.owner_id and state = 'active';
  if v_do is null then return null; end if;
  update waldo.imessage_invitations set used_at = clock_timestamp() where code_hash = p_code_hash;
  insert into waldo.imessage_bridges(bridge_id, account_id, owner_id, environment, state, wrapped_credential, host_version, transport_version, database_generation, pending_expires_at, kind)
    values (p_bridge_id, p_account_id, v_invite.owner_id, p_environment, 'pending', p_wrapped_credential, p_host_version, p_transport_version, p_generation,
      clock_timestamp() + make_interval(secs => p_pending_seconds), v_invite.kind);
  return jsonb_build_object('bridge_id', p_bridge_id, 'account_id', p_account_id, 'do_name', v_do,
    'expires_at_ms', (extract(epoch from clock_timestamp() + make_interval(secs => p_pending_seconds)) * 1000)::bigint);
exception when unique_violation or check_violation then return null;
end $$;

-- Unsigned body shared by the bridge and sender authority reads; reachable only through them.
create function waldo.imessage_authority_json(p_environment text, p_bridge_id text, p_account_id text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r record;
begin
  select b.*, o.do_name, o.state as owner_state, o.state_version, o.admission_revision, p.subject as presence_subject, p.state as presence_state
    into r from waldo.imessage_bridges b join waldo.owners o on o.id = b.owner_id left join waldo.presences p on p.id = b.presence_id
    where b.bridge_id = p_bridge_id and b.account_id = p_account_id and b.environment = p_environment;
  if r.bridge_id is null then return null; end if;
  return jsonb_build_object(
    'state', case when r.owner_state <> 'active' then 'owner_inactive'
                  when r.state = 'pending' and clock_timestamp() >= greatest(r.pending_expires_at, coalesce(r.challenge_expires_at, r.pending_expires_at)) then 'expired'
                  when r.kind = 'owner' and r.state = 'active' and (r.presence_state is distinct from 'active') then 'revoked'
                  else r.state end,
    'kind', r.kind,
    'bridge_id', r.bridge_id, 'account_id', r.account_id, 'owner_id', r.owner_id, 'do_name', r.do_name,
    'wrapped_credential', r.wrapped_credential, 'credential_epoch', r.credential_epoch,
    'revision', r.authority_revision::text || '.' || r.state_version::text || '.' || r.admission_revision::text,
    'presence_id', r.presence_id, 'subject', case when r.kind = 'owner' then r.presence_subject end,
    'chat_guid', case when r.state = 'active' and r.kind = 'owner' then r.expected_chat_guid end,
    'challenge_hash', case when r.state = 'pending' and r.observed_at is null and r.challenge_expires_at > clock_timestamp() then r.challenge_hash end,
    'expected_subject', case when r.state = 'pending' then r.expected_subject end,
    'expected_chat_guid', case when r.state = 'pending' then r.expected_chat_guid end);
end $$;
revoke all on function waldo.imessage_authority_json(text, text, text) from public, anon, authenticated;

create or replace function waldo.imessage_bridge_authority(p_environment text, p_bridge_id text, p_account_id text, p_locator text, p_at bigint, p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform waldo.imessage_signed('authority', p_locator, jsonb_build_array(p_environment, p_bridge_id, p_account_id), p_at, p_sig);
  return waldo.imessage_authority_json(p_environment, p_bridge_id, p_account_id);
end $$;

-- Authority for ONE sender on a bridge, in the same shape as the bridge authority.
-- Owner bridge: the bridge authority when the sender is its bound subject, else unknown_sender.
-- Shared bridge (active): the sender's own active imessage presence decides the owner; none = unknown_sender.
create function waldo.imessage_sender_authority(p_environment text, p_bridge_id text, p_account_id text, p_subject text, p_locator text, p_at bigint, p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_bridge jsonb; b waldo.imessage_bridges; p record;
begin
  perform waldo.imessage_signed('sender', p_locator, jsonb_build_array(p_environment, p_bridge_id, p_account_id, p_subject), p_at, p_sig);
  if octet_length(coalesce(p_subject, '')) not between 1 and 512 then return null; end if;
  v_bridge := waldo.imessage_authority_json(p_environment, p_bridge_id, p_account_id);
  if v_bridge is null then return null; end if;
  if v_bridge->>'kind' = 'owner' then
    if v_bridge->>'subject' is not distinct from p_subject then return v_bridge; end if;
    return jsonb_build_object('state', 'unknown_sender', 'kind', 'owner', 'bridge_id', p_bridge_id, 'account_id', p_account_id);
  end if;
  if v_bridge->>'state' <> 'active' then return v_bridge; end if;
  select * into b from waldo.imessage_bridges where bridge_id = p_bridge_id;
  select pr.id, pr.owner_id, o.do_name, o.state_version, o.admission_revision into p
    from waldo.presences pr join waldo.owners o on o.id = pr.owner_id
    where pr.provider = 'imessage' and pr.subject = p_subject and pr.state = 'active' and o.state = 'active';
  if p.id is null then
    return jsonb_build_object('state', 'unknown_sender', 'kind', 'shared', 'bridge_id', p_bridge_id, 'account_id', p_account_id);
  end if;
  return jsonb_build_object('state', 'active', 'kind', 'shared', 'bridge_id', b.bridge_id, 'account_id', b.account_id,
    'owner_id', p.owner_id, 'do_name', p.do_name, 'wrapped_credential', b.wrapped_credential, 'credential_epoch', b.credential_epoch,
    'revision', b.authority_revision::text || '.' || p.state_version::text || '.' || p.admission_revision::text || '.' || p.id::text,
    'presence_id', p.id, 'subject', p_subject, 'chat_guid', 'iMessage;-;' || p_subject,
    'challenge_hash', null, 'expected_subject', null, 'expected_chat_guid', null);
end $$;

-- The owner activation refuses a shared bridge (it would create a presence the shared bridge must not carry).
create or replace function waldo.imessage_activate(p_do_name text, p_bridge_id text, p_subject text, p_chat_guid text, p_locator text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; b waldo.imessage_bridges; v_presence uuid;
begin
  perform waldo.imessage_signed('activate', p_locator, jsonb_build_array(p_do_name, p_bridge_id, p_subject, p_chat_guid), p_at, p_sig);
  select id into v_owner from waldo.owners where do_name = p_do_name and state = 'active' for update;
  if v_owner is null then return null; end if;
  select * into b from waldo.imessage_bridges where bridge_id = p_bridge_id and owner_id = v_owner for update;
  if b.bridge_id is null or b.kind <> 'owner' or b.state <> 'pending' or b.observed_at is null or b.challenge_expires_at <= clock_timestamp()
    or b.observed_subject is distinct from b.expected_subject or b.observed_chat_guid is distinct from b.expected_chat_guid
    or b.observed_subject is distinct from p_subject or b.observed_chat_guid is distinct from p_chat_guid then return null; end if;
  if exists (select 1 from waldo.imessage_bridges where owner_id = v_owner and state = 'active' and kind = 'owner') then return null; end if;
  if exists (select 1 from waldo.presences where provider = 'imessage' and subject = b.observed_subject and state = 'active') then return null; end if;
  insert into waldo.presences(owner_id, provider, subject, state) values (v_owner, 'imessage', b.observed_subject, 'active') returning id into v_presence;
  update waldo.imessage_bridges set state = 'active', presence_id = v_presence, activated_at = clock_timestamp(), challenge_hash = null,
      authority_revision = nextval('waldo.imessage_authority_revision_seq'::regclass)
    where bridge_id = b.bridge_id;
  return jsonb_build_object('bridge_id', b.bridge_id, 'account_id', b.account_id, 'presence_id', v_presence, 'subject', b.observed_subject, 'chat_guid', b.observed_chat_guid);
exception when unique_violation then return null;
end $$;

-- Operator confirms the shared bridge after its host observed the operator's challenge: proves the host
-- reads the Waldo number. No presence is created; one active shared bridge per environment.
create function waldo.imessage_activate_shared(p_do_name text, p_bridge_id text, p_subject text, p_chat_guid text, p_locator text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; b waldo.imessage_bridges;
begin
  perform waldo.imessage_signed('activate_shared', p_locator, jsonb_build_array(p_do_name, p_bridge_id, p_subject, p_chat_guid), p_at, p_sig);
  if not waldo.is_admin(p_do_name) then return null; end if;
  select id into v_owner from waldo.owners where do_name = p_do_name and state = 'active' for update;
  if v_owner is null then return null; end if;
  select * into b from waldo.imessage_bridges where bridge_id = p_bridge_id and owner_id = v_owner for update;
  if b.bridge_id is null or b.kind <> 'shared' or b.state <> 'pending' or b.observed_at is null or b.challenge_expires_at <= clock_timestamp()
    or b.observed_subject is distinct from b.expected_subject or b.observed_chat_guid is distinct from b.expected_chat_guid
    or b.observed_subject is distinct from p_subject or b.observed_chat_guid is distinct from p_chat_guid then return null; end if;
  if exists (select 1 from waldo.imessage_bridges where environment = b.environment and state = 'active' and kind = 'shared') then return null; end if;
  update waldo.imessage_bridges set state = 'active', activated_at = clock_timestamp(), challenge_hash = null,
      authority_revision = nextval('waldo.imessage_authority_revision_seq'::regclass)
    where bridge_id = b.bridge_id;
  return jsonb_build_object('bridge_id', b.bridge_id, 'account_id', b.account_id);
exception when unique_violation then return null;
end $$;

-- One onboarding reply per sender per 30 days, and at most 20 per bridge per hour.
create function waldo.imessage_onboarding_allowed(p_environment text, p_bridge_id text, p_account_id text, p_subject_hash text, p_locator text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz := clock_timestamp();
begin
  perform waldo.imessage_signed('onboard', p_locator, jsonb_build_array(p_environment, p_bridge_id, p_account_id, p_subject_hash), p_at, p_sig);
  if p_subject_hash is null or p_subject_hash !~ '^[0-9a-f]{64}$' then return false; end if;
  perform 1 from waldo.imessage_bridges where bridge_id = p_bridge_id and account_id = p_account_id and environment = p_environment
    and kind = 'shared' and state = 'active' for update;
  if not found then return false; end if;
  if exists (select 1 from waldo.imessage_onboarding_replies where bridge_id = p_bridge_id and subject_hash = p_subject_hash
    and last_sent_at > v_now - interval '30 days') then return false; end if;
  if (select count(*) from waldo.imessage_onboarding_replies where bridge_id = p_bridge_id and last_sent_at > v_now - interval '1 hour') >= 20 then return false; end if;
  insert into waldo.imessage_onboarding_replies(bridge_id, subject_hash, last_sent_at) values (p_bridge_id, p_subject_hash, v_now)
    on conflict (bridge_id, subject_hash) do update set last_sent_at = excluded.last_sent_at;
  return true;
end $$;

-- Console status gains the bridge kind.
create or replace function waldo.imessage_list(p_do_name text, p_locator text, p_at bigint, p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform waldo.imessage_signed('list', p_locator, jsonb_build_array(p_do_name), p_at, p_sig);
  return coalesce((select jsonb_agg(jsonb_build_object('bridge_id', b.bridge_id, 'account_id', b.account_id, 'state', b.state, 'kind', b.kind,
      'subject', b.expected_subject, 'chat_guid', b.expected_chat_guid, 'observed', b.observed_at is not null,
      'host_version', b.host_version, 'created_at', b.created_at, 'activated_at', b.activated_at, 'revoked_at', b.revoked_at) order by b.created_at)
    from waldo.imessage_bridges b join waldo.owners o on o.id = b.owner_id where o.do_name = p_do_name), '[]'::jsonb);
end $$;

do $grants$
declare f text;
begin
  foreach f in array array[
    'waldo.imessage_issue_shared_invitation(text,text,text,integer,text,bigint,text)',
    'waldo.imessage_sender_authority(text,text,text,text,text,bigint,text)',
    'waldo.imessage_activate_shared(text,text,text,text,text,bigint,text)',
    'waldo.imessage_onboarding_allowed(text,text,text,text,text,bigint,text)'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to anon';
  end loop;
end $grants$;
