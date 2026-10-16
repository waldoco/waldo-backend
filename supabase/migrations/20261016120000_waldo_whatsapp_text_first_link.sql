-- Text-first WhatsApp linking. A sender with no presence texts the Waldo number; when exactly one active owner
-- has that number on file, Waldo replies with a one-tap link that opens a request bound to BOTH that sender and
-- that owner. Signing in as that owner and confirming the full number on the console binds the presence. The
-- request is single-use and lives 10 minutes, and only its sha256 is stored.
--
-- Forwarding the link does not move the number: the request names one owner, so a different signed-in owner
-- can neither view nor consume it. The owner's phone on file is unverified contact data, so it only decides
-- who may confirm; the authenticated confirm is what binds.
--
-- The confirm is also the phone verification presences_whatsapp_verified_phone waits for: the link reached
-- only that number's WhatsApp chat, and it is used from a browser signed in as the owner who has that number
-- on file - the same possession proof as a code sent to the phone and typed into the signed-in console.

create table waldo.presence_link_requests (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  provider text not null check (provider = 'whatsapp'),
  subject text not null check (subject ~ '^[1-9][0-9]{5,14}$'),
  owner_id uuid not null references waldo.owners (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create index presence_link_requests_subject on waldo.presence_link_requests (provider, subject) where consumed_at is null;
alter table waldo.presence_link_requests enable row level security;
alter table waldo.presence_link_requests force row level security;
revoke all on waldo.presence_link_requests from public, anon, authenticated;

-- 'opened': a request now exists for this sender and its matching owner. 'linked': the sender already has an
-- active presence. 'waitlist': no single active owner has this number on file.
create function waldo.open_presence_link_request(p_provider text, p_subject text, p_token_hash text, p_at bigint, p_sig text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_owners uuid[];
begin
  if not waldo.router_signed('linkreq.open.' || p_provider || '.' || p_subject || '.' || p_token_hash, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  if p_provider is distinct from 'whatsapp' or p_subject !~ '^[1-9][0-9]{5,14}$' or p_token_hash !~ '^[0-9a-f]{64}$' then return 'waitlist'; end if;
  if exists (select 1 from waldo.presences where provider = p_provider and subject = p_subject and state = 'active') then return 'linked'; end if;
  select array_agg(id) into v_owners from waldo.owners where state = 'active' and phone = '+' || p_subject;
  if coalesce(array_length(v_owners, 1), 0) <> 1 then return 'waitlist'; end if;
  -- One live request per sender: a new one replaces any earlier unconsumed link.
  delete from waldo.presence_link_requests where provider = p_provider and subject = p_subject and consumed_at is null;
  delete from waldo.presence_link_requests where expires_at < now() - interval '1 day';
  insert into waldo.presence_link_requests (token_hash, provider, subject, owner_id, expires_at)
    values (p_token_hash, p_provider, p_subject, v_owners[1], now() + interval '10 minutes');
  return 'opened';
end $$;

-- Read-only: the subject a live request would link, only for the owner it names. The confirm page shows it in full.
create function waldo.presence_link_request_subject(p_do_name text, p_token_hash text, p_at bigint, p_sig text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_subject text;
begin
  if not waldo.router_signed('linkreq.view.' || p_do_name || '.' || p_token_hash, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select r.subject into v_subject from waldo.presence_link_requests r join waldo.owners o on o.id = r.owner_id
    where r.token_hash = p_token_hash and o.do_name = p_do_name and o.state = 'active' and r.consumed_at is null and r.expires_at > now();
  return v_subject;
end $$;

-- The bind: the request must be live, name this owner and the subject the confirm page showed, and the owner's
-- number on file must still be that subject. It is consumed whatever the outcome after those checks, so a link
-- is never usable twice. 'claimed': the sender became active under another owner meanwhile, and nothing changed.
-- Linking replaces this owner's earlier WhatsApp presence.
create function waldo.consume_presence_link_request(p_do_name text, p_token_hash text, p_subject text, p_at bigint, p_sig text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_request waldo.presence_link_requests; v_owner uuid;
begin
  if not waldo.router_signed('linkreq.consume.' || p_do_name || '.' || p_token_hash || '.' || p_subject, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select id into v_owner from waldo.owners where do_name = p_do_name and state = 'active' for update;
  if v_owner is null then return 'rejected'; end if;
  select * into v_request from waldo.presence_link_requests where token_hash = p_token_hash for update;
  if v_request.token_hash is null or v_request.consumed_at is not null or v_request.expires_at <= now()
    or v_request.owner_id <> v_owner or v_request.subject is distinct from p_subject then return 'rejected'; end if;
  update waldo.presence_link_requests set consumed_at = now() where token_hash = p_token_hash;
  if not exists (select 1 from waldo.owners where id = v_owner and phone = '+' || v_request.subject) then return 'rejected'; end if;
  if exists (select 1 from waldo.presences where provider = v_request.provider and subject = v_request.subject and state = 'active' and owner_id <> v_owner) then
    return 'claimed';
  end if;
  update waldo.owners set phone_verified_at = now() where id = v_owner and phone_verified_at is null;
  update waldo.presences set state = 'unlinked', unlinked_at = now() where provider = v_request.provider and owner_id = v_owner and state = 'active';
  insert into waldo.presences (owner_id, provider, subject) values (v_owner, v_request.provider, v_request.subject);
  return 'linked';
end $$;

do $grants$
declare f text;
begin
  foreach f in array array[
    'waldo.open_presence_link_request(text,text,text,bigint,text)',
    'waldo.presence_link_request_subject(text,text,bigint,text)',
    'waldo.consume_presence_link_request(text,text,text,bigint,text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon', f);
  end loop;
end $grants$;
