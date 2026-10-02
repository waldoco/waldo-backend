-- Disabled runtime preparation: phone proof is not signup completion authority.
create table if not exists waldo.signup_phone_budget (
  id boolean primary key default true check (id),
  sends integer not null default 0 check (sends between 0 and 20),
  checks integer not null default 0 check (checks between 0 and 50),
  proof_slots integer not null default 0 check (proof_slots between 0 and 10)
);
insert into waldo.signup_phone_budget(id) values (true) on conflict do nothing;
create table if not exists waldo.signup_phone_challenges (
  attempt uuid primary key,
  auth_user uuid not null,
  email text not null,
  invite_hash text not null check (invite_hash ~ '^[0-9a-f]{64}$'),
  phone text not null check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  service text not null check (service ~ '^VA[0-9a-fA-F]{32}$'),
  signup_expires timestamptz not null,
  phone_expires timestamptz not null,
  -- NULL quarantines an in-flight/uncertain send until separately reviewed reconciliation.
  recipient_hold_until timestamptz,
  sid text check (sid ~ '^VE[0-9a-fA-F]{32}$'),
  state text not null check (state in ('sending','pending','checking','approved','canceled','expired','unknown')),
  operation uuid,
  sends integer not null default 1 check (sends between 1 and 3),
  checks integer not null default 0 check (checks between 0 and 5),
  next_send timestamptz not null,
  approved_at timestamptz,
  check (state <> 'approved' or approved_at is not null)
);
create index if not exists signup_phone_recipient on waldo.signup_phone_challenges(service,phone);
alter table waldo.signup_phone_budget enable row level security;
alter table waldo.signup_phone_budget force row level security;
alter table waldo.signup_phone_challenges enable row level security;
alter table waldo.signup_phone_challenges force row level security;
revoke all on waldo.signup_phone_budget, waldo.signup_phone_challenges from public, anon, authenticated;

create or replace function waldo.signup_phone_transition(p_action text, p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p jsonb; c waldo.signup_phone_challenges%rowtype; b waldo.signup_phone_budget%rowtype;
  v_attempt uuid; v_auth uuid; v_operation uuid; v_email text; v_hash text; v_phone text; v_service text;
  v_expires timestamptz; v_now timestamptz; v_outcome text; v_sid text;
begin
  if not coalesce(waldo.router_signed('phoneproof.' || p_action || '.' || p_payload, p_at, p_sig),false) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  if length(p_payload) > 2048 or p_action not in ('reserve_send','finish_send','reserve_check','finish_check','cancel') then
    return jsonb_build_object('kind','denied');
  end if;
  begin
    p := p_payload::jsonb;
    v_attempt := (p->>'attempt')::uuid; v_auth := (p->>'authUser')::uuid;
    v_email := p->>'email'; v_hash := p->>'inviteHash'; v_phone := p->>'phone'; v_service := p->>'service';
    v_expires := to_timestamp((p->>'expires')::bigint);
    if p_action <> 'cancel' then v_operation := (p->>'operation')::uuid; end if;
  exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then
    return jsonb_build_object('kind','denied');
  end;
  if v_attempt is null or v_auth is null or v_email is null or v_email <> lower(v_email) or length(v_email)>254
    or v_email ~ '[[:space:]]' or position('@' in v_email)<2
    or v_hash is null or v_hash !~ '^[0-9a-f]{64}$' or v_phone is null or v_phone !~ '^\+[1-9][0-9]{6,14}$'
    or v_service is null or v_service !~ '^VA[0-9a-fA-F]{32}$' or v_expires is null
    or (p_action <> 'cancel' and v_operation is null) then return jsonb_build_object('kind','denied'); end if;
  -- All operations acquire locks in the same order. Pilot counters serialize across processes.
  select * into b from waldo.signup_phone_budget where id for update;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('phoneproof.'||v_service||'.'||v_phone,0));
  select * into c from waldo.signup_phone_challenges where attempt=v_attempt for update;
  if c.attempt is not null and (c.auth_user<>v_auth or c.email<>v_email or c.invite_hash<>v_hash
    or c.phone<>v_phone or c.service<>v_service or c.signup_expires<>v_expires) then return jsonb_build_object('kind','denied'); end if;
  v_now := clock_timestamp();
  -- Cancellation is allowed after expiry/revocation but preserves the recipient quarantine.
  if p_action='cancel' then
    if c.attempt is null then return jsonb_build_object('kind','denied'); end if;
    update waldo.signup_phone_challenges set state='canceled',operation=null,approved_at=null where attempt=v_attempt;
    return jsonb_build_object('kind','canceled');
  end if;
  if v_expires<=v_now or v_expires>v_now+interval '15 minutes'
    or (c.attempt is not null and c.phone_expires<=v_now) then return jsonb_build_object('kind','expired'); end if;
  -- The exact invited recipient is required, not the active-member branch of signin_allowed.
  if not exists(select 1 from auth.users where id=v_auth and lower(email)=v_email and email_confirmed_at is not null)
    or exists(select 1 from waldo.owners where auth_user_id=v_auth or lower(email)=v_email)
    or not exists(select 1 from waldo.invites where code_hash=v_hash and lower(email)=v_email
      and used_at is null and revoked_at is null and expires_at>v_now) then return jsonb_build_object('kind','denied'); end if;
  if p_action='reserve_send' then
    if c.attempt is null then
      if exists(select 1 from waldo.signup_phone_challenges where service=v_service and phone=v_phone
        and (recipient_hold_until is null or recipient_hold_until>v_now)) then return jsonb_build_object('kind','denied'); end if;
    elsif c.state<>'pending' then return jsonb_build_object('kind','denied');
    elsif c.next_send>v_now or c.sends>=3 then return jsonb_build_object('kind','throttled'); end if;
    if b.id is null or b.sends>=20 then return jsonb_build_object('kind','throttled'); end if;
    update waldo.signup_phone_budget set sends=sends+1 where id;
    if c.attempt is null then
      insert into waldo.signup_phone_challenges(attempt,auth_user,email,invite_hash,phone,service,signup_expires,phone_expires,state,operation,next_send)
        values(v_attempt,v_auth,v_email,v_hash,v_phone,v_service,v_expires,least(v_expires,v_now+interval '10 minutes'),'sending',v_operation,v_now+interval '60 seconds');
    else
      update waldo.signup_phone_challenges set state='sending',operation=v_operation,sends=sends+1,next_send=v_now+interval '60 seconds',recipient_hold_until=null where attempt=v_attempt;
    end if;
    return jsonb_build_object('kind','reserved');
  end if;
  if c.attempt is null then return jsonb_build_object('kind','denied'); end if;
  if p_action='reserve_check' then
    if c.state<>'pending' or c.sid is null then return jsonb_build_object('kind','denied'); end if;
    if c.checks>=5 or b.id is null or b.checks>=50 or b.proof_slots>=10 then return jsonb_build_object('kind','throttled'); end if;
    update waldo.signup_phone_budget set checks=checks+1,proof_slots=proof_slots+1 where id;
    update waldo.signup_phone_challenges set state='checking',operation=v_operation,checks=checks+1 where attempt=v_attempt;
    return jsonb_build_object('kind','reserved','reference',jsonb_build_object('service',c.service,'sid',c.sid,'phone',c.phone));
  end if;
  if c.operation is distinct from v_operation or c.state<>(case p_action when 'finish_send' then 'sending' else 'checking' end) then
    return jsonb_build_object('kind','denied');
  end if;
  v_outcome := p->>'outcome'; v_sid := p->>'sid';
  if v_outcome is null or v_outcome not in ('pending','approved','unknown','expired','throttled') then return jsonb_build_object('kind','denied'); end if;
  if p_action='finish_send' then
    if v_outcome='pending' and v_sid ~ '^VE[0-9a-fA-F]{32}$' and (c.sid is null or c.sid=v_sid) then
      update waldo.signup_phone_challenges set state='pending',sid=v_sid,operation=null,
        recipient_hold_until=greatest(coalesce(recipient_hold_until,v_now),v_now+interval '10 minutes') where attempt=v_attempt;
      return jsonb_build_object('kind','pending');
    end if;
    -- Even explicit provider errors cannot authorize an automatic send retry.
    update waldo.signup_phone_challenges set state='unknown',operation=null,recipient_hold_until=null where attempt=v_attempt;
    return jsonb_build_object('kind','unknown');
  end if;
  if v_outcome in ('pending','approved') and (v_sid is null or v_sid<>c.sid) then v_outcome:='unknown'; end if;
  if v_outcome='approved' then
    update waldo.signup_phone_challenges set state='approved',approved_at=v_now,operation=null where attempt=v_attempt;
    return jsonb_build_object('kind','approved');
  elsif v_outcome='pending' then
    update waldo.signup_phone_budget set proof_slots=proof_slots-1 where id;
    update waldo.signup_phone_challenges set state='pending',operation=null where attempt=v_attempt;
    return jsonb_build_object('kind','pending');
  end if;
  update waldo.signup_phone_challenges set state=case when v_outcome='expired' then 'expired' else 'unknown' end,operation=null where attempt=v_attempt;
  return jsonb_build_object('kind',case when v_outcome='expired' then 'expired' else 'unknown' end);
end $$;
revoke all on function waldo.signup_phone_transition(text,text,bigint,text) from public;
grant execute on function waldo.signup_phone_transition(text,text,bigint,text) to anon;
