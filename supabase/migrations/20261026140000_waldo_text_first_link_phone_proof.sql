-- The text-first WhatsApp confirm proves the number through the one shared rule, waldo.verify_owner_phone, instead of
-- writing phone_verified_at itself. A number another active owner holds, by proving it or by a WhatsApp or iMessage link
-- from it, is answered claimed: the confirm neither verifies it nor links WhatsApp from it, even for an owner whose
-- earlier proof of it predates that rule. The number's lock comes first, before the owner row, in the same order as
-- owner_phone_set and verify_owner_phone, so a change of number and this confirm take turns.
--
-- The same-provider check stays ahead of it: the live-subject index is unique whatever the owner's state, so a suspended
-- owner's live WhatsApp presence on the number still answers claimed rather than failing the insert.
create or replace function waldo.consume_presence_link_request(p_do_name text, p_token_hash text, p_subject text, p_at bigint, p_sig text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_request waldo.presence_link_requests; v_owner uuid;
begin
  if not waldo.router_signed('linkreq.consume.' || p_do_name || '.' || p_token_hash || '.' || p_subject, p_at, p_sig) then
    raise exception 'unsigned router call' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('waldophone.+' || p_subject, 0));
  select id into v_owner from waldo.owners where do_name = p_do_name and state = 'active' for update;
  if v_owner is null then return 'rejected'; end if;
  select * into v_request from waldo.presence_link_requests where token_hash = p_token_hash for update;
  if v_request.token_hash is null or v_request.consumed_at is not null or v_request.expires_at <= now()
    or v_request.owner_id <> v_owner or v_request.subject is distinct from p_subject then return 'rejected'; end if;
  update waldo.presence_link_requests set consumed_at = now() where token_hash = p_token_hash;
  if not exists (select 1 from waldo.owners where id = v_owner and phone = '+' || v_request.subject) then return 'rejected'; end if;
  if exists (select 1 from waldo.presences where provider = v_request.provider and subject = v_request.subject and state = 'active' and owner_id <> v_owner)
    or waldo.phone_held_by_other(v_owner, '+' || v_request.subject) then
    return 'claimed';
  end if;
  perform waldo.verify_owner_phone(v_owner, '+' || v_request.subject);
  update waldo.presences set state = 'unlinked', unlinked_at = now() where provider = v_request.provider and owner_id = v_owner and state = 'active';
  insert into waldo.presences (owner_id, provider, subject) values (v_owner, v_request.provider, v_request.subject);
  return 'linked';
end $$;
