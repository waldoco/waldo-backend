begin;
create extension if not exists pgtap with schema extensions;
select plan(17);
delete from vault.secrets where name = 'waldo_router_hmac';
select vault.create_secret('test-router-secret', 'waldo_router_hmac');
create function pg_temp.at() returns bigint language sql as $$ select extract(epoch from now())::bigint $$;
create function pg_temp.sig(msg text) returns text language sql as $$ select encode(extensions.hmac(pg_temp.at()::text || '.' || msg, 'test-router-secret', 'sha256'), 'hex') $$;
create function pg_temp.add(do_name text, batch text, rows text) returns integer language sql as $$
  select waldo.cost_ledger_add(do_name, batch, rows, pg_temp.at(), pg_temp.sig('cost.add.' || do_name || '.' || batch || '.' || md5(rows))) $$;
insert into waldo.owners (id, do_name) values ('10000000-0000-0000-0000-0000000000c1', 'do-cost'), ('10000000-0000-0000-0000-0000000000c2', 'do-cost-other');

select is(has_function_privilege('anon', 'waldo.cost_ledger_add(text, text, text, bigint, text)', 'execute'), true, 'the runtime key can add (signature still required)');
select is(has_function_privilege('service_role', 'waldo.cost_ledger_add(text, text, text, bigint, text)', 'execute'), false, 'service role is not granted the ledger RPC');
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'waldo' and c.relname in ('cost_ledger_daily', 'cost_ledger_batches') and c.relrowsecurity and c.relforcerowsecurity), 2, 'both ledger tables enable and force RLS');

select throws_ok($$ select waldo.cost_ledger_add('do-cost', 'b1', '[]', pg_temp.at(), 'badsig') $$, '42501', 'unsigned router call', 'an unsigned add is rejected');
select throws_ok($$ select waldo.cost_ledger_add('do-cost', 'b1', '[{"day":"2026-10-20","kind":"turn","model":"m","calls":1}]', pg_temp.at(), pg_temp.sig('cost.add.do-cost.b1.' || md5('[]'))) $$,
  '42501', 'unsigned router call', 'a signature over other rows is rejected');
select is(pg_temp.add('do-unknown', 'b1', '[]'), null, 'an unknown DO adds nothing');

select is(pg_temp.add('do-cost', 'b1', format('[{"day":"%s","kind":"turn","model":"gpt-6-luna","calls":2,"input":1500,"output":300,"cached":600,"web_searches":1,"usd":0.0125},'
  || '{"day":"%s","kind":"worker","model":"","sandbox_ms":1500,"usd":0},{"day":"%s","kind":"turn","model":"gpt-6-luna","calls":1,"input":10,"output":5,"cached":0,"usd":0.0001}]',
  current_date, current_date, current_date)), 2, 'a signed batch folds rows for the same bucket into one');
select is((select array[calls, input_tokens, output_tokens, cached_tokens, web_searches] from waldo.cost_ledger_daily where owner_id = '10000000-0000-0000-0000-0000000000c1' and kind = 'turn'),
  array[3, 1510, 305, 600, 1]::bigint[], 'token, call and search counts add up');
select is((select usd_estimate from waldo.cost_ledger_daily where owner_id = '10000000-0000-0000-0000-0000000000c1' and kind = 'turn'), 0.0126::numeric, 'the USD estimate adds up');
select is((select sandbox_ms from waldo.cost_ledger_daily where owner_id = '10000000-0000-0000-0000-0000000000c1' and kind = 'worker' and model = ''), 1500::bigint, 'non-model spend files under the empty model');

select is(pg_temp.add('do-cost', 'b1', format('[{"day":"%s","kind":"turn","model":"gpt-6-luna","calls":2}]', current_date)), 0, 'a replayed batch id is a no-op');
select is(pg_temp.add('do-cost', 'b2', format('[{"day":"%s","kind":"turn","model":"gpt-6-luna","calls":2}]', current_date)), 1, 'a new batch adds to the existing bucket');
select is((select calls from waldo.cost_ledger_daily where owner_id = '10000000-0000-0000-0000-0000000000c1' and kind = 'turn'), 5::bigint, 'calls count once per batch');

select throws_ok(format($$ select pg_temp.add('do-cost', 'b3', '[{"day":"%s","kind":"chat","model":"m","calls":1}]') $$, current_date), '23514', null, 'an unknown cost kind is rejected');
select throws_ok($$ select pg_temp.add('do-cost', 'b4', '{"day":"2026-10-20"}') $$, '22023', null, 'a batch that is not an array is rejected');
select is(pg_temp.add('do-cost-other', 'b1', format('[{"day":"%s","kind":"turn","model":"m","calls":1}]', current_date)), 1, 'batch ids are scoped per owner');

delete from waldo.owners where id = '10000000-0000-0000-0000-0000000000c1';
select is((select count(*)::int from waldo.cost_ledger_daily where owner_id = '10000000-0000-0000-0000-0000000000c1')
  + (select count(*)::int from waldo.cost_ledger_batches where owner_id = '10000000-0000-0000-0000-0000000000c1'), 0, 'deleting the owner removes their ledger and batch rows');

select * from finish();
rollback;
