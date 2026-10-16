begin;
create extension if not exists pgtap with schema extensions;
select plan(3);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
create function pg_temp.throttle(k text, lim integer, win integer) returns boolean language sql as $$
  select waldo.console_auth_throttle(k, lim, win, pg_temp.at(), pg_temp.sig('throttle.' || k || '.' || lim::text || '.' || win::text))
$$;

-- The WhatsApp hidden-number reply shares console_auth_throttle, whose cleanup deletes older buckets across every key.
-- On the sign-in window, a sign-in call in between must not reset the reply's count.
select is(pg_temp.throttle('wahidden.' || repeat('a', 64), 1, 900), true, 'the first hidden-number reply is allowed');
select is(pg_temp.throttle('send:someone@test.invalid', 5, 900), true, 'a sign-in send runs in between');
select is(pg_temp.throttle('wahidden.' || repeat('a', 64), 1, 900), false, 'the second hidden-number reply in the window is still refused');

select * from finish();
rollback;
