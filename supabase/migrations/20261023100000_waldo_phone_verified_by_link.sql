-- Phone verification by the link code. The owner texts "waldo CODE" to Waldo from their phone: the code was issued to
-- that signed-in owner, is single-use and lives 10 minutes, and the message arrived from the handle the channel reports.
-- When that handle is the number the owner has on file, the redemption proves the number as well as linking it, in the
-- same transaction. WhatsApp subjects are the number's digits; an iMessage handle is either the number itself or an
-- Apple ID email, which proves no number. A number another active owner has already verified is not verified again.
--
-- The verification is written before the presence, so a WhatsApp "waldo CODE" from the owner's own number now links:
-- the presence rule that wants a verified number (presences_whatsapp_verified_phone) is satisfied by the same act.
create or replace function waldo.redeem_link_code(p_code_hash text, p_provider text, p_subject text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_number text;
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
  v_number := case p_provider when 'whatsapp' then '+' || p_subject when 'imessage' then p_subject end;
  if v_number ~ '^\+[1-9][0-9]{6,14}$' then
    update waldo.owners set phone_verified_at = now()
      where id = v_owner and state = 'active' and phone = v_number and phone_verified_at is null
        and not exists (select 1 from waldo.owners other
          where other.id <> v_owner and other.state = 'active' and other.phone = v_number and other.phone_verified_at is not null);
  end if;
  insert into waldo.presences (owner_id, provider, subject) values (v_owner, p_provider, p_subject);
  return v_owner;
end $$;

-- A verification proves one number: when the number on file changes, it starts unverified again.
create function waldo.owners_phone_change_unverifies() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.phone is distinct from old.phone then new.phone_verified_at := null; end if;
  return new;
end $$;
create trigger owners_phone_change_unverifies before update of phone on waldo.owners
  for each row execute function waldo.owners_phone_change_unverifies();
