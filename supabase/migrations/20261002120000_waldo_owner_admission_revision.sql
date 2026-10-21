-- Host-managed custody epoch. Global allocation prevents UUID deletion/reuse ABA.
create sequence waldo.owner_admission_revision_seq as bigint no cycle;
alter table waldo.owners add column admission_revision bigint not null default 0;
update waldo.owners set admission_revision = nextval('waldo.owner_admission_revision_seq'::regclass);
alter table waldo.owners add constraint owners_admission_revision_positive check (admission_revision > 0);

-- Invoker identity must remain visible here. Depth alone is not authorization.
create function waldo.guard_owner_admission_revision() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (tg_op = 'INSERT' and new.admission_revision is distinct from 0)
     or (tg_op = 'UPDATE' and new.admission_revision is distinct from old.admission_revision) then
    if tg_op <> 'UPDATE' or pg_trigger_depth() <> 2
       or current_user <> pg_get_userbyid((select proowner from pg_proc
         where oid = 'waldo.bump_presence_admission_revision()'::regprocedure)) then
      raise exception 'owner admission revision is host managed' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create function waldo.allocate_owner_admission_revision() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.admission_revision := nextval('waldo.owner_admission_revision_seq'::regclass);
  elsif row(new.id, new.state, new.do_name, new.auth_user_id)
        is distinct from row(old.id, old.state, old.do_name, old.auth_user_id) then
    new.admission_revision := nextval('waldo.owner_admission_revision_seq'::regclass);
  end if;
  return new;
end $$;

create function waldo.bump_presence_admission_revision() returns trigger
language plpgsql security definer set search_path = '' as $$
declare affected uuid[]; owner_uuid uuid;
begin
  if tg_op = 'UPDATE' then
    if row(new.id, new.owner_id, new.provider, new.subject, new.state)
       is not distinct from row(old.id, old.owner_id, old.provider, old.subject, old.state) then
      return null;
    end if;
    affected := array[old.owner_id, new.owner_id];
  elsif tg_op = 'INSERT' then affected := array[new.owner_id];
  else affected := array[old.owner_id];
  end if;
  -- UUID order serializes transfers; NO KEY UPDATE remains compatible with the
  -- destination FK KEY SHARE already held by the presence write.
  for owner_uuid in select id from waldo.owners where id = any(affected) order by id for no key update loop
    update waldo.owners set admission_revision = nextval('waldo.owner_admission_revision_seq'::regclass)
      where id = owner_uuid;
  end loop;
  return null;
end $$;

revoke all on function waldo.guard_owner_admission_revision() from public, anon, authenticated, service_role;
revoke all on function waldo.allocate_owner_admission_revision() from public, anon, authenticated, service_role;
revoke all on function waldo.bump_presence_admission_revision() from public, anon, authenticated, service_role;
-- Alphabetical BEFORE-trigger order keeps the invoker guard before allocation.
create trigger a_owner_admission_revision_guard before insert or update on waldo.owners
  for each row execute function waldo.guard_owner_admission_revision();
create trigger z_owner_admission_revision_allocate before insert or update on waldo.owners
  for each row execute function waldo.allocate_owner_admission_revision();
create trigger presence_admission_revision after insert or update or delete on waldo.presences
  for each row execute function waldo.bump_presence_admission_revision();
