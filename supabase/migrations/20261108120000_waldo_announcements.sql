-- What's new: an announcement is product copy an admin writes once. Each owner's Waldo reads the announcements for its
-- environment on a release wake, checks the capability is live for its owner, and decides how and whether to say it.
-- Only a signed router call naming an active admin's DO writes one; nothing else can create or edit a row, so the table
-- is not a channel into every owner's model. An announcement is created in dry run everywhere it targets: owners'
-- Waldos only count who is eligible, and each environment needs its own explicit go before anything is said there.
-- Outcomes hold an announcement id, an owner and one word per owner, never message text, so the dry-run report and the
-- delivered counts are counts only. The owner's DO keeps the authoritative per-owner state; this row is its report.
create table waldo.announcements (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  release text not null check (length(release) between 1 and 64),
  title text not null check (length(title) between 1 and 120),
  shipped text not null check (length(shipped) between 1 and 1000),
  why text not null check (length(why) between 1 and 1000),
  capability text not null check (capability ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  requires text[] not null default '{}' check (requires <@ array['app', 'whatsapp', 'imessage', 'google', 'health']),
  environments text[] not null check (cardinality(environments) > 0 and environments <@ array['preview', 'staging', 'production']),
  live_in text[] not null default '{}' check (live_in <@ environments),
  created_by uuid references waldo.owners(id) on delete set null,
  created_at timestamptz not null default now()
);

create table waldo.announcement_outcomes (
  announcement_id text not null references waldo.announcements(id) on delete cascade,
  owner_id uuid not null references waldo.owners(id) on delete cascade,
  outcome text not null check (outcome in ('eligible', 'not_live', 'opted_out', 'folded', 'messaged', 'skipped')),
  reported_at timestamptz not null default now(),
  primary key (announcement_id, owner_id)
);

alter table waldo.announcements enable row level security;
alter table waldo.announcements force row level security;
alter table waldo.announcement_outcomes enable row level security;
alter table waldo.announcement_outcomes force row level security;
revoke all on table waldo.announcements, waldo.announcement_outcomes from public, anon, authenticated;

-- The signature covers every field, so a captured call cannot be replayed with different copy. Fields are joined with
-- the unit separator (U+001F), lists with commas.
create function waldo.admin_announce(p_do_name text, p_id text, p_release text, p_title text, p_shipped text, p_why text,
  p_capability text, p_requires text, p_environments text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_admin uuid;
begin
  if not waldo.router_signed('announce.' || p_do_name || '.' || p_id || '.' || encode(extensions.digest(concat_ws(chr(31),
      p_release, p_title, p_shipped, p_why, p_capability, p_requires, p_environments), 'sha256'), 'hex'), p_at, p_sig)
    then raise exception 'unsigned router call' using errcode = '42501'; end if;
  if not waldo.is_admin(p_do_name) then return false; end if;
  select id into v_admin from waldo.owners where do_name = p_do_name;
  insert into waldo.announcements (id, release, title, shipped, why, capability, requires, environments, created_by)
  values (p_id, p_release, p_title, p_shipped, p_why, p_capability,
    coalesce(string_to_array(nullif(p_requires, ''), ','), '{}'), string_to_array(nullif(p_environments, ''), ','), v_admin)
  on conflict (id) do nothing;
  return found;
end $$;

-- The go for one environment. Production is never live until an admin says so for production by itself.
create function waldo.admin_announcement_live(p_do_name text, p_id text, p_environment text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not waldo.router_signed('announcelive.' || p_do_name || '.' || p_id || '.' || p_environment, p_at, p_sig)
    then raise exception 'unsigned router call' using errcode = '42501'; end if;
  if not waldo.is_admin(p_do_name) then return false; end if;
  update waldo.announcements set live_in = array_append(live_in, p_environment)
  where id = p_id and p_environment = any(environments) and not (p_environment = any(live_in));
  return found;
end $$;

-- Counts per outcome for one announcement, and how many active owners there are to compare against.
create function waldo.admin_announcement_report(p_do_name text, p_id text, p_at bigint, p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not waldo.router_signed('announcereport.' || p_do_name || '.' || p_id, p_at, p_sig)
    then raise exception 'unsigned router call' using errcode = '42501'; end if;
  if not waldo.is_admin(p_do_name) or not exists (select 1 from waldo.announcements where id = p_id) then return null; end if;
  return jsonb_build_object(
    'live_in', (select to_jsonb(live_in) from waldo.announcements where id = p_id),
    'owners', (select count(*) from waldo.owners where state = 'active'),
    'outcomes', coalesce((select jsonb_object_agg(outcome, n) from (select outcome, count(*) as n
      from waldo.announcement_outcomes where announcement_id = p_id group by outcome) c), '{}'::jsonb));
end $$;

-- What an owner's Waldo may read: the announcements targeting its environment, newest first, and whether each is live
-- there. A DO that is not an active owner gets nothing.
create function waldo.announcements_for(p_do_name text, p_environment text, p_at bigint, p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not waldo.router_signed('announcements.' || p_do_name || '.' || p_environment, p_at, p_sig)
    then raise exception 'unsigned router call' using errcode = '42501'; end if;
  if not exists (select 1 from waldo.owners where do_name = p_do_name and state = 'active') then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'release', a.release, 'title', a.title, 'shipped', a.shipped,
      'why', a.why, 'capability', a.capability, 'requires', to_jsonb(a.requires), 'live', p_environment = any(a.live_in),
      'created_at', a.created_at) order by a.created_at desc)
    from (select * from waldo.announcements where p_environment = any(environments) order by created_at desc limit 20) a), '[]'::jsonb);
end $$;

-- An owner's DO reports its own outcome for one announcement. The latest report wins, so a dry-run count of eligible
-- becomes folded, messaged or skipped once the environment goes live.
create function waldo.announcement_report(p_do_name text, p_id text, p_outcome text, p_at bigint, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  if not waldo.router_signed('announcereport.owner.' || p_do_name || '.' || p_id || '.' || p_outcome, p_at, p_sig)
    then raise exception 'unsigned router call' using errcode = '42501'; end if;
  select id into v_owner from waldo.owners where do_name = p_do_name and state = 'active';
  if v_owner is null or not exists (select 1 from waldo.announcements where id = p_id) then return false; end if;
  insert into waldo.announcement_outcomes (announcement_id, owner_id, outcome) values (p_id, v_owner, p_outcome)
  on conflict (announcement_id, owner_id) do update set outcome = excluded.outcome, reported_at = now();
  return true;
end $$;

revoke all on function waldo.admin_announce(text, text, text, text, text, text, text, text, text, bigint, text) from public;
revoke all on function waldo.admin_announcement_live(text, text, text, bigint, text) from public;
revoke all on function waldo.admin_announcement_report(text, text, bigint, text) from public;
revoke all on function waldo.announcements_for(text, text, bigint, text) from public;
revoke all on function waldo.announcement_report(text, text, text, bigint, text) from public;
grant execute on function waldo.admin_announce(text, text, text, text, text, text, text, text, text, bigint, text) to anon;
grant execute on function waldo.admin_announcement_live(text, text, text, bigint, text) to anon;
grant execute on function waldo.admin_announcement_report(text, text, bigint, text) to anon;
grant execute on function waldo.announcements_for(text, text, bigint, text) to anon;
grant execute on function waldo.announcement_report(text, text, text, bigint, text) to anon;
