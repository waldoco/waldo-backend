-- Isolated synthetic database only; no external providers and always rollback.
begin;
insert into auth.users(id,email) values
 ('c2000000-0000-0000-0000-000000000001','channel-a@example.invalid'),
 ('d2000000-0000-0000-0000-000000000001','channel-b@example.invalid');
insert into waldo.owners(id,auth_user_id,do_name,email) values
 ('c4000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','channel-owner-a','channel-a@example.invalid'),
 ('d4000000-0000-0000-0000-000000000001','d2000000-0000-0000-0000-000000000001','channel-owner-b','channel-b@example.invalid');
insert into waldo.console_sessions(owner_id,session_hash,created_at,last_seen_at) values
 ('c4000000-0000-0000-0000-000000000001',repeat('c',64),now(),now()),
 ('c4000000-0000-0000-0000-000000000001',repeat('e',64),now()-interval '13 hours',now()),
 ('d4000000-0000-0000-0000-000000000001',repeat('d',64),now(),now());
insert into waldo.presences(owner_id,provider,subject) values
 ('c4000000-0000-0000-0000-000000000001','telegram','synthetic-channel-a'),
 ('d4000000-0000-0000-0000-000000000001','telegram','synthetic-channel-b');
select vault.create_secret('synthetic-channel-secret-only','waldo_router_hmac');
create function pg_temp.channel_sig(message text) returns text language sql as $$
 select encode(extensions.hmac(extract(epoch from now())::bigint::text||'.'||message,'synthetic-channel-secret-only','sha256'),'hex');
$$;
create function pg_temp.channel_inventory(owner_name text,session_hash text,revision text) returns jsonb language sql as $$
 select waldo.owner_channel_inventory(owner_name,session_hash,revision,extract(epoch from now())::bigint,
   pg_temp.channel_sig('app.channels.inventory.'||owner_name||'.'||session_hash||'.'||revision));
$$;
create function pg_temp.channel_unlink(owner_name text,session_hash text,revision text,provider text) returns jsonb language sql as $$
 select waldo.unlink_presence(owner_name,session_hash,revision,provider,extract(epoch from now())::bigint,
   pg_temp.channel_sig('app.channels.unlink.'||owner_name||'.'||session_hash||'.'||revision||'.'||provider));
$$;
do $$
declare revision text; updated text; other_revision text; row jsonb; checks integer:=0; owner_state bigint; at_time bigint:=extract(epoch from now())::bigint; h text:=repeat('f',64);
begin
 select state_version::text||':'||admission_revision::text,state_version into revision,owner_state from waldo.owners where do_name='channel-owner-a';
 select state_version::text||':'||admission_revision::text into other_revision from waldo.owners where do_name='channel-owner-b';
 row:=pg_temp.channel_inventory('channel-owner-a',repeat('c',64),revision);
 assert row->'linked'='["telegram"]'::jsonb,'inventory has only actual active owner channels'; checks:=checks+1;
 assert pg_temp.channel_inventory('channel-owner-a',repeat('d',64),revision) is null,'cross-owner session cannot read inventory'; checks:=checks+1;
 assert pg_temp.channel_inventory('channel-owner-a',repeat('e',64),revision) is null,'expired session cannot read inventory'; checks:=checks+1;
 assert pg_temp.channel_inventory('channel-owner-a',repeat('c',64),'0:999') is null,'stale revision cannot read inventory'; checks:=checks+1;
 assert pg_temp.channel_unlink('channel-owner-a',repeat('d',64),revision,'telegram') is null,'cross-owner session cannot unlink'; checks:=checks+1;
 assert pg_temp.channel_unlink('channel-owner-a',repeat('c',64),'0:999','telegram') is null,'stale revision cannot unlink'; checks:=checks+1;
 row:=waldo.issue_link_code('channel-owner-a',repeat('c',64),revision,'whatsapp',h,at_time,
   pg_temp.channel_sig('app.channels.link.channel-owner-a.'||repeat('c',64)||'.'||revision||'.whatsapp.'||h));
 assert row->>'revision'=revision and (row->>'expires_at')::bigint>extract(epoch from now())*1000,'WhatsApp code issuance returns an expiring handoff'; checks:=checks+1;
 assert exists(select 1 from waldo.link_codes where code_hash=h and owner_id='c4000000-0000-0000-0000-000000000001' and provider='whatsapp'),'code uses canonical owner and existing provider redeem tables'; checks:=checks+1;
 assert not exists(select 1 from waldo.presences where owner_id='c4000000-0000-0000-0000-000000000001' and provider='whatsapp'),'issuing code does not invent a linked channel'; checks:=checks+1;
 row:=pg_temp.channel_unlink('channel-owner-a',repeat('c',64),revision,'telegram'); updated:=row->>'revision';
 assert updated<>revision,'unlink advances channel admission epoch'; checks:=checks+1;
 assert pg_temp.channel_inventory('channel-owner-a',repeat('c',64),updated)->'linked'='[]'::jsonb,'unlink readback removes only active channel'; checks:=checks+1;
 assert exists(select 1 from waldo.owners where id='c4000000-0000-0000-0000-000000000001' and auth_user_id='c2000000-0000-0000-0000-000000000001' and state='active' and state_version=owner_state),'canonical owner/auth/lifecycle preserved'; checks:=checks+1;
 assert exists(select 1 from waldo.console_sessions where session_hash=repeat('c',64)),'app session preserved after unlink'; checks:=checks+1;
 assert pg_temp.channel_inventory('channel-owner-b',repeat('d',64),other_revision)->'linked'='["telegram"]'::jsonb,'second owner remains linked at same revision'; checks:=checks+1;
 assert pg_temp.channel_unlink('channel-owner-a',repeat('c',64),revision,'telegram') is null,'old revision cannot revoke a newer binding'; checks:=checks+1;
 perform pg_temp.channel_unlink('channel-owner-a',repeat('c',64),updated,'whatsapp');
 assert not exists(select 1 from waldo.link_codes where code_hash=h),'unlink removes unused provider link code'; checks:=checks+1;
 delete from waldo.console_sessions where session_hash=repeat('c',64);
 assert pg_temp.channel_inventory('channel-owner-a',repeat('c',64),updated) is null,'revoked session rejected'; checks:=checks+1;
 begin perform waldo.owner_channel_inventory('channel-owner-b',repeat('d',64),other_revision,at_time,'unsigned'); raise exception 'unsigned accepted'; exception when insufficient_privilege then checks:=checks+1; end;
 begin perform pg_temp.channel_unlink('channel-owner-b',repeat('d',64),other_revision,'imessage'); raise exception 'unsupported provider accepted'; exception when insufficient_privilege then checks:=checks+1; end;
 assert not has_function_privilege('anon','waldo.app_channel_owner(text,text,text)','execute'),'private helper cannot be remotely invoked'; checks:=checks+1;
 assert not has_function_privilege('authenticated','waldo.owner_channel_inventory(text,text,text,bigint,text)','execute'),'no authenticated role grant expansion'; checks:=checks+1;
 raise notice 'app channels: % synthetic SQL assertions PASS',checks;
end $$;
rollback;
