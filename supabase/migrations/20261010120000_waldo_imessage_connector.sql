-- iMessage connector: pairing invitation -> pending bridge credential -> owner-set expected scope ->
-- host-observed one-use challenge -> owner-confirmed activation -> revoke. Every effect goes through
-- router-signed security definer functions; tables are unreachable for public/anon/authenticated.
-- PROPOSED lifecycle (handoff 2026-10-10 section 2). Activation trusts the paired host's observation
-- of the challenge; it is not Apple cryptographic attestation. Live use stays gated off in config.

alter table waldo.presences drop constraint presences_provider_check;
alter table waldo.presences add constraint presences_provider_check
  check (provider in ('telegram','console','ios','whatsapp','imessage'));

create sequence waldo.imessage_authority_revision_seq as bigint no cycle;

create table waldo.imessage_invitations (
  code_hash text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  owner_id uuid not null references waldo.owners(id) on delete cascade,
  environment text not null check (environment ~ '^[a-z][a-z0-9_-]{0,31}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '3600 seconds')
);
create index imessage_invitations_owner on waldo.imessage_invitations(owner_id);

create table waldo.imessage_bridges (
  bridge_id text primary key check (bridge_id ~ '^imb_[0-9a-f]{32}$'),
  account_id text not null unique check (account_id ~ '^ima_[0-9a-f]{32}$'),
  owner_id uuid not null references waldo.owners(id) on delete cascade,
  environment text not null check (environment ~ '^[a-z][a-z0-9_-]{0,31}$'),
  state text not null check (state in ('pending','active','revoked')),
  -- AES-GCM ciphertext made by the Worker under a separately configured wrapping key. Never plaintext.
  wrapped_credential text not null check (wrapped_credential ~ '^v1\.[0-9a-f]{24}\.[0-9a-f]+$'),
  credential_epoch integer not null default 1 check (credential_epoch > 0),
  authority_revision bigint not null default nextval('waldo.imessage_authority_revision_seq'::regclass),
  host_version text not null check (octet_length(host_version) between 1 and 128),
  transport_version text not null check (octet_length(transport_version) between 1 and 128),
  database_generation text not null check (octet_length(database_generation) between 1 and 512),
  expected_subject text check (octet_length(expected_subject) between 1 and 512),
  expected_chat_guid text check (octet_length(expected_chat_guid) between 1 and 512),
  challenge_hash text check (challenge_hash ~ '^[0-9a-f]{64}$'),
  challenge_expires_at timestamptz,
  observed_subject text,
  observed_chat_guid text,
  observed_generation text,
  observed_event_id text,
  observed_digest text check (observed_digest ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz,
  presence_id uuid references waldo.presences(id) on delete set null,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  revoked_at timestamptz,
  -- presence_id is deliberately outside these checks: a presence unlinked or deleted elsewhere makes
  -- the authority read report the binding revoked instead of blocking that deletion.
  check ((state = 'active') = (activated_at is not null and revoked_at is null)),
  check (state <> 'revoked' or revoked_at is not null)
);
create index imessage_bridges_owner on waldo.imessage_bridges(owner_id);
-- First slice: one active exact sender/chat binding per owner on this rail.
create unique index imessage_bridges_one_active_per_owner on waldo.imessage_bridges(owner_id) where state = 'active';

create table waldo.imessage_throttle_keys (
  key text primary key,
  admitted_at timestamptz[] not null default '{}'
);

alter table waldo.imessage_invitations enable row level security;
alter table waldo.imessage_invitations force row level security;
alter table waldo.imessage_bridges enable row level security;
alter table waldo.imessage_bridges force row level security;
alter table waldo.imessage_throttle_keys enable row level security;
alter table waldo.imessage_throttle_keys force row level security;
revoke all on waldo.imessage_invitations, waldo.imessage_bridges, waldo.imessage_throttle_keys from public, anon, authenticated;
revoke all on sequence waldo.imessage_authority_revision_seq from public, anon, authenticated;

-- Every RPC passes its arguments twice: as parameters and as a JSON locator whose sha256 is signed.
create function waldo.imessage_signed(p_op text, p_locator text, p_args jsonb, p_at bigint, p_sig text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_locator is null or p_args is null or p_locator::jsonb is distinct from p_args then
    raise exception 'imessage locator mismatch' using errcode = '42501';
  end if;
  if waldo.router_signed('imsg.' || p_op || '.' || encode(extensions.digest(p_locator, 'sha256'), 'hex'), p_at, p_sig) is not true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
end $$;
revoke all on function waldo.imessage_signed(text,text,jsonb,bigint,text) from public, anon, authenticated;

create function waldo.imessage_throttle(p_key text, p_limit integer, p_window_seconds integer, p_locator text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz := clock_timestamp(); v_times timestamptz[];
begin
  perform waldo.imessage_signed('throttle', p_locator, jsonb_build_array(p_key, p_limit, p_window_seconds), p_at, p_sig);
  if p_key is null or p_key !~ '^imredeem\.(code|source)\.[0-9a-f]{64}$' or p_limit not between 1 and 20 or p_window_seconds not between 1 and 86400 then return false; end if;
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

-- Console (owner session + CSRF already verified by the Worker/owner DO) issues a one-use invitation.
create function waldo.imessage_issue_invitation(p_do_name text, p_environment text, p_code_hash text, p_lifetime_seconds integer, p_locator text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_now timestamptz;
begin
  perform waldo.imessage_signed('invite', p_locator, jsonb_build_array(p_do_name, p_environment, p_code_hash, p_lifetime_seconds), p_at, p_sig);
  if p_code_hash !~ '^[0-9a-f]{64}$' or p_lifetime_seconds not between 60 and 3600 or p_environment !~ '^[a-z][a-z0-9_-]{0,31}$' then return false; end if;
  select id into v_owner from waldo.owners where do_name = p_do_name and state = 'active' for update;
  if v_owner is null then return false; end if;
  v_now := clock_timestamp();
  if (select count(*) from waldo.imessage_invitations where owner_id = v_owner and used_at is null and expires_at > v_now) >= 3 then return false; end if;
  insert into waldo.imessage_invitations(code_hash, owner_id, environment, created_at, expires_at)
    values (p_code_hash, v_owner, p_environment, v_now, v_now + make_interval(secs => p_lifetime_seconds));
  return true;
exception when unique_violation then return false;
end $$;

-- Host redeems: consumes the invitation and creates a PENDING bridge. Owner/DO come from the
-- invitation row, never from the caller. Pending credentials cannot reach owner turns.
create function waldo.imessage_redeem_invitation(p_code_hash text, p_environment text, p_bridge_id text, p_account_id text, p_wrapped_credential text,
  p_host_version text, p_transport_version text, p_generation text, p_locator text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_invite waldo.imessage_invitations; v_do text;
begin
  perform waldo.imessage_signed('redeem', p_locator, jsonb_build_array(p_code_hash, p_environment, p_bridge_id, p_account_id, p_wrapped_credential, p_host_version, p_transport_version, p_generation), p_at, p_sig);
  select * into v_invite from waldo.imessage_invitations where code_hash = p_code_hash and used_at is null for update;
  if v_invite.code_hash is null or v_invite.expires_at <= clock_timestamp() or v_invite.environment <> p_environment then return null; end if;
  select do_name into v_do from waldo.owners where id = v_invite.owner_id and state = 'active';
  if v_do is null then return null; end if;
  update waldo.imessage_invitations set used_at = clock_timestamp() where code_hash = p_code_hash;
  insert into waldo.imessage_bridges(bridge_id, account_id, owner_id, environment, state, wrapped_credential, host_version, transport_version, database_generation)
    values (p_bridge_id, p_account_id, v_invite.owner_id, p_environment, 'pending', p_wrapped_credential, p_host_version, p_transport_version, p_generation);
  return jsonb_build_object('bridge_id', p_bridge_id, 'account_id', p_account_id, 'do_name', v_do);
exception when unique_violation or check_violation then return null;
end $$;

-- Current authority for one bridge/account. Never returns raw key material: only the wrapped
-- credential, which needs the Worker's separately configured wrapping key.
create function waldo.imessage_bridge_authority(p_environment text, p_bridge_id text, p_account_id text, p_locator text, p_at bigint, p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r record;
begin
  perform waldo.imessage_signed('authority', p_locator, jsonb_build_array(p_environment, p_bridge_id, p_account_id), p_at, p_sig);
  select b.*, o.do_name, o.state as owner_state, o.state_version, o.admission_revision, p.subject as presence_subject, p.state as presence_state
    into r from waldo.imessage_bridges b join waldo.owners o on o.id = b.owner_id left join waldo.presences p on p.id = b.presence_id
    where b.bridge_id = p_bridge_id and b.account_id = p_account_id and b.environment = p_environment;
  if r.bridge_id is null then return null; end if;
  return jsonb_build_object(
    'state', case when r.owner_state <> 'active' then 'owner_inactive'
                  when r.state = 'active' and (r.presence_state is distinct from 'active') then 'revoked'
                  else r.state end,
    'bridge_id', r.bridge_id, 'account_id', r.account_id, 'owner_id', r.owner_id, 'do_name', r.do_name,
    'wrapped_credential', r.wrapped_credential, 'credential_epoch', r.credential_epoch,
    'revision', r.authority_revision::text || '.' || r.state_version::text || '.' || r.admission_revision::text,
    'presence_id', r.presence_id, 'subject', r.presence_subject, 'chat_guid', case when r.state = 'active' then r.expected_chat_guid end,
    'challenge_hash', case when r.state = 'pending' and r.observed_at is null and r.challenge_expires_at > clock_timestamp() then r.challenge_hash end,
    'expected_subject', case when r.state = 'pending' then r.expected_subject end,
    'expected_chat_guid', case when r.state = 'pending' then r.expected_chat_guid end);
end $$;

-- Console: owner sets the exact expected sender/direct chat and a fresh one-use challenge.
create function waldo.imessage_set_expected_scope(p_do_name text, p_bridge_id text, p_subject text, p_chat_guid text, p_challenge_hash text, p_lifetime_seconds integer,
  p_locator text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  perform waldo.imessage_signed('scope', p_locator, jsonb_build_array(p_do_name, p_bridge_id, p_subject, p_chat_guid, p_challenge_hash, p_lifetime_seconds), p_at, p_sig);
  if p_challenge_hash !~ '^[0-9a-f]{64}$' or p_lifetime_seconds not between 60 and 3600
    or octet_length(coalesce(p_subject, '')) not between 1 and 512 or octet_length(coalesce(p_chat_guid, '')) not between 1 and 512
    -- Direct iMessage chats only: no group, SMS or RCS chat identifiers.
    or p_chat_guid !~ '^iMessage;-;' then return false; end if;
  select id into v_owner from waldo.owners where do_name = p_do_name and state = 'active';
  if v_owner is null then return false; end if;
  update waldo.imessage_bridges set expected_subject = p_subject, expected_chat_guid = p_chat_guid, challenge_hash = p_challenge_hash,
      challenge_expires_at = clock_timestamp() + make_interval(secs => p_lifetime_seconds),
      observed_subject = null, observed_chat_guid = null, observed_generation = null, observed_event_id = null, observed_digest = null, observed_at = null,
      authority_revision = nextval('waldo.imessage_authority_revision_seq'::regclass)
    where bridge_id = p_bridge_id and owner_id = v_owner and state = 'pending';
  return found;
end $$;

-- Host (pending S2 credential, verified by the Worker) reports the challenge it observed. Only a
-- direct, incoming iMessage from the expected sender in the expected chat, before expiry, counts.
create function waldo.imessage_record_challenge(p_environment text, p_bridge_id text, p_account_id text, p_challenge_hash text, p_subject text, p_chat_guid text,
  p_generation text, p_event_id text, p_event_digest text, p_locator text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform waldo.imessage_signed('challenge', p_locator, jsonb_build_array(p_environment, p_bridge_id, p_account_id, p_challenge_hash, p_subject, p_chat_guid, p_generation, p_event_id, p_event_digest), p_at, p_sig);
  if p_event_digest !~ '^[0-9a-f]{64}$' then return false; end if;
  update waldo.imessage_bridges set observed_subject = p_subject, observed_chat_guid = p_chat_guid, observed_generation = p_generation,
      observed_event_id = p_event_id, observed_digest = p_event_digest, observed_at = clock_timestamp()
    where bridge_id = p_bridge_id and account_id = p_account_id and environment = p_environment and state = 'pending'
      and observed_at is null and challenge_hash = p_challenge_hash and challenge_expires_at > clock_timestamp()
      and expected_subject = p_subject and expected_chat_guid = p_chat_guid
      and exists (select 1 from waldo.owners o where o.id = owner_id and o.state = 'active');
  return found;
end $$;

-- Console: the authenticated owner confirms the observed scope. Atomically consumes the observation,
-- creates the exact active presence and binding and bumps the revision. Concurrent/duplicate live
-- subjects or a second active binding for the owner fail closed.
create function waldo.imessage_activate(p_do_name text, p_bridge_id text, p_subject text, p_chat_guid text, p_locator text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; b waldo.imessage_bridges; v_presence uuid;
begin
  perform waldo.imessage_signed('activate', p_locator, jsonb_build_array(p_do_name, p_bridge_id, p_subject, p_chat_guid), p_at, p_sig);
  select id into v_owner from waldo.owners where do_name = p_do_name and state = 'active' for update;
  if v_owner is null then return null; end if;
  select * into b from waldo.imessage_bridges where bridge_id = p_bridge_id and owner_id = v_owner for update;
  if b.bridge_id is null or b.state <> 'pending' or b.observed_at is null or b.challenge_expires_at <= clock_timestamp()
    or b.observed_subject is distinct from b.expected_subject or b.observed_chat_guid is distinct from b.expected_chat_guid
    or b.observed_subject is distinct from p_subject or b.observed_chat_guid is distinct from p_chat_guid then return null; end if;
  if exists (select 1 from waldo.imessage_bridges where owner_id = v_owner and state = 'active') then return null; end if;
  if exists (select 1 from waldo.presences where provider = 'imessage' and subject = b.observed_subject and state = 'active') then return null; end if;
  insert into waldo.presences(owner_id, provider, subject, state) values (v_owner, 'imessage', b.observed_subject, 'active') returning id into v_presence;
  update waldo.imessage_bridges set state = 'active', presence_id = v_presence, activated_at = clock_timestamp(), challenge_hash = null,
      authority_revision = nextval('waldo.imessage_authority_revision_seq'::regclass)
    where bridge_id = b.bridge_id;
  return jsonb_build_object('bridge_id', b.bridge_id, 'account_id', b.account_id, 'presence_id', v_presence, 'subject', b.observed_subject, 'chat_guid', b.observed_chat_guid);
exception when unique_violation then return null;
end $$;

-- Console: revoke FIRST invalidates canonical authority (state + revision), then unlinks the presence.
create function waldo.imessage_revoke(p_do_name text, p_bridge_id text, p_locator text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_presence uuid;
begin
  perform waldo.imessage_signed('revoke', p_locator, jsonb_build_array(p_do_name, p_bridge_id), p_at, p_sig);
  select id into v_owner from waldo.owners where do_name = p_do_name;
  if v_owner is null then return false; end if;
  select presence_id into v_presence from waldo.imessage_bridges
    where bridge_id = p_bridge_id and owner_id = v_owner and state in ('pending', 'active') for update;
  if not found then return false; end if;
  update waldo.imessage_bridges set state = 'revoked', revoked_at = clock_timestamp(), challenge_hash = null, activated_at = null, presence_id = null,
      authority_revision = nextval('waldo.imessage_authority_revision_seq'::regclass)
    where bridge_id = p_bridge_id;
  if v_presence is not null then
    update waldo.presences set state = 'unlinked', unlinked_at = now() where id = v_presence and state = 'active';
  end if;
  return true;
end $$;

-- Console status: safe fields only (no credentials, invitations, challenges or observations).
create function waldo.imessage_list(p_do_name text, p_locator text, p_at bigint, p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform waldo.imessage_signed('list', p_locator, jsonb_build_array(p_do_name), p_at, p_sig);
  return coalesce((select jsonb_agg(jsonb_build_object('bridge_id', b.bridge_id, 'account_id', b.account_id, 'state', b.state,
      'subject', b.expected_subject, 'chat_guid', b.expected_chat_guid, 'observed', b.observed_at is not null,
      'host_version', b.host_version, 'created_at', b.created_at, 'activated_at', b.activated_at, 'revoked_at', b.revoked_at) order by b.created_at)
    from waldo.imessage_bridges b join waldo.owners o on o.id = b.owner_id where o.do_name = p_do_name), '[]'::jsonb);
end $$;

do $grants$
declare f text;
begin
  foreach f in array array[
    'waldo.imessage_throttle(text,integer,integer,text,bigint,text)',
    'waldo.imessage_issue_invitation(text,text,text,integer,text,bigint,text)',
    'waldo.imessage_redeem_invitation(text,text,text,text,text,text,text,text,text,bigint,text)',
    'waldo.imessage_bridge_authority(text,text,text,text,bigint,text)',
    'waldo.imessage_set_expected_scope(text,text,text,text,text,integer,text,bigint,text)',
    'waldo.imessage_record_challenge(text,text,text,text,text,text,text,text,text,text,bigint,text)',
    'waldo.imessage_activate(text,text,text,text,text,bigint,text)',
    'waldo.imessage_revoke(text,text,text,bigint,text)',
    'waldo.imessage_list(text,text,bigint,text)'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to anon';
  end loop;
end $grants$;
