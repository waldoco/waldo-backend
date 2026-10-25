-- iMessage through Photon (Spectrum cloud, shared-pool plan). Before someone can text Waldo, their iPhone number has
-- to be a user of Waldo's Photon project, and Photon assigns them the pool number they text. The Worker enrolls an
-- owner with Photon from the console and records the outcome here, so the console can show "your Waldo number".
--
-- Enrollment proves nothing about the phone and links no one. Possession decides: a number reaches an owner's Waldo
-- only after "waldo CODE" arrives from it (the code issued to that signed-in owner). So several owners may hold an
-- enrollment for one number; only a number already linked to another owner is refused.

create table waldo.imessage_photon_enrollments (
  owner_id uuid not null references waldo.owners (id) on delete cascade,
  environment text not null check (environment ~ '^[a-z][a-z0-9_-]{0,31}$'),
  phone text not null check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  photon_user_id text not null check (length(photon_user_id) between 1 and 128),
  assigned_number text not null check (assigned_number ~ '^\+[1-9][0-9]{6,14}$'),
  -- true only when Waldo created this Photon user; a user Waldo found already in the project is never removed by Waldo.
  photon_created boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, environment)
);
create index imessage_photon_enrollments_phone on waldo.imessage_photon_enrollments (environment, phone);
create index imessage_photon_enrollments_user on waldo.imessage_photon_enrollments (photon_user_id);
alter table waldo.imessage_photon_enrollments enable row level security;
alter table waldo.imessage_photon_enrollments force row level security;
revoke all on waldo.imessage_photon_enrollments from public, anon, authenticated;

-- What the console needs to enroll an active owner: their sign-in email (Photon requires one per user), their phone
-- on file (to prefill the form) and their current enrollment in this environment, if any.
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

-- Records (or replaces) the owner's enrollment after Photon accepted it. result 'phone_taken': the number is linked to
-- another owner, nothing changed. release: the owner's previous Photon user, when Waldo created it, no enrollment
-- references it any more, and it is not the owner's linked number; the Worker removes it from Photon.
create function waldo.imessage_enrollment_record(p_do_name text, p_environment text, p_phone text, p_photon_user_id text, p_assigned_number text,
  p_photon_created boolean, p_locator text, p_at bigint, p_sig text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_prev waldo.imessage_photon_enrollments; v_release text;
begin
  perform waldo.imessage_signed('enroll_record', p_locator,
    jsonb_build_array(p_do_name, p_environment, p_phone, p_photon_user_id, p_assigned_number, p_photon_created), p_at, p_sig);
  if p_phone is null or p_phone !~ '^\+[1-9][0-9]{6,14}$' or p_assigned_number is null or p_assigned_number !~ '^\+[1-9][0-9]{6,14}$'
    or p_photon_user_id is null or length(p_photon_user_id) not between 1 and 128 or p_photon_created is null then
    return jsonb_build_object('result', 'rejected');
  end if;
  select id into v_owner from waldo.owners where do_name = p_do_name and state = 'active' for update;
  if v_owner is null then return jsonb_build_object('result', 'rejected'); end if;
  if exists (select 1 from waldo.presences where provider = 'imessage' and subject = p_phone and state = 'active' and owner_id <> v_owner) then
    return jsonb_build_object('result', 'phone_taken');
  end if;
  select * into v_prev from waldo.imessage_photon_enrollments where owner_id = v_owner and environment = p_environment;
  insert into waldo.imessage_photon_enrollments (owner_id, environment, phone, photon_user_id, assigned_number, photon_created)
    values (v_owner, p_environment, p_phone, p_photon_user_id, p_assigned_number, p_photon_created)
    on conflict (owner_id, environment) do update set phone = excluded.phone, photon_user_id = excluded.photon_user_id,
      assigned_number = excluded.assigned_number, updated_at = now(),
      photon_created = case when waldo.imessage_photon_enrollments.photon_user_id = excluded.photon_user_id
        then waldo.imessage_photon_enrollments.photon_created or excluded.photon_created else excluded.photon_created end;
  if v_prev.owner_id is not null and v_prev.photon_user_id <> p_photon_user_id and v_prev.photon_created
    and not exists (select 1 from waldo.imessage_photon_enrollments where photon_user_id = v_prev.photon_user_id)
    and not exists (select 1 from waldo.presences where provider = 'imessage' and subject = v_prev.phone and state = 'active' and owner_id = v_owner) then
    v_release := v_prev.photon_user_id;
  end if;
  return jsonb_build_object('result', 'recorded', 'release', v_release);
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
    'waldo.imessage_enrollment_record(text,text,text,text,text,boolean,text,bigint,text)',
    'waldo.imessage_enrolled_handle(text,text,text,bigint,text)'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to anon';
  end loop;
end $grants$;
