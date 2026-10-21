-- A WhatsApp sender Meta names only by business-scoped user id (no phone number) cannot be routed to an owner, and is
-- sent one fixed reply instead: at most once per 30 days per sender and 20 an hour overall, like the iMessage
-- onboarding reply. Only the SHA-256 of the user id is kept, and rows older than 30 days are deleted.
-- This does not use console_auth_throttle: its cleanup deletes every other key's older buckets on each sign-in call.
create table waldo.whatsapp_onboarding_replies (
  subject_hash text primary key check (subject_hash ~ '^[0-9a-f]{64}$'),
  last_sent_at timestamptz not null
);
create index whatsapp_onboarding_replies_last_sent on waldo.whatsapp_onboarding_replies (last_sent_at);
alter table waldo.whatsapp_onboarding_replies enable row level security;
alter table waldo.whatsapp_onboarding_replies force row level security;
revoke all on waldo.whatsapp_onboarding_replies from public, anon, authenticated;

create function waldo.whatsapp_onboarding_allowed(p_subject_hash text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz := clock_timestamp();
begin
  if not waldo.router_signed('waonboard.' || coalesce(p_subject_hash, ''), p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  if p_subject_hash is null or p_subject_hash !~ '^[0-9a-f]{64}$' then return false; end if;
  -- One decision at a time, so neither the per-sender nor the hourly limit can be passed by concurrent calls.
  perform pg_advisory_xact_lock(hashtext('waldo.whatsapp_onboarding_replies'));
  delete from waldo.whatsapp_onboarding_replies where last_sent_at <= v_now - interval '30 days';
  if exists (select 1 from waldo.whatsapp_onboarding_replies where subject_hash = p_subject_hash) then return false; end if;
  if (select count(*) from waldo.whatsapp_onboarding_replies where last_sent_at > v_now - interval '1 hour') >= 20 then return false; end if;
  insert into waldo.whatsapp_onboarding_replies (subject_hash, last_sent_at) values (p_subject_hash, v_now);
  return true;
end $$;
revoke all on function waldo.whatsapp_onboarding_allowed(text, bigint, text) from public;
grant execute on function waldo.whatsapp_onboarding_allowed(text, bigint, text) to anon;
