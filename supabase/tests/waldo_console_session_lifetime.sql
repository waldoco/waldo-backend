begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('lifetime-router', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'lifetime-router', 'sha256'), 'hex') $$;
create function pg_temp.open_for(name text, hash text, lifetime integer, idle integer) returns boolean language sql as $$
  select waldo.console_session_open_for(name, hash, lifetime, idle, pg_temp.at(), pg_temp.sig('consolesess.openfor.' || name || '.' || hash || '.' || lifetime || '.' || idle)) $$;
create function pg_temp.touch(name text, hash text) returns boolean language sql as $$
  select waldo.console_session_touch(name, hash, pg_temp.at(), pg_temp.sig('consolesess.touch.' || name || '.' || hash)) $$;
create function pg_temp.list(name text) returns jsonb language sql as $$
  select waldo.console_session_list(name, pg_temp.at(), pg_temp.sig('consolesess.list.' || name)) $$;
create function pg_temp.authority(name text, hash text) returns jsonb language sql as $$
  select waldo.app_session_authority(name, hash, pg_temp.at(), pg_temp.sig('app.session.' || name || '.' || hash)) $$;
insert into auth.users (id) values ('31000000-0000-0000-0000-000000000001');
insert into waldo.owners (id, do_name, auth_user_id, email) values
  ('11000000-0000-0000-0000-000000000001', 'life-owner', '31000000-0000-0000-0000-000000000001', 'life@test.invalid');

-- Who may call it.
select is(has_function_privilege('anon', 'waldo.console_session_open_for(text, text, integer, integer, bigint, text)', 'execute'), true, 'the runtime key can open a console session (signature still required)');
select is(has_function_privilege('service_role', 'waldo.console_session_open_for(text, text, integer, integer, bigint, text)', 'execute'), false, 'service role is not granted the console open');
select is(has_function_privilege('authenticated', 'waldo.console_session_open_for(text, text, integer, integer, bigint, text)', 'execute'), false, 'a signed-in Supabase user is not granted the console open');

-- The signature covers the lifetimes, so a caller cannot stretch a session it was not signed for.
select throws_ok($$ select waldo.console_session_open_for('life-owner', repeat('a', 64), 2592000, 604800, pg_temp.at(), 'forged') $$, '42501', 'unsigned router call', 'an unsigned open is rejected');
select throws_ok($$ select waldo.console_session_open_for('life-owner', repeat('a', 64), 2592000, 604800, pg_temp.at(), pg_temp.sig('consolesess.openfor.life-owner.' || repeat('a', 64) || '.43200.604800')) $$, '42501', 'unsigned router call', 'a signature for a shorter lifetime does not open a longer one');

-- The database holds the ceiling: 30 days absolute, and the idle limit inside it.
select throws_ok($$ select pg_temp.open_for('life-owner', repeat('a', 64), 2592001, 604800) $$, '22023', 'console session lifetime out of range', 'more than 30 days is refused');
select throws_ok($$ select pg_temp.open_for('life-owner', repeat('a', 64), 0, 0) $$, '22023', 'console session lifetime out of range', 'a zero lifetime is refused');
select throws_ok($$ select pg_temp.open_for('life-owner', repeat('a', 64), 86400, 86401) $$, '22023', 'console session lifetime out of range', 'an idle limit longer than the lifetime is refused');
select throws_ok($$ select pg_temp.open_for('life-owner', repeat('a', 64), 86400, 0) $$, '22023', 'console session lifetime out of range', 'a zero idle limit is refused');
select is(pg_temp.open_for('nobody', repeat('a', 64), 2592000, 604800), false, 'an unknown owner gets no session');
select is(pg_temp.open_for('life-owner', repeat('z', 64), 2592000, 604800), false, 'a session hash that is not 64 lowercase hex characters is refused');
select is(pg_temp.open_for('life-owner', upper(repeat('a', 64)), 2592000, 604800), false, 'an uppercase hash is refused');
select is(pg_temp.open_for('life-owner', repeat('a', 63), 2592000, 604800), false, 'a short hash is refused');
select is(pg_temp.open_for('life-owner', '', 2592000, 604800), false, 'an empty hash is refused');
select is((select count(*)::int from waldo.console_sessions where session_hash !~ '^[a-f0-9]{64}$'), 0, 'no refused hash was stored');

select is(pg_temp.open_for('life-owner', repeat('a', 64), 2592000, 604800), true, 'a signed open stores a console session');
select is((select lifetime = interval '30 days' and idle_timeout = interval '7 days' from waldo.console_sessions where session_hash = repeat('a', 64)), true, 'the row carries its own lifetime and idle limit');
select is(pg_temp.open_for('life-owner', repeat('a', 64), 2592000, 604800), true, 'a retried open is harmless');
select is((select count(*)::int from waldo.console_sessions where session_hash = repeat('a', 64)), 1, 'a retried open does not stack rows');

-- Past today's 12 hours the console session still works, for pages and for console chat.
update waldo.console_sessions set created_at = now() - interval '12 hours 1 second', last_seen_at = now() - interval '1 hour' where session_hash = repeat('a', 64);
select is(pg_temp.touch('life-owner', repeat('a', 64)), true, 'a console session outlives 12 hours');
select is(pg_temp.authority('life-owner', repeat('a', 64))->>'session_hash', repeat('a', 64), 'console chat keeps its session past 12 hours');
select is(jsonb_array_length(pg_temp.list('life-owner')), 1, 'the session list still shows it');
select is((select array_agg(k order by k) from jsonb_object_keys(pg_temp.list('life-owner')->0) k), array['created_at', 'last_seen_at', 'session'], 'the list keeps exactly its three keys, so the current Worker still reads it');

-- Use slides the idle limit.
update waldo.console_sessions set last_seen_at = now() - interval '6 days 23 hours' where session_hash = repeat('a', 64);
select is(pg_temp.touch('life-owner', repeat('a', 64)), true, 'a session used within its idle limit validates');
select is((select last_seen_at > now() - interval '1 minute' from waldo.console_sessions where session_hash = repeat('a', 64)), true, 'that use restarts the idle clock');
select is((pg_temp.authority('life-owner', repeat('a', 64))->>'expires_at')::numeric
  = extract(epoch from (select least(created_at + lifetime, last_seen_at + idle_timeout) from waldo.console_sessions where session_hash = repeat('a', 64))) * 1000,
  true, 'console chat sees the earlier of the absolute and idle ends');

-- Idle past the limit: refused everywhere, and a refused touch does not revive it.
update waldo.console_sessions set last_seen_at = now() - interval '7 days 1 second' where session_hash = repeat('a', 64);
select is(pg_temp.touch('life-owner', repeat('a', 64)), false, 'a session idle past its limit rejects a correctly signed cookie');
select is((select last_seen_at < now() - interval '7 days' from waldo.console_sessions where session_hash = repeat('a', 64)), true, 'the refused touch leaves the idle session dead');
select is(pg_temp.authority('life-owner', repeat('a', 64)), null, 'an idle session no longer admits console chat');
select is(jsonb_array_length(pg_temp.list('life-owner')), 0, 'an idle session is absent from the active list');

-- Used constantly, it still ends 30 days after sign-in.
update waldo.console_sessions set created_at = now() - interval '30 days 1 second', last_seen_at = now() where session_hash = repeat('a', 64);
select is(pg_temp.touch('life-owner', repeat('a', 64)), false, 'a session past its absolute lifetime rejects a correctly signed cookie');
select is(pg_temp.authority('life-owner', repeat('a', 64)), null, 'a session past its absolute lifetime no longer admits console chat');
select is(jsonb_array_length(pg_temp.list('life-owner')), 0, 'a session past its absolute lifetime is absent from the active list');

-- A session opened through the existing rail keeps today's 12 hours and no idle limit: the app is unchanged.
select is(waldo.console_session_open('life-owner', repeat('b', 64), pg_temp.at(), pg_temp.sig('consolesess.open.life-owner.' || repeat('b', 64))), true, 'the existing open still works');
select is((select lifetime = interval '12 hours' and idle_timeout is null from waldo.console_sessions where session_hash = repeat('b', 64)), true, 'the existing open keeps 12 hours with no idle limit');
update waldo.console_sessions set last_seen_at = now() - interval '8 days' where session_hash = repeat('b', 64);
select is(pg_temp.touch('life-owner', repeat('b', 64)), true, 'no idle limit applies to a session opened through the existing rail');
update waldo.console_sessions set created_at = now() - interval '12 hours 1 second' where session_hash = repeat('b', 64);
select is(pg_temp.touch('life-owner', repeat('b', 64)), false, 'the existing rail still ends at 12 hours');
select is(pg_temp.authority('life-owner', repeat('b', 64)), null, 'and the app authority still refuses it after 12 hours');

-- Revocation and sign-out everywhere cover long sessions.
select is(pg_temp.open_for('life-owner', repeat('c', 64), 2592000, 604800), true, 'a second console session opens');
select is(pg_temp.open_for('life-owner', repeat('d', 64), 2592000, 604800), true, 'a third console session opens');
select is(waldo.console_session_revoke('life-owner', repeat('c', 64), pg_temp.at(), pg_temp.sig('consolesess.revoke.life-owner.' || repeat('c', 64))), true, 'one long session can be revoked');
select is(pg_temp.touch('life-owner', repeat('c', 64)), false, 'a revoked long session no longer validates');
select is(pg_temp.touch('life-owner', repeat('d', 64)), true, 'revoking one leaves the other');
select is(waldo.console_signout_all('life-owner', pg_temp.at(), pg_temp.sig('consolesess.signout.life-owner')) >= 1, true, 'sign-out everywhere drops the long sessions');
select is(pg_temp.touch('life-owner', repeat('d', 64)), false, 'a long session signed out everywhere no longer validates');
select is(pg_temp.authority('life-owner', repeat('d', 64)), null, 'nor admits console chat');
select * from finish();
rollback;
