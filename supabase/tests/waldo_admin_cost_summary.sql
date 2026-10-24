begin;
create extension if not exists pgtap with schema extensions;
select plan(13);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
create function pg_temp.summary(p_do text) returns jsonb language sql as $$ select waldo.admin_cost_summary(p_do, pg_temp.at(), pg_temp.sig('admincost.' || p_do)) $$;

insert into waldo.owners (do_name, email, is_admin) values ('do-cost-admin', 'admin@test.invalid', true), ('do-cost-user', 'user@test.invalid', false);
insert into waldo.cost_ledger_daily (owner_id, day, kind, model, calls, input_tokens, output_tokens, cached_tokens, usd_estimate)
select o.id, r.day, r.kind, r.model, r.calls, r.input, r.output, r.cached, r.usd
from waldo.owners o join (values
  ('do-cost-user', current_date, 'turn', 'model-a', 3, 1000, 50, 400, 0.25),
  ('do-cost-user', current_date, 'heartbeat', 'model-b', 1, 200, 10, 0, 0.05),
  ('do-cost-user', current_date - 29, 'turn', 'model-a', 2, 500, 20, 100, 0.10),
  ('do-cost-user', current_date - 30, 'turn', 'model-a', 9, 9000, 90, 900, 9.00),
  ('do-cost-admin', current_date - 1, 'turn', 'model-a', 1, 100, 5, 0, 0.01)
) as r(do_name, day, kind, model, calls, input, output, cached, usd) on r.do_name = o.do_name;

select is(pg_temp.summary('do-cost-user'), null, 'a normal owner sees no spend');
select is(pg_temp.summary('do-missing'), null, 'an unknown DO sees no spend');
select throws_ok($$ select waldo.admin_cost_summary('do-cost-admin', pg_temp.at(), 'forged') $$, '42501', 'unsigned router call', 'a forged call is refused');
select throws_ok($$ select waldo.admin_cost_summary('do-cost-admin', pg_temp.at(), pg_temp.sig('admin.do-cost-admin')) $$, '42501', 'unsigned router call', 'the admin overview signature does not open spend');

select is(jsonb_array_length(pg_temp.summary('do-cost-admin')->'rows'), 3, 'the admin gets one row per owner per day in the window');
select is(pg_temp.summary('do-cost-admin')->'truncated', 'false'::jsonb, 'a small ledger is not truncated');
select is((select r from jsonb_array_elements(pg_temp.summary('do-cost-admin')->'rows') r
  where r->>'owner_id' = (select id::text from waldo.owners where do_name = 'do-cost-user') and r->>'day' = current_date::text),
  jsonb_build_object('owner_id', (select id from waldo.owners where do_name = 'do-cost-user'), 'day', current_date, 'usd', 0.30, 'calls', 4, 'input_tokens', 1200, 'cached_tokens', 400),
  'a day sums every kind and model, and carries only owner, day, usd, calls, input and cached tokens');
select is((select count(*) from jsonb_array_elements(pg_temp.summary('do-cost-admin')->'rows') r where (r->>'day')::date = current_date - 29), 1::bigint, 'the 30th day back is in the window');
select is((select count(*) from jsonb_array_elements(pg_temp.summary('do-cost-admin')->'rows') r where (r->>'day')::date < current_date - 29), 0::bigint, 'older days are left out');

select ok((select relforcerowsecurity from pg_class where oid = 'waldo.cost_ledger_daily'::regclass), 'row level security on the ledger stays forced');
select ok((select prosecdef from pg_proc where oid = 'waldo.admin_cost_summary(text,bigint,text)'::regprocedure), 'the summary runs as security definer');
select is(has_function_privilege('anon', 'waldo.admin_cost_summary(text,bigint,text)', 'execute'), true, 'the signed runtime can call the summary');
select is(has_function_privilege('authenticated', 'waldo.admin_cost_summary(text,bigint,text)', 'execute'), has_function_privilege('authenticated', 'waldo.admin_overview(text,bigint,text)', 'execute'), 'signed-in users hold the same grant on the summary as on the admin overview');
select * from finish();
rollback;
