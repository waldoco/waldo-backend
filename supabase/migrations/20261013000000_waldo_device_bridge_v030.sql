-- v0.2.3 rows retain their historical contract; active transport requires re-pair.
create function waldo.device_capabilities_v030(p_caps text[]) returns boolean
language sql immutable strict set search_path='' as $$
 select cardinality(p_caps) between 1 and 5
 and p_caps <@ array['machine_state_query','notify_local','shell_exec','session_query','session_control']::text[]
 and cardinality(array(select distinct c from unnest(p_caps) c))=cardinality(p_caps)
 and p_caps=(select array_agg(c order by array_position(array['machine_state_query','notify_local','shell_exec','session_query','session_control']::text[],c)) from unnest(p_caps)c)
$$;
revoke all on function waldo.device_capabilities_v030(text[]) from public,anon,authenticated;
alter table waldo.devices add column session_consent boolean not null default false;
alter table waldo.devices drop constraint devices_capabilities_check;
alter table waldo.devices drop constraint devices_contract_version_check;
alter table waldo.devices add constraint devices_contract_version_check check(contract_version in ('0.2.3','0.3.0'));
alter table waldo.devices add constraint devices_capabilities_check check(
 contract_version='0.2.3' and capabilities in (array['machine_state_query'],array['notify_local'],array['machine_state_query','notify_local'])
 or contract_version='0.3.0' and waldo.device_capabilities_v030(capabilities)
 and (not capabilities && array['session_query','session_control']::text[] or session_consent)
);
create function waldo.device_pairing_immutable() returns trigger language plpgsql set search_path='' as $$
begin
 if (new.device_id,new.owner_id,new.pubkey,new.capabilities,new.contract_version,new.session_consent) is distinct from (old.device_id,old.owner_id,old.pubkey,old.capabilities,old.contract_version,old.session_consent) then
  raise exception 'device re-pair required' using errcode='23514';
 end if;
 return new;
end $$;
revoke all on function waldo.device_pairing_immutable() from public,anon,authenticated;
create trigger device_pairing_immutable before update on waldo.devices for each row execute function waldo.device_pairing_immutable();

create function waldo.redeem_device_pairing_v030(p_code_hash text,p_pubkey text,p_label text,p_capabilities text,p_session_consent boolean,p_at bigint,p_sig text) returns table(device_id text,owner_id text)
language plpgsql security definer set search_path='' as $$
declare v_owner uuid;v_device text;v_now timestamptz;v_caps text[];
begin
 if waldo.router_signed('devredeem030.'||p_code_hash||'.'||p_pubkey||'.'||encode(convert_to(p_label,'UTF8'),'hex')||'.'||p_capabilities||'.'||p_session_consent::text,p_at,p_sig) is not true then raise exception 'unsigned router call' using errcode='42501';end if;
 v_caps:=string_to_array(p_capabilities,',');
 if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' or p_pubkey is null or p_pubkey !~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$' or p_label is null or octet_length(p_label) not between 1 and 120 or p_session_consent is null or waldo.device_capabilities_v030(v_caps) is not true or (v_caps && array['session_query','session_control']::text[] and not p_session_consent) then return;end if;
 select c.owner_id into v_owner from waldo.device_pairing_codes c where c.code_hash=p_code_hash and c.used_at is null for update;
 if v_owner is null then return;end if;
 perform 1 from waldo.owners where id=v_owner and state='active' for update;
 if not found then return;end if;
 v_now:=clock_timestamp();
 update waldo.device_pairing_codes c set used_at=v_now where c.code_hash=p_code_hash and c.used_at is null and c.expires_at>v_now;
 if not found then return;end if;
 v_device:=gen_random_uuid()::text;
 insert into waldo.devices(device_id,owner_id,pubkey,capabilities,label,contract_version,session_consent,created_at) values(v_device,v_owner,p_pubkey,v_caps,p_label,'0.3.0',p_session_consent,v_now);
 return query select v_device,v_owner::text;
exception when unique_violation then return;
end $$;
create function waldo.device_for_auth_v030(p_device_id text,p_at bigint,p_sig text) returns table(owner_id text,pubkey text,capabilities text,contract_version text,do_name text)
language plpgsql security definer set search_path='' as $$
begin
 if waldo.router_signed('devauth030.'||p_device_id,p_at,p_sig) is not true then raise exception 'unsigned router call' using errcode='42501';end if;
 return query select d.owner_id::text,d.pubkey,array_to_string(d.capabilities,','),d.contract_version,o.do_name from waldo.devices d join waldo.owners o on o.id=d.owner_id where d.device_id=p_device_id and d.contract_version='0.3.0' and o.state='active';
end $$;
revoke all on function waldo.redeem_device_pairing_v030(text,text,text,text,boolean,bigint,text),waldo.device_for_auth_v030(text,bigint,text) from public,anon,authenticated;
grant execute on function waldo.redeem_device_pairing_v030(text,text,text,text,boolean,bigint,text),waldo.device_for_auth_v030(text,bigint,text) to anon;
