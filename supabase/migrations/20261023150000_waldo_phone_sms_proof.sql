-- Phone verification by a code Twilio Verify texts to the number on file, for an owner who cannot text Waldo first.
-- Only the router calls it, for an owner it has already signed in, and only for that owner's own number on file: the
-- number is read here, never taken from the request. Each send is reserved before Twilio is called and finished after,
-- so a lost answer stays recorded as unknown and is never retried by itself. The code is never stored; Twilio checks it.
-- An approved check proves the number exactly as a link code texted from it does, through the one shared rule below.
-- It links no channel and grants no session.

-- The one rule for proving a number, shared by the link code and the texted code: the owner is active, the number is the
-- one on file and not yet verified, and no other active owner has verified it. The number's lock makes two owners
-- proving the same number at once take turns, so at most one of them succeeds.
create function waldo.verify_owner_phone(p_owner uuid, p_number text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_owner is null or p_number is null or p_number !~ '^\+[1-9][0-9]{6,14}$' then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('waldophone.' || p_number, 0));
  update waldo.owners set phone_verified_at = now()
    where id = p_owner and state = 'active' and phone = p_number and phone_verified_at is null
      and not exists (select 1 from waldo.owners other
        where other.id <> p_owner and other.state = 'active' and other.phone = p_number and other.phone_verified_at is not null);
  return found;
end $$;
revoke all on function waldo.verify_owner_phone(uuid, text) from public, anon, authenticated;

create or replace function waldo.redeem_link_code(p_code_hash text, p_provider text, p_subject text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  update waldo.link_codes set used_at = now()
    where code_hash = p_code_hash and provider = p_provider and used_at is null and expires_at > now()
    returning owner_id into v_owner;
  if v_owner is null then return null; end if;
  update waldo.presences set state = 'unlinked', unlinked_at = now()
    where provider = p_provider and owner_id = v_owner and state = 'active';
  if exists (select 1 from waldo.presences where provider = p_provider and subject = p_subject and state = 'active') then
    raise exception 'presence already linked to another owner' using errcode = '23505';
  end if;
  perform waldo.verify_owner_phone(v_owner, case p_provider when 'whatsapp' then '+' || p_subject when 'imessage' then p_subject end);
  insert into waldo.presences (owner_id, provider, subject) values (v_owner, p_provider, p_subject);
  return v_owner;
end $$;

comment on column waldo.owners.phone is 'Contact phone (E.164) given at signup. Unverified until phone_verified_at is set; Waldo sends nothing to an unverified number except a Twilio Verify code the owner asks for.';
comment on column waldo.owners.phone_verified_at is 'When the number on file was proven: a link code texted to Waldo from it, or a code Twilio Verify texted to it at the owner''s request (waldo.verify_owner_phone). NULL = unverified; a change of number clears it, and no whatsapp presence may link while NULL.';

-- One challenge per owner. The hold keeps every other owner from having a code sent to the same number while this
-- owner's code is live or a send's outcome is unknown.
create table waldo.phone_sms_challenges (
  owner_id uuid primary key references waldo.owners (id) on delete cascade,
  phone text not null check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  service text not null check (service ~ '^VA[0-9a-fA-F]{32}$'),
  sid text check (sid ~ '^VE[0-9a-fA-F]{32}$'),
  state text not null check (state in ('sending', 'pending', 'checking', 'approved', 'expired', 'unknown')),
  operation uuid,
  sends integer not null check (sends between 1 and 3),
  checks integer not null default 0 check (checks between 0 and 5),
  next_send timestamptz not null,
  send_day date not null,
  expires_at timestamptz not null,
  recipient_hold_until timestamptz not null,
  approved_at timestamptz,
  check ((state in ('sending', 'checking')) = (operation is not null)),
  check (state <> 'approved' or approved_at is not null)
);
create index phone_sms_challenges_phone on waldo.phone_sms_challenges (phone);

-- Sends in a UTC day, per owner and the number texted. The rows belong to the owner and go with the account; the number
-- is keyed by an HMAC under a key derived from the router's Vault secret, so the key cannot be reversed by hashing
-- candidate numbers. Summed by owner and by number key, they give the per-owner and per-number caps across owners.
-- Rotating the router secret starts the day's per-number counts afresh.
create table waldo.phone_sms_daily (
  owner_id uuid not null references waldo.owners (id) on delete cascade,
  number_key text not null check (number_key ~ '^[0-9a-f]{64}$'),
  day date not null,
  sends integer not null check (sends between 0 and 5),
  primary key (owner_id, number_key, day)
);
create index phone_sms_daily_number on waldo.phone_sms_daily (number_key, day);
-- Sends in a UTC day across the whole server, against the cap the router signs into each reservation. No owner, no number.
create table waldo.phone_sms_sends (
  day date primary key,
  sends integer not null check (sends >= 0)
);
alter table waldo.phone_sms_challenges enable row level security;
alter table waldo.phone_sms_challenges force row level security;
alter table waldo.phone_sms_daily enable row level security;
alter table waldo.phone_sms_daily force row level security;
alter table waldo.phone_sms_sends enable row level security;
alter table waldo.phone_sms_sends force row level security;
revoke all on waldo.phone_sms_challenges, waldo.phone_sms_daily, waldo.phone_sms_sends from public, anon, authenticated;

create function waldo.phone_sms_number_key(p_number text) returns text
language plpgsql stable set search_path = '' as $$
declare v_secret text;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'waldo_router_hmac';
  if v_secret is null then raise exception 'phone counter key unavailable'; end if;
  return encode(extensions.hmac('phonecap.' || p_number, v_secret, 'sha256'), 'hex');
end $$;
revoke all on function waldo.phone_sms_number_key(text) from public, anon, authenticated;

create function waldo.phone_sms_transition(p_action text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p jsonb; o waldo.owners; c waldo.phone_sms_challenges;
  v_service text; v_operation uuid; v_outcome text; v_sid text; v_locked text; v_number_key text; v_now timestamptz; v_day date;
  v_resend boolean := false; v_limit integer;
begin
  if not waldo.router_signed('phonesms.' || p_action || '.' || p_payload, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  if length(p_payload) > 1024 or p_action not in ('reserve_send', 'finish_send', 'reserve_check', 'finish_check') then
    return jsonb_build_object('kind', 'denied');
  end if;
  begin
    p := p_payload::jsonb;
    v_service := p->>'service'; v_operation := (p->>'operation')::uuid; v_outcome := p->>'outcome'; v_sid := p->>'sid';
  exception when invalid_text_representation then return jsonb_build_object('kind', 'denied');
  end;
  if jsonb_typeof(p) <> 'object' or v_service is null or v_service !~ '^VA[0-9a-fA-F]{32}$' or v_operation is null then
    return jsonb_build_object('kind', 'denied');
  end if;
  select * into o from waldo.owners where do_name = p->>'do_name';
  if o.id is null then return jsonb_build_object('kind', 'denied'); end if;
  -- Locks in one order everywhere: the number, then the owner's challenge. The clock is read after both.
  v_locked := o.phone;
  if v_locked is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('waldophone.' || v_locked, 0));
  end if;
  select * into o from waldo.owners where id = o.id;
  if o.phone is distinct from v_locked then return jsonb_build_object('kind', 'busy'); end if;
  select * into c from waldo.phone_sms_challenges where owner_id = o.id for update;
  v_now := clock_timestamp();
  v_day := (v_now at time zone 'utc')::date;
  if o.state <> 'active' then return jsonb_build_object('kind', 'denied'); end if;

  if p_action = 'reserve_send' then
    -- Rows from before sign-up checked the format can hold a number that is not E.164: there is nothing to text.
    if o.phone is null or o.phone !~ '^\+[1-9][0-9]{6,14}$' then return jsonb_build_object('kind', 'no_number'); end if;
    if o.phone_verified_at is not null then return jsonb_build_object('kind', 'verified'); end if;
    -- The router signs in the country codes it may text and the server's daily cap. A malformed list or cap is refused;
    -- an empty list texts nobody, and a cap above 200 is held to 200.
    if jsonb_typeof(p->'countries') is distinct from 'array' or jsonb_typeof(p->'daily_limit') is distinct from 'number'
        or (p->>'daily_limit') !~ '^[1-9][0-9]{0,5}$'
        or exists (select 1 from jsonb_array_elements(p->'countries') e where jsonb_typeof(e) <> 'string' or e #>> '{}' !~ '^\+[1-9][0-9]{0,2}$') then
      return jsonb_build_object('kind', 'denied');
    end if;
    if not exists (select 1 from jsonb_array_elements_text(p->'countries') cc where starts_with(o.phone, cc)) then
      return jsonb_build_object('kind', 'unsupported');
    end if;
    v_limit := least((p->>'daily_limit')::integer, 200);
    if exists (select 1 from waldo.owners other where other.id <> o.id and other.state = 'active'
        and other.phone = o.phone and other.phone_verified_at is not null) then
      return jsonb_build_object('kind', 'number_taken');
    end if;
    if exists (select 1 from waldo.phone_sms_challenges h where h.owner_id <> o.id and h.phone = o.phone
        and h.recipient_hold_until > v_now) then
      return jsonb_build_object('kind', 'held');
    end if;
    if c.owner_id is not null then
      if (c.state = 'sending' and c.recipient_hold_until > v_now) or (c.state = 'checking' and c.expires_at > v_now) then
        return jsonb_build_object('kind', 'busy');
      end if;
      if c.state = 'unknown' and c.recipient_hold_until > v_now then return jsonb_build_object('kind', 'throttled'); end if;
      -- Sends are 60 seconds apart whatever came of the last one, a refused one included.
      if c.next_send > v_now then return jsonb_build_object('kind', 'throttled'); end if;
      v_resend := c.state = 'pending' and c.expires_at > v_now and c.phone = o.phone and c.service = v_service;
      if v_resend and c.sends >= 3 then return jsonb_build_object('kind', 'throttled'); end if;
    end if;
    v_number_key := waldo.phone_sms_number_key(o.phone);
    if (select coalesce(sum(sends), 0) from waldo.phone_sms_daily where owner_id = o.id and day = v_day) >= 5
        or (select coalesce(sum(sends), 0) from waldo.phone_sms_daily where number_key = v_number_key and day = v_day) >= 5 then
      return jsonb_build_object('kind', 'throttled');
    end if;
    -- The server's count is the last check and the first write, in one statement, so two sends to different numbers
    -- cannot both take the last place under the cap, and a send refused at the cap charges nothing else.
    insert into waldo.phone_sms_sends (day, sends) values (v_day, 1)
      on conflict (day) do update set sends = waldo.phone_sms_sends.sends + 1 where waldo.phone_sms_sends.sends < v_limit;
    if not found then return jsonb_build_object('kind', 'throttled'); end if;
    insert into waldo.phone_sms_daily (owner_id, number_key, day, sends) values (o.id, v_number_key, v_day, 1)
      on conflict (owner_id, number_key, day) do update set sends = waldo.phone_sms_daily.sends + 1;
    delete from waldo.phone_sms_daily where day < v_day - 1;
    delete from waldo.phone_sms_sends where day < v_day - 1;
    if v_resend then
      update waldo.phone_sms_challenges set state = 'sending', operation = v_operation, sends = sends + 1, send_day = v_day,
        next_send = v_now + interval '60 seconds', recipient_hold_until = greatest(recipient_hold_until, v_now + interval '1 hour')
        where owner_id = o.id;
    else
      insert into waldo.phone_sms_challenges (owner_id, phone, service, state, operation, sends, next_send, send_day, expires_at, recipient_hold_until)
        values (o.id, o.phone, v_service, 'sending', v_operation, 1, v_now + interval '60 seconds', v_day, v_now + interval '10 minutes', v_now + interval '1 hour')
        on conflict (owner_id) do update set phone = excluded.phone, service = excluded.service, sid = null, state = 'sending',
          operation = excluded.operation, sends = 1, checks = 0, next_send = excluded.next_send, send_day = excluded.send_day,
          expires_at = excluded.expires_at, recipient_hold_until = excluded.recipient_hold_until, approved_at = null;
    end if;
    return jsonb_build_object('kind', 'reserved', 'phone', o.phone);
  end if;

  if c.owner_id is null or c.service <> v_service then return jsonb_build_object('kind', 'denied'); end if;

  if p_action = 'reserve_check' then
    if c.state = 'checking' and c.expires_at > v_now then return jsonb_build_object('kind', 'busy'); end if;
    if c.state = 'expired' or (c.state in ('pending', 'checking') and c.expires_at <= v_now) then
      update waldo.phone_sms_challenges set state = 'expired', operation = null where owner_id = o.id;
      return jsonb_build_object('kind', 'expired');
    end if;
    if c.state <> 'pending' or c.sid is null or c.phone is distinct from o.phone then return jsonb_build_object('kind', 'denied'); end if;
    if c.checks >= 5 then return jsonb_build_object('kind', 'throttled'); end if;
    update waldo.phone_sms_challenges set state = 'checking', operation = v_operation, checks = checks + 1 where owner_id = o.id;
    return jsonb_build_object('kind', 'reserved', 'reference', jsonb_build_object('service', c.service, 'sid', c.sid, 'phone', c.phone));
  end if;

  if c.operation is distinct from v_operation or c.state <> (case p_action when 'finish_send' then 'sending' else 'checking' end)
      or v_outcome is null or v_outcome not in ('pending', 'approved', 'unknown', 'expired', 'throttled', 'refused') then
    return jsonb_build_object('kind', 'denied');
  end if;

  if p_action = 'finish_send' then
    -- A resend may come back as a new verification; the code's ten minutes still count from the first send.
    if v_outcome = 'pending' and v_sid ~ '^VE[0-9a-fA-F]{32}$' then
      update waldo.phone_sms_challenges set state = 'pending', sid = v_sid, operation = null,
        recipient_hold_until = greatest(c.expires_at, v_now) where owner_id = o.id;
      return jsonb_build_object('kind', 'pending');
    end if;
    -- Twilio turned the request down, so no text went out: the send is refunded on the day it was charged and the number
    -- is not held. A refused resend leaves the code already sent working.
    if v_outcome = 'refused' then
      update waldo.phone_sms_sends set sends = sends - 1 where day = c.send_day and sends > 0;
      update waldo.phone_sms_daily set sends = sends - 1
        where owner_id = o.id and number_key = waldo.phone_sms_number_key(c.phone) and day = c.send_day and sends > 0;
      if c.sid is null then
        update waldo.phone_sms_challenges set state = 'expired', operation = null, recipient_hold_until = v_now where owner_id = o.id;
      else
        update waldo.phone_sms_challenges set state = 'pending', operation = null, sends = sends - 1,
          recipient_hold_until = greatest(c.expires_at, v_now) where owner_id = o.id;
      end if;
      return jsonb_build_object('kind', 'refused');
    end if;
    -- No clear answer: the text may have gone out, so the number stays held.
    update waldo.phone_sms_challenges set state = 'unknown', operation = null, recipient_hold_until = v_now + interval '1 hour'
      where owner_id = o.id;
    return jsonb_build_object('kind', 'unknown');
  end if;

  -- An answer about another verification proves nothing; the challenge stays open for another try.
  if v_outcome in ('pending', 'approved') and v_sid is distinct from c.sid then
    update waldo.phone_sms_challenges set state = 'pending', operation = null where owner_id = o.id;
    return jsonb_build_object('kind', 'denied');
  end if;
  if v_outcome = 'approved' then
    if c.expires_at <= v_now then
      update waldo.phone_sms_challenges set state = 'expired', operation = null where owner_id = o.id;
      return jsonb_build_object('kind', 'expired');
    end if;
    if c.phone is distinct from o.phone then
      update waldo.phone_sms_challenges set state = 'expired', operation = null where owner_id = o.id;
      return jsonb_build_object('kind', 'denied');
    end if;
    if o.phone_verified_at is null and not waldo.verify_owner_phone(o.id, c.phone) then
      update waldo.phone_sms_challenges set state = 'expired', operation = null where owner_id = o.id;
      return jsonb_build_object('kind', 'number_taken');
    end if;
    update waldo.phone_sms_challenges set state = 'approved', approved_at = v_now, operation = null where owner_id = o.id;
    return jsonb_build_object('kind', 'approved');
  end if;
  if v_outcome = 'expired' then
    update waldo.phone_sms_challenges set state = 'expired', operation = null where owner_id = o.id;
    return jsonb_build_object('kind', 'expired');
  end if;
  -- Twilio turned the check down, so the code was not checked: the try is given back.
  if v_outcome = 'refused' then
    update waldo.phone_sms_challenges set state = 'pending', operation = null, checks = checks - 1 where owner_id = o.id;
    return jsonb_build_object('kind', 'refused');
  end if;
  update waldo.phone_sms_challenges set state = 'pending', operation = null where owner_id = o.id;
  return jsonb_build_object('kind', v_outcome);
end $$;

-- What the console and the app show: the number on file, whether it is proven, and the state of a code sent to it, with
-- when the owner may next ask for one (null: now) and how many checks the code has left, so a surface offers only what
-- the ledger would accept. A daily cap or another owner's hold is not shown; the refusal says so when the owner asks.
create function waldo.owner_phone_state(p_do_name text, p_at bigint, p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare o waldo.owners; c waldo.phone_sms_challenges; v_state text; v_retry timestamptz;
begin
  if not waldo.router_signed('phonestate.' || p_do_name, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  select * into o from waldo.owners where do_name = p_do_name and state = 'active';
  if o.id is null then return null; end if;
  select * into c from waldo.phone_sms_challenges where owner_id = o.id and phone = o.phone;
  v_state := case
    when c.owner_id is null then null
    when c.state = 'sending' and c.recipient_hold_until <= now() then 'unknown'
    when c.state in ('pending', 'checking') and c.expires_at <= now() then 'expired'
    else c.state end;
  v_retry := case
    when v_state in ('pending', 'checking') and c.sends >= 3 then c.expires_at
    when v_state = 'sending' or c.state = 'unknown' then c.recipient_hold_until
    else c.next_send end;
  return jsonb_build_object('phone', case when o.phone ~ '^\+[1-9][0-9]{6,14}$' then o.phone end, 'verified', o.phone_verified_at is not null,
    'challenge', case when v_state is null then null
      else jsonb_build_object('state', v_state, 'expires_at', extract(epoch from c.expires_at)::bigint,
        'retry_at', case when v_retry > now() then extract(epoch from v_retry)::bigint end, 'checks_left', 5 - c.checks) end);
end $$;

revoke all on function waldo.phone_sms_transition(text, text, bigint, text), waldo.owner_phone_state(text, bigint, text) from public;
grant execute on function waldo.phone_sms_transition(text, text, bigint, text), waldo.owner_phone_state(text, bigint, text) to anon;
