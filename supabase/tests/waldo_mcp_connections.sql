begin;
create extension if not exists pgtap with schema extensions;
select plan(27);
insert into waldo.owners (do_name, email) values ('do-a', 'a@test.invalid'), ('do-b', 'b@test.invalid');

select is(has_function_privilege('anon', 'waldo.mcp_access(text, uuid)', 'execute'), false, 'the runtime key cannot read an MCP token');
select is(has_function_privilege('anon', 'waldo.mcp_store(text, text, text, jsonb, text)', 'execute'), false, 'the runtime key cannot store an MCP token');
select is(has_function_privilege('anon', 'waldo.mcp_rotate(text, uuid, text, text, text)', 'execute'), false, 'the runtime key cannot rotate an MCP token');
select is(has_function_privilege('anon', 'waldo.mcp_client_get(text, text)', 'execute'), false, 'the runtime key cannot read a client registration');
select is(has_function_privilege('service_role', 'waldo.mcp_access(text, uuid)', 'execute'), true, 'the edge reads MCP tokens');

create temp table m as select waldo.mcp_store('do-a', 'https://auth.example.com https://mcp.example.com/mcp', 'pages:read',
  '{"resource":"https://mcp.example.com/mcp","issuer":"https://auth.example.com","token_endpoint":"https://auth.example.com/token","client_id":"c","client_auth":"none"}'::jsonb,
  '{"access_token":"at-1","refresh_token":"rt-1"}') as id;
select isnt((select id from m), null, 'an MCP grant is stored');
select is((select provider from waldo.connections where id = (select id from m)), 'mcp', 'with the mcp provider');
select is((select count(*)::int from waldo.connections c join vault.secrets s on s.id = c.secret_id where s.secret like '%rt-1%'), 0, 'Vault holds the tokens encrypted');
select is((select secret from waldo.mcp_access('do-a', (select id from m))), '{"access_token":"at-1","refresh_token":"rt-1"}', 'the edge reads the owner''s MCP tokens');
select is((select pins->>'token_endpoint' from waldo.mcp_access('do-a', (select id from m))), 'https://auth.example.com/token', 'with the endpoints pinned at connect');
select is((select count(*)::int from waldo.mcp_access('do-b', (select id from m))), 0, 'another owner reads nothing');
select is((select count(*)::int from waldo.proxy_access('do-a', (select id from m))), 0, 'the Google proxy never reads an MCP grant');
select is(waldo.proxy_secret('do-a', (select id from m)), null, 'nor through the older Google read');
select throws_ok($$ insert into waldo.connections (owner_id, provider, account, secret_id) select id, 'mcp', 'x', gen_random_uuid() from waldo.owners where do_name = 'do-a' $$, '23514', null, 'an MCP row must carry its pins');

select is(waldo.mcp_rotate('do-a', (select id from m), encode(extensions.digest('{"access_token":"stale"}', 'sha256'), 'hex'), '{"access_token":"at-2","refresh_token":"rt-2"}', ''), false, 'a rotation from a stale secret loses');
select is(waldo.mcp_rotate('do-a', (select id from m), encode(extensions.digest('{"access_token":"at-1","refresh_token":"rt-1"}', 'sha256'), 'hex'), '{"access_token":"at-2","refresh_token":"rt-2"}', 'pages:read pages:write'), true, 'a rotation from the current secret lands');
select is((select secret from waldo.mcp_access('do-a', (select id from m))), '{"access_token":"at-2","refresh_token":"rt-2"}', 'the rotated tokens are read back');
select is((select scopes from waldo.connections where id = (select id from m)), array['pages:read', 'pages:write'], 'the granted scopes follow the rotation');
select is(waldo.mcp_rotate('do-b', (select id from m), encode(extensions.digest('{"access_token":"at-2","refresh_token":"rt-2"}', 'sha256'), 'hex'), 'x', ''), false, 'another owner cannot rotate it');

select is(waldo.mcp_client_put('https://auth.example.com', 'https://w.example/cb', 'client-1', 'none', null), true, 'the first registration is kept');
select is(waldo.mcp_client_put('https://auth.example.com', 'https://w.example/cb', 'client-2', 'none', null), false, 'a second registration for the same issuer is dropped');
select is((select client_id from waldo.mcp_client_get('https://auth.example.com', 'https://w.example/cb')), 'client-1', 'both callers read the stored client');

select is((waldo.proxy_idem_claim('do-a', (select id from m), 'approval:1:apply', 'd1'))->>'state', 'new', 'an MCP write claims its intent');
select is(waldo.mcp_idem_release('do-b', (select id from m), 'approval:1:apply'), false, 'another owner cannot release it');
select is(waldo.mcp_idem_release('do-a', (select id from m), 'approval:1:apply') and (waldo.proxy_idem_claim('do-a', (select id from m), 'approval:1:apply', 'd1'))->>'state' = 'new', true, 'a provably refused write releases its claim and can claim it again');
select is(waldo.mcp_revoke('do-a', (select id from m)), true, 'disconnect revokes the MCP grant');
select is((select count(*)::int from vault.secrets s join waldo.connections c on c.secret_id = s.id where c.id = (select id from m)), 0, 'and deletes its Vault secret');
select * from finish();
rollback;
