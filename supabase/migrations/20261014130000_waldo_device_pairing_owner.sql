-- Seamless Mac pairing: the console shows one copyable code that also names the owner, so a
-- fresh Kennel install can bind to its owner without any boot-time configuration. Same rules
-- as issue_device_pairing_code (signed router call, active owner, 5 outstanding codes, 600s),
-- but returns the owner's UUID instead of a boolean. The UUID is the value redeem already
-- returns as owner_id; it is an identifier, not a credential.
create function waldo.issue_device_pairing_code_owned(p_do_name text,p_code_hash text,p_at bigint,p_sig text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_now timestamptz;
begin
  if waldo.router_signed('devpairowner.'||p_do_name||'.'||p_code_hash,p_at,p_sig) is not true then raise exception 'unsigned router call' using errcode='42501'; end if;
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then return null; end if;
  -- Serialize all issuers for this owner before checking the outstanding-code cap.
  select id into v_owner from waldo.owners where do_name=p_do_name and state='active' for update;
  if v_owner is null then return null; end if;
  v_now := clock_timestamp();
  if (select count(*) from waldo.device_pairing_codes where owner_id=v_owner and used_at is null and expires_at>v_now)>=5 then return null; end if;
  insert into waldo.device_pairing_codes(code_hash,owner_id,created_at,expires_at) values(p_code_hash,v_owner,v_now,v_now+interval '600 seconds');
  return v_owner;
exception when unique_violation then return null;
end $$;
revoke all on function waldo.issue_device_pairing_code_owned(text,text,bigint,text) from public,anon,authenticated;
grant execute on function waldo.issue_device_pairing_code_owned(text,text,bigint,text) to anon;
