-- iMessage through Photon (Spectrum cloud, shared-pool plan). Before someone can text Waldo, their iPhone number has
-- to be a user of Waldo's Photon project, and Photon assigns them the pool number they text. The Worker enrolls an
-- owner with Photon from the console and records the outcome here, so the console can show "your Waldo number".
--
-- Enrollment links no one: a text from the number still reaches an owner's Waldo only after the owner links it
-- ("waldo CODE" sent from that phone, the code issued to that signed-in owner). The enrolled phone is the owner's own
-- claim, like owners.phone; it only decides which number Photon lets through and who is told to finish linking.

create table waldo.imessage_photon_enrollments (
  owner_id uuid primary key references waldo.owners (id) on delete cascade,
  environment text not null check (environment ~ '^[a-z][a-z0-9_-]{0,31}$'),
  phone text not null check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  photon_user_id text not null check (length(photon_user_id) between 1 and 128),
  assigned_number text not null check (assigned_number ~ '^\+[1-9][0-9]{6,14}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One owner per number per environment: Photon routes a number to one project user.
create unique index imessage_photon_enrollments_phone on waldo.imessage_photon_enrollments (environment, phone);
alter table waldo.imessage_photon_enrollments enable row level security;
alter table waldo.imessage_photon_enrollments force row level security;
revoke all on waldo.imessage_photon_enrollments from public, anon, authenticated;

-- What the console needs to enroll an active owner: their sign-in email (Photon requires one per user), their phone
-- on file (to prefill the form) and their current enrollment, if any.
create function waldo.imessage_enrollment_read(p_do_name text, p_environment text, p_locator text, p_at bigint, p_sig text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_owner waldo.owners; v_row waldo.imessage_photon_enrollments;
begin
  perform waldo.imessage_signed('enroll_read', p_locator, jsonb_build_array(p_do_name, p_environment), p_at, p_sig);
  select * into v_owner from waldo.owners where do_name = p_do_name and state = 'active';
  if v_owner.id is null then return null; end if;
  select * into v_row from waldo.imessage_photon_enrollments where owner_id = v_owner.id and environment = p_environment;
  return jsonb_build_object('email', v_owner.email, 'phone', v_owner.phone,
    'enrollment', case when v_row.owner_id is null then null else jsonb_build_object(
      'phone', v_row.phone, 'photon_user_id', v_row.photon_user_id, 'assigned_number', v_row.assigned_number) end);
end $$;

-- Records (or replaces) the owner's enrollment after Photon accepted it. 'phone_taken': another active owner already
-- enrolled this number here, so nothing changed.
create function waldo.imessage_enrollment_record(p_do_name text, p_environment text, p_phone text, p_photon_user_id text, p_assigned_number text,
  p_locator text, p_at bigint, p_sig text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  perform waldo.imessage_signed('enroll_record', p_locator, jsonb_build_array(p_do_name, p_environment, p_phone, p_photon_user_id, p_assigned_number), p_at, p_sig);
  if p_phone is null or p_phone !~ '^\+[1-9][0-9]{6,14}$' or p_assigned_number is null or p_assigned_number !~ '^\+[1-9][0-9]{6,14}$'
    or p_photon_user_id is null or length(p_photon_user_id) not between 1 and 128 then return 'rejected'; end if;
  select id into v_owner from waldo.owners where do_name = p_do_name and state = 'active' for update;
  if v_owner is null then return 'rejected'; end if;
  if exists (select 1 from waldo.imessage_photon_enrollments e join waldo.owners o on o.id = e.owner_id
    where e.environment = p_environment and e.phone = p_phone and e.owner_id <> v_owner and o.state = 'active') then return 'phone_taken'; end if;
  -- An inactive owner's stale row for this number gives way.
  delete from waldo.imessage_photon_enrollments where environment = p_environment and phone = p_phone and owner_id <> v_owner;
  insert into waldo.imessage_photon_enrollments (owner_id, environment, phone, photon_user_id, assigned_number)
    values (v_owner, p_environment, p_phone, p_photon_user_id, p_assigned_number)
    on conflict (owner_id) do update set environment = excluded.environment, phone = excluded.phone, photon_user_id = excluded.photon_user_id,
      assigned_number = excluded.assigned_number, updated_at = now();
  return 'recorded';
end $$;

-- A shared-number sender with no linked Waldo: true when an active owner enrolled exactly this number, so the bridge
-- tells them to finish linking from their console instead of sending the waitlist link. Names no owner.
create function waldo.imessage_enrolled_handle(p_environment text, p_subject text, p_locator text, p_at bigint, p_sig text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  perform waldo.imessage_signed('enrolled', p_locator, jsonb_build_array(p_environment, p_subject), p_at, p_sig);
  return exists (select 1 from waldo.imessage_photon_enrollments e join waldo.owners o on o.id = e.owner_id
    where e.environment = p_environment and e.phone = p_subject and o.state = 'active');
end $$;

do $grants$
declare f text;
begin
  foreach f in array array[
    'waldo.imessage_enrollment_read(text,text,text,bigint,text)',
    'waldo.imessage_enrollment_record(text,text,text,text,text,text,bigint,text)',
    'waldo.imessage_enrolled_handle(text,text,text,bigint,text)'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to anon';
  end loop;
end $grants$;
