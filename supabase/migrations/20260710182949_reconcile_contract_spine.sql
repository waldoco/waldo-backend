-- Preserve historical consent rows without fabricating source, purpose, withdrawal, or age
-- evidence. New and changed rows must satisfy the canonical consent contract; legacy rows
-- remain readable for audit but never authorize health processing.
alter table public.user_consents
  alter column policy_version drop not null,
  alter column health_data_consent drop not null,
  add column consent_class text,
  add column source text,
  add column purpose text,
  add column version integer,
  add column status text,
  add column granted_at timestamptz,
  add column withdrawn_at timestamptz,
  add column age_attested_18_plus boolean;

alter table public.user_consents
  add constraint user_consents_canonical_record_check
  check ((
    consent_class in ('health_processing', 'telegram_content')
    and char_length(source) between 1 and 100
    and char_length(purpose) between 1 and 200
    and version > 0
    and status in ('granted', 'withdrawn')
    and granted_at is not null
    and age_attested_18_plus is true
    and (
      (status = 'granted' and withdrawn_at is null)
      or (status = 'withdrawn' and withdrawn_at >= granted_at)
    )
  ) is true) not valid;

create unique index user_consents_one_active_grant
  on public.user_consents (user_id, consent_class, source, purpose)
  where status = 'granted';

create index idx_user_consents_user
  on public.user_consents (user_id);

create or replace function public.health_daily_requires_consent()
  returns trigger
  language plpgsql
  security invoker
  set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.user_consents
    where user_id = new.user_id
      and consent_class = 'health_processing'
      and source = new.primary_source
      and purpose = 'daily_readiness_briefing'
      and status = 'granted'
      and withdrawn_at is null
      and age_attested_18_plus is true
  ) then
    raise exception 'health_daily write requires active health processing consent'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.health_daily_requires_consent() from public;

drop trigger health_daily_requires_consent on public.health_daily;
create trigger health_daily_requires_consent
  before insert or update on public.health_daily
  for each row
  execute function public.health_daily_requires_consent();

-- Runtime trace identifiers are opaque contract strings, not necessarily UUIDs.
alter table public.patrol_entries
  alter column trace_id type text using trace_id::text;
alter table public.feedback_signals
  alter column trace_id type text using trace_id::text;
alter table public.agent_logs
  alter column trace_id type text using trace_id::text;

alter table public.notification_log
  add constraint notification_log_idempotency_key_check
  check (idempotency_key ~ '^[0-9a-f]{64}$');

alter table public.crs_scores
  add constraint crs_scores_score_check
    check (score between 0 and 100),
  add constraint crs_scores_zone_check
    check (zone in ('energized', 'steady', 'flagging', 'depleted')),
  add constraint crs_scores_score_zone_check
    check (zone = case
      when score >= 80 then 'energized'
      when score >= 60 then 'steady'
      when score >= 40 then 'flagging'
      else 'depleted'
    end),
  add constraint crs_scores_confidence_check
    check (confidence is null or confidence between 0 and 1);
