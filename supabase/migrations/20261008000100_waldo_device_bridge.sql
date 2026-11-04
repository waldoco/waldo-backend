-- Pairing hashes and devices are accessible only through router-authenticated RPCs.
create table waldo.device_pairing_codes (
  code_hash text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  owner_id uuid not null references waldo.owners(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  check (expires_at = created_at + interval '600 seconds')
);
create index device_pairing_codes_owner on waldo.device_pairing_codes(owner_id);
create table waldo.devices (
  device_id text primary key check (device_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  owner_id uuid not null references waldo.owners(id) on delete cascade,
  pubkey text not null unique check (pubkey ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
  capabilities text[] not null check (capabilities in (array['machine_state_query'],array['notify_local'],array['machine_state_query','notify_local'])),
  label text not null check (octet_length(label) between 1 and 120),
  contract_version text not null check (contract_version = '0.2.3'),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);
create index devices_owner on waldo.devices(owner_id);
-- Each row holds at most 20 admitted instants, with a row lock serializing workers.
-- Independent keys prevent cleanup of one window from resetting another budget.
create table waldo.device_bridge_throttle_keys (
  key text primary key,
  admitted_at timestamptz[] not null default '{}'
);
alter table waldo.device_pairing_codes enable row level security;
alter table waldo.device_pairing_codes force row level security;
alter table waldo.devices enable row level security;
alter table waldo.devices force row level security;
alter table waldo.device_bridge_throttle_keys enable row level security;
alter table waldo.device_bridge_throttle_keys force row level security;
revoke all on waldo.device_pairing_codes,waldo.devices,waldo.device_bridge_throttle_keys from public,anon,authenticated;

create function waldo.issue_device_pairing_code(p_do_name text,p_code_hash text,p_at bigint,p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_now timestamptz;
begin
  if waldo.router_signed('devpair.'||p_do_name||'.'||p_code_hash,p_at,p_sig) is not true then raise exception 'unsigned router call' using errcode='42501'; end if;
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then return false; end if;
  -- Serialize all issuers for this owner before checking the outstanding-code cap.
  select id into v_owner from waldo.owners where do_name=p_do_name and state='active' for update;
  if v_owner is null then return false; end if;
  v_now := clock_timestamp();
  if (select count(*) from waldo.device_pairing_codes where owner_id=v_owner and used_at is null and expires_at>v_now)>=5 then return false; end if;
  insert into waldo.device_pairing_codes(code_hash,owner_id,created_at,expires_at) values(p_code_hash,v_owner,v_now,v_now+interval '600 seconds');
  return true;
exception when unique_violation then return false;
end $$;

create function waldo.redeem_device_pairing(p_code_hash text,p_pubkey text,p_label text,p_capabilities text,p_at bigint,p_sig text) returns table(device_id text,owner_id text)
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_device text; v_now timestamptz;
begin
  if waldo.router_signed('devredeem.'||p_code_hash||'.'||p_pubkey||'.'||encode(convert_to(p_label,'UTF8'),'hex')||'.'||p_capabilities,p_at,p_sig) is not true then raise exception 'unsigned router call' using errcode='42501'; end if;
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' or p_pubkey is null or p_pubkey !~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$' or p_label is null or octet_length(p_label) not between 1 and 120 or p_capabilities is null or p_capabilities not in ('machine_state_query','notify_local','machine_state_query,notify_local') then return; end if;
  -- Lock before reading database time so waiting cannot admit an expired code.
  select c.owner_id into v_owner from waldo.device_pairing_codes c where c.code_hash=p_code_hash and c.used_at is null for update;
  if v_owner is null then return; end if;
  perform 1 from waldo.owners where id=v_owner and state='active' for update;
  if not found then return; end if;
  v_now := clock_timestamp();
  update waldo.device_pairing_codes c set used_at=v_now where c.code_hash=p_code_hash and c.used_at is null and c.expires_at>v_now;
  if not found then return; end if;
  v_device := gen_random_uuid()::text;
  insert into waldo.devices(device_id,owner_id,pubkey,capabilities,label,contract_version,created_at) values(v_device,v_owner,p_pubkey,string_to_array(p_capabilities,','),p_label,'0.2.3',v_now);
  return query select v_device,v_owner::text;
-- The exception subtransaction rolls back code consumption with a pubkey conflict.
exception when unique_violation then return;
end $$;

create function waldo.device_for_auth(p_device_id text,p_at bigint,p_sig text) returns table(owner_id text,pubkey text,capabilities text)
language plpgsql security definer set search_path = '' as $$
begin
  if waldo.router_signed('devauth.'||p_device_id,p_at,p_sig) is not true then raise exception 'unsigned router call' using errcode='42501'; end if;
  return query select d.owner_id::text,d.pubkey,array_to_string(d.capabilities,',') from waldo.devices d join waldo.owners o on o.id=d.owner_id where d.device_id=p_device_id and o.state='active';
end $$;
create function waldo.device_touch(p_device_id text,p_at bigint,p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if waldo.router_signed('devtouch.'||p_device_id,p_at,p_sig) is not true then raise exception 'unsigned router call' using errcode='42501'; end if;
  update waldo.devices d set last_seen_at=clock_timestamp() from waldo.owners o where o.id=d.owner_id and o.state='active' and d.device_id=p_device_id;
  return found;
end $$;
create function waldo.list_devices(p_do_name text,p_at bigint,p_sig text) returns table(device_id text,label text,capabilities text,created_at timestamptz,last_seen_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if waldo.router_signed('devlist.'||p_do_name,p_at,p_sig) is not true then raise exception 'unsigned router call' using errcode='42501'; end if;
  return query select d.device_id,d.label,array_to_string(d.capabilities,','),d.created_at,d.last_seen_at from waldo.devices d join waldo.owners o on o.id=d.owner_id where o.do_name=p_do_name and o.state='active' order by d.created_at,d.device_id;
end $$;
create function waldo.revoke_device(p_do_name text,p_device_id text,p_at bigint,p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if waldo.router_signed('devrevoke.'||p_do_name||'.'||p_device_id,p_at,p_sig) is not true then raise exception 'unsigned router call' using errcode='42501'; end if;
  delete from waldo.devices d using waldo.owners o where o.id=d.owner_id and o.do_name=p_do_name and o.state='active' and d.device_id=p_device_id;
  return found;
end $$;
create function waldo.device_bridge_throttle(p_key text,p_limit integer,p_window_seconds integer,p_at bigint,p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz; v_times timestamptz[];
begin
  if waldo.router_signed('devthrottle.'||p_key||'.'||p_limit::text||'.'||p_window_seconds::text,p_at,p_sig) is not true then raise exception 'unsigned router call' using errcode='42501'; end if;
  if (p_key ~ '^devredeem\.ip60\.[0-9a-f]{64}$' and p_limit=5 and p_window_seconds=60 or p_key ~ '^devredeem\.ip3600\.[0-9a-f]{64}$' and p_limit=20 and p_window_seconds=3600 or p_key ~ '^devredeem\.code\.[0-9a-f]{64}$' and p_limit=5 and p_window_seconds=600) is not true then raise exception 'invalid device throttle profile' using errcode='22023'; end if;
  insert into waldo.device_bridge_throttle_keys(key) values(p_key) on conflict do nothing;
  select admitted_at into v_times from waldo.device_bridge_throttle_keys where key=p_key for update;
  v_now := clock_timestamp();
  select coalesce(array_agg(t),'{}'::timestamptz[]) into v_times from unnest(v_times) t where t>v_now-make_interval(secs=>p_window_seconds);
  if cardinality(v_times)>=p_limit then return false; end if;
  update waldo.device_bridge_throttle_keys set admitted_at=array_append(v_times,v_now) where key=p_key;
  return true;
end $$;
revoke all on function waldo.issue_device_pairing_code(text,text,bigint,text),waldo.redeem_device_pairing(text,text,text,text,bigint,text),waldo.device_for_auth(text,bigint,text),waldo.device_touch(text,bigint,text),waldo.list_devices(text,bigint,text),waldo.revoke_device(text,text,bigint,text),waldo.device_bridge_throttle(text,integer,integer,bigint,text) from public,anon,authenticated;
grant execute on function waldo.issue_device_pairing_code(text,text,bigint,text),waldo.redeem_device_pairing(text,text,text,text,bigint,text),waldo.device_for_auth(text,bigint,text),waldo.device_touch(text,bigint,text),waldo.list_devices(text,bigint,text),waldo.revoke_device(text,text,bigint,text),waldo.device_bridge_throttle(text,integer,integer,bigint,text) to anon;
