-- The owner sets or changes their own number on file from the app or console. Only the router calls it, for an owner it
-- has already signed in. The number is stored unverified: a change clears the old proof through
-- owners_phone_change_unverifies, and only verify_owner_phone proves a number. A number another active owner has
-- verified is refused as taken, without saying whose. Each attempt that could answer taken counts against a small daily
-- cap per owner, so the answer cannot be used to sweep for numbers registered with Waldo.

create table waldo.phone_set_daily (
  owner_id uuid primary key references waldo.owners (id) on delete cascade,
  day date not null,
  attempts integer not null check (attempts between 1 and 5)
);
alter table waldo.phone_set_daily enable row level security;
alter table waldo.phone_set_daily force row level security;
revoke all on waldo.phone_set_daily from public, anon, authenticated;

-- Outcomes: set (stored, unverified), unchanged (already the number on file; its proof stands), taken, invalid (not
-- E.164), unsupported (outside the country codes the router signs in), throttled (five attempts this UTC day), denied.
create function waldo.owner_phone_set(p_payload text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p jsonb; o waldo.owners; v_phone text; v_day date;
begin
  if not waldo.router_signed('phoneset.' || p_payload, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  if length(p_payload) > 1024 then return jsonb_build_object('kind', 'denied'); end if;
  begin p := p_payload::jsonb;
  exception when invalid_text_representation then return jsonb_build_object('kind', 'denied');
  end;
  if jsonb_typeof(p) <> 'object' or jsonb_typeof(p->'phone') is distinct from 'string' or jsonb_typeof(p->'countries') is distinct from 'array'
      or exists (select 1 from jsonb_array_elements(p->'countries') e where jsonb_typeof(e) <> 'string' or e #>> '{}' !~ '^\+[1-9][0-9]{0,2}$') then
    return jsonb_build_object('kind', 'denied');
  end if;
  select * into o from waldo.owners where do_name = p->>'do_name' and state = 'active';
  if o.id is null then return jsonb_build_object('kind', 'denied'); end if;
  v_phone := p->>'phone';
  if v_phone !~ '^\+[1-9][0-9]{6,14}$' then return jsonb_build_object('kind', 'invalid'); end if;
  if not exists (select 1 from jsonb_array_elements_text(p->'countries') cc where starts_with(v_phone, cc)) then
    return jsonb_build_object('kind', 'unsupported');
  end if;
  -- The number locks, in one order, so a send or check for the old number and another owner proving the new one take
  -- turns with this change. The owner is read again after them.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('waldophone.' || least(o.phone, v_phone), 0));
  if o.phone <> v_phone then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('waldophone.' || greatest(o.phone, v_phone), 0));
  end if;
  select * into o from waldo.owners where id = o.id for update;
  if o.state <> 'active' then return jsonb_build_object('kind', 'denied'); end if;
  if o.phone = v_phone then return jsonb_build_object('kind', 'unchanged'); end if;
  v_day := (clock_timestamp() at time zone 'utc')::date;
  insert into waldo.phone_set_daily (owner_id, day, attempts) values (o.id, v_day, 1)
    on conflict (owner_id) do update set day = v_day,
      attempts = case when waldo.phone_set_daily.day = v_day then waldo.phone_set_daily.attempts + 1 else 1 end
    where waldo.phone_set_daily.day <> v_day or waldo.phone_set_daily.attempts < 5;
  if not found then return jsonb_build_object('kind', 'throttled'); end if;
  if exists (select 1 from waldo.owners other where other.id <> o.id and other.state = 'active'
      and other.phone = v_phone and other.phone_verified_at is not null) then
    return jsonb_build_object('kind', 'taken');
  end if;
  update waldo.owners set phone = v_phone where id = o.id;
  return jsonb_build_object('kind', 'set');
end $$;

revoke all on function waldo.owner_phone_set(text, bigint, text) from public, anon, authenticated;
grant execute on function waldo.owner_phone_set(text, bigint, text) to anon;
