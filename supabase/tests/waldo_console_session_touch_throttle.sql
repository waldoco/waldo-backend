begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('touch-router', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'touch-router', 'sha256'), 'hex') $$;
create function pg_temp.open_for(name text, hash text) returns boolean language sql as $$
  select waldo.console_session_open_for(name, hash, 2592000, 604800, pg_temp.at(), pg_temp.sig('consolesess.openfor.' || name || '.' || hash || '.2592000.604800')) $$;
create function pg_temp.open(name text, hash text) returns boolean language sql as $$
  select waldo.console_session_open(name, hash, pg_temp.at(), pg_temp.sig('consolesess.open.' || name || '.' || hash)) $$;
create function pg_temp.touch(name text, hash text) returns boolean language sql as $$
  select waldo.console_session_touch(name, hash, pg_temp.at(), pg_temp.sig('consolesess.touch.' || name || '.' || hash)) $$;
create function pg_temp.row_version(hash text) returns tid language sql as $$ select ctid from waldo.console_sessions where session_hash = hash $$;
create function pg_temp.seen_ago(hash text) returns interval language sql as $$ select now() - last_seen_at from waldo.console_sessions where session_hash = hash $$;
insert into auth.users (id) values ('32000000-0000-0000-0000-000000000001'), ('32000000-0000-0000-0000-000000000002');
insert into waldo.owners (id, do_name, auth_user_id, email) values
  ('12000000-0000-0000-0000-000000000001', 'touch-owner', '32000000-0000-0000-0000-000000000001', 'touch@test.invalid'),
  ('12000000-0000-0000-0000-000000000002', 'touch-other', '32000000-0000-0000-0000-000000000002', 'other@test.invalid');
select is(pg_temp.open_for('touch-owner', repeat('a', 64)), true, 'a console session with a 7-day idle limit');
select is(pg_temp.open('touch-owner', repeat('b', 64)), true, 'an app-rail session with no idle limit');

-- A fresh stamp: the call validates and writes nothing.
update waldo.console_sessions set last_seen_at = now() - interval '1 minute' where session_hash in (repeat('a', 64), repeat('b', 64));
create temp table versions as select session_hash, ctid as version from waldo.console_sessions where session_hash in (repeat('a', 64), repeat('b', 64));
select is(pg_temp.touch('touch-owner', repeat('a', 64)), true, 'a session stamped a minute ago validates');
select is(pg_temp.touch('touch-owner', repeat('b', 64)), true, 'so does an app-rail session');
select is(pg_temp.row_version(repeat('a', 64)), (select version from versions where session_hash = repeat('a', 64)), 'and its row is not rewritten');
select is(pg_temp.row_version(repeat('b', 64)), (select version from versions where session_hash = repeat('b', 64)), 'nor the app-rail row');
select is(pg_temp.seen_ago(repeat('a', 64)), interval '1 minute', 'its stamp stays where it was');

-- A stamp older than five minutes is moved to now.
update waldo.console_sessions set last_seen_at = now() - interval '5 minutes 1 second' where session_hash = repeat('a', 64);
select is(pg_temp.touch('touch-owner', repeat('a', 64)), true, 'a session stamped over five minutes ago validates');
select is(pg_temp.seen_ago(repeat('a', 64)), interval '0', 'and its stamp moves to now');
update waldo.console_sessions set last_seen_at = now() - interval '6 days 23 hours' where session_hash = repeat('a', 64);
select is(pg_temp.touch('touch-owner', repeat('a', 64)), true, 'a use inside the idle limit validates');
select is(pg_temp.seen_ago(repeat('a', 64)), interval '0', 'and restarts the idle clock');

-- Every refusal still holds while the stamp is fresh enough to skip the write.
select is(pg_temp.touch('touch-other', repeat('a', 64)), false, 'another owner never validates the session');
select throws_ok($$ select waldo.console_session_touch('touch-owner', repeat('a', 64), pg_temp.at(), 'forged') $$, '42501', 'unsigned router call', 'an unsigned touch is rejected');
update waldo.console_sessions set created_at = now() - interval '30 days 1 second', last_seen_at = now() - interval '1 minute' where session_hash = repeat('a', 64);
select is(pg_temp.touch('touch-owner', repeat('a', 64)), false, 'a session past its lifetime is refused with a fresh stamp');
update waldo.console_sessions set created_at = now() - interval '13 hours', last_seen_at = now() - interval '1 minute' where session_hash = repeat('b', 64);
select is(pg_temp.touch('touch-owner', repeat('b', 64)), false, 'an app-rail session past its 12 hours is refused with a fresh stamp');
update waldo.console_sessions set created_at = now() - interval '8 days', last_seen_at = now() - interval '7 days 1 second' where session_hash = repeat('a', 64);
select is(pg_temp.touch('touch-owner', repeat('a', 64)), false, 'a session idle past its limit is refused');
select is(pg_temp.seen_ago(repeat('a', 64)), interval '7 days 1 second', 'and the refused touch does not revive it');
select is(pg_temp.touch('touch-owner', repeat('c', 64)), false, 'an unknown session is refused');
select * from finish();
rollback;
