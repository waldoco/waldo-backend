-- Beta diagnostic recording: whether staging may keep this owner's chat text in the diagnostic tool (Langfuse).
-- One row per agreement, carrying the wording version the owner saw and where they agreed (signup, the console or the app);
-- withdrawn_at closes it. At most one agreement is live per owner, so the history of agreeing and withdrawing survives.
-- No row means not agreed. Only the two signed router functions below read or write this table.
create table waldo.diagnostic_recording_agreements (
  id bigint generated always as identity primary key,
  owner_id uuid not null references waldo.owners (id) on delete cascade,
  wording_version text not null check (wording_version ~ '^[a-z0-9][a-z0-9.-]{0,39}$'),
  source text not null check (source in ('signup', 'console', 'app')),
  agreed_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  check (withdrawn_at is null or withdrawn_at >= agreed_at)
);
create unique index diagnostic_recording_agreements_live on waldo.diagnostic_recording_agreements (owner_id) where withdrawn_at is null;
alter table waldo.diagnostic_recording_agreements enable row level security;
alter table waldo.diagnostic_recording_agreements force row level security;
revoke all on table waldo.diagnostic_recording_agreements from public, anon, authenticated;

-- Agree (p_agreed true) or withdraw. Agreeing needs an active owner; withdrawing works for any owner, so a suspended
-- owner is never left recorded. Agreeing again to the wording already agreed changes nothing; agreeing to newer
-- wording closes the old agreement and opens one for the new version. Every argument rides the signed message.
create function waldo.set_diagnostic_recording(p_do_name text, p_agreed boolean, p_version text, p_source text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_state text; v_live text;
begin
  if p_do_name is null or p_agreed is null or p_version is null or p_source is null
    or waldo.router_signed('diagnostic.set.' || p_do_name || '.' || case when p_agreed then 'on' else 'off' end || '.' || p_version || '.' || p_source, p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  if length(p_do_name) not between 1 and 240 or p_version !~ '^[a-z0-9][a-z0-9.-]{0,39}$' or p_source not in ('signup', 'console', 'app') then return false; end if;
  select id, state into v_owner, v_state from waldo.owners where do_name = p_do_name for update;
  if v_owner is null then return false; end if;
  select wording_version into v_live from waldo.diagnostic_recording_agreements where owner_id = v_owner and withdrawn_at is null;
  if not p_agreed or v_live is distinct from p_version then
    update waldo.diagnostic_recording_agreements set withdrawn_at = now() where owner_id = v_owner and withdrawn_at is null;
  end if;
  if not p_agreed then return true; end if;
  if v_state <> 'active' then return false; end if;
  if v_live is distinct from p_version then
    insert into waldo.diagnostic_recording_agreements (owner_id, wording_version, source) values (v_owner, p_version, p_source);
  end if;
  return true;
end $$;

-- The owner's live agreement, if any: {agreed, version, agreed_at}. Null for a DO with no active owner, which callers
-- read as not agreed.
create function waldo.diagnostic_recording_state(p_do_name text, p_at bigint, p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_owner uuid; v_row waldo.diagnostic_recording_agreements;
begin
  if p_do_name is null or waldo.router_signed('diagnostic.read.' || p_do_name, p_at, p_sig) is distinct from true then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select id into v_owner from waldo.owners where do_name = p_do_name and state = 'active';
  if v_owner is null then return null; end if;
  select * into v_row from waldo.diagnostic_recording_agreements where owner_id = v_owner and withdrawn_at is null;
  return jsonb_build_object('agreed', v_row.id is not null, 'version', v_row.wording_version,
    'agreed_at', to_char(v_row.agreed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end $$;

revoke all on function waldo.set_diagnostic_recording(text, boolean, text, text, bigint, text) from public, anon, authenticated, service_role;
revoke all on function waldo.diagnostic_recording_state(text, bigint, text) from public, anon, authenticated, service_role;
grant execute on function waldo.set_diagnostic_recording(text, boolean, text, text, bigint, text) to anon;
grant execute on function waldo.diagnostic_recording_state(text, bigint, text) to anon;
