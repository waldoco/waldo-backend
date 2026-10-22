begin;
create extension if not exists pgtap with schema extensions;
select plan(44);
insert into waldo.owners (do_name, email) values ('do-a', 'a@test.invalid'), ('do-b', 'b@test.invalid');

select is(has_function_privilege('anon', 'waldo.oauth_access(text, uuid)', 'execute'), false, 'the runtime key cannot read an edge-held token');
select is(has_function_privilege('anon', 'waldo.oauth_store(text, text, text, text, jsonb, text)', 'execute'), false, 'the runtime key cannot store an edge-held token');
select is(has_function_privilege('anon', 'waldo.oauth_rotate(text, uuid, text, text, text)', 'execute'), false, 'the runtime key cannot rotate an edge-held token');
select is(has_function_privilege('anon', 'waldo.oauth_client_get(text, text)', 'execute'), false, 'the runtime key cannot read a client registration');
select is(has_function_privilege('service_role', 'waldo.oauth_access(text, uuid)', 'execute'), true, 'the edge reads its tokens');

-- Custody: a provider exists only with a custody row, and each Edge Function reads only its own providers.
select throws_ok($$ insert into waldo.connections (owner_id, provider, account, secret_id) select id, 'unregistered', 'x', gen_random_uuid() from waldo.owners where do_name = 'do-a' $$, '23503', null, 'a provider without a custody row is refused');
select is((select custodian from waldo.connection_custody where provider = 'google'), 'connector-proxy', 'Google stays with the connector-proxy');
select is((select custodian from waldo.connection_custody where provider = 'mcp'), 'oauth-proxy', 'MCP servers are held by the oauth-proxy');

create temp table g as select waldo.proxy_store('do-a', 'google', 'a@test.invalid', 'https://www.googleapis.com/auth/calendar', 'google-refresh') as id;
select isnt((select id from g), null, 'a Google grant is stored through the connector-proxy as before');
select is((select secret from waldo.proxy_access('do-a', (select id from g))), 'google-refresh', 'and read back by proxy_access, unnarrowed');
select is(waldo.proxy_secret('do-a', (select id from g)), 'google-refresh', 'and by proxy_secret');
select is((select count(*)::int from waldo.oauth_access('do-a', (select id from g))), 0, 'the oauth-proxy never reads a Google grant');
select is(waldo.oauth_rotate('do-a', (select id from g), encode(extensions.digest('google-refresh', 'sha256'), 'hex'), 'x', ''), false, 'nor rotates one');
select is(waldo.oauth_store('do-a', 'google', 'a@test.invalid', 's', '{"issuer":"https://accounts.google.com"}', 'x'), '{"error":"invalid"}'::jsonb, 'nor stores one');
select is(waldo.proxy_store('do-a', 'mcp', 'https://auth.example.com https://mcp.example.com/mcp', 's', 'x'), null, 'the connector-proxy cannot store or overwrite an edge-held token');

create temp table m as select (waldo.oauth_store('do-a', 'mcp', 'https://auth.example.com https://mcp.example.com/mcp', 'pages:read',
  '{"server_url":"https://mcp.example.com/mcp","resource":"https://mcp.example.com/mcp","issuer":"https://auth.example.com","token_endpoint":"https://auth.example.com/token","client_id":"c","client_auth":"none","redirect_uri":"https://w.example/cb"}'::jsonb,
  '{"access_token":"at-1","refresh_token":"rt-1"}')->>'id')::uuid as id;
select isnt((select id from m), null, 'an MCP grant is stored');
select is((select provider from waldo.connections where id = (select id from m)), 'mcp', 'with the mcp provider');
select is((select count(*)::int from waldo.connections c join vault.secrets s on s.id = c.secret_id where s.secret like '%rt-1%'), 0, 'Vault holds the tokens encrypted');
select is((select secret from waldo.oauth_access('do-a', (select id from m))), '{"access_token":"at-1","refresh_token":"rt-1"}', 'the edge reads the owner''s MCP tokens');
select is((select provider from waldo.oauth_access('do-a', (select id from m))), 'mcp', 'with the provider named');
select is((select pins->>'token_endpoint' from waldo.oauth_access('do-a', (select id from m))), 'https://auth.example.com/token', 'and the endpoints pinned at connect');
select is((select count(*)::int from waldo.oauth_access('do-b', (select id from m))), 0, 'another owner reads nothing');
select is((select count(*)::int from waldo.proxy_access('do-a', (select id from m))), 0, 'the Google proxy never reads an MCP grant');
select is(waldo.proxy_secret('do-a', (select id from m)), null, 'nor through the older Google read');

select is(waldo.oauth_rotate('do-a', (select id from m), encode(extensions.digest('{"access_token":"stale"}', 'sha256'), 'hex'), '{"access_token":"at-2","refresh_token":"rt-2"}', ''), false, 'a rotation from a stale secret loses');
select is(waldo.oauth_rotate('do-a', (select id from m), encode(extensions.digest('{"access_token":"at-1","refresh_token":"rt-1"}', 'sha256'), 'hex'), '{"access_token":"at-2","refresh_token":"rt-2"}', 'pages:read pages:write'), true, 'a rotation from the current secret lands');
select is((select secret from waldo.oauth_access('do-a', (select id from m))), '{"access_token":"at-2","refresh_token":"rt-2"}', 'the rotated tokens are read back');
select is((select scopes from waldo.connections where id = (select id from m)), array['pages:read', 'pages:write'], 'the granted scopes follow the rotation');
select is(waldo.oauth_rotate('do-b', (select id from m), encode(extensions.digest('{"access_token":"at-2","refresh_token":"rt-2"}', 'sha256'), 'hex'), 'x', ''), false, 'another owner cannot rotate it');

-- A second provider registers with one custody row and uses the same store, rotate and access path.
insert into waldo.connection_custody (provider, custodian) values ('fixture_health', 'oauth-proxy');
create unique index fixture_health_account on waldo.connections (provider, account) where provider = 'fixture_health' and status <> 'revoked';
create temp table h as select (waldo.oauth_store('do-a', 'fixture_health', '1001', 'offline read:sleep',
  '{"issuer":"https://health.example.com","token_endpoint":"https://health.example.com/oauth/token","client_id":"h","client_auth":"client_secret_post","redirect_uri":"https://w.example/health","api_base":"https://health.example.com/v2/","rotation":"single_use"}'::jsonb,
  '{"access_token":"hat-1","refresh_token":"hrt-1"}')->>'id')::uuid as id;
select isnt((select id from h), null, 'a non-MCP provider row is stored with its pins');
select is(waldo.oauth_store('do-b', 'fixture_health', '1001', 'offline', '{"issuer":"https://health.example.com"}', 'x'), '{"error":"account_linked"}'::jsonb, 'a provider account already linked to another owner is refused');
select is(waldo.oauth_rotate('do-a', (select id from h), encode(extensions.digest('{"access_token":"hat-0","refresh_token":"hrt-0"}', 'sha256'), 'hex'), '{"access_token":"hat-2","refresh_token":"hrt-2"}', ''), false, 'a non-MCP rotation from a spent refresh token loses');
select is(waldo.oauth_rotate('do-a', (select id from h), encode(extensions.digest('{"access_token":"hat-1","refresh_token":"hrt-1"}', 'sha256'), 'hex'), '{"access_token":"hat-2","refresh_token":"hrt-2"}', ''), true, 'a non-MCP rotation from the current secret lands');
select is((select secret from waldo.oauth_access('do-a', (select id from h))), '{"access_token":"hat-2","refresh_token":"hrt-2"}', 'and its rotated tokens are read back');
select is((select scopes from waldo.connections where id = (select id from h)), array['offline', 'read:sleep'], 'a rotation without a scope keeps the granted scopes');
select is((select count(*)::int from waldo.proxy_access('do-a', (select id from h))), 0, 'the Google proxy never reads a health-provider grant');

select is(waldo.oauth_client_put('https://auth.example.com', 'https://w.example/cb', 'client-1', 'none', null), true, 'the first registration is kept');
select is(waldo.oauth_client_put('https://auth.example.com', 'https://w.example/cb', 'client-2', 'none', null), false, 'a second registration for the same issuer is dropped');
select is((select client_id from waldo.oauth_client_get('https://auth.example.com', 'https://w.example/cb')), 'client-1', 'both callers read the stored client');

select is((waldo.proxy_idem_claim('do-a', (select id from m), 'approval:1:apply', 'd1'))->>'state', 'new', 'an MCP write claims its intent');
select is(waldo.oauth_idem_release('do-b', (select id from m), 'approval:1:apply'), false, 'another owner cannot release it');
select is(waldo.oauth_idem_release('do-a', (select id from m), 'approval:1:apply') and (waldo.proxy_idem_claim('do-a', (select id from m), 'approval:1:apply', 'd1'))->>'state' = 'new', true, 'a provably refused write releases its claim and can claim it again');
select is(waldo.oauth_revoke('do-a', (select id from m)), true, 'disconnect revokes the MCP grant');
select is((select count(*)::int from vault.secrets s join waldo.connections c on c.secret_id = s.id where c.id = (select id from m)), 0, 'and deletes its Vault secret');
select * from finish();
rollback;
