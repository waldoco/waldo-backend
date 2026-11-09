begin;
create extension if not exists pgtap with schema extensions;
select plan(25);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
-- A signed call at an explicit instant; router_signed accepts up to 300 s either side of now().
create function pg_temp.throttle_at(k text, lim integer, win integer, at bigint) returns boolean language sql as $$
  select waldo.console_auth_throttle(k, lim, win, at, encode(extensions.hmac(at::text || '.throttle.' || k || '.' || lim || '.' || win, 'test-router-secret', 'sha256'), 'hex')) $$;
create function pg_temp.throttle(k text, lim integer, win integer) returns boolean language sql as $$ select pg_temp.throttle_at(k, lim, win, pg_temp.at()) $$;

-- One window: attempts up to the limit pass, the next is refused, and each key counts alone.
select is(pg_temp.throttle('send:a@test.invalid', 2, 900), true, 'the first attempt is allowed');
select is(pg_temp.throttle('send:a@test.invalid', 2, 900), true, 'attempts up to the limit are allowed');
select is(pg_temp.throttle('send:a@test.invalid', 2, 900), false, 'the attempt over the limit is refused');
select is(pg_temp.throttle('send:b@test.invalid', 2, 900), true, 'another key keeps its own count');

-- Two windows: a sign-in attempt on 900 s must not reset an hourly key's count, nor the reverse.
select is(pg_temp.throttle('walink.' || repeat('7', 64), 1, 3600), true, 'the first hourly attempt is allowed');
select is(pg_temp.throttle('walink.' || repeat('7', 64), 1, 3600), false, 'the hourly key is at its limit');
select is(pg_temp.throttle('send:c@test.invalid', 5, 900), true, 'a sign-in attempt for another key on the 900 s window');
select is(pg_temp.throttle('walink.' || repeat('7', 64), 1, 3600), false, 'the hourly key stays refused after it');
select is(pg_temp.throttle('send:a@test.invalid', 2, 900), false, 'the 900 s key stays refused after hourly calls');

-- The signed call shape, the argument checks and the function's privileges are unchanged.
select throws_ok($$ select waldo.console_auth_throttle('send:d@test.invalid', 5, 900, pg_temp.at(), 'forged') $$, '42501', 'unsigned router call', 'an unsigned call is refused');
select throws_ok($$ select pg_temp.throttle('send:d@test.invalid', 0, 900) $$, '22023', 'throttle requires a positive limit and window', 'a zero limit is refused');
select throws_ok($$ select pg_temp.throttle('send:d@test.invalid', 5, 0) $$, '22023', 'throttle requires a positive limit and window', 'a zero window is refused');
select is((select prosecdef from pg_proc where oid = 'waldo.console_auth_throttle(text,integer,integer,bigint,text)'::regprocedure), true, 'the throttle runs as security definer');
select is((select proconfig from pg_proc where oid = 'waldo.console_auth_throttle(text,integer,integer,bigint,text)'::regprocedure), array['search_path=""']::text[], 'with an empty search_path');
select is(has_function_privilege('anon', 'waldo.console_auth_throttle(text,integer,integer,bigint,text)', 'execute'), true, 'the runtime key can call it (signature still required)');
select is(has_function_privilege('service_role', 'waldo.console_auth_throttle(text,integer,integer,bigint,text)', 'execute'), false, 'service role is not granted it');
select is((select relforcerowsecurity from pg_class where oid = 'waldo.console_auth_attempts'::regclass), true, 'the attempts table keeps forced row security');

-- A new window admits again, and the old window's row is swept.
select is(pg_temp.throttle('roll', 1, 60), true, 'the first attempt in a 60 s window');
select is(pg_temp.throttle('roll', 1, 60), false, 'the second is refused');
select is(pg_temp.throttle_at('roll', 1, 60, pg_temp.at() + 120), true, 'two windows later the key is admitted again');
select is((select count(*)::int from waldo.console_auth_attempts where key = 'roll'), 1, 'and the old window''s row is gone');

-- Each row expires on its own window: a 900 s call sweeps rows two windows old and keeps the previous window, for both windows.
insert into waldo.console_auth_attempts (key, window_seconds, bucket, attempts) values
  ('stale.900', 900, pg_temp.at() / 900 - 2, 1), ('kept.900', 900, pg_temp.at() / 900 - 1, 1),
  ('stale.3600', 3600, pg_temp.at() / 3600 - 2, 1), ('kept.3600', 3600, pg_temp.at() / 3600 - 1, 1);
select is(pg_temp.throttle('send:e@test.invalid', 5, 900), true, 'a sign-in attempt runs the sweep');
select is((select array_agg(key order by key) from waldo.console_auth_attempts where key like 'stale.%' or key like 'kept.%'), array['kept.3600', 'kept.900'], 'only rows two of their own windows old are swept');
select throws_ok($$ insert into waldo.console_auth_attempts (key, window_seconds, bucket, attempts) values ('zero', 0, 0, 1) $$, '23514', null, 'a row cannot carry a zero window, which the sweep divides by');
select col_hasnt_default('waldo', 'console_auth_attempts', 'window_seconds', 'every write names its window');

select * from finish();
rollback;
