begin;
create extension if not exists pgtap with schema extensions;
select plan(9);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.sig(msg text, at bigint) returns text language sql as $$ select encode(extensions.hmac(at::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
create function pg_temp.retention(owner text) returns jsonb language plpgsql as $$
declare t text := '{}'; a bigint := extract(epoch from now())::bigint; r jsonb;
begin
  select waldo.health_retention(owner, t, a, pg_temp.sig('health.retention.' || owner || '.' || md5(t), a)) into r;
  return r;
end $$;

insert into auth.users (id, email) values ('d1000000-0000-0000-0000-0000000000a1', 'a@test.invalid'), ('d1000000-0000-0000-0000-0000000000b1', 'b@test.invalid');
insert into waldo.owners (id, auth_user_id, do_name) values
  ('d2000000-0000-0000-0000-0000000000a1', 'd1000000-0000-0000-0000-0000000000a1', 'ret-owner-a'),
  ('d2000000-0000-0000-0000-0000000000b1', 'd1000000-0000-0000-0000-0000000000b1', 'ret-owner-b');

-- Owner A holds a row for each age; owner B holds one very old row that A's retention must not touch.
-- The cut is UTC today minus 733 days: that day survives, the one before it goes.
insert into public.health_context_daily (user_id, day, form) select 'd1000000-0000-0000-0000-0000000000a1', (now() at time zone 'UTC')::date - n, '{"reason":"x"}' from unnest(array[0, 100, 733, 734, 740]) n;
insert into public.health_context_daily (user_id, day, form) values ('d1000000-0000-0000-0000-0000000000b1', (now() at time zone 'UTC')::date - 800, '{"reason":"x"}');
insert into waldo.health_context_basis (owner_id, day, consent_basis, timezone) select 'd2000000-0000-0000-0000-0000000000a1', (now() at time zone 'UTC')::date - n, '[{"source":"apple","consent_epoch":1}]', 'UTC' from unnest(array[0, 733, 734, 740]) n;
insert into waldo.health_context_basis (owner_id, day, consent_basis, timezone) values ('d2000000-0000-0000-0000-0000000000b1', (now() at time zone 'UTC')::date - 800, '[{"source":"apple","consent_epoch":1}]', 'UTC');

select is(pg_temp.retention('ret-owner-a')->>'context_deleted', '2', 'retention expires the two derived rows older than the 24-month cut');
select is((select array_agg((now() at time zone 'UTC')::date - day order by day desc) from public.health_context_daily where user_id = 'd1000000-0000-0000-0000-0000000000a1'), array[0, 100, 733], 'the rows inside the cut, including the cut day itself, are kept');
select is((select array_agg((now() at time zone 'UTC')::date - day order by day desc) from waldo.health_context_basis where owner_id = 'd2000000-0000-0000-0000-0000000000a1'), array[0, 733], 'the basis records expire with their rows');
select is((select count(*)::int from public.health_context_daily where user_id = 'd1000000-0000-0000-0000-0000000000b1'), 1, 'another owner''s old row is not touched by this owner''s retention');
select is((select count(*)::int from waldo.health_context_basis where owner_id = 'd2000000-0000-0000-0000-0000000000b1'), 1, 'nor is another owner''s basis record');
select is(pg_temp.retention('ret-owner-a')->>'context_deleted', '0', 'a second run finds nothing more to expire');
select is(pg_temp.retention('ret-owner-b')->>'context_deleted', '1', 'the other owner''s own retention expires their old row');
select is(pg_temp.retention('nobody')->>'error', 'not_linked', 'an unknown owner is not linked');
select throws_ok($q$select waldo.health_retention('ret-owner-a', '{}', 1, 'bad')$q$, '42501', 'unsigned router call', 'an unsigned call is refused');

select * from finish();
rollback;
