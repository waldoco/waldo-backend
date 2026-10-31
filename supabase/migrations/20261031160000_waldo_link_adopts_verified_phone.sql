-- A link from a phone number proves that number, so an owner with no proven number takes it as theirs. Sending a link
-- code from WhatsApp or from an iMessage number is the same possession proof as a texted code: the code was issued to
-- the signed-in owner, works once for 10 minutes, and arrived from the handle the channel reports. Until now that send
-- proved only a number already on file, and most owners have none on file, so their WhatsApp link was refused.
--
-- adopt_owner_phone: when the owner has no proven number, the sending number replaces whatever unproven number is on
-- file and is proven, unless another active owner holds it (proved it, or links from it). An owner who has proven a
-- number keeps it; linking from another number still links, as before, and proves nothing.
create function waldo.adopt_owner_phone(p_owner uuid, p_number text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_owner is null or p_number is null or p_number !~ '^\+[1-9][0-9]{6,14}$' then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('waldophone.' || p_number, 0));
  if waldo.phone_held_by_other(p_owner, p_number) then return false; end if;
  -- owners_phone_change_unverifies leaves a changed number unproven; verify_owner_phone proves it below.
  update waldo.owners set phone = p_number
    where id = p_owner and state = 'active' and phone_verified_at is null and phone is distinct from p_number;
  return waldo.verify_owner_phone(p_owner, p_number);
end $$;
revoke all on function waldo.adopt_owner_phone(uuid, text) from public, anon, authenticated;

-- A WhatsApp link needs a proven number on the account (presences_whatsapp_verified_phone). When the sending number is
-- held by another owner and this owner has proven none, the refusal says so in its own words, so the sender is told
-- why instead of hearing that the code failed; the transaction rolls back and the code is not spent. Any other reason
-- the number stayed unproven (a subject that is not a number) is left to the presence rule's own refusal.
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
  perform waldo.adopt_owner_phone(v_owner, case p_provider when 'whatsapp' then '+' || p_subject when 'imessage' then p_subject end);
  if p_provider = 'whatsapp' and (select phone_verified_at from waldo.owners where id = v_owner) is null
      and waldo.phone_held_by_other(v_owner, '+' || p_subject) then
    raise exception 'phone number held by another owner' using errcode = '23505';
  end if;
  insert into waldo.presences (owner_id, provider, subject) values (v_owner, p_provider, p_subject);
  return v_owner;
end $$;

-- Owners who linked iMessage from a number before this took no number from it. Their link proved that number, so it
-- becomes their proven number now, under the same rule.
do $$
declare r record;
begin
  for r in select p.owner_id, p.subject from waldo.presences p join waldo.owners o on o.id = p.owner_id
      where p.provider = 'imessage' and p.state = 'active' and o.state = 'active' and o.phone_verified_at is null
        and p.subject ~ '^\+[1-9][0-9]{6,14}$'
      order by p.created_at
  loop
    perform waldo.adopt_owner_phone(r.owner_id, r.subject);
  end loop;
end $$;

comment on column waldo.owners.phone_verified_at is 'When the number on file was proven: a link code sent to Waldo from it on WhatsApp or iMessage (which, for an owner with no proven number, also makes it the number on file), or a code Twilio Verify texted to it at the owner''s request (waldo.verify_owner_phone, waldo.adopt_owner_phone). NULL = unverified; a change of number clears it, and no whatsapp presence may link while NULL.';
